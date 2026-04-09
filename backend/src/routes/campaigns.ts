import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { scoreEngagement } from '../ai/engagementScore'
import { extractAudienceFromProducts } from '../ai/extractAudience'
import { chatGenerateSequence, type ChatMessage } from '../ai/generate-sequence'
import type { CampaignStatus } from '../types'

export const campaignsRouter = Router()

campaignsRouter.use(requireAuth)

// GET /api/campaigns
campaignsRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// POST /api/campaigns/extract-audience — AI-extract target audience from products
campaignsRouter.post('/extract-audience', async (req: Request, res: Response) => {
  const { products } = req.body as {
    products: Array<{ name: string; one_liner?: string; description?: string; target_use_case?: string }>
  }

  if (!Array.isArray(products) || products.length === 0) {
    res.status(400).json({ error: 'products array is required' })
    return
  }

  try {
    const suggestion = await extractAudienceFromProducts(products)
    res.json({ data: suggestion })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// GET /api/campaigns/:id — includes sequences
campaignsRouter.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select(`
      *,
      sequences (
        *,
        sequence_steps (*)
      )
    `)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error) {
    res.status(404).json({ error: 'Campaign not found' })
    return
  }

  res.json({ data })
})

// POST /api/campaigns
campaignsRouter.post('/', async (req: Request, res: Response) => {
  const {
    name,
    icp_config,
    daily_connection_limit,
    daily_message_limit,
    schedule_start_hour,
    schedule_end_hour,
    schedule_days,
    schedule_timezone,
  } = req.body as {
    name: string
    icp_config?: Record<string, unknown>
    daily_connection_limit?: number
    daily_message_limit?: number
    schedule_start_hour?: number
    schedule_end_hour?: number
    schedule_days?: number[]
    schedule_timezone?: string
  }

  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }

  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      user_id: req.user.id,
      name,
      status: 'draft',
      icp_config: icp_config ?? {},
      daily_connection_limit: daily_connection_limit ?? 25,
      daily_message_limit: daily_message_limit ?? 100,
      schedule_start_hour: schedule_start_hour ?? 9,
      schedule_end_hour: schedule_end_hour ?? 17,
      schedule_days: schedule_days ?? [1, 2, 3, 4, 5],
      schedule_timezone: schedule_timezone ?? 'UTC',
    })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json({ data })
})

// PATCH /api/campaigns/:id
campaignsRouter.patch('/:id', async (req: Request, res: Response) => {
  const allowed = [
    'name',
    'status',
    'icp_config',
    'daily_connection_limit',
    'daily_message_limit',
    'schedule_start_hour',
    'schedule_end_hour',
    'schedule_days',
    'schedule_timezone',
    'account_id',
    'min_icp_score',
    'connection_note',
    'target_audience',
    'product_id',
  ] as const
  type AllowedKey = (typeof allowed)[number]

  const updates: Partial<Record<AllowedKey, unknown>> = {}
  for (const key of allowed) {
    if (key in req.body) {
      updates[key] = req.body[key] as unknown
    }
  }

  // message_approach and message_tone are stored inside icp_config JSONB
  const hasApproachOrTone = 'message_approach' in req.body || 'message_tone' in req.body
  if (hasApproachOrTone) {
    const { data: existing } = await supabase
      .from('campaigns')
      .select('icp_config')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single()
    const currentIcp = (existing as { icp_config: Record<string, unknown> } | null)?.icp_config ?? {}
    updates.icp_config = {
      ...currentIcp,
      ...(updates.icp_config as Record<string, unknown> ?? {}),
      ...('message_approach' in req.body ? { message_approach: req.body.message_approach } : {}),
      ...('message_tone' in req.body ? { message_tone: req.body.message_tone } : {}),
    }
  }

  if (updates.status) {
    const validStatuses: CampaignStatus[] = ['draft', 'active', 'paused', 'completed']
    if (!validStatuses.includes(updates.status as CampaignStatus)) {
      res.status(400).json({ error: 'Invalid status value' })
      return
    }
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// DELETE /api/campaigns/:id
campaignsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})

// ── Campaign Leads ──────────────────────────────────────────────────────────

// GET /api/campaigns/:id/leads — campaign_leads joined with lead profile data
campaignsRouter.get('/:id/leads', async (req: Request, res: Response) => {
  // Verify ownership
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (campErr || !campaign) {
    res.status(404).json({ error: 'Campaign not found' })
    return
  }

  const { data, error } = await supabase
    .from('campaign_leads')
    .select(`
      id,
      status,
      current_step,
      last_action_at,
      reply_classification,
      account_id,
      campaign_fit_score,
      campaign_fit_reasoning,
      created_at,
      lead:leads (
        id, first_name, last_name, title, company, industry, location,
        linkedin_url, icp_score, icp_flag, raw_data
      )
    `)
    .eq('campaign_id', req.params.id)
    .order('created_at', { ascending: false })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// POST /api/campaigns/:id/leads — assign leads to campaign
campaignsRouter.post('/:id/leads', async (req: Request, res: Response) => {
  const { lead_ids, account_id } = req.body as {
    lead_ids: string[]
    account_id?: string
  }

  if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
    res.status(400).json({ error: 'lead_ids array is required' })
    return
  }

  // Verify campaign ownership
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (campErr || !campaign) {
    res.status(404).json({ error: 'Campaign not found' })
    return
  }

  // Skip leads already in this campaign
  const { data: existing } = await supabase
    .from('campaign_leads')
    .select('lead_id')
    .eq('campaign_id', req.params.id)
    .in('lead_id', lead_ids)

  const existingIds = new Set((existing ?? []).map((r: { lead_id: string }) => r.lead_id))
  const newLeadIds = lead_ids.filter(id => !existingIds.has(id))

  if (newLeadIds.length === 0) {
    res.status(200).json({ data: [], added: 0, message: 'All leads already in campaign' })
    return
  }

  const rows = newLeadIds.map(lead_id => ({
    campaign_id: req.params.id,
    lead_id,
    account_id: account_id ?? null,
    status: 'pending',
    current_step: 0,
  }))

  const { data, error } = await supabase
    .from('campaign_leads')
    .insert(rows)
    .select()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json({ data, added: data?.length ?? 0 })
})

// DELETE /api/campaigns/:id/leads/:clId — remove a lead from campaign
campaignsRouter.delete('/:id/leads/:clId', async (req: Request, res: Response) => {
  // Verify ownership via campaign
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (campErr || !campaign) {
    res.status(404).json({ error: 'Campaign not found' })
    return
  }

  const { error } = await supabase
    .from('campaign_leads')
    .delete()
    .eq('id', req.params.clId)
    .eq('campaign_id', req.params.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})

// POST /api/campaigns/:id/score-engagement — recalculate engagement scores for all (or selected) leads
campaignsRouter.post('/:id/score-engagement', async (req: Request, res: Response) => {
  // Verify campaign ownership
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('id, user_id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (campErr || !campaign) {
    res.status(404).json({ error: 'Campaign not found' })
    return
  }

  // Fetch campaign leads (optionally filtered by specific IDs)
  const campaign_lead_ids = (req.body as { campaign_lead_ids?: string[] } | undefined)?.campaign_lead_ids
  let query = supabase
    .from('campaign_leads')
    .select('id')
    .eq('campaign_id', req.params.id)
  if (Array.isArray(campaign_lead_ids) && campaign_lead_ids.length > 0) {
    query = query.in('id', campaign_lead_ids)
  }
  const { data: clRows, error: clErr } = await query

  if (clErr || !clRows) {
    res.status(500).json({ error: clErr?.message ?? 'Failed to fetch campaign leads' })
    return
  }

  let scored = 0
  for (const cl of clRows as Array<{ id: string }>) {
    try {
      await scoreEngagement(cl.id)
      scored++
    } catch (e) {
      console.warn(`[score-engagement] Failed for campaign_lead ${cl.id}:`, (e as Error).message)
    }
  }

  res.json({ scored, total: clRows.length })
})

// POST /api/campaigns/:id/chat-sequence
// Chat with AI to generate a sequence. Returns a conversational reply
// and optionally a structured steps array to apply to the sequence.
campaignsRouter.post('/:id/chat-sequence', async (req: Request, res: Response) => {
  const { id } = req.params
  const { messages, sequenceId } = req.body as {
    messages:   ChatMessage[]
    sequenceId: string | null
  }

  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'messages must be an array' }); return
  }

  // Verify campaign belongs to the authenticated user
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('name, target_audience')
    .eq('id', id)
    .eq('user_id', req.user.id)
    .single()

  if (campErr || !campaign) {
    res.status(404).json({ error: 'Campaign not found' }); return
  }

  // Summarise existing steps so Claude has context
  let existingSteps = ''
  if (sequenceId) {
    const { data: steps } = await supabase
      .from('sequence_steps')
      .select('type, step_order, message_template, wait_days, branch')
      .eq('sequence_id', sequenceId)
      .order('step_order', { ascending: true })

    if (steps?.length) {
      existingSteps = (steps as Array<{
        type: string; step_order: number; message_template: string | null
        wait_days: number | null; branch: string
      }>)
        .map(s =>
          `${s.step_order + 1}. [${s.branch}] ${s.type}` +
          (s.wait_days ? ` (${s.wait_days}d)` : '') +
          (s.message_template ? ': ' + s.message_template.substring(0, 60) + '…' : '')
        )
        .join('\n')
    }
  }

  try {
    const result = await chatGenerateSequence(messages, {
      name:           (campaign as { name: string; target_audience: string | null }).name,
      targetAudience: (campaign as { name: string; target_audience: string | null }).target_audience,
      existingSteps,
    })
    res.json(result)
  } catch (err) {
    console.error('[chat-sequence] AI error:', (err as Error).message)
    res.status(500).json({ error: 'AI generation failed. Please try again.' })
  }
})
