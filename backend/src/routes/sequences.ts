import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { StepType } from '../types'

export const sequencesRouter = Router()

sequencesRouter.use(requireAuth)

// Verify the campaign belongs to the user before mutating sequences
async function campaignBelongsToUser(campaignId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('user_id', userId)
    .single()
  return !!data
}

// GET /api/sequences?campaign_id=xxx
sequencesRouter.get('/', async (req: Request, res: Response) => {
  const { campaign_id } = req.query as { campaign_id?: string }

  if (!campaign_id) {
    res.status(400).json({ error: 'campaign_id query param is required' })
    return
  }

  const owned = await campaignBelongsToUser(campaign_id, req.user.id)
  if (!owned) {
    res.status(404).json({ error: 'Campaign not found' })
    return
  }

  const { data, error } = await supabase
    .from('sequences')
    .select(`*, sequence_steps (*)`)
    .eq('campaign_id', campaign_id)
    .order('created_at', { ascending: true })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// POST /api/sequences
sequencesRouter.post('/', async (req: Request, res: Response) => {
  const { campaign_id, name } = req.body as { campaign_id: string; name: string }

  if (!campaign_id || !name) {
    res.status(400).json({ error: 'campaign_id and name are required' })
    return
  }

  const owned = await campaignBelongsToUser(campaign_id, req.user.id)
  if (!owned) {
    res.status(404).json({ error: 'Campaign not found' })
    return
  }

  const { data, error } = await supabase
    .from('sequences')
    .insert({ campaign_id, name })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json({ data })
})

// DELETE /api/sequences/:id
sequencesRouter.delete('/:id', async (req: Request, res: Response) => {
  // Fetch sequence to confirm ownership via campaign
  const { data: seq, error: fetchErr } = await supabase
    .from('sequences')
    .select('campaign_id')
    .eq('id', req.params.id)
    .single()

  if (fetchErr || !seq) {
    res.status(404).json({ error: 'Sequence not found' })
    return
  }

  const owned = await campaignBelongsToUser(seq.campaign_id as string, req.user.id)
  if (!owned) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const { error } = await supabase
    .from('sequences')
    .delete()
    .eq('id', req.params.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})

// POST /api/sequences/:id/steps
sequencesRouter.post('/:id/steps', async (req: Request, res: Response) => {
  const { data: seq, error: fetchErr } = await supabase
    .from('sequences')
    .select('campaign_id')
    .eq('id', req.params.id)
    .single()

  if (fetchErr || !seq) {
    res.status(404).json({ error: 'Sequence not found' })
    return
  }

  const owned = await campaignBelongsToUser(seq.campaign_id as string, req.user.id)
  if (!owned) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const { type, step_order, message_template, wait_days, condition, subject, parent_step_id, branch } = req.body as {
    type: StepType
    step_order: number
    message_template?: string
    wait_days?: number
    condition?: Record<string, unknown>
    subject?: string
    parent_step_id?: string
    branch?: 'main' | 'if_yes' | 'if_no'
  }

  const validTypes: StepType[] = ['connect', 'message', 'wait', 'inmail', 'view_profile', 'react_post', 'fork', 'follow', 'end']
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` })
    return
  }

  if (type === 'inmail' && !subject) {
    res.status(400).json({ error: 'subject is required for inmail steps' })
    return
  }

  const { data, error } = await supabase
    .from('sequence_steps')
    .insert({
      sequence_id: req.params.id,
      type,
      step_order,
      message_template: message_template ?? null,
      wait_days: wait_days ?? null,
      condition: condition ?? null,
      subject: subject ?? null,
      parent_step_id: parent_step_id ?? null,
      branch: branch ?? 'main',
    })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json({ data })
})

// PATCH /api/sequences/:id/steps/:stepId
sequencesRouter.patch('/:id/steps/:stepId', async (req: Request, res: Response) => {
  const { data: seq, error: fetchErr } = await supabase
    .from('sequences')
    .select('campaign_id')
    .eq('id', req.params.id)
    .single()

  if (fetchErr || !seq) {
    res.status(404).json({ error: 'Sequence not found' })
    return
  }

  const owned = await campaignBelongsToUser(seq.campaign_id as string, req.user.id)
  if (!owned) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const allowed = ['type', 'step_order', 'message_template', 'wait_days', 'condition', 'subject', 'parent_step_id', 'branch', 'ai_generation_mode'] as const
  type AllowedKey = (typeof allowed)[number]

  const updates: Partial<Record<AllowedKey, unknown>> = {}
  for (const key of allowed) {
    if (key in req.body) {
      updates[key] = req.body[key] as unknown
    }
  }

  const { data, error } = await supabase
    .from('sequence_steps')
    .update(updates)
    .eq('id', req.params.stepId)
    .eq('sequence_id', req.params.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// DELETE /api/sequences/:id/steps — bulk-clear all steps in a sequence
sequencesRouter.delete('/:id/steps', async (req: Request, res: Response) => {
  const { data: seq, error: fetchErr } = await supabase
    .from('sequences')
    .select('campaign_id')
    .eq('id', req.params.id)
    .single()

  if (fetchErr || !seq) {
    res.status(404).json({ error: 'Sequence not found' })
    return
  }

  const owned = await campaignBelongsToUser(seq.campaign_id as string, req.user.id)
  if (!owned) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const { error } = await supabase
    .from('sequence_steps')
    .delete()
    .eq('sequence_id', req.params.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})

// DELETE /api/sequences/:id/steps/:stepId
sequencesRouter.delete('/:id/steps/:stepId', async (req: Request, res: Response) => {
  const { data: seq, error: fetchErr } = await supabase
    .from('sequences')
    .select('campaign_id')
    .eq('id', req.params.id)
    .single()

  if (fetchErr || !seq) {
    res.status(404).json({ error: 'Sequence not found' })
    return
  }

  const owned = await campaignBelongsToUser(seq.campaign_id as string, req.user.id)
  if (!owned) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const { error } = await supabase
    .from('sequence_steps')
    .delete()
    .eq('id', req.params.stepId)
    .eq('sequence_id', req.params.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})
