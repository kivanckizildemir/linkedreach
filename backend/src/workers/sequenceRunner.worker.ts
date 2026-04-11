/**
 * Sequence Runner Worker
 *
 * Picks up pending campaign leads, evaluates their next sequence step,
 * executes it via Playwright, and advances their position in the sequence.
 *
 * Enqueue jobs via sequenceRunnerQueue.add('run', { campaign_lead_id })
 */

import { Worker } from 'bullmq'
import { randomUUID } from 'crypto'
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
  resolveSalesNavUrl,
} from '../linkedin/actions'
import { warmupConnectionLimit } from './warmup.worker'
import { personaliseOpeningLine } from '../ai/personalise'
import { isExtensionOnline, sendActionToExtension, type ExtensionJob } from '../lib/extensionHub'
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

function isWithinActiveHours(timezone = 'Europe/London', startHour = 7, endHour = 23): boolean {
  const now = new Date()
  const hour = parseInt(
    now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }),
    10
  )
  return hour >= startHour && hour < endHour
}

function randomDelay(): Promise<void> {
  const ms = 8_000 + Math.random() * 22_000   // 8–30 s
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
  ai_generation_mode: boolean | null
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
  user_id: string
  cookies: string
  proxy_id: string | null
  status: string
  warmup_day: number | null
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

  if (campaignLead.status === 'stopped' || campaignLead.status === 'converted') {
    console.log(`[runner] Lead ${campaignLeadId} is ${campaignLead.status} — skipping`)
    return
  }

  // 2. Load campaign + account
  const { data: camp } = await supabase
    .from('campaigns')
    .select('account_id, schedule_start_hour, schedule_end_hour, schedule_timezone')
    .eq('id', campaignLead.campaign_id)
    .single()

  let resolvedAccountId = campaignLead.account_id ?? (camp as { account_id: string | null } | null)?.account_id ?? null

  if (!resolvedAccountId) throw new Error('No account assigned to this campaign lead or campaign')

  const { data: acc, error: accErr } = await supabase
    .from('linkedin_accounts')
    .select('*')
    .eq('id', resolvedAccountId)
    .single()

  if (accErr || !acc) throw new Error('Account not found')
  const account = acc as Account

  if (account.status !== 'active' && account.status !== 'warming_up') {
    console.log(`[runner] Account ${account.id} is ${account.status} — skipping`)
    return
  }

  // Use the campaign's own schedule window (not the hardcoded 7–23 default)
  const campSchedule = camp as { schedule_start_hour: number; schedule_end_hour: number; schedule_timezone: string } | null
  const startHour = campSchedule?.schedule_start_hour ?? 7
  const endHour   = campSchedule?.schedule_end_hour   ?? 23
  const tz        = campSchedule?.schedule_timezone   ?? 'Europe/London'
  if (!isWithinActiveHours(tz, startHour, endHour)) {
    console.log(`[runner] Outside active hours (${startHour}–${endHour} ${tz}) — skipping`)
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

  // 7. Extension-first routing — check if account owner has extension connected
  const useExtension = isExtensionOnline(account.user_id)
  const via = useExtension ? 'extension' : 'playwright'
  console.log(`[runner] ${currentStep.type} for lead ${leadData.first_name} → ${via.toUpperCase()}`)

  // For fork steps and inmail we always need Playwright.
  // For all other action steps, extension handles it entirely.
  const needsPlaywright = !useExtension || currentStep.type === 'fork' || currentStep.type === 'inmail'

  let context: Awaited<ReturnType<typeof getOrCreateBrowserSession>>['context'] | null = null
  let page:    Awaited<ReturnType<typeof getOrCreateBrowserSession>>['page']    | null = null
  let release: (() => Promise<void>) | null = null

  // Use a short TTL — sequence steps take at most 3 minutes. A 30-min TTL
  // causes long idle periods when a worker is killed before releasing the lock.
  const STEP_LOCK_TTL = 5 * 60  // 5 minutes
  if (needsPlaywright) {
    release = await acquireAccountLock(account.id, STEP_LOCK_TTL)
    if (!release) {
      console.log(`[runner] Account ${account.id} locked by another worker — will retry`)
      throw new Error(`Account ${account.id} is currently in use — retrying`)
    }
    const session = await getOrCreateBrowserSession(account)
    context = session.context
    page    = session.page
  } else {
    // Still acquire the lock to serialise per-account actions (no Playwright needed)
    release = await acquireAccountLock(account.id, STEP_LOCK_TTL)
    if (!release) {
      console.log(`[runner] Account ${account.id} locked by another worker — will retry`)
      throw new Error(`Account ${account.id} is currently in use — retrying`)
    }
  }

  try {
    // 8. Handle fork — evaluate condition and route to branch
    if (currentStep.type === 'fork') {
      const isConnected = page
        ? await checkConnectionStatus(page, leadData.linkedin_url, account.id) === 'connected'
        : false   // fallback: assume not connected when no browser
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

      if (context) await persistCookies(context, account.id)
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

    // ── Extension path ────────────────────────────────────────────────────────
    if (useExtension && currentStep.type !== 'inmail') {
      const supportedByExtension: StepType[] = ['view_profile', 'connect', 'message', 'follow', 'react_post']

      if ((supportedByExtension as string[]).includes(currentStep.type)) {
        // Daily limit checks (still enforced server-side)
        if (currentStep.type === 'connect') {
          const allowed = await checkDailyLimit(account.id, 'connection', account.warmup_day ?? 0, account.status)
          if (!allowed) { console.log(`[runner] Connection cap reached — skipping`); return }
        }
        if (currentStep.type === 'message') {
          const allowed = await checkDailyLimit(account.id, 'message', 0, account.status)
          if (!allowed) { console.log(`[runner] Message cap reached — skipping`); return }
        }

        const extJob: ExtensionJob = {
          jobId:      randomUUID(),
          action:     currentStep.type as ExtensionJob['action'],
          accountId:  account.id,
          profileUrl: leadData.linkedin_url,
          note:       currentStep.type === 'connect' ? (personalised || undefined) : undefined,
          message:    currentStep.type === 'message' ? personalised : undefined,
          reaction:   currentStep.type === 'react_post'
            ? (currentStep.ai_generation_mode
                ? (['like', 'celebrate', 'insightful'] as const)[Math.floor(Math.random() * 3)]
                : ((currentStep.condition?.reaction as string) ?? 'like'))
            : undefined,
        }

        const extResult = await sendActionToExtension(account.user_id, extJob)
        const res = extResult as { warning?: boolean; captcha?: boolean } | null

        // Pause account if LinkedIn signals a problem
        if (res?.warning || res?.captcha) {
          await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account.id)
          throw new Error('LinkedIn warning/captcha detected — account paused')
        }

        if (currentStep.type === 'connect') newStatus = 'connection_sent'
        if (currentStep.type === 'message') newStatus = 'messaged'

        // Log activity
        await supabase.from('activity_log').insert({
          user_id:     account.user_id,
          account_id:  account.id,
          campaign_id: campaignLead.campaign_id,
          lead_id:     campaignLead.lead_id,
          action:      currentStep.type,
          detail:      `${leadData.first_name} ${leadData.last_name}${leadData.company ? ` · ${leadData.company}` : ''}`,
        }).then(({ error }) => { if (error) console.warn('[runner] activity_log insert failed:', error.message) })

      } else if (currentStep.type === 'end') {
        await supabase
          .from('campaign_leads')
          .update({ status: 'stopped', last_action_at: new Date().toISOString() })
          .eq('id', campaignLeadId)
        return
      }

    // ── Playwright path ───────────────────────────────────────────────────────
    } else {
      if (!page) throw new Error('Playwright page not initialised')

      // Resolve Sales Nav URLs → real /in/ URL via three-dot → "View LinkedIn profile".
      // This ensures we always act on the person's actual LinkedIn profile, not the
      // Sales Nav entity (which can map to different people across sessions).
      let effectiveUrl = leadData.linkedin_url
      if (
        leadData.linkedin_url.includes('/sales/lead/') ||
        leadData.linkedin_url.includes('/sales/people/')
      ) {
        const resolved = await resolveSalesNavUrl(page, leadData.linkedin_url, account.id)
        if (resolved) {
          effectiveUrl = resolved
          console.log(`[runner] Resolved Sales Nav for ${leadData.first_name}: ${resolved}`)
          // Update the lead's URL so future actions go directly to the right profile
          supabase.from('leads').update({ linkedin_url: resolved }).eq('id', leadData.id)
            .then(({ error }) => { if (error) console.warn('[runner] lead URL update failed:', error.message) })
        } else {
          console.log(`[runner] Could not resolve Sales Nav URL for ${leadData.first_name} — proceeding with original`)
        }
      }

      switch (currentStep.type as StepType) {
        case 'view_profile':
          await viewProfile(page, effectiveUrl, account.id)
          break

        case 'connect': {
          const allowed = await checkDailyLimit(account.id, 'connection', account.warmup_day ?? 0, account.status)
          if (!allowed) throw new Error('Daily connection limit reached')
          await sendConnectionRequest(page, effectiveUrl, account.id, personalised || null)
          newStatus = 'connection_sent'
          break
        }

        case 'message': {
          const allowed = await checkDailyLimit(account.id, 'message', 0, account.status)
          if (!allowed) throw new Error('Daily message limit reached')
          await sendMessage(page, effectiveUrl, account.id, personalised)
          newStatus = 'messaged'
          supabase.from('messages').insert({
            campaign_lead_id: campaignLeadId,
            direction: 'sent',
            content: personalised,
            sent_at: new Date().toISOString(),
          }).then(({ error }) => { if (error) console.warn('[runner] messages insert failed:', error.message) })
          break
        }

        case 'inmail': {
          if (!account.has_premium) throw new Error('Account does not have LinkedIn Premium')
          await sendInMail(
            page, effectiveUrl, account.id,
            currentStep.subject ?? '(no subject)',
            personalised
          )
          newStatus = 'messaged'
          supabase.from('messages').insert({
            campaign_lead_id: campaignLeadId,
            direction: 'sent',
            content: personalised,
            sent_at: new Date().toISOString(),
          }).then(({ error }) => { if (error) console.warn('[runner] messages insert failed:', error.message) })
          break
        }

        case 'react_post': {
          let reaction: ReactionType
          if (currentStep.ai_generation_mode) {
            const aiPool: ReactionType[] = ['like', 'celebrate', 'insightful']
            reaction = aiPool[Math.floor(Math.random() * aiPool.length)]
          } else {
            reaction = (currentStep.condition?.reaction as ReactionType) ?? 'like'
          }
          try {
            await reactToPost(page, effectiveUrl, account.id, reaction)
          } catch (err) {
            const msg = (err as Error).message ?? ''
            if (msg.includes('No post found')) {
              console.log(`[runner] react_post: no posts found for lead ${effectiveUrl} — skipping step`)
            } else {
              throw err
            }
          }
          break
        }

        case 'follow':
          await followProfile(page, leadData.linkedin_url, account.id)
          break

        case 'end':
          await supabase
            .from('campaign_leads')
            .update({ status: 'stopped', last_action_at: new Date().toISOString() })
            .eq('id', campaignLeadId)
          if (context) await persistCookies(context, account.id)
          return
      }
    }

    // 10. Log activity (Playwright path — extension path logs above)
    if (via !== 'extension') {
      await supabase.from('activity_log').insert({
        user_id:     account.user_id,
        account_id:  account.id,
        campaign_id: campaignLead.campaign_id,
        lead_id:     campaignLead.lead_id,
        action:      currentStep.type,
        detail:      `${leadData.first_name} ${leadData.last_name}${leadData.company ? ` · ${leadData.company}` : ''}`,
      }).then(({ error }) => { if (error) console.warn('[runner] activity_log insert failed:', error.message) })
    }

    // 11. Advance to next step
    const nextStep = resolveNextStep(
      allSteps, currentStep.step_order,
      currentStep.parent_step_id, currentStep.branch
    )

    const update: Record<string, unknown> = {
      current_step:    nextStep?.step_order ?? currentStep.step_order,
      last_action_at:  new Date().toISOString(),
      next_action_at:  null,  // clear any failure backoff
    }
    if (newStatus) update.status = newStatus

    await supabase.from('campaign_leads').update(update).eq('id', campaignLeadId)

    // 12. Save cookies (only when Playwright was used)
    if (context) await persistCookies(context, account.id)

    // 12. Random human delay before next job
    await randomDelay()

    console.log(
      `[runner] ${currentStep.type} done for lead ${leadData.first_name} ${leadData.last_name} (via ${via})`
    )
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('SESSION_EXPIRED')) {
      // Mark paused immediately so the UI reflects the broken state.
      try { await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account.id) } catch {}
      // Trigger background reconnect and defer this step so reconnect can finish first
      if (page) invalidateBrowserSession(account.id)
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
      if (page) invalidateBrowserSession(account.id)
    }
    throw err
  } finally {
    if (release) await release()
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
  }
)

sequenceRunnerWorker.on('failed', async (job, err) => {
  const msg = err.message ?? ''
  if (msg.startsWith('SECURITY_CHALLENGE')) {
    console.error(`[runner] Security challenge detected — account paused`)
  } else {
    console.error(`[runner] Job ${job?.id} failed:`, msg)
  }
  // Back off this lead for 5 minutes so cold leads get a chance to run.
  // Without this, failed warm leads (high ICP priority) would monopolise the queue.
  if (job?.data?.campaign_lead_id) {
    const nextRetry = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    try {
      await supabase.from('campaign_leads')
        .update({ next_action_at: nextRetry })
        .eq('id', job.data.campaign_lead_id)
    } catch { /* non-fatal */ }
  }
})

console.log('Sequence runner worker started')
