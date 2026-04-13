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
import { getOrCreateBrowserSession } from '../lib/browserPool'
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
import {
  generateSequenceMessage,
} from '../ai/generate-sequence-message'
import type {
  LeadContext,
  ProductContext,
  SenderContext as AiSenderContext,
} from '../ai/generate-sequence-message'
import type {
  CampaignLeadStatus,
  StepType,
  ReactionType,
  ReplyClassification,
} from '../types'

// ── AI context loader ─────────────────────────────────────────────────────────

interface CampaignAiContext {
  product: ProductContext | null
  sender: AiSenderContext | null
  icpNotes: string | undefined
  approach: string | null
  tone: string | null
}

async function loadCampaignAiContext(
  campaignId: string,
  userId: string,
  accountId: string
): Promise<CampaignAiContext> {
  // Load campaign ICP config for approach/tone/product
  const { data: camp } = await supabase
    .from('campaigns')
    .select('product_id, icp_config')
    .eq('id', campaignId)
    .single()

  const icp = (camp as any)?.icp_config as Record<string, unknown> | null
  const approach = (icp?.message_approach as string) ?? null
  const tone     = (icp?.message_tone     as string) ?? null
  const productId = (camp as any)?.product_id
    ?? (icp?.selected_product_ids as string[] | undefined)?.[0]
    ?? null

  // Load product from user_settings
  let product: ProductContext | null = null
  if (productId) {
    const { data: settings } = await supabase
      .from('user_settings')
      .select('icp_config')
      .eq('user_id', userId)
      .single()
    const cfg = (settings as any)?.icp_config as { products_services?: Array<{ id: string } & ProductContext> } | null
    product = cfg?.products_services?.find(p => p.id === productId) ?? null
  }

  // Load ICP notes
  const { data: settingsForNotes } = await supabase
    .from('user_settings')
    .select('icp_config')
    .eq('user_id', userId)
    .single()
  const icpNotes = ((settingsForNotes as any)?.icp_config as { notes?: string } | null)?.notes ?? undefined

  // Load sender context
  let sender: AiSenderContext | null = null
  const { data: acc } = await supabase
    .from('linkedin_accounts')
    .select('sender_name, sender_headline, sender_about, sender_experience, sender_skills, sender_recent_posts')
    .eq('id', accountId)
    .single()
  if (acc && (acc as any).sender_name) {
    sender = {
      name:         (acc as any).sender_name         as string,
      headline:     (acc as any).sender_headline     as string | null,
      about:        (acc as any).sender_about        as string | null,
      experience:   (acc as any).sender_experience   as string | null,
      skills:       (acc as any).sender_skills       as string[] | undefined,
      recent_posts: (acc as any).sender_recent_posts as string[] | undefined,
    }
  }

  return { product, sender, icpNotes, approach, tone }
}

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

/** Check daily limits for an account. Respects warmup ramp for warming_up accounts.
 *
 * Counts today's completed actions from activity_log — NOT from campaign_lead.status.
 * campaign_lead.status changes as connections get accepted ('connection_sent' → 'connected')
 * so counting by status would undercount the real number of actions taken today.
 * activity_log has one entry per action regardless of subsequent status changes.
 */
async function checkDailyLimit(
  accountId: string,
  type: 'connection' | 'message',
  warmupDay = 0,
  accountStatus = 'active'
): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)

  // 'connect' step → connection sent.  'message' or 'inmail' step → message sent.
  const actions = type === 'connection' ? ['connect'] : ['message', 'inmail']

  const { count } = await supabase
    .from('activity_log')
    .select('*', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .in('action', actions)
    .gte('created_at', `${today}T00:00:00Z`)

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
 * Evaluate a fork condition purely from the lead's DB state.
 * Returns 'if_yes' or 'if_no' branch name.
 *
 * connected condition  → lead status shows they accepted the connection request
 * replied   condition  → lead has sent a reply (reply_classification set, or status=replied)
 */
function evaluateFork(
  condition: Record<string, unknown>,
  campaignLead: { status: CampaignLeadStatus; reply_classification: ReplyClassification }
): 'if_yes' | 'if_no' {
  const type = condition.type as string
  const { status, reply_classification } = campaignLead

  // A lead is "connected" once they accepted — these statuses all imply that happened
  const isConnected = ['connected', 'messaged', 'replied', 'converted'].includes(status)

  // A lead has "replied" if their reply was classified or their status tracks it
  const hasReplied = reply_classification !== 'none' || status === 'replied'

  if (type === 'replied')     return hasReplied   ? 'if_yes' : 'if_no'
  if (type === 'not_replied') return !hasReplied  ? 'if_yes' : 'if_no'
  if (type === 'connected')   return isConnected  ? 'if_yes' : 'if_no'
  if (type === 'not_connected') return !isConnected ? 'if_yes' : 'if_no'

  return 'if_yes'
}

/**
 * Resolve the next step for a campaign lead.
 *
 * Traverses the sequence tree respecting parent_step_id / branch.
 * When a branch (if_yes / if_no) is exhausted, automatically continues
 * with the step that follows the parent fork node in the outer sequence —
 * so leads never get stuck at the end of a branch.
 */
function resolveNextStep(
  allSteps: SequenceStep[],
  currentStepOrder: number,
  currentParentId: string | null,
  currentBranch: 'main' | 'if_yes' | 'if_no'
): SequenceStep | null {
  // Find next sibling in the same branch / parent
  const siblings = allSteps
    .filter(s => s.parent_step_id === currentParentId && s.branch === currentBranch)
    .sort((a, b) => a.step_order - b.step_order)

  const nextSibling = siblings.find(s => s.step_order > currentStepOrder)
  if (nextSibling) return nextSibling

  // Branch exhausted — walk up to the parent fork and continue from there
  if (currentParentId !== null) {
    const parentFork = allSteps.find(s => s.id === currentParentId)
    if (parentFork) {
      return resolveNextStep(
        allSteps,
        parentFork.step_order,
        parentFork.parent_step_id,
        parentFork.branch
      )
    }
  }

  return null
}

/**
 * Find the next meaningful step after currentStep, skipping waits and forks.
 * Returns the step type string, or 'end' if an end step follows, or null if nothing.
 */
function resolveNextMeaningfulStepType(
  allSteps: SequenceStep[],
  currentStep: SequenceStep
): string | null {
  const SKIP_TYPES = new Set(['wait', 'fork'])
  let step: SequenceStep | null = currentStep
  // Walk siblings in the same branch, skipping wait/fork
  while (step) {
    const next = resolveNextStep(allSteps, step.step_order, step.parent_step_id, step.branch)
    if (!next) return null
    if (!SKIP_TYPES.has(next.type)) return next.type
    step = next
  }
  return null
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

  // 7. Playwright routing — always use Playwright for all actions
  const via = 'playwright'
  console.log(`[runner] ${currentStep.type} for lead ${leadData.first_name} → PLAYWRIGHT`)

  let context: Awaited<ReturnType<typeof getOrCreateBrowserSession>>['context'] | null = null
  let page:    Awaited<ReturnType<typeof getOrCreateBrowserSession>>['page']    | null = null
  let release: (() => Promise<void>) | null = null

  const STEP_LOCK_TTL = 5 * 60  // 5 minutes
  release = await acquireAccountLock(account.id, STEP_LOCK_TTL)
  if (!release) {
    console.log(`[runner] Account ${account.id} locked by another worker — will retry`)
    throw new Error(`Account ${account.id} is currently in use — retrying`)
  }
  const session = await getOrCreateBrowserSession(account)
  context = session.context
  page    = session.page

  try {
    // 8. Handle fork — evaluate condition and route to branch
    if (currentStep.type === 'fork') {
      const conditionType = (currentStep.condition?.type as string) ?? ''

      // For connection forks: DB status is authoritative when the lead has clearly
      // progressed past connection. When status is still pending/connection_sent we
      // don't know yet — do a live Playwright check and update DB so future steps
      // don't have to repeat the check.
      if (
        (conditionType === 'connected' || conditionType === 'not_connected') &&
        (campaignLead.status === 'pending' || campaignLead.status === 'connection_sent')
      ) {
        const liveStatus = page
          ? await checkConnectionStatus(page, leadData.linkedin_url, account.id)
          : 'not_connected'
        if (liveStatus === 'connected') {
          console.log(`[runner] Fork live-check: lead ${campaignLeadId} is connected on LinkedIn — updating DB`)
          await supabase.from('campaign_leads').update({ status: 'connected' }).eq('id', campaignLeadId)
          campaignLead.status = 'connected'   // update local so evaluateFork sees it
        }
      }

      const branch = evaluateFork(currentStep.condition ?? {}, campaignLead)

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

    // Guard: if this is a message/connect step with no template and no AI mode, skip and warn
    // rather than hanging Playwright trying to send an empty message.
    // IMPORTANT: advance current_step so the lead doesn't get stuck here indefinitely.
    if ((currentStep.type === 'message' || currentStep.type === 'connect')
        && tmpl.trim() === ''
        && !currentStep.ai_generation_mode) {
      console.warn(`[runner] Step ${currentStep.id} (${currentStep.type}) has no message_template — skipping lead ${leadData.first_name}. Add a template in the Sequence Builder.`)
      const skipNext = resolveNextStep(allSteps, currentStep.step_order, currentStep.parent_step_id, currentStep.branch)
      if (skipNext) {
        await supabase.from('campaign_leads').update({ current_step: skipNext.step_order }).eq('id', campaignLeadId)
      }
      if (context) await persistCookies(context, account.id)
      return
    }

    // AI-generation mode: generate a fully personalised message per-lead using Claude
    let aiGeneratedMessage = ''
    if ((currentStep.type === 'message' || currentStep.type === 'connect' || currentStep.type === 'inmail')
        && currentStep.ai_generation_mode
        && tmpl.trim() === '') {
      try {
        console.log(`[runner] AI mode — generating message for ${leadData.first_name} (${currentStep.type})`)
        const ctx = await loadCampaignAiContext(campaignLead.campaign_id, account.user_id, account.id)
        if (!ctx.product) {
          console.warn(`[runner] AI mode — no product found for campaign ${campaignLead.campaign_id}, falling back to generic`)
        }

        // Load the full message thread for this lead so the AI can reference prior messages
        // and avoid repeating hooks, CTAs, or angles already used.
        const { data: priorMsgs } = await supabase
          .from('messages')
          .select('direction, content, step_id')
          .eq('campaign_lead_id', campaignLead.id)
          .order('created_at', { ascending: true })

        const priorMessages = (priorMsgs ?? []).map(m => {
          // Look up the step type for sent messages so the AI knows what it was
          const stepType = m.step_id
            ? allSteps.find(s => s.id === m.step_id)?.type ?? undefined
            : undefined
          return {
            direction: m.direction as 'sent' | 'received',
            content:   m.content as string,
            step_type: stepType,
          }
        })

        // Compute position: count message-type steps that have already been sent
        const sentStepCount = priorMessages.filter(m => m.direction === 'sent').length
        const positionInSequence = sentStepCount + 1

        const leadCtx: LeadContext = {
          first_name:             leadData.first_name,
          last_name:              leadData.last_name,
          title:                  leadData.title ?? null,
          company:                leadData.company ?? null,
          industry:               null,
          about:                  leadData.about ?? null,
          experience_description: leadData.experience_description ?? null,
          skills:                 leadData.skills ?? undefined,
          recent_posts:           leadData.recent_posts ?? undefined,
        }
        const nextStepType = resolveNextMeaningfulStepType(allSteps, currentStep)

        const result = await generateSequenceMessage({
          step_type:            currentStep.type as 'connect' | 'message' | 'inmail',
          position_in_sequence: positionInSequence,
          product:              ctx.product ?? { name: 'our product' },
          sender:               ctx.sender,
          lead:                 leadCtx,
          prior_messages:       priorMessages,
          icp_notes:            ctx.icpNotes,
          resolve_variables:    true,
          approach:             ctx.approach,
          tone:                 ctx.tone,
          next_step_type:       nextStepType,
        })
        aiGeneratedMessage = result.body
        console.log(`[runner] AI message generated for ${leadData.first_name} (pos ${positionInSequence}, ${priorMessages.length} prior msgs): "${aiGeneratedMessage.slice(0, 80)}..."`)
      } catch (aiErr) {
        console.error(`[runner] AI message generation failed for ${leadData.first_name}:`, (aiErr as Error).message)
        if (context) await persistCookies(context, account.id)
        // Throw so BullMQ retries with backoff instead of silently hanging the lead.
        // With attempts:3 + backoff:60s, this retries up to 3 times before giving up.
        throw aiErr
      }
    }

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

    // Use AI-generated message if available, otherwise personalise the template
    const personalised = aiGeneratedMessage || personaliseTemplate(tmpl, {
      first_name:   leadData.first_name,
      last_name:    leadData.last_name,
      company:      leadData.company      ?? undefined,
      title:        leadData.title        ?? undefined,
      ai_opening:   aiOpening             || undefined,
      sender_name:  account.sender_name   ?? undefined,
    })

    let newStatus: CampaignLeadStatus | null = null

    {
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
          // Update the lead's URL so future actions go directly to the right profile.
          // Awaited so the next scheduler cycle sees the resolved URL immediately.
          const { error: urlErr } = await supabase.from('leads').update({ linkedin_url: resolved }).eq('id', leadData.id)
          if (urlErr) console.warn('[runner] lead URL update failed:', urlErr.message)
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
          try {
            await sendConnectionRequest(page, effectiveUrl, account.id, personalised || null)
            newStatus = 'connection_sent'
          } catch (connectErr) {
            const connectMsg = (connectErr as Error).message
            if (connectMsg === 'ALREADY_CONNECTED') {
              // Lead is already a 1st-degree connection — mark connected and advance
              console.log(`[runner] Lead ${campaignLeadId} already connected — marking connected`)
              newStatus = 'connected'
            } else if (connectMsg === 'CONNECTION_PENDING') {
              // Connection request already sent in a previous run — treat as sent
              console.log(`[runner] Lead ${campaignLeadId} connection already pending — marking connection_sent`)
              newStatus = 'connection_sent'
            } else if (connectMsg === 'FOLLOW_ONLY_PROFILE') {
              // Profile only allows following, not connecting — advance without changing status
              console.log(`[runner] Lead ${campaignLeadId} is follow-only — advancing step without connection`)
              // Don't set newStatus — leave as 'pending'; advance the step below
            } else {
              throw connectErr
            }
          }
          break
        }

        case 'message': {
          const allowed = await checkDailyLimit(account.id, 'message', 0, account.status)
          if (!allowed) throw new Error('Daily message limit reached')

          // If the DB status is still 'connection_sent', check the ACTUAL LinkedIn
          // connection status. The connection request may have been accepted since
          // we last checked — navigating to the profile is the only way to know.
          if (campaignLead.status === 'pending' || campaignLead.status === 'connection_sent') {
            const liveStatus = await checkConnectionStatus(page, effectiveUrl, account.id)
            if (liveStatus !== 'connected') {
              console.log(`[runner] message step skipped — lead ${campaignLead.id} is ${liveStatus} on LinkedIn (DB: ${campaignLead.status})`)
              // Persist fresh cookies before returning so we don't waste the browser navigation
              if (context) await persistCookies(context, account.id)
              return
            }
            // Connection was accepted — update DB status before sending
            console.log(`[runner] Lead ${campaignLead.id} connection accepted — updating to connected`)
            await supabase.from('campaign_leads').update({ status: 'connected' }).eq('id', campaignLeadId)
          }

          await sendMessage(page, effectiveUrl, account.id, personalised)
          newStatus = 'messaged'
          // Awaited — message was already sent on LinkedIn so we never throw on insert failure,
          // but we do log loudly so it can be caught in monitoring.
          const { error: msgErr } = await supabase.from('messages').insert({
            campaign_lead_id: campaignLeadId,
            direction: 'sent',
            content: personalised,
            sent_at: new Date().toISOString(),
            step_id: currentStep.id,
          })
          if (msgErr) console.warn('[runner] messages insert failed — message was sent but not recorded:', msgErr.message)
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
          const { error: inmailMsgErr } = await supabase.from('messages').insert({
            campaign_lead_id: campaignLeadId,
            direction: 'sent',
            content: personalised,
            sent_at: new Date().toISOString(),
            step_id: currentStep.id,
          })
          if (inmailMsgErr) console.warn('[runner] messages insert (inmail) failed — message was sent but not recorded:', inmailMsgErr.message)
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
          await followProfile(page, effectiveUrl, account.id)
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

    // 10. Log activity — MUST be awaited before step advance so that checkDailyLimit
    // (which counts activity_log rows) sees this action in the same cycle.
    const { error: logErr } = await supabase.from('activity_log').insert({
      user_id:     account.user_id,
      account_id:  account.id,
      campaign_id: campaignLead.campaign_id,
      lead_id:     campaignLead.lead_id,
      action:      currentStep.type,
      detail:      `${leadData.first_name} ${leadData.last_name}${leadData.company ? ` · ${leadData.company}` : ''}`,
    })
    if (logErr) console.warn('[runner] activity_log insert failed:', logErr.message)

    // 11. Advance to next step
    const nextStep = resolveNextStep(
      allSteps, currentStep.step_order,
      currentStep.parent_step_id, currentStep.branch
    )

    const update: Record<string, unknown> = {
      current_step:    nextStep?.step_order ?? currentStep.step_order,
      last_action_at:  new Date().toISOString(),
    }
    if (newStatus) update.status = newStatus

    await supabase.from('campaign_leads').update(update).eq('id', campaignLeadId)

    // 12. Save cookies (only when Playwright was used)
    if (context) await persistCookies(context, account.id)

    // 12. Random human delay before next job
    await randomDelay()

    console.log(
      `[runner] ${currentStep.type} done for lead ${leadData.first_name} ${leadData.last_name}`
    )
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('SESSION_EXPIRED')) {
      // Mark paused so the UI reflects the broken state.
      // DO NOT call invalidateBrowserSession — that triggers a background reconnect which
      // opens a new browser, causing LinkedIn to send "new device login" notifications.
      // The user should manually refresh the session via Accounts → Set Session.
      try { await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account.id) } catch {}
      console.warn(`[runner] Session expired for ${account.id} — pausing account. Refresh via Accounts → Set Session.`)
      // Log session expiry to activity feed
      try { await supabase.from('activity_log').insert({
        user_id: account.user_id, account_id: account.id,
        campaign_id: campaignLead.campaign_id, lead_id: campaignLead.lead_id,
        action: 'session_expired',
        detail: `Account paused — session expired. Re-activate via Accounts → Set Session.`,
      }) } catch {}
      return
    }
    if (msg.includes('SECURITY_CHALLENGE')) {
      // Same: pause but don't reconnect — let the user handle the security challenge manually.
      console.warn(`[runner] Security challenge for ${account.id} — account paused. Handle challenge manually then re-activate.`)
      // Log security challenge to activity feed
      try { await supabase.from('activity_log').insert({
        user_id: account.user_id, account_id: account.id,
        campaign_id: campaignLead.campaign_id, lead_id: campaignLead.lead_id,
        action: 'security_challenge',
        detail: `Account paused — LinkedIn security challenge. Handle it manually then re-activate.`,
      }) } catch {}
    }

    // Log non-retryable failures to activity feed so they appear in the UI.
    // Skip "currently in use" — those are lock-contention retries, not real failures.
    const isLockContention = msg.includes('currently in use')
    if (!isLockContention) {
      const stepLabel = currentStep?.type ?? 'step'
      const leadLabel = leadData ? `${leadData.first_name} ${leadData.last_name}` : 'lead'
      const shortMsg  = msg.replace(/^[A-Z_]+:\s*/, '').slice(0, 140)  // strip error prefix, trim
      try { await supabase.from('activity_log').insert({
        user_id:    account.user_id,
        account_id: account.id,
        campaign_id: campaignLead.campaign_id,
        lead_id:    campaignLead.lead_id,
        action:     'failed',
        detail:     `${stepLabel} for ${leadLabel} — ${shortMsg}`,
      }) } catch {}
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
  // Failed jobs are removed from queue (removeOnFail: true) so the scheduler
  // can re-add them on the next cycle. No DB update needed here.
})

console.log('Sequence runner worker started')
