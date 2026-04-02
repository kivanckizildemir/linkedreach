import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
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
  ] as const
  type AllowedKey = (typeof allowed)[number]

  const updates: Partial<Record<AllowedKey, unknown>> = {}
  for (const key of allowed) {
    if (key in req.body) {
      updates[key] = req.body[key] as unknown
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
      created_at,
      lead:leads (
        id, first_name, last_name, title, company, industry, location,
        linkedin_url, icp_score, icp_flag
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
