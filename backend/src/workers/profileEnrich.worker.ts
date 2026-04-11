import { Worker } from 'bullmq'
import { connection, profileEnrichQueue } from '../lib/queue'
import type IORedis from 'ioredis'
import { supabase } from '../lib/supabase'
import { persistCookies } from '../linkedin/session'
import type { AccountRecord } from '../linkedin/session'
import { enrichLeads } from '../linkedin/enrichProfiles'
import { acquireAccountLock } from '../lib/accountLock'
import { getOrCreateBrowserSession, invalidateBrowserSession } from '../lib/browserPool'

// How long to wait after session expiry before re-attempting enrichment.
// The headless reconnect typically takes 1–3 minutes (including 2captcha solve).
const RECONNECT_WAIT_MS = 3 * 60 * 1000 // 3 minutes

interface ProfileEnrichJob {
  lead_ids: string[]
  account_id: string
  user_id: string
  /** Set internally when the job is re-queued after a session expiry reconnect. */
  _retry_after_reconnect?: boolean
}

export const profileEnrichWorker = new Worker<ProfileEnrichJob>(
  'profile-enrich',
  async (job) => {
    const { lead_ids, account_id, user_id } = job.data

    await job.updateProgress(2)

    // Fetch account
    const { data: account } = await supabase
      .from('linkedin_accounts')
      .select('*')
      .eq('id', account_id)
      .single()

    if (!account) throw new Error('Account not found')

    // If this is a retry-after-reconnect and the account is still not active,
    // throw so BullMQ retries with backoff — don't silently drop the work.
    if (!['active', 'warming_up'].includes(account.status)) {
      throw new Error(`Account is not active (status: ${account.status}) — will retry`)
    }

    // Fetch leads
    const { data: leads } = await supabase
      .from('leads')
      .select('id, linkedin_url, first_name, last_name')
      .in('id', lead_ids)
      .eq('user_id', user_id)

    if (!leads || leads.length === 0) throw new Error('No leads found')

    await job.updateProgress(5)

    // Acquire per-account lock — prevents two browser processes using the same
    // persistent Chrome profile simultaneously (causes session invalidation)
    const release = await acquireAccountLock(account_id)
    if (!release) throw new Error(`Account ${account_id} is currently in use by another worker — job will retry`)

    // Get or reuse persistent browser session (avoids cold-start detection)
    let context
    try {
      const session = await getOrCreateBrowserSession(account as AccountRecord)
      context = session.context
      const { page } = session

      const cancelKey = `cancel:enrich:${job.id}`
      const isCancelled = async () => {
        const flag = await (connection as unknown as IORedis).get(cancelKey)
        return flag === '1'
      }

      const { sessionExpired, cancelled } = await enrichLeads(page, leads, user_id, async (done, total) => {
        const pct = 5 + Math.round((done / total) * 93)
        await job.updateProgress(pct)
      }, isCancelled)

      if (cancelled) {
        await (connection as unknown as IORedis).del(cancelKey)
        await job.updateProgress(100)
        return { enriched: 0, cancelled: true }
      }

      if (sessionExpired) {
        console.warn(`[profile-enrich] Session expired mid-batch for ${account_id} — pausing account and re-queuing in ${RECONNECT_WAIT_MS / 60000}min`)

        // Mark account as paused immediately so the UI reflects the broken state.
        // browserPool reconnect will set it back to 'active' once the session is restored.
        await supabase
          .from('linkedin_accounts')
          .update({ status: 'paused' })
          .eq('id', account_id)

        invalidateBrowserSession(account_id)

        // Re-queue the SAME lead_ids with a delay so reconnect can finish first.
        // Mark as _retry_after_reconnect so the re-queued job is distinguishable in logs.
        await profileEnrichQueue.add(
          'profile-enrich',
          { lead_ids, account_id, user_id, _retry_after_reconnect: true },
          {
            delay: RECONNECT_WAIT_MS,
            attempts: 3,
            backoff: { type: 'fixed', delay: 60_000 }, // 1-min fixed retry if account still paused
          }
        )

        // Return success for THIS job — the re-queued job will do the actual work.
        await job.updateProgress(100)
        return { enriched: 0, requeued: true }
      }

      await persistCookies(context, account_id)
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('SESSION_EXPIRED') || msg.includes('session') || msg.includes('login')) {
        // Mark account paused immediately — reconnect will restore to 'active' on success.
        try { await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account_id) } catch {}
        invalidateBrowserSession(account_id)

        // Re-queue with delay just like the sessionExpired path above.
        await profileEnrichQueue.add(
          'profile-enrich',
          { lead_ids, account_id, user_id, _retry_after_reconnect: true },
          {
            delay: RECONNECT_WAIT_MS,
            attempts: 3,
            backoff: { type: 'fixed', delay: 60_000 },
          }
        ).catch(() => null) // don't let re-queue failure mask the original error
      }
      throw err
    } finally {
      await release()
    }

    await job.updateProgress(100)
    return { enriched: leads.length }
  },
  {
    connection,
    concurrency: 1,
  }
)

profileEnrichWorker.on('failed', (job, err) => {
  console.error(`[profile-enrich] Job ${job?.id} failed:`, err.message)
})

console.log('Profile enrich worker started')
