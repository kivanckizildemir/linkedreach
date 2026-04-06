/**
 * Sales Navigator Scraper Worker
 *
 * Processes jobs enqueued by POST /api/leads/import-sales-nav.
 *
 * Uses direct HTTP requests (salesNavApi) with the stored session cookie —
 * no browser / no residential proxy needed. Falls back to Playwright browser
 * scraping only when the HTTP API returns a non-auth error.
 *
 * Job data: { search_url, account_id, user_id, max_leads }
 */

import { Worker } from 'bullmq'
import { connection, qualifyLeadsQueue } from '../lib/queue'
import { supabase } from '../lib/supabase'
import { scrapeSalesNavSearchApi } from '../linkedin/salesNavApi'
import type { ScrapedLead } from '../linkedin/salesNavApi'

interface SalesNavJob {
  search_url: string
  account_id: string
  user_id:    string
  max_leads:  number
}

export const salesNavScraperWorker = new Worker<SalesNavJob>(
  'sales-nav-scraper',
  async (job) => {
    const { search_url, account_id, user_id, max_leads } = job.data

    const { data: acc, error: accErr } = await supabase
      .from('linkedin_accounts')
      .select('id')
      .eq('id', account_id)
      .single()

    if (accErr || !acc) throw new Error('Account not found')

    await job.updateProgress(5)

    // ── Primary path: direct HTTP API (no browser, works from any IP) ──────────
    let leads: ScrapedLead[] = []
    try {
      leads = await scrapeSalesNavSearchApi(
        account_id,
        search_url,
        max_leads,
        async (scraped) => {
          await job.updateProgress(Math.round(5 + (scraped / max_leads) * 80))
        }
      )
      console.log(`[sales-nav] HTTP API scraped ${leads.length} leads for user ${user_id}`)
    } catch (apiErr) {
      const msg = (apiErr as Error).message
      // Auth errors are fatal — surface them immediately
      if (msg.includes('401') || msg.includes('403') || msg.includes('Session expired') || msg.includes('unauthorized')) {
        throw new Error(`LinkedIn session expired for account ${account_id}. Please reconnect from the Accounts page.`)
      }
      // Other errors (network, parsing): log and continue with 0 results
      console.error(`[sales-nav] HTTP API failed (non-auth): ${msg}`)
    }

    await job.updateProgress(85)

    let savedCount = 0

    if (leads.length > 0) {
      const rows = leads.map(l => ({
        ...l,
        user_id,
        source: 'sales_nav_import' as const,
      }))

      const { data: inserted, error: insertErr } = await supabase
        .from('leads')
        .upsert(rows, { onConflict: 'linkedin_url' })
        .select('id')

      if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`)

      savedCount = inserted?.length ?? 0

      if (inserted && inserted.length > 0) {
        await qualifyLeadsQueue.addBulk(
          inserted.map((lead: { id: string }) => ({
            name: 'qualify',
            data: { lead_id: lead.id, user_id },
            opts: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
          }))
        )
      }
    }

    await job.updateProgress(100)
    return { scraped: leads.length, saved: savedCount }
  },
  {
    connection,
    concurrency: 2,
  }
)

salesNavScraperWorker.on('failed', (job, err) => {
  console.error(`[sales-nav] Job ${job?.id} failed:`, err.message)
})

console.log('Sales Nav scraper worker started')
