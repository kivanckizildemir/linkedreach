/**
 * LinkedIn Action Worker
 *
 * Processes jobs from the 'linkedin-actions' BullMQ queue.
 *
 * Routing strategy (in order):
 *   1. If the account owner has the Chrome extension connected → send job there.
 *      Extension runs in the user's real browser with their real session/IP.
 *   2. Otherwise → Playwright fallback (Phase 2 — stub for now).
 *
 * Rate limits enforced regardless of execution path:
 *   - Max 25 connection requests / account / day
 *   - Max 100 messages / account / day
 *   - 30–120 s randomised gap between actions
 *   - Only 7 am–11 pm
 *   - Warmup ramp: 5/day start, +3/week
 */

import { Worker, Job } from 'bullmq'
import { connection } from '../lib/queue'
import { createClient } from '@supabase/supabase-js'
import { isExtensionOnline, sendActionToExtension, type ExtensionJob } from '../lib/extensionHub'
import { randomUUID } from 'crypto'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CONNECTIONS_PER_DAY = 25
const MAX_MESSAGES_PER_DAY    = 100
const MIN_DELAY_MS             = 30_000
const MAX_DELAY_MS             = 120_000

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinkedInActionJob {
  accountId:        string
  userId:           string   // account owner — needed for extension routing
  action:           'connect' | 'message' | 'view_profile' | 'follow' | 'react_post'
  targetProfileUrl: string
  messageContent?:  string
  note?:            string   // connection request note (≤ 300 chars)
  reaction?:        string   // for react_post: like/celebrate/love/insightful/curious
  campaignLeadId?:  string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomDelay(): number {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
}

function isWithinActiveHours(): boolean {
  const h = new Date().getHours()
  return h >= 7 && h < 23
}

async function getAccount(accountId: string) {
  const { data } = await supabase
    .from('linkedin_accounts')
    .select('id, user_id, daily_connection_count, daily_message_count, warmup_day, status')
    .eq('id', accountId)
    .single()
  return data as {
    id: string; user_id: string; daily_connection_count: number;
    daily_message_count: number; warmup_day: number | null; status: string
  } | null
}

async function incrementCounter(accountId: string, field: 'daily_connection_count' | 'daily_message_count') {
  const { data } = await supabase
    .from('linkedin_accounts')
    .select(field)
    .eq('id', accountId)
    .single()
  const current = (data as Record<string, number> | null)?.[field] ?? 0
  await supabase
    .from('linkedin_accounts')
    .update({ [field]: current + 1, last_active_at: new Date().toISOString() })
    .eq('id', accountId)
}

async function logActivity(accountId: string, action: string, targetUrl: string, status: string, via: string) {
  await supabase.from('activity_logs').insert({
    account_id: accountId, action_type: action, target_url: targetUrl,
    status, executed_via: via,
  }).then(({ error }) => {
    if (error) console.warn('[Worker] activity_log insert failed:', error.message)
  })
}

// ── Main processor ────────────────────────────────────────────────────────────

async function processLinkedInAction(job: Job<LinkedInActionJob>) {
  const { accountId, userId, action, targetProfileUrl, messageContent, note, reaction, campaignLeadId } = job.data

  // Time gate
  if (!isWithinActiveHours()) {
    console.log(`[${accountId}] Outside active hours — will retry`)
    throw new Error('outside_active_hours')
  }

  // Fetch account
  const account = await getAccount(accountId)
  if (!account) throw new Error(`Account ${accountId} not found`)
  if (account.status === 'paused' || account.status === 'banned') {
    console.log(`[${accountId}] Account ${account.status} — skipping`)
    return { skipped: true, reason: account.status }
  }

  // Rate limits
  const warmupMax = account.warmup_day != null
    ? Math.min(5 + Math.floor(account.warmup_day / 7) * 3, MAX_CONNECTIONS_PER_DAY)
    : MAX_CONNECTIONS_PER_DAY

  if (action === 'connect' && account.daily_connection_count >= warmupMax) {
    console.log(`[${accountId}] Connection cap ${warmupMax}/day reached`)
    return { skipped: true, reason: 'daily_connection_limit' }
  }
  if (action === 'message' && account.daily_message_count >= MAX_MESSAGES_PER_DAY) {
    console.log(`[${accountId}] Message cap ${MAX_MESSAGES_PER_DAY}/day reached`)
    return { skipped: true, reason: 'daily_message_limit' }
  }

  // Human-like delay
  const delay = randomDelay()
  console.log(`[${accountId}] Waiting ${Math.round(delay / 1000)}s before ${action}`)
  await new Promise(r => setTimeout(r, delay))

  // Route: extension (preferred) vs Playwright (fallback)
  const effectiveUserId = userId ?? account.user_id
  const useExtension    = isExtensionOnline(effectiveUserId)
  const via             = useExtension ? 'extension' : 'playwright'
  console.log(`[${accountId}] ${action} → ${via.toUpperCase()}`)

  let result: unknown

  if (useExtension) {
    const extJob: ExtensionJob = {
      jobId:      randomUUID(),
      action:     action as ExtensionJob['action'],
      accountId,
      profileUrl: targetProfileUrl,
      note,
      message:    messageContent,
      reaction,
    }

    result = await sendActionToExtension(effectiveUserId, extJob)

    // Pause account if extension detected a LinkedIn warning or captcha
    const res = result as { warning?: boolean; captcha?: boolean } | null
    if (res?.warning || res?.captcha) {
      await supabase
        .from('linkedin_accounts')
        .update({ status: 'paused' })
        .eq('id', accountId)
      throw new Error('LinkedIn warning/captcha detected — account paused')
    }

  } else {
    // Playwright stub — will be implemented in Phase 2
    console.warn(`[${accountId}] Extension offline, Playwright not yet implemented — skipping`)
    return { skipped: true, reason: 'extension_offline' }
  }

  // Update counters
  if (action === 'connect') await incrementCounter(accountId, 'daily_connection_count')
  if (action === 'message') await incrementCounter(accountId, 'daily_message_count')

  // Log activity
  await logActivity(accountId, action, targetProfileUrl, 'success', via)

  // Update campaign lead status
  if (campaignLeadId) {
    const newStatus =
      action === 'connect' ? 'connection_sent' :
      action === 'message' ? 'messaged' : undefined
    if (newStatus) {
      await supabase
        .from('campaign_leads')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', campaignLeadId)
    }
  }

  console.log(`[${accountId}] ${action} ✓`)
  return { success: true, action, accountId, result }
}

// ── Worker setup ──────────────────────────────────────────────────────────────

export const linkedinActionWorker = new Worker<LinkedInActionJob>(
  'linkedin-actions',
  processLinkedInAction,
  { connection, concurrency: 3, limiter: { max: 1, duration: MIN_DELAY_MS } }
)

linkedinActionWorker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} (${job.data.action}) done`)
})

linkedinActionWorker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed:`, err.message)
})

console.log('[Worker] LinkedIn action worker started — extension-first routing')
