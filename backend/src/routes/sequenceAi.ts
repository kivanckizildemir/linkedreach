import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import {
  generateSequenceMessage,
  buildPriorChain,
  getMessagePosition,
  type StepNode,
  type ProductContext,
  type LeadContext,
  type PriorMessage,
  type SequenceStepType,
} from '../ai/generate-sequence-message'

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

/** Fetch campaign-level context (product_id, message_approach, message_tone).
 *  approach and tone live inside icp_config JSONB to avoid requiring a migration. */
async function getCampaignContext(campaignId: string): Promise<{ product_id: string | null; message_approach: string | null; message_tone: string | null }> {
  const { data } = await supabase
    .from('campaigns')
    .select('product_id, icp_config')
    .eq('id', campaignId)
    .single()
  const icp = (data as any)?.icp_config as Record<string, unknown> | null
  return {
    product_id: (data as any)?.product_id ?? null,
    message_approach: (icp?.message_approach as string) ?? null,
    message_tone: (icp?.message_tone as string) ?? null,
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

  const icpNotes = await getIcpNotes(req.user.id)

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

  // Use a placeholder lead for the "generate all" authoring context
  // Real personalisation happens at send time via personalise.ts
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

  // Process steps in order (step_order ascending, already sorted)
  for (const step of allSteps) {
    if (!MESSAGE_TYPES.has(step.type)) continue

    const position = getMessagePosition(step.id, allSteps)

    // Build prior messages from already-processed steps (updated in-memory)
    const priorMsgs = buildPriorMessages(step.id, allSteps)

    try {
      const result = await generateSequenceMessage({
        step_type: step.type as SequenceStepType,
        position_in_sequence: position,
        product,
        lead: placeholderLead,
        prior_messages: priorMsgs,
        icp_notes: icpNotes,
        resolve_variables: false,
        approach: campaignCtx.message_approach,
        tone: campaignCtx.message_tone,
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
  const { product_id: bodyProductId } = req.body as { product_id?: string }

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

  const icpNotes = await getIcpNotes(req.user.id)

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

  const result = await generateSequenceMessage({
    step_type: targetStep.type as SequenceStepType,
    position_in_sequence: position,
    product,
    lead: placeholderLead,
    prior_messages: priorMsgs,
    icp_notes: icpNotes,
    resolve_variables: false,
    approach: campaignCtx2.message_approach,
    tone: campaignCtx2.message_tone,
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

  // Verify lead belongs to user
  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, first_name, last_name, title, company, industry, location, raw_data')
    .eq('id', lead_id)
    .eq('user_id', req.user.id)
    .single()

  if (leadErr || !lead) { res.status(404).json({ error: 'Lead not found' }); return }

  // Get product + approach/tone
  const campaignCtx3 = await getCampaignContext(seq.campaign_id)
  const productId = campaignCtx3.product_id
  const product: ProductContext = productId
    ? (await getProductFromSettings(req.user.id, productId)) ?? { name: 'our product' }
    : { name: 'our product' }

  const icpNotes = await getIcpNotes(req.user.id)

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

  // Build lead context with real data
  const rawData = (lead.raw_data as Record<string, unknown> | null) ?? {}
  const leadContext: LeadContext = {
    first_name: lead.first_name as string,
    last_name: lead.last_name as string,
    title: lead.title as string | null,
    company: lead.company as string | null,
    industry: lead.industry as string | null,
    location: lead.location as string | null,
    opening_line: rawData.opening_line as string | null,
    recent_posts: Array.isArray(rawData.recent_posts) ? rawData.recent_posts as string[] : undefined,
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

  try {
    const result = await generateSequenceMessage({
      step_type: targetStep.type as SequenceStepType,
      position_in_sequence: position,
      product,
      lead: leadContext,
      prior_messages: priorMsgs,
      icp_notes: icpNotes,
      resolve_variables: true,   // ← substitutes real values, no {{placeholders}}
      approach: campaignCtx3.message_approach,
      tone: campaignCtx3.message_tone,
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
