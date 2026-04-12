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
    const rawPriority = campaign.lead_priority ?? null
    // Decode the combined priority string into two independent flags
    const wantHighIcp  = rawPriority === 'high_icp' || rawPriority === 'high_icp+warm'
    const wantWarm     = rawPriority === 'warm'      || rawPriority === 'high_icp+warm'

    // Join leads table to get icp_score + icp_flag for ordering
    const { data: leads, error: leadsErr } = await supabase
      .from('campaign_leads')
      .select('id, account_id, leads(icp_score, icp_flag)')
      .eq('campaign_id', campaign.id)
      .in('status', ['pending', 'connection_sent', 'connected', 'messaged'])
      .limit(50)   // process up to 50 per cycle per campaign

    if (leadsErr) {
      console.error(`[scheduler] Error fetching leads for campaign ${campaign.id}: ${leadsErr.message}`)
      continue
    }

    if (!leads || leads.length === 0) continue

    type RawLead = { id: string; account_id: string | null; leads: { icp_score: number | null; icp_flag: string | null } | { icp_score: number | null; icp_flag: string | null }[] | null }

    // Resolve each lead's effective account_id: use the lead's own, fall back to campaign's
    const resolvedLeads = (leads as RawLead[])
      .map(l => {
        const leadData = Array.isArray(l.leads) ? l.leads[0] : l.leads
        return {
          id: l.id,
          effective_account_id: l.account_id ?? campaign.account_id,
          icp_score: leadData?.icp_score ?? null,
          icp_flag:  leadData?.icp_flag  ?? null,
        }
      })
      .filter(l => l.effective_account_id !== null) as Array<{ id: string; effective_account_id: string; icp_score: number | null; icp_flag: string | null }>

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
        // BullMQ priority: 1 = highest (runs first), 100 = lowest.
        // Start at 100 and subtract bonuses for each active toggle.
        // Both toggles off → all leads get priority 50 (FIFO-like within a batch).
        let bullPriority = 50  // neutral baseline when no toggles are active

        if (wantHighIcp || wantWarm) {
          let p = 100  // start at lowest

          // High ICP bonus: score 100 → -50, score 0 → -0
          if (wantHighIcp) {
            const score = l.icp_score ?? 50
            p -= Math.round(score / 2)  // max 50-point reduction for perfect ICP
          }

          // Warm leads bonus: hot/warm flag gets a flat -30 boost
          if (wantWarm) {
            const isWarm = l.icp_flag === 'hot' || l.icp_flag === 'warm'
            if (isWarm) p -= 30
          }

          bullPriority = Math.max(1, p)
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
