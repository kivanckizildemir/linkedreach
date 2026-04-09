import { Router } from 'express'
import type { Request, Response } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import {
  generateSequenceMessage,
  buildPriorChain,
  getMessagePosition,
  MESSAGE_LENGTH_WORDS,
  type StepNode,
  type ProductContext,
  type LeadContext,
  type PriorMessage,
  type SenderContext,
  type SequenceStepType,
} from '../ai/generate-sequence-message'

let _ai: Anthropic | null = null
function getAi(): Anthropic {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _ai
}

/** Read max_words from a raw step's condition JSONB. */
function getStepMaxWords(rawStep: unknown): number | undefined {
  const cond = (rawStep as { condition?: Record<string, unknown> | null } | null)?.condition
  const preset = cond?.max_length_preset as string | undefined
  return preset ? MESSAGE_LENGTH_WORDS[preset] : undefined
}

export const sequenceAiRouter = Router()
sequenceAiRouter.use(requireAuth)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Verify sequence ownership and return the sequence row (including campaign_id). */
async function getOwnedSequence(
  sequenceId: string,
  userId: string
): Promise<{ id: string; campaign_id: string } | null> {
  const { data: seq } = await supabase
    .from('sequences')
    .select('id, campaign_id')
    .eq('id', sequenceId)
    .single()
  if (!seq) return null

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, user_id')
    .eq('id', seq.campaign_id as string)
    .eq('user_id', userId)
    .single()

  return campaign ? (seq as { id: string; campaign_id: string }) : null
}

/** Fetch the product from the user's settings by product_id string. */
async function getProductFromSettings(
  userId: string,
  productId: string
): Promise<ProductContext | null> {
  const { data: settings } = await supabase
    .from('user_settings')
    .select('icp_config')
    .eq('user_id', userId)
    .single()

  if (!settings) return null

  const config = settings.icp_config as {
    products_services?: Array<{ id: string } & ProductContext>
    notes?: string
  }
  const products = config.products_services ?? []
  const product = products.find(p => p.id === productId)
  return product ?? null
}

/** Fetch campaign-level context (product_id, account_id, message_approach, message_tone). */
async function getCampaignContext(campaignId: string): Promise<{
  product_id: string | null
  account_id: string | null
  message_approach: string | null
  message_tone: string | null
}> {
  const { data } = await supabase
    .from('campaigns')
    .select('product_id, account_id, icp_config')
    .eq('id', campaignId)
    .single()
  const icp = (data as any)?.icp_config as Record<string, unknown> | null
  // Fallback: if top-level product_id is null, check icp_config.selected_product_ids[0]
  const selectedProductIds = icp?.selected_product_ids as string[] | undefined
  const productId = (data as any)?.product_id ?? selectedProductIds?.[0] ?? null
  return {
    product_id: productId,
    account_id: (data as any)?.account_id ?? null,
    message_approach: (icp?.message_approach as string) ?? null,
    message_tone: (icp?.message_tone as string) ?? null,
  }
}

// ─── Build-flow types & helpers ───────────────────────────────────────────────

/** Recursive step definition returned by Claude's Sequence Architect. */
interface AiStepDef {
  type: string
  wait_days?: number
  has_note?: boolean
  condition?: string         // for fork: 'connected' | 'replied'
  if_yes?: AiStepDef[]
  if_no?: AiStepDef[]
  // AI guidance fields for message steps (AI automated mode)
  ai_role?: string
  ai_arc?: string
  ai_instruction?: string
  ai_context?: string
  ai_sequence_strategy?: string
}

interface BuildFlowStructure {
  strategy: string
  rationale: string
  steps: AiStepDef[]
}

interface GenerationContext {
  product: ProductContext
  sender: SenderContext | null
  icpNotes: string | undefined
  campaignApproach: string | null
  campaignTone: string | null
}

const BUILD_FLOW_MESSAGE_TYPES = new Set(['connect', 'message', 'inmail', 'follow_up'])

const PLACEHOLDER_LEAD: LeadContext = {
  first_name: '{{first_name}}',
  last_name:  '{{last_name}}',
  title:      '{{title}}',
  company:    '{{company}}',
  industry:   '{{industry}}',
  location:   null,
  opening_line: '{{opening_line}}',
}

// ─── Learning constitution: the Sequence Architect system prompt ───────────────

const BUILD_FLOW_SYSTEM_PROMPT = `You are the Sequence Architect — an elite AI revenue consultant that combines deep expertise in B2B sales strategy, behavioural psychology, digital marketing, and LinkedIn outreach mechanics.

Your mission: design optimally structured outreach sequences that treat each prospect as an individual, not a name in a list. You think like a seasoned VP of Sales who has also studied Cialdini, Kahneman, and modern revenue operations.

━━━ STEP TYPE LIBRARY ━━━

You have access to these step types:

• view_profile   — Visit the lead's profile. Triggers a "someone viewed your profile" notification. Passively warms the lead. Always recommended first.
• follow         — Follow the lead's profile. Non-intrusive signal of interest, increases visibility.
• connect        — Send a connection request. Optional note (has_note: true) for a personalised approach. Max 300 chars if a note is included.
• wait           — A deliberate pause. Use wait_days (integer 1–14). Required between connect and first message, and between messages.
• message        — LinkedIn direct message (only available after connection accepted). Best for ongoing dialogue.
• inmail         — LinkedIn InMail (bypasses connection requirement). Reserve for premium or highly targeted situations.
• fork           — A conditional branch point. Splits the sequence based on lead behaviour:
    condition: "connected" → did the lead accept the connection request?
    condition: "replied"   → has the lead replied to any message in this branch?
  A fork has two branches: if_yes (condition met) and if_no (condition not met).
  Each branch must be a complete sub-sequence ending with an "end" step.
• end            — Terminates the current branch. Required at the end of EVERY branch and the main sequence.

━━━ THE 10 OUTREACH APPROACHES ━━━

1. direct             — No warm-up. Respect their time. Clear who, what, why in one message.
2. trigger_based      — Reference a specific recent signal: job change, funding, post, product launch. Genuine relevance beats generic every time.
3. insight_challenger — Open with a counterintuitive insight that reframes their world. You are a thinker, not a vendor.
4. problem_solution   — Name the specific pain they likely face. Make them feel understood. Then solve.
5. social_proof       — Lead with a specific named result. "We helped [Company type] achieve X" — specificity overcomes scepticism.
6. question_hook      — A single provocative question. No preamble. The question IS the message.
7. before_after_bridge— Paint the before (friction), the after (outcome), the bridge (how you get there).
8. mutual_ground      — Establish shared background, connection, or perspective before any pitch.
9. pattern_interrupt  — Break every convention. Unexpected, self-aware, structurally original. Surprise earns read-through.
10. value_first       — Lead with the concrete outcome in sentence one. Zero setup.

━━━ THE 4 TONES ━━━

1. professional   — Precise, authoritative business language. Sharp executive voice.
2. conversational — Peer-to-peer warmth. Reads like a smart colleague's Slack message.
3. casual         — Relaxed, warm, coffee-chat energy. Light humour welcome if it fits.
4. bold           — Punchy, unapologetic, no hedging. Confident people do not say "just".

━━━ FORK DESIGN PRINCIPLES ━━━

Use forks strategically, not excessively:
- The most powerful pattern: a "connected" fork after the connect step. It separates engaged leads from unresponsive ones.
- A "replied" fork after M1 in the if_yes branch optimises the post-connection journey.
- Never nest more than 2 levels of forks. Complexity beyond that produces noise.
- The if_no branch (never connected) should be shorter — typically 1 inmail or a simple end.
- The if_yes branch (connected and engaged) deserves the full message arc.
- Not every sequence needs a fork. Simple, direct campaigns can stay linear.

━━━ MESSAGE ARC DESIGN ━━━

For each message step, provide these ai guidance fields:
- ai_role: strategic role of this message (first_touch | nurture | follow_up | breakup | inmail_cold | inmail_followup)
- ai_arc: position in the arc, e.g. "M1 of 3"
- ai_instruction: specific 1–2 sentence writing instruction for the message generator — shaped by the approach and audience. Not generic.
- ai_context: what is the lead's state at this step, e.g. "Accepted connection 3 days ago, no reply yet"

The ai_instruction for M1 must reflect the campaign approach directly.
ai_instructions for M2, M3 must offer completely new angles — never repeat M1's hook or CTA.

━━━ SEQUENCE DESIGN RULES ━━━

1. Always start with: view_profile → (optional follow) → connect
2. Wait 1–3 days after connect before first message
3. Use 3–7 day waits between messages (shorter for high-intent, longer for cold)
4. Total depth per branch: 4–8 steps
5. Every branch MUST end with an "end" step
6. For enterprise/high-value targets: longer sequences, more nurture touch points
7. For SMB/startup targets: shorter, punchier, faster cadence
8. Approach shapes the arc: direct = fewer messages; relationship-based = more touch points
9. If mode is AI AUTOMATED: do NOT generate any message text — only provide ai_role, ai_arc, ai_instruction, ai_context
10. If mode is MANUAL: you may optionally include a "template" field with a starter draft, but it is not required

━━━ OUTPUT FORMAT ━━━

Respond with ONLY valid JSON. No markdown fences. No explanation outside the JSON.

{
  "strategy": "short_strategy_name_no_spaces",
  "rationale": "1–2 sentence explanation of why this structure fits this campaign",
  "steps": [ ... recursive step tree as described above ... ]
}`

// ─── Build-flow user prompt assembler ────────────────────────────────────────

function buildBuildFlowUserPrompt(params: {
  product: ProductContext
  targetRoles: string | null
  targetIndustries: string | null
  seniority: string | null
  keywords: string | null
  customCriteria: string | null
  icpNotes: string | undefined
  campaignNotes: string | null
  sender: SenderContext | null
  approach: string | null
  tone: string | null
  defaultAiMode: boolean
}): string {
  const lines: string[] = []

  lines.push('━━━ CAMPAIGN BRIEF ━━━')
  lines.push('')
  lines.push('PRODUCT / SERVICE')
  lines.push(`Name: ${params.product.name}`)
  if (params.product.one_liner)       lines.push(`One-liner: ${params.product.one_liner}`)
  if (params.product.description)     lines.push(`Description: ${params.product.description}`)
  if (params.product.target_use_case) lines.push(`Ideal customer: ${params.product.target_use_case}`)
  if (params.product.usps?.length) {
    lines.push('USPs:')
    params.product.usps.forEach(u => lines.push(`  • ${u}`))
  }
  if (params.product.differentiators?.length) {
    lines.push('Differentiators:')
    params.product.differentiators.forEach(d => lines.push(`  • ${d}`))
  }
  lines.push('')

  lines.push('TARGET AUDIENCE')
  if (params.targetRoles)      lines.push(`Roles: ${params.targetRoles}`)
  if (params.targetIndustries) lines.push(`Industries: ${params.targetIndustries}`)
  if (params.seniority)        lines.push(`Seniority: ${params.seniority}`)
  if (params.keywords)         lines.push(`Keywords / signals: ${params.keywords}`)
  if (params.customCriteria)   lines.push(`Custom criteria: ${params.customCriteria}`)
  if (params.icpNotes)         lines.push(`ICP notes: ${params.icpNotes}`)
  if (!params.targetRoles && !params.targetIndustries && !params.seniority) {
    lines.push('(Not specified — infer optimal audience from product context)')
  }
  lines.push('')

  lines.push('CAMPAIGN PARAMETERS')
  lines.push(`Outreach approach: ${params.approach ?? 'direct (default)'}`)
  lines.push(`Tone: ${params.tone ?? 'professional (default)'}`)
  if (params.sender) {
    lines.push(`Sender: ${params.sender.name}${params.sender.headline ? ` — ${params.sender.headline}` : ''}`)
  }
  if (params.campaignNotes) lines.push(`Campaign notes: ${params.campaignNotes}`)
  lines.push('')

  lines.push('MESSAGE GENERATION MODE')
  if (params.defaultAiMode) {
    lines.push('Mode: AI AUTOMATED')
    lines.push('Do NOT write message text or templates. For every message/inmail/connect step, provide ONLY: ai_role, ai_arc, ai_instruction, ai_context. The live message generator will craft the actual messages using these parameters plus the lead\'s live profile data.')
  } else {
    lines.push('Mode: MANUAL')
    lines.push('Generate the full sequence structure. Message templates will be generated separately after the structure is created.')
  }
  lines.push('')
  lines.push('Design the optimal sequence for this campaign. Use fork steps where they add clear strategic value.')

  return lines.join('\n')
}

// ─── Recursive step creator ───────────────────────────────────────────────────

async function createStepsFromTree(
  stepDefs: AiStepDef[],
  sequenceId: string,
  parentStepId: string | null,
  branch: string,
  defaultAiMode: boolean,
  genCtx: GenerationContext,
  allCreated: StepNode[],
  startOrder: number = 0,
): Promise<void> {
  for (let i = 0; i < stepDefs.length; i++) {
    const def = stepDefs[i]
    const stepType = def.type
    const stepOrder = startOrder + i
    console.log(`[createStepsFromTree] branch="${branch}" order=${stepOrder} type=${stepType} def=`, JSON.stringify(def).slice(0, 200))
    const isMessageStep = BUILD_FLOW_MESSAGE_TYPES.has(stepType)

    // Build condition payload
    const conditionPayload: Record<string, unknown> = {}
    if (stepType === 'wait')    conditionPayload.wait_days = def.wait_days ?? 3
    if (stepType === 'connect') conditionPayload.include_note = def.has_note ?? false
    if (stepType === 'fork')    conditionPayload.type = def.condition ?? 'connected'

    // In AI automated mode: store guidance params in condition field for message steps
    if (isMessageStep && defaultAiMode) {
      if (def.ai_role)               conditionPayload.ai_role = def.ai_role
      if (def.ai_arc)                conditionPayload.ai_arc = def.ai_arc
      if (def.ai_instruction)        conditionPayload.ai_instruction = def.ai_instruction
      if (def.ai_context)            conditionPayload.ai_context = def.ai_context
      if (def.ai_sequence_strategy)  conditionPayload.ai_sequence_strategy = def.ai_sequence_strategy
    }

    const { data: newStep, error: insertErr } = await supabase
      .from('sequence_steps')
      .insert({
        sequence_id:        sequenceId,
        type:               stepType,
        step_order:         stepOrder,
        parent_step_id:     parentStepId,
        branch:             branch,
        wait_days:          stepType === 'wait' ? (def.wait_days ?? 3) : null,
        condition:          Object.keys(conditionPayload).length > 0 ? conditionPayload : null,
        message_template:   null,
        ai_generation_mode: isMessageStep,
      })
      .select()
      .single()

    if (insertErr || !newStep) {
      throw new Error(`Failed to create step ${stepOrder} (${stepType}) in branch "${branch}": ${insertErr?.message}`)
    }

    const stepNode: StepNode = {
      id:               (newStep as any).id as string,
      type:             stepType,
      message_template: null,
      parent_step_id:   parentStepId,
      branch:           branch,
      step_order:       stepOrder,
      ai_generation_mode: isMessageStep,
    }
    allCreated.push(stepNode)

    // In manual mode: generate message template right away
    if (isMessageStep && !defaultAiMode) {
      try {
        const priorMsgs: PriorMessage[] = allCreated
          .filter(s => BUILD_FLOW_MESSAGE_TYPES.has(s.type) && s.message_template && s.id !== stepNode.id)
          .map(s => ({ direction: 'sent' as const, content: s.message_template!, step_type: s.type }))
        const position = priorMsgs.length + 1

        const result = await generateSequenceMessage({
          step_type:            stepType as SequenceStepType,
          position_in_sequence: position,
          product:              genCtx.product,
          sender:               genCtx.sender,
          lead:                 PLACEHOLDER_LEAD,
          prior_messages:       priorMsgs,
          icp_notes:            genCtx.icpNotes,
          resolve_variables:    false,
          approach:             genCtx.campaignApproach,
          tone:                 genCtx.campaignTone,
        })

        await supabase.from('sequence_steps').update({
          message_template:   result.body,
          subject:            result.subject ?? null,
          ai_generation_mode: true,
        }).eq('id', stepNode.id)

        stepNode.message_template = result.body
      } catch {
        // Non-fatal: step exists, message can be generated manually later
      }
    }

    // Recurse into fork branches
    if (stepType === 'fork') {
      if (def.if_yes && def.if_yes.length > 0) {
        await createStepsFromTree(def.if_yes, sequenceId, stepNode.id, 'if_yes', defaultAiMode, genCtx, allCreated, 0)
      }
      if (def.if_no && def.if_no.length > 0) {
        await createStepsFromTree(def.if_no, sequenceId, stepNode.id, 'if_no', defaultAiMode, genCtx, allCreated, 0)
      }
    }
  }
}

/** Fetch sender identity from the LinkedIn account assigned to the campaign. */
async function getSenderContext(accountId: string | null): Promise<SenderContext | null> {
  if (!accountId) return null
  const { data } = await supabase
    .from('linkedin_accounts')
    .select('sender_name, sender_headline, sender_about, sender_experience, sender_skills, sender_recent_posts')
    .eq('id', accountId)
    .single()
  if (!data || !(data as any).sender_name) return null
  return {
    name:         (data as any).sender_name         as string,
    headline:     (data as any).sender_headline     as string | null,
    about:        (data as any).sender_about        as string | null,
    experience:   (data as any).sender_experience   as string | null,
    skills:       (data as any).sender_skills       as string[] | undefined,
    recent_posts: (data as any).sender_recent_posts as string[] | undefined,
  }
}

/** Fetch ICP notes for the user. */
async function getIcpNotes(userId: string): Promise<string | undefined> {
  const { data } = await supabase
    .from('user_settings')
    .select('icp_config')
    .eq('user_id', userId)
    .single()
  const config = data?.icp_config as { notes?: string } | null
  return config?.notes ?? undefined
}

const MESSAGE_TYPES = new Set(['connect', 'message', 'inmail', 'follow_up'])

/**
 * Build a PriorMessage array from the ancestor chain of a given step.
 * Uses template text from the steps themselves (authoring context, not real sent messages).
 */
function buildPriorMessages(
  targetStepId: string,
  allSteps: StepNode[]
): PriorMessage[] {
  const chain = buildPriorChain(targetStepId, allSteps)
  return chain
    .filter(s => MESSAGE_TYPES.has(s.type) && s.message_template)
    .map(s => ({
      direction: 'sent' as const,
      content: s.message_template!,
      step_type: s.type,
    }))
}

// ─── POST /api/sequence-ai/:sequenceId/generate-all ──────────────────────────
/**
 * Generates AI message content for every message-capable step in the sequence at once.
 * Body: { product_id?: string }  — if omitted, uses the campaign's product_id
 */
sequenceAiRouter.post('/:sequenceId/generate-all', async (req: Request, res: Response) => {
  const sequenceId = req.params.sequenceId as string
  const { product_id: bodyProductId } = req.body as { product_id?: string }

  const seq = await getOwnedSequence(sequenceId, req.user.id)
  if (!seq) { res.status(404).json({ error: 'Sequence not found' }); return }

  // Resolve product
  const campaignCtx = await getCampaignContext(seq.campaign_id)
  const productId = bodyProductId ?? campaignCtx.product_id
  if (!productId) {
    res.status(400).json({ error: 'No product selected for this campaign. Go to campaign Settings and pick a product.' })
    return
  }
  const product = await getProductFromSettings(req.user.id, productId)
  if (!product) {
    res.status(404).json({ error: 'Product not found in your settings.' })
    return
  }

  const [icpNotes, sender] = await Promise.all([
    getIcpNotes(req.user.id),
    getSenderContext(campaignCtx.account_id),
  ])

  // Fetch all steps for this sequence
  const { data: rawSteps, error: stepsErr } = await supabase
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', sequenceId)
    .order('step_order', { ascending: true })

  if (stepsErr || !rawSteps) { res.status(500).json({ error: stepsErr?.message ?? 'Failed to fetch steps' }); return }

  const allSteps: StepNode[] = rawSteps.map(s => ({
    id: s.id as string,
    type: s.type as string,
    message_template: s.message_template as string | null,
    parent_step_id: s.parent_step_id as string | null,
    branch: s.branch as string | null,
    step_order: s.step_order as number,
    ai_generation_mode: (s.ai_generation_mode ?? false) as boolean,
  }))

  // Placeholder lead — real personalisation happens at send time via personalise.ts
  const placeholderLead: LeadContext = {
    first_name: '{{first_name}}',
    last_name: '{{last_name}}',
    title: '{{title}}',
    company: '{{company}}',
    industry: '{{industry}}',
    location: null,
    opening_line: '{{opening_line}}',
  }

  const updatedSteps: StepNode[] = []
  const errors: string[] = []

  for (const step of allSteps) {
    if (!MESSAGE_TYPES.has(step.type)) continue

    const position = getMessagePosition(step.id, allSteps)
    const priorMsgs = buildPriorMessages(step.id, allSteps)

    try {
      const rawStep = rawSteps.find(s => (s.id as string) === step.id)
      const result = await generateSequenceMessage({
        step_type: step.type as SequenceStepType,
        position_in_sequence: position,
        product,
        sender,
        lead: placeholderLead,
        prior_messages: priorMsgs,
        icp_notes: icpNotes,
        resolve_variables: false,
        approach: campaignCtx.message_approach,
        tone: campaignCtx.message_tone,
        max_words: getStepMaxWords(rawStep),
      })

      // Update the step in the database
      const { data: updated, error: updateErr } = await supabase
        .from('sequence_steps')
        .update({
          message_template: result.body,
          subject: result.subject ?? null,
          ai_generation_mode: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', step.id)
        .select()
        .single()

      if (updateErr) {
        errors.push(`Step ${step.id}: ${updateErr.message}`)
        continue
      }

      // Update in-memory so subsequent steps see the new content
      const idx = allSteps.findIndex(s => s.id === step.id)
      if (idx !== -1) {
        allSteps[idx] = { ...allSteps[idx], message_template: result.body, ai_generation_mode: true }
      }

      updatedSteps.push(updated as unknown as StepNode)
    } catch (err) {
      errors.push(`Step ${step.id} (${step.type}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  res.json({
    updated: updatedSteps.length,
    steps: updatedSteps,
    errors: errors.length > 0 ? errors : undefined,
  })
})

// ─── POST /api/sequence-ai/:sequenceId/steps/:stepId/generate ────────────────
/**
 * Regenerate a single step.
 * Body: { product_id?: string }
 */
sequenceAiRouter.post('/:sequenceId/steps/:stepId/generate', async (req: Request, res: Response) => {
  const sequenceId = req.params.sequenceId as string
  const stepId = req.params.stepId as string
  const { product_id: bodyProductId, profile_sources } = req.body as { product_id?: string; profile_sources?: string[] }

  const seq = await getOwnedSequence(sequenceId, req.user.id)
  if (!seq) { res.status(404).json({ error: 'Sequence not found' }); return }

  const campaignCtx2 = await getCampaignContext(seq.campaign_id)
  const productId = bodyProductId ?? campaignCtx2.product_id
  if (!productId) {
    res.status(400).json({ error: 'No product selected for this campaign.' })
    return
  }
  const product = await getProductFromSettings(req.user.id, productId)
  if (!product) { res.status(404).json({ error: 'Product not found.' }); return }

  const [icpNotes2, sender2] = await Promise.all([
    getIcpNotes(req.user.id),
    getSenderContext(campaignCtx2.account_id),
  ])

  const { data: rawSteps, error: stepsErr } = await supabase
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', sequenceId)
    .order('step_order', { ascending: true })

  if (stepsErr || !rawSteps) { res.status(500).json({ error: 'Failed to fetch steps' }); return }

  const allSteps: StepNode[] = rawSteps.map(s => ({
    id: s.id as string,
    type: s.type as string,
    message_template: s.message_template as string | null,
    parent_step_id: s.parent_step_id as string | null,
    branch: s.branch as string | null,
    step_order: s.step_order as number,
    ai_generation_mode: (s.ai_generation_mode ?? false) as boolean,
  }))

  const targetStep = allSteps.find(s => s.id === stepId)
  if (!targetStep) { res.status(404).json({ error: 'Step not found' }); return }
  if (!MESSAGE_TYPES.has(targetStep.type)) {
    res.status(400).json({ error: 'This step type does not have a message body.' })
    return
  }

  const position = getMessagePosition(stepId, allSteps)
  const priorMsgs = buildPriorMessages(stepId, allSteps)

  const placeholderLead: LeadContext = {
    first_name: '{{first_name}}',
    last_name: '{{last_name}}',
    title: '{{title}}',
    company: '{{company}}',
    industry: '{{industry}}',
    location: null,
    opening_line: '{{opening_line}}',
  }

  const rawTargetForSingle = rawSteps.find(s => (s.id as string) === stepId)
  // profile_sources from body, fallback to step's saved condition
  const stepProfileSources = profile_sources
    ?? (rawTargetForSingle?.condition as Record<string, unknown> | null)?.profile_sources as string[] | undefined

  const result = await generateSequenceMessage({
    step_type: targetStep.type as SequenceStepType,
    position_in_sequence: position,
    product,
    sender: sender2,
    lead: placeholderLead,
    prior_messages: priorMsgs,
    icp_notes: icpNotes2,
    resolve_variables: false,
    approach: campaignCtx2.message_approach,
    tone: campaignCtx2.message_tone,
    max_words: getStepMaxWords(rawTargetForSingle),
    profile_sources: stepProfileSources,
  })

  const { data: updated, error: updateErr } = await supabase
    .from('sequence_steps')
    .update({
      message_template: result.body,
      subject: result.subject ?? null,
      ai_generation_mode: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', stepId)
    .select()
    .single()

  if (updateErr) { res.status(500).json({ error: updateErr.message }); return }

  res.json({ data: updated })
})

// ─── POST /api/sequence-ai/:sequenceId/steps/:stepId/preview ─────────────────
/**
 * Generate a fully-resolved preview of a step for a specific lead.
 * Does NOT write to the database.
 * Body: { lead_id: string }
 */
sequenceAiRouter.post('/:sequenceId/steps/:stepId/preview', async (req: Request, res: Response) => {
  const sequenceId = req.params.sequenceId as string
  const stepId = req.params.stepId as string
  const { lead_id } = req.body as { lead_id?: string }

  if (!lead_id) { res.status(400).json({ error: 'lead_id is required' }); return }

  const seq = await getOwnedSequence(sequenceId, req.user.id)
  if (!seq) { res.status(404).json({ error: 'Sequence not found' }); return }

  // Verify lead belongs to user — fetch all enriched fields
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, first_name, last_name, title, company, industry, location, about, experience_description, skills, recent_posts, raw_data')
    .eq('id', lead_id)
    .eq('user_id', req.user.id)
    .single()

  if (leadErr || !lead) { res.status(404).json({ error: 'Lead not found' }); return }

  // Get product + approach/tone + sender
  const campaignCtx3 = await getCampaignContext(seq.campaign_id)
  const productId = campaignCtx3.product_id
  const [product3, icpNotes3, sender3] = await Promise.all([
    productId
      ? getProductFromSettings(req.user.id, productId).then(p => p ?? ({ name: 'our product' } as ProductContext))
      : Promise.resolve({ name: 'our product' } as ProductContext),
    getIcpNotes(req.user.id),
    getSenderContext(campaignCtx3.account_id),
  ])
  const product = product3
  const icpNotes = icpNotes3

  // Fetch all steps
  const { data: rawSteps, error: stepsErr } = await supabase
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', sequenceId)
    .order('step_order', { ascending: true })

  if (stepsErr || !rawSteps) { res.status(500).json({ error: 'Failed to fetch steps' }); return }

  const allSteps: StepNode[] = rawSteps.map(s => ({
    id: s.id as string,
    type: s.type as string,
    message_template: s.message_template as string | null,
    parent_step_id: s.parent_step_id as string | null,
    branch: s.branch as string | null,
    step_order: s.step_order as number,
    ai_generation_mode: (s.ai_generation_mode ?? false) as boolean,
  }))

  const targetStep = allSteps.find(s => s.id === stepId)
  if (!targetStep) { res.status(404).json({ error: 'Step not found' }); return }
  if (!MESSAGE_TYPES.has(targetStep.type)) {
    res.status(400).json({ error: 'This step type does not have a message body.' })
    return
  }

  // Build lead context with all enriched profile data
  const rawData = (lead.raw_data as Record<string, unknown> | null) ?? {}
  const leadContext: LeadContext = {
    first_name: lead.first_name as string,
    last_name: lead.last_name as string,
    title: lead.title as string | null,
    company: lead.company as string | null,
    industry: lead.industry as string | null,
    location: lead.location as string | null,
    about: (lead.about as string | null) ?? null,
    experience_description: (lead.experience_description as string | null) ?? null,
    skills: Array.isArray(lead.skills) ? lead.skills as string[] : undefined,
    recent_posts: Array.isArray(lead.recent_posts) ? lead.recent_posts as string[]
      : Array.isArray(rawData.recent_posts) ? rawData.recent_posts as string[]
      : undefined,
    opening_line: rawData.opening_line as string | null,
  }

  const position = getMessagePosition(stepId, allSteps)

  // Build prior messages: use step templates as "already sent" simulation
  // Also check for real sent messages to this lead in this campaign
  const priorTemplateChain = buildPriorMessages(stepId, allSteps)

  // Optionally fetch real sent messages to this lead in this campaign
  const { data: campaignLead } = await supabase
    .from('campaign_leads')
    .select('id')
    .eq('campaign_id', seq.campaign_id)
    .eq('lead_id', lead_id)
    .maybeSingle()

  let priorMsgs: PriorMessage[] = priorTemplateChain

  if (campaignLead) {
    const { data: realMessages } = await supabase
      .from('messages')
      .select('direction, body, sent_at')
      .eq('campaign_lead_id', (campaignLead as { id: string }).id)
      .order('sent_at', { ascending: true })

    if (realMessages && realMessages.length > 0) {
      // Replace template-based context with real sent messages
      priorMsgs = (realMessages as Array<{ direction: string; body: string }>).map(m => ({
        direction: m.direction as 'sent' | 'received',
        content: m.body as string,
      }))
    }
  }

  const rawTargetForPreview = rawSteps.find(s => (s.id as string) === stepId)
  try {
    const result = await generateSequenceMessage({
      step_type: targetStep.type as SequenceStepType,
      position_in_sequence: position,
      product,
      sender: sender3,
      lead: leadContext,
      prior_messages: priorMsgs,
      icp_notes: icpNotes,
      resolve_variables: true,
      approach: campaignCtx3.message_approach,
      tone: campaignCtx3.message_tone,
      max_words: getStepMaxWords(rawTargetForPreview),
    })

    res.json({
      preview: result.body,
      subject: result.subject,
      lead_name: `${lead.first_name} ${lead.last_name}`,
      lead_company: lead.company,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'AI generation failed' })
  }
})

// ─── POST /api/sequence-ai/:sequenceId/build-flow ────────────────────────────
/**
 * Uses the AI Sequence Architect to design a complete, branch-aware sequence
 * tailored to the campaign's product, audience, approach and tone.
 *
 * Dual mode:
 *   - AI automated (default_ai_mode = true): Creates steps with guidance params
 *     stored in the condition field — no message templates written. The live
 *     message generator uses these params when the step executes.
 *   - Manual (default_ai_mode = false): Creates steps and generates full
 *     placeholder message templates immediately via generateSequenceMessage.
 *
 * Clears existing steps first.
 */
sequenceAiRouter.post('/:sequenceId/build-flow', async (req: Request, res: Response) => {
  const sequenceId = req.params.sequenceId as string

  const seq = await getOwnedSequence(sequenceId, req.user.id)
  if (!seq) { res.status(404).json({ error: 'Sequence not found' }); return }

  // ── 1. Gather campaign context ───────────────────────────────────────────────
  const campaignCtx = await getCampaignContext(seq.campaign_id)

  const { data: campaignRow } = await supabase
    .from('campaigns')
    .select('name, icp_config, product_id')
    .eq('id', seq.campaign_id)
    .single()

  const icp = (campaignRow as any)?.icp_config as Record<string, unknown> | null ?? {}
  const targetRoles      = (icp.target_roles      as string | null) ?? null
  const targetIndustries = (icp.target_industries as string | null) ?? null
  const seniority        = (icp.seniority_levels  as string | null) ?? null
  const keywords         = (icp.keywords          as string | null) ?? null
  const customCriteria   = (icp.custom_criteria   as string | null) ?? null
  const campaignNotes    = (icp.ai_notes          as string | null) ?? null

  // ── 2. Read default_ai_mode from user settings ───────────────────────────────
  const { data: userSettings } = await supabase
    .from('user_settings')
    .select('icp_config')
    .eq('user_id', req.user.id)
    .single()
  const userIcp = (userSettings?.icp_config as Record<string, unknown> | null) ?? {}
  const defaultAiMode = (userIcp.default_ai_mode as boolean | undefined) ?? true

  // ── 3. Resolve product ───────────────────────────────────────────────────────
  const productId = campaignCtx.product_id
  if (!productId) {
    res.status(400).json({ error: 'No product selected for this campaign. Set one under Campaign Settings → Products & Services.' })
    return
  }
  const product = await getProductFromSettings(req.user.id, productId)
  if (!product) {
    res.status(404).json({ error: 'Product not found in your settings.' })
    return
  }

  const [icpNotes, sender] = await Promise.all([
    getIcpNotes(req.user.id),
    getSenderContext(campaignCtx.account_id),
  ])

  // ── 4. Call the Sequence Architect ───────────────────────────────────────────
  const userPrompt = buildBuildFlowUserPrompt({
    product,
    targetRoles,
    targetIndustries,
    seniority,
    keywords,
    customCriteria,
    icpNotes,
    campaignNotes,
    sender,
    approach: campaignCtx.message_approach,
    tone: campaignCtx.message_tone,
    defaultAiMode,
  })

  let flowJson: BuildFlowStructure
  try {
    const resp = await getAi().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: BUILD_FLOW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const raw = (resp.content[0] as { type: string; text: string }).text.trim()
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    flowJson = JSON.parse(cleaned) as BuildFlowStructure
    console.log('[build-flow] Parsed AI response:', JSON.stringify(flowJson, null, 2).slice(0, 2000))
  } catch (err) {
    res.status(500).json({ error: `Sequence Architect failed: ${err instanceof Error ? err.message : String(err)}` })
    return
  }

  const rootSteps = flowJson.steps ?? []
  console.log('[build-flow] rootSteps count:', rootSteps.length, 'isArray:', Array.isArray(rootSteps))
  if (rootSteps.length > 0) console.log('[build-flow] first step:', JSON.stringify(rootSteps[0]))
  if (!Array.isArray(rootSteps) || rootSteps.length === 0) {
    res.status(500).json({ error: 'AI returned an empty sequence structure.' })
    return
  }

  // ── 5. Clear existing steps ──────────────────────────────────────────────────
  await supabase.from('sequence_steps').delete().eq('sequence_id', sequenceId)

  // ── 6. Recursively create all steps ─────────────────────────────────────────
  const genCtx: GenerationContext = {
    product,
    sender,
    icpNotes,
    campaignApproach: campaignCtx.message_approach,
    campaignTone: campaignCtx.message_tone,
  }
  const allCreated: StepNode[] = []

  try {
    await createStepsFromTree(rootSteps, sequenceId, null, 'main', defaultAiMode, genCtx, allCreated, 0)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create sequence steps' })
    return
  }

  // ── 7. Return the final sequence ─────────────────────────────────────────────
  const { data: finalSteps } = await supabase
    .from('sequence_steps')
    .select('*')
    .eq('sequence_id', sequenceId)
    .order('step_order', { ascending: true })

  res.json({
    strategy: flowJson.strategy ?? null,
    rationale: flowJson.rationale ?? null,
    steps: finalSteps ?? [],
    mode: defaultAiMode ? 'ai_automated' : 'manual',
  })
})
