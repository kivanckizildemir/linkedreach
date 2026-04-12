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
  // Get all active campaigns with their assigned account and lead priority
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, account_id, lead_priority')
    .eq('status', 'active')

  if (!campaigns || campaigns.length === 0) return

  for (const campaign of campaigns as Array<{ id: string; account_id: string | null; lead_priority: string | null }>) {
    const priority = campaign.lead_priority ?? 'high_icp'

    // Join leads table to get icp_score for ordering
    const now = new Date().toISOString()
    // Use last_action_at (the actual DB column) for scheduling.
    // A lead is "due" if it has never been acted on (null) or was last acted on
    // enough time ago (the wait_days logic is handled inside the sequence runner).
    // We simply re-enqueue all eligible leads; the runner guards against double-actions.
    const { data: leads, error: leadsErr } = await supabase
      .from('campaign_leads')
      .select('id, account_id, leads(icp_score)')
      .eq('campaign_id', campaign.id)
      .in('status', ['pending', 'connection_sent', 'connected', 'messaged'])
      .limit(50)   // process up to 50 per cycle per campaign

    if (leadsErr) {
      console.error(`[scheduler] Error fetching leads for campaign ${campaign.id}: ${leadsErr.message}`)
      continue
    }

    if (!leads || leads.length === 0) continue

    type RawLead = { id: string; account_id: string | null; leads: { icp_score: number | null } | { icp_score: number | null }[] | null }

    // Resolve each lead's effective account_id: use the lead's own, fall back to campaign's
    const resolvedLeads = (leads as RawLead[])
      .map(l => ({
        id: l.id,
        effective_account_id: l.account_id ?? campaign.account_id,
        icp_score: (Array.isArray(l.leads) ? l.leads[0]?.icp_score : l.leads?.icp_score) ?? null,
      }))
      .filter(l => l.effective_account_id !== null) as Array<{ id: string; effective_account_id: string; icp_score: number | null }>

    if (resolvedLeads.length === 0) continue

    // Verify the resolved accounts are active before enqueuing
    const accountIds = [...new Set(resolvedLeads.map(l => l.effective_account_id))]
    const { data: activeAccounts } = await supabase
      .from('linkedin_accounts')
      .select('id')
      .in('id', accountIds)
      .in('status', ['active', 'warming_up'])

    const activeSet = new Set((activeAccounts ?? []).map((a: { id: string }) => a.id))

    const jobs = resolvedLeads
      .filter(l => activeSet.has(l.effective_account_id))
      .map(l => {
        // Map ICP score → BullMQ priority (1 = highest priority, 100 = lowest).
        // This ensures ordering is respected across scheduler cycles, not just
        // within a single addBulk batch.
        let bullPriority: number
        if (priority === 'fifo') {
          bullPriority = 50  // all equal — FIFO order preserved naturally
        } else {
          const score = l.icp_score ?? 50  // unscored leads land in the middle
          bullPriority = priority === 'high_icp'
            ? Math.max(1, 100 - score)   // score 100 → priority 1 (first)
            : Math.max(1, score + 1)     // score 0   → priority 1 (first)
        }
        return {
          name: 'run',
          data: { campaign_lead_id: l.id },
          opts: {
            // deduplicate by lead id — don't queue the same lead twice
            jobId:            `run-${l.id}`,
            priority:         bullPriority,
            attempts:         3,
            backoff:          { type: 'fixed', delay: 60_000 },
            // Auto-remove after failure so the scheduler can re-add on the next cycle.
            // Without this, exhausted failed jobs block re-scheduling indefinitely.
            removeOnFail:     true,
            removeOnComplete: true,
          },
        }
      })

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
