/**
 * Reply Agent Worker
 *
 * Handles the Agent Mode loop for leads who have replied.
 * When a lead replies and the campaign has agent_mode_settings.enabled = true,
 * the inbox poller enqueues a job here instead of letting the scheduled
 * sequence continue.
 *
 * Flow:
 *  1. Load lead, campaign_lead, campaign, account
 *  2. Analyze the reply (warmth, tone, length, intent, meeting interest, location)
 *  3. Update warmth_score + warmth_flag on campaign_leads
 *  4. If not_interested → apply configured action (pause or end), stop
 *  5. Determine if a meeting CTA should be injected
 *     - meeting_interest_detected OR warmth >= threshold → propose meeting
 *     - face-to-face: check lead location against f2f_location_mode + f2f_locations
 *     - If lead hasn't mentioned their location yet and f2f is possible → ask for it first
 *  6. Build message overrides (tone / length / approach matching)
 *  7. Generate personalised reply via generateSequenceMessage
 *  8. Wait configurable human-like delay
 *  9. Send via LinkedIn (Playwright)
 * 10. Log to messages + activity_log
 *
 * Enqueue via: replyAgentQueue.add('reply', { campaign_lead_id, reply_content })
 */

import { Worker, Queue } from 'bullmq'
import { connection } from '../lib/queue'
import { supabase } from '../lib/supabase'
import { acquireAccountLock } from '../lib/accountLock'
import { getOrCreateBrowserSession } from '../lib/browserPool'
import { persistCookies } from '../linkedin/session'
import { sendMessage } from '../linkedin/actions'
import { analyzeReply } from '../ai/analyze-reply'
import { matchF2FLocation } from '../lib/locations'
import { generateSequenceMessage, MESSAGE_LENGTH_WORDS } from '../ai/generate-sequence-message'
import { createTeamsMeeting } from '../lib/microsoftGraph'
import type { F2FLocation } from '../lib/locations'
import type { ProductContext, SenderContext as AiSenderContext, LeadContext, PriorMessage } from '../ai/generate-sequence-message'

// ── Queue ─────────────────────────────────────────────────────────────────────

export const replyAgentQueue = new Queue('reply-agent', { connection })

// ── Agent Mode settings shape ─────────────────────────────────────────────────

interface AgentModeSettings {
  enabled:                       boolean
  match_tone:                    boolean
  match_length:                  boolean
  match_approach:                boolean
  reply_delay_minutes:           { min: number; max: number }
  meeting_scheduler_enabled:     boolean
  meeting_type:                  'online' | 'face_to_face' | 'either'
  meeting_platform:              'zoom' | 'google_meet' | 'teams' | 'phone' | null
  meeting_link:                  string | null
  teams_auto_generate:           boolean
  meeting_duration_minutes:      number
  warmth_threshold_for_meeting:  number
  not_interested_action:         'pause' | 'end'
  sender_location:               string | null
  f2f_location_mode:             'include' | 'exclude'
  f2f_locations:                 F2FLocation[]
}

interface ReplyAgentJob {
  campaign_lead_id: string
  reply_content:    string
}

// ── Intent → approach mapping ─────────────────────────────────────────────────

function intentToApproach(intent: string): string | null {
  switch (intent) {
    case 'objecting':    return 'problem_solution'
    case 'curious':      return 'insight_challenger'
    case 'interested':   return 'direct'
    case 'scheduling':   return 'direct'
    case 'asking_info':  return 'value_first'
    case 'deflecting':   return 'question_hook'
    default:             return null
  }
}

// ── Human-like delay ──────────────────────────────────────────────────────────

function replyDelay(settings: AgentModeSettings): Promise<void> {
  const min = (settings.reply_delay_minutes?.min ?? 5) * 60 * 1000
  const max = (settings.reply_delay_minutes?.max ?? 30) * 60 * 1000
  const ms  = min + Math.random() * (max - min)
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Meeting CTA builder ───────────────────────────────────────────────────────

interface MeetingCtaOptions {
  settings:         AgentModeSettings
  offerF2F:         boolean
  leadLocationKnown: boolean
  senderLocation:   string | null
  leadLocation:     string | null
}

function buildMeetingInstruction(opts: MeetingCtaOptions): string {
  const { settings, offerF2F, leadLocationKnown, senderLocation, leadLocation } = opts
  const dur = settings.meeting_duration_minutes ?? 30
  const link = settings.meeting_link ? ` Here's my calendar: ${settings.meeting_link}` : ''

  if (settings.meeting_type === 'face_to_face' || (settings.meeting_type === 'either' && offerF2F)) {
    if (!leadLocationKnown) {
      // Don't know lead's location yet — ask before proposing f2f
      return `Propose a meeting, but first ask where they are based.${senderLocation ? ` Mention you are based in ${senderLocation} and you would love to meet in person if they are nearby.` : ' Mention you are open to meeting in person if they are in the area.'}`
    }
    // We know their location and it qualifies — propose f2f
    return `Propose a face-to-face meeting.${senderLocation ? ` You are based in ${senderLocation}.` : ''}${leadLocation ? ` They are in ${leadLocation}.` : ''} Keep the ask light - suggest a coffee or short in-person meeting. No calendar link for in-person.`
  }

  if (settings.meeting_type === 'online' || (settings.meeting_type === 'either' && !offerF2F)) {
    const platform = settings.meeting_platform ?? 'a call'
    const platformName = platform === 'zoom' ? 'Zoom call' : platform === 'google_meet' ? 'Google Meet call' : platform === 'teams' ? 'Teams call' : platform === 'phone' ? 'quick phone call' : 'call'
    return `Propose a ${dur}-minute ${platformName}.${link} Keep the CTA light and easy to say yes to.`
  }

  return `Propose a ${dur}-minute meeting.${link}`
}

// ── Core agent job handler ────────────────────────────────────────────────────

async function runReplyAgent(job: { data: ReplyAgentJob }): Promise<void> {
  const { campaign_lead_id, reply_content } = job.data
  console.log(`[agent] Processing reply for campaign_lead ${campaign_lead_id}`)

  // ── Load campaign_lead ──────────────────────────────────────────────────────
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select('id, campaign_id, lead_id, account_id, status, agent_mode_active')
    .eq('id', campaign_lead_id)
    .single()

  if (clErr || !cl) {
    console.error(`[agent] campaign_lead ${campaign_lead_id} not found`)
    return
  }

  // ── Load campaign + agent settings ─────────────────────────────────────────
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('agent_mode_settings, icp_config, product_id')
    .eq('id', (cl as any).campaign_id)
    .single()

  const agentSettings = (campaign as any)?.agent_mode_settings as AgentModeSettings | null
  if (!agentSettings?.enabled) {
    console.log(`[agent] Agent mode not enabled for campaign ${(cl as any).campaign_id} — skipping`)
    return
  }

  // ── Load account ────────────────────────────────────────────────────────────
  const { data: account } = await supabase
    .from('linkedin_accounts')
    .select('id, user_id, cookies, proxy_id, status, warmup_day, sender_name, sender_headline, sender_about, sender_experience, sender_skills, sender_recent_posts')
    .eq('id', (cl as any).account_id)
    .single()

  if (!account || (account as any).status === 'paused') {
    console.warn(`[agent] Account ${(cl as any).account_id} not available — skipping`)
    return
  }

  const userId = (account as any).user_id as string

  // ── Load lead ───────────────────────────────────────────────────────────────
  const { data: lead } = await supabase
    .from('leads')
    .select('id, linkedin_url, first_name, last_name, title, company, about, experience_description, skills, recent_posts, location')
    .eq('id', (cl as any).lead_id)
    .single()

  if (!lead) {
    console.error(`[agent] Lead ${(cl as any).lead_id} not found`)
    return
  }

  const leadData = lead as any

  // ── Load conversation history ───────────────────────────────────────────────
  const { data: allMsgs } = await supabase
    .from('messages')
    .select('direction, content, created_at')
    .eq('campaign_lead_id', campaign_lead_id)
    .order('created_at', { ascending: true })

  const history = (allMsgs ?? []).map((m: any) => ({
    direction: m.direction as 'sent' | 'received',
    content:   m.content  as string,
  }))

  // ── Analyze the reply ───────────────────────────────────────────────────────
  console.log(`[agent] Analyzing reply from ${leadData.first_name}`)
  let analysis
  try {
    analysis = await analyzeReply(
      reply_content,
      history,
      leadData.first_name
    )
  } catch (err) {
    console.error(`[agent] Reply analysis failed:`, (err as Error).message)
    throw err // BullMQ will retry
  }

  console.log(
    `[agent] ${leadData.first_name}: warmth=${analysis.warmth_score} (${analysis.warmth_flag}) ` +
    `intent=${analysis.reply_intent} tone=${analysis.reply_tone} ` +
    `meeting_interest=${analysis.meeting_interest_detected}`
  )

  // ── Update warmth on campaign_lead ──────────────────────────────────────────
  await supabase
    .from('campaign_leads')
    .update({
      warmth_score:      analysis.warmth_score,
      warmth_flag:       analysis.warmth_flag,
      agent_mode_active: true,
    })
    .eq('id', campaign_lead_id)

  // ── Handle not_interested ───────────────────────────────────────────────────
  if (analysis.warmth_flag === 'not_interested') {
    const action = agentSettings.not_interested_action ?? 'pause'
    const newStatus = action === 'end' ? 'excluded' : 'paused'
    await supabase
      .from('campaign_leads')
      .update({ status: newStatus })
      .eq('id', campaign_lead_id)
    console.log(`[agent] ${leadData.first_name} not interested — ${action} → status=${newStatus}`)
    return
  }

  // ── Load product + sender context ───────────────────────────────────────────
  const icp = (campaign as any)?.icp_config as Record<string, unknown> | null
  const productId = (campaign as any)?.product_id
    ?? (icp?.selected_product_ids as string[] | undefined)?.[0]
    ?? null

  let product: ProductContext | null = null
  if (productId) {
    const { data: userSettings } = await supabase
      .from('user_settings').select('icp_config').eq('user_id', userId).single()
    const cfg = (userSettings as any)?.icp_config as { products_services?: Array<{ id: string } & ProductContext> } | null
    product = cfg?.products_services?.find(p => p.id === productId) ?? null
  }

  let sender: AiSenderContext | null = null
  if ((account as any).sender_name) {
    sender = {
      name:         (account as any).sender_name,
      headline:     (account as any).sender_headline ?? null,
      about:        (account as any).sender_about ?? null,
      experience:   (account as any).sender_experience ?? null,
      skills:       (account as any).sender_skills ?? undefined,
      recent_posts: (account as any).sender_recent_posts ?? undefined,
    }
  }

  // ── Determine meeting CTA ───────────────────────────────────────────────────
  const shouldProposeMeeting =
    agentSettings.meeting_scheduler_enabled && (
      analysis.meeting_interest_detected ||
      analysis.warmth_score >= (agentSettings.warmth_threshold_for_meeting ?? 70)
    )

  let meetingInstruction: string | null = null
  let offerF2F = false

  if (shouldProposeMeeting) {
    const canConsiderF2F =
      agentSettings.meeting_type === 'face_to_face' ||
      agentSettings.meeting_type === 'either'

    if (canConsiderF2F) {
      // Use location from analysis first, fall back to stored lead location
      const locationToCheck = analysis.location_mentioned ?? leadData.location ?? null
      if (locationToCheck) {
        offerF2F = await matchF2FLocation(
          locationToCheck,
          agentSettings.f2f_location_mode ?? 'include',
          agentSettings.f2f_locations ?? []
        )
      }
    }

    // Auto-generate a Teams meeting link if configured
    let effectiveSettings = agentSettings
    if (
      agentSettings.meeting_platform === 'teams' &&
      agentSettings.teams_auto_generate &&
      !offerF2F
    ) {
      try {
        const meeting = await createTeamsMeeting(
          userId,
          `Meeting with ${leadData.first_name}`,
          agentSettings.meeting_duration_minutes ?? 30
        )
        effectiveSettings = { ...agentSettings, meeting_link: meeting.joinWebUrl }
        console.log(`[agent] Teams meeting created for ${leadData.first_name}: ${meeting.joinWebUrl}`)
      } catch (err) {
        console.warn(`[agent] Teams meeting creation failed, falling back to static link:`, (err as Error).message)
      }
    }

    meetingInstruction = buildMeetingInstruction({
      settings:          effectiveSettings,
      offerF2F,
      leadLocationKnown: !!(analysis.location_mentioned ?? leadData.location),
      senderLocation:    agentSettings.sender_location ?? null,
      leadLocation:      analysis.location_mentioned ?? leadData.location ?? null,
    })
  }

  // ── Build message overrides ─────────────────────────────────────────────────
  const tone = agentSettings.match_tone
    ? (analysis.reply_tone === 'curt' ? 'conversational' : analysis.reply_tone) // map curt → conversational
    : ((icp?.message_tone as string) ?? null)

  // match_length: use their word count as target, rounded to nearest preset
  let maxWords: number | null = null
  if (agentSettings.match_length) {
    const lengths = Object.entries(MESSAGE_LENGTH_WORDS).sort(([, a], [, b]) => a - b)
    const closest = lengths.reduce((prev, curr) =>
      Math.abs(curr[1] - analysis.reply_length_words) < Math.abs(prev[1] - analysis.reply_length_words)
        ? curr : prev
    )
    maxWords = closest[1]
  }

  const approach = agentSettings.match_approach
    ? intentToApproach(analysis.reply_intent)
    : ((icp?.message_approach as string) ?? null)

  // ── Build prior messages for AI context ────────────────────────────────────
  const priorMessages: PriorMessage[] = history.map(m => ({
    direction: m.direction,
    content:   m.content,
  }))

  // ── Build lead context ──────────────────────────────────────────────────────
  const leadCtx: LeadContext = {
    first_name:             leadData.first_name,
    last_name:              leadData.last_name,
    title:                  leadData.title    ?? null,
    company:                leadData.company  ?? null,
    industry:               null,
    about:                  leadData.about    ?? null,
    experience_description: leadData.experience_description ?? null,
    skills:                 leadData.skills      ?? undefined,
    recent_posts:           leadData.recent_posts ?? undefined,
  }

  // ── Build AI guidance for agent context ────────────────────────────────────
  const agentGuidance = {
    ai_role:    'agent_reply',
    ai_context: `Lead replied: "${reply_content.slice(0, 200)}". Warmth: ${analysis.warmth_flag} (${analysis.warmth_score}/100). Intent: ${analysis.reply_intent}.${analysis.key_objection ? ` Key concern: "${analysis.key_objection}".` : ''}`,
    ai_instruction: [
      'Respond naturally to their reply. Build on the conversation thread.',
      analysis.key_objection ? `Address their concern: "${analysis.key_objection}" — don't ignore it.` : null,
      meetingInstruction ? `MEETING CTA — include this in your message: ${meetingInstruction}` : null,
    ].filter(Boolean).join(' '),
  }

  // ── Generate reply ──────────────────────────────────────────────────────────
  console.log(`[agent] Generating reply for ${leadData.first_name} (tone=${tone}, maxWords=${maxWords}, approach=${approach}, meeting=${shouldProposeMeeting})`)

  let replyBody: string
  try {
    const result = await generateSequenceMessage({
      step_type:            'message',
      position_in_sequence: priorMessages.filter(m => m.direction === 'sent').length + 1,
      product:              product ?? { name: 'our product' },
      sender,
      lead:                 leadCtx,
      prior_messages:       priorMessages,
      resolve_variables:    true,
      tone:                 tone as any,
      approach,
      max_words:            maxWords,
      ai_guidance:          agentGuidance,
    })
    replyBody = result.body
  } catch (err) {
    console.error(`[agent] Message generation failed for ${leadData.first_name}:`, (err as Error).message)
    throw err
  }

  console.log(`[agent] Generated reply for ${leadData.first_name}: "${replyBody.slice(0, 80)}..."`)

  // ── Wait human-like delay before sending ───────────────────────────────────
  console.log(`[agent] Waiting ${agentSettings.reply_delay_minutes?.min ?? 5}–${agentSettings.reply_delay_minutes?.max ?? 30} min before sending...`)
  await replyDelay(agentSettings)

  // ── Acquire account lock + browser session ─────────────────────────────────
  const release = await acquireAccountLock((account as any).id)
  if (!release) {
    console.warn(`[agent] Account ${(account as any).id} locked — requeueing`)
    throw new Error('Account locked')
  }

  let browserSession = null
  try {
    browserSession = await getOrCreateBrowserSession(account as any)
    const { context, page } = browserSession

    await sendMessage(page, leadData.linkedin_url, (account as any).id, replyBody)
    console.log(`[agent] ✓ Reply sent to ${leadData.first_name}`)

    await persistCookies(context, (account as any).id)
  } finally {
    await release()
  }

  // ── Record message ──────────────────────────────────────────────────────────
  const { error: msgErr } = await supabase.from('messages').insert({
    campaign_lead_id: campaign_lead_id,
    direction:        'sent',
    content:          replyBody,
    sent_at:          new Date().toISOString(),
  })
  if (msgErr) console.warn('[agent] messages insert failed — reply sent but not recorded:', msgErr.message)

  // ── Log activity ────────────────────────────────────────────────────────────
  await supabase.from('activity_log').insert({
    account_id:  (account as any).id,
    campaign_id: (cl as any).campaign_id,
    lead_id:     leadData.id,
    action:      'message',
    metadata:    { source: 'agent_mode', warmth: analysis.warmth_score, meeting_proposed: shouldProposeMeeting },
  })
}

// ── Worker registration ───────────────────────────────────────────────────────

export function startReplyAgentWorker(): Worker {
  const worker = new Worker<ReplyAgentJob>(
    'reply-agent',
    runReplyAgent,
    {
      connection,
      concurrency: 3,
      removeOnComplete: { count: 200 },
      removeOnFail:     { count: 100 },
    }
  )

  worker.on('completed', job => {
    console.log(`[agent] Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[agent] Job ${job?.id} failed:`, err.message)
  })

  console.log('[agent] Reply agent worker started')
  return worker
}
