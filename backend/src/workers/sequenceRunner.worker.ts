/**
 * Sequence Runner Worker
 *
 * Picks up pending campaign leads, evaluates their next sequence step,
 * executes it via Playwright, and advances their position in the sequence.
 *
 * Enqueue jobs via sequenceRunnerQueue.add('run', { campaign_lead_id })
 */

import { Worker } from 'bullmq'
import { connection } from '../lib/queue'
import { supabase } from '../lib/supabase'
import { persistCookies } from '../linkedin/session'
import { acquireAccountLock } from '../lib/accountLock'
import { getOrCreateBrowserSession, invalidateBrowserSession } from '../lib/browserPool'
import {
  viewProfile,
  sendConnectionRequest,
  sendMessage,
  sendInMail,
  reactToPost,
  followProfile,
  checkConnectionStatus,
  personaliseTemplate,
} from '../linkedin/actions'
import { warmupConnectionLimit } from './warmup.worker'
import { personaliseOpeningLine } from '../ai/personalise'
import type {
  CampaignLeadStatus,
  StepType,
  ReactionType,
  ReplyClassification,
} from '../types'

interface RunJob {
  campaign_lead_id: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWithinActiveHours(timezone = 'Europe/London'): boolean {
  const now = new Date()
  const hour = parseInt(
    now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }),
    10
  )
  return hour >= 7 && hour < 23
}

function randomDelay(): Promise<void> {
  const ms = 30_000 + Math.random() * 90_000   // 30–120 s
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Check daily limits for an account. Respects warmup ramp for warming_up accounts. */
async function checkDailyLimit(
  accountId: string,
  type: 'connection' | 'message',
  warmupDay = 0,
  accountStatus = 'active'
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)

  const { count } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('last_action_at', `${today}T00:00:00Z`)
    .eq('status', type === 'connection' ? 'connection_sent' : 'messaged')

  let limit: number
  if (type === 'connection') {
    limit = accountStatus === 'warming_up' ? warmupConnectionLimit(warmupDay) : 25
  } else {
    limit = 100
  }

  return (count ?? 0) < limit
}

// ── Sequence tree helpers ─────────────────────────────────────────────────────

interface SequenceStep {
  id: string
  type: StepType
  step_order: number
  message_template: string | null
  subject: string | null
  wait_days: number | null
  condition: Record<string, unknown> | null
  parent_step_id: string | null
  branch: 'main' | 'if_yes' | 'if_no'
}

interface CampaignLead {
  id: string
  campaign_id: string
  lead_id: string
  account_id: string
  status: CampaignLeadStatus
  current_step: number
  last_action_at: string | null
  reply_classification: ReplyClassification
}

interface Lead {
  id: string
  linkedin_url: string
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  about?: string | null
  experience_description?: string | null
  skills?: string[] | null
  recent_posts?: string[] | null
}

interface Account {
  id: string
  cookies: string
  proxy_id: string | null
  status: string
  daily_connection_count: number
  daily_message_count: number
  has_premium: boolean
  sender_name: string | null
  sender_headline: string | null
  sender_about: string | null
  sender_experience: string | null
  sender_skills: string[] | null
  sender_recent_posts: string[] | null
}

/**
 * Evaluate a fork condition against the current lead state.
 * Returns 'if_yes' or 'if_no' branch name.
 */
function evaluateFork(
  condition: Record<string, unknown>,
  leadStatus: CampaignLeadStatus,
  replyClassification: ReplyClassification,
  isConnected: boolean
): 'if_yes' | 'if_no' {
  const type = condition.type as string

  if (type === 'replied') {
    return replyClassification !== 'none' ? 'if_yes' : 'if_no'
  }
  if (type === 'not_replied') {
    return replyClassification === 'none' ? 'if_yes' : 'if_no'
  }
  if (type === 'connected') {
    return isConnected ? 'if_yes' : 'if_no'
  }
  if (type === 'not_connected') {
    return !isConnected ? 'if_yes' : 'if_no'
  }

  return 'if_yes'
}

/**
 * Resolve the next step for a campaign lead.
 * Traverses the sequence tree respecting parent_step_id / branch.
 */
function resolveNextStep(
  allSteps: SequenceStep[],
  currentStepOrder: number,
  currentParentId: string | null,
  currentBranch: 'main' | 'if_yes' | 'if_no'
): SequenceStep | null {
  // Find next step in the same branch / parent
  const siblings = allSteps
    .filter(s => s.parent_step_id === currentParentId && s.branch === currentBranch)
    .sort((a, b) => a.step_order - b.step_order)

  const nextSibling = siblings.find(s => s.step_order > currentStepOrder)
  return nextSibling ?? null
}

// ── Main worker handler ───────────────────────────────────────────────────────

async function runSequenceStep(campaignLeadId: string): Promise<void> {
  // 1. Load campaign lead
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select('*')
    .eq('id', campaignLeadId)
    .single()

  if (clErr || !cl) throw new Error(`CampaignLead ${campaignLeadId} not found`)

  const campaignLead = cl as CampaignLead

  if (campaignLead.status === 'stopped' || campaignLead.status === 'converted') return

  // 2. Load account
  const { data: acc, error: accErr } = await supabase
    .from('linkedin_accounts')
    .select('*')
    .eq('id', campaignLead.account_id)
    .single()

  if (accErr || !acc) throw new Error('Account not found')
  const account = acc as Account

  if (account.status !== 'active' && account.status !== 'warming_up') {
    console.log(`[runner] Account ${account.id} is ${account.status} — skipping`)
    return
  }

  if (!isWithinActiveHours()) {
    console.log('[runner] Outside active hours — skipping')
    return
  }

  // 3. Load lead
  const { data: lead } = await supabase
    .from('leads')
    .select('id, linkedin_url, first_name, last_name, title, company, about, experience_description, skills, recent_posts')
    .eq('id', campaignLead.lead_id)
    .single()

  if (!lead) throw new Error('Lead not found')
  const leadData = lead as Lead

  // 4. Load sequence
  const { data: sequences } = await supabase
    .from('sequences')
    .select('*, sequence_steps(*)')
    .eq('campaign_id', campaignLead.campaign_id)
    .limit(1)

  const sequence = sequences?.[0]
  if (!sequence) throw new Error('No sequence found for campaign')

  const allSteps = (sequence.sequence_steps as SequenceStep[]).sort(
    (a, b) => a.step_order - b.step_order
  )

  if (allSteps.length === 0) return

  // 5. Find current step
  // For a fresh lead (current_step = 0), start with the first root step
  let currentStep: SequenceStep
  if (campaignLead.current_step === 0) {
    const firstStep = allSteps.find(s => s.parent_step_id === null && s.branch === 'main')
    if (!firstStep) return
    currentStep = firstStep
  } else {
    const found = allSteps.find(s => s.step_order === campaignLead.current_step)
    if (!found) return
    currentStep = found
  }

  // 6. Check wait steps
  if (currentStep.type === 'wait') {
    const waitVal  = currentStep.wait_days ?? 1
    const waitUnit = (currentStep.condition?.wait_unit as string) ?? 'days'
    const waitMs   = waitUnit === 'minutes'
      ? waitVal * 60 * 1000
      : waitUnit === 'hours'
        ? waitVal * 60 * 60 * 1000
        : waitVal * 24 * 60 * 60 * 1000
    const lastAction = campaignLead.last_action_at ? new Date(campaignLead.last_action_at) : null
    if (lastAction) {
      const elapsed = Date.now() - lastAction.getTime()
      if (elapsed < waitMs) {
        const remaining = ((waitMs - elapsed) / 60000).toFixed(1)
        console.log(`[runner] Lead ${campaignLead.id} waiting — ${remaining} min remaining`)
        return
      }
    }
    // Wait is done — advance to next step and re-run
    const nextStep = resolveNextStep(
      allSteps, currentStep.step_order,
      currentStep.parent_step_id, currentStep.branch
    )
    if (!nextStep) return
    await supabase.from('campaign_leads').update({ current_step: nextStep.step_order }).eq('id', campaignLeadId)
    currentStep = nextStep
  }

  // 7. Acquire per-account lock then open browser
  const release = await acquireAccountLock(account.id)
  if (!release) {
    console.log(`[runner] Account ${account.id} locked by another worker — will retry`)
    throw new Error(`Account ${account.id} is currently in use — retrying`)
  }

  const { browser: _browser, context, page } = await getOrCreateBrowserSession(account)

  try {
    // 8. Handle fork — evaluate condition and route to branch
    if (currentStep.type === 'fork') {
      const isConnected = await checkConnectionStatus(page, leadData.linkedin_url, account.id) === 'connected'
      const branch = evaluateFork(
        currentStep.condition ?? {},
        campaignLead.status,
        campaignLead.reply_classification,
        isConnected
      )

      // Find first step in the chosen branch
      const branchSteps = allSteps
        .filter(s => s.parent_step_id === currentStep.id && s.branch === branch)
        .sort((a, b) => a.step_order - b.step_order)

      if (branchSteps.length > 0) {
        await supabase
          .from('campaign_leads')
          .update({ current_step: branchSteps[0].step_order })
          .eq('id', campaignLeadId)
      }

      await persistCookies(context, account.id)
      return
    }

    // 9. Execute the action step
    const tmpl = currentStep.message_template ?? ''

    // Generate AI opening line if template uses {{ai_opening}} or {{opening_line}}
    let aiOpening = ''
    if (tmpl.includes('{{ai_opening}}') || tmpl.includes('{{opening_line}}')) {
      try {
        const result = await personaliseOpeningLine({
          first_name:             leadData.first_name,
          last_name:              leadData.last_name,
          title:                  leadData.title ?? null,
          company:                leadData.company ?? null,
          industry:               null,
          about:                  leadData.about ?? null,
          experience_description: leadData.experience_description ?? null,
          skills:                 leadData.skills ?? undefined,
          recent_posts:           leadData.recent_posts ?? undefined,
        })
        aiOpening = result.opening_line
      } catch {
        aiOpening = `I came across your profile and was impressed by your work at ${leadData.company ?? 'your company'}`
      }
    }

    const personalised = personaliseTemplate(tmpl, {
      first_name:   leadData.first_name,
      last_name:    leadData.last_name,
      company:      leadData.company      ?? undefined,
      title:        leadData.title        ?? undefined,
      ai_opening:   aiOpening             || undefined,
      sender_name:  account.sender_name   ?? undefined,
    })

    let newStatus: CampaignLeadStatus | null = null

    switch (currentStep.type as StepType) {
      case 'view_profile':
        await viewProfile(page, leadData.linkedin_url, account.id)
        break

      case 'connect': {
        const allowed = await checkDailyLimit(account.id, 'connection', account.daily_connection_count, account.status)
        if (!allowed) throw new Error('Daily connection limit reached')
        await sendConnectionRequest(page, leadData.linkedin_url, account.id, personalised || null)
        newStatus = 'connection_sent'
        break
      }

      case 'message': {
        const allowed = await checkDailyLimit(account.id, 'message', 0, account.status)
        if (!allowed) throw new Error('Daily message limit reached')
        await sendMessage(page, leadData.linkedin_url, account.id, personalised)
        newStatus = 'messaged'
        break
      }

      case 'inmail': {
        if (!account.has_premium) throw new Error('Account does not have LinkedIn Premium')
        await sendInMail(
          page, leadData.linkedin_url, account.id,
          currentStep.subject ?? '(no subject)',
          personalised
        )
        newStatus = 'messaged'
        break
      }

      case 'react_post': {
        const reaction = (currentStep.condition?.reaction as ReactionType) ?? 'like'
        await reactToPost(page, leadData.linkedin_url, account.id, reaction)
        break
      }

      case 'follow':
        await followProfile(page, leadData.linkedin_url, account.id)
        break

      case 'end':
        // Explicitly end the sequence for this lead
        await supabase
          .from('campaign_leads')
          .update({ status: 'stopped', last_action_at: new Date().toISOString() })
          .eq('id', campaignLeadId)
        await persistCookies(context, account.id)
        return
    }

    // 10. Advance to next step
    const nextStep = resolveNextStep(
      allSteps, currentStep.step_order,
      currentStep.parent_step_id, currentStep.branch
    )

    const update: Record<string, unknown> = {
      current_step:   nextStep?.step_order ?? currentStep.step_order,
      last_action_at: new Date().toISOString(),
    }
    if (newStatus) update.status = newStatus

    await supabase.from('campaign_leads').update(update).eq('id', campaignLeadId)

    // 11. Save cookies
    await persistCookies(context, account.id)

    // 12. Random human delay before next job
    await randomDelay()

    console.log(
      `[runner] ${currentStep.type} done for lead ${leadData.first_name} ${leadData.last_name}`
    )
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('SESSION_EXPIRED')) {
      // Mark paused immediately so the UI reflects the broken state.
      try { await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account.id) } catch {}
      // Trigger background reconnect and defer this step so reconnect can finish first
      invalidateBrowserSession(account.id)
      console.warn(`[runner] Session expired for ${account.id} — pausing account, deferring step 3min for reconnect`)
      try {
        await supabase
          .from('campaign_leads')
          .update({ next_action_at: new Date(Date.now() + 3 * 60 * 1000).toISOString() })
          .eq('id', campaignLeadId)
      } catch { /* non-fatal — scheduler will retry */ }
      // Don't rethrow — scheduler will re-queue from next_action_at
      return
    }
    if (msg.includes('SECURITY_CHALLENGE')) {
      invalidateBrowserSession(account.id)
    }
    throw err
  } finally {
    await release()
  }
}

export const sequenceRunnerWorker = new Worker<RunJob>(
  'sequence-runner',
  async job => {
    await runSequenceStep(job.data.campaign_lead_id)
  },
  {
    connection,
    concurrency: 3,   // max 3 accounts running in parallel
    limiter: { max: 1, duration: 30_000 },
  }
)

sequenceRunnerWorker.on('failed', (job, err) => {
  const msg = err.message ?? ''
  // Pause account on security challenges
  if (msg.startsWith('SECURITY_CHALLENGE')) {
    console.error(`[runner] Security challenge detected — account paused`)
  } else {
    console.error(`[runner] Job ${job?.id} failed:`, msg)
  }
})

console.log('Sequence runner worker started')
