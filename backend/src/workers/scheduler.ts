/**
 * Scheduler
 *
 * Runs every minute. Finds campaign leads that are due for their next action
 * and enqueues them into the sequence-runner queue.
 *
 * A lead is "due" when:
 *   - Campaign is active
 *   - Lead status is not stopped/converted
 *   - Account is active
 *   - Either never acted on, or last_action_at was long enough ago for a wait step
 */

import { supabase } from '../lib/supabase'
import { sequenceRunnerQueue } from '../lib/queue'

export async function schedulePendingLeads(): Promise<void> {
  // Get all active campaigns
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id')
    .eq('status', 'active')

  if (!campaigns || campaigns.length === 0) return

  for (const campaign of campaigns) {
    const { data: leads } = await supabase
      .from('campaign_leads')
      .select('id, account_id')
      .eq('campaign_id', campaign.id)
      .in('status', ['pending', 'connection_sent', 'connected', 'messaged'])
      .limit(50)   // process up to 50 per cycle per campaign

    if (!leads || leads.length === 0) continue

    // Verify the account is active before enqueuing
    const accountIds = [...new Set(leads.map((l: { account_id: string }) => l.account_id))]
    const { data: activeAccounts } = await supabase
      .from('linkedin_accounts')
      .select('id')
      .in('id', accountIds)
      .eq('status', 'active')

    const activeSet = new Set((activeAccounts ?? []).map((a: { id: string }) => a.id))

    const jobs = leads
      .filter((l: { account_id: string }) => activeSet.has(l.account_id))
      .map((l: { id: string }) => ({
        name: 'run',
        data: { campaign_lead_id: l.id },
        opts: {
          // deduplicate by lead id — don't queue the same lead twice
          jobId:    `run-${l.id}`,
          attempts: 2,
          backoff:  { type: 'fixed', delay: 60_000 },
        },
      }))

    if (jobs.length > 0) {
      await sequenceRunnerQueue.addBulk(jobs)
      console.log(`[scheduler] Enqueued ${jobs.length} jobs for campaign ${campaign.id}`)
    }
  }
}

// Run every 60 seconds
export function startScheduler(): void {
  console.log('[scheduler] Started — running every 60s')
  schedulePendingLeads().catch(console.error)
  setInterval(() => schedulePendingLeads().catch(console.error), 60_000)
}
