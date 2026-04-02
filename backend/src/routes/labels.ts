import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'

export const labelsRouter = Router()
labelsRouter.use(requireAuth)

// GET /api/labels — list all labels for user
labelsRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('lead_labels')
    .select('*')
    .eq('user_id', req.user.id)
    .order('name')
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data: data ?? [] })
})

// POST /api/labels — create a label
labelsRouter.post('/', async (req: Request, res: Response) => {
  const { name, color } = req.body as { name?: string; color?: string }
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }

  const { data, error } = await supabase
    .from('lead_labels')
    .insert({ user_id: req.user.id, name: name.trim(), color: color ?? '#6366f1' })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') { res.status(409).json({ error: 'Label already exists' }); return }
    res.status(500).json({ error: error.message }); return
  }
  res.status(201).json({ data })
})

// PATCH /api/labels/:id — rename or recolor
labelsRouter.patch('/:id', async (req: Request, res: Response) => {
  const { name, color } = req.body as { name?: string; color?: string }
  const updates: Record<string, unknown> = {}
  if (name?.trim()) updates.name = name.trim()
  if (color) updates.color = color

  const { data, error } = await supabase
    .from('lead_labels')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data })
})

// DELETE /api/labels/:id
labelsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('lead_labels')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(204).send()
})

// GET /api/labels/lead/:leadId — get labels for a lead
labelsRouter.get('/lead/:leadId', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('lead_label_assignments')
    .select('label:lead_labels(*)')
    .eq('lead_id', req.params.leadId)

  if (error) { res.status(500).json({ error: error.message }); return }
  const labels = (data ?? []).map((r: { label: unknown }) => r.label)
  res.json({ data: labels })
})

// POST /api/labels/lead/:leadId — assign a label to a lead
labelsRouter.post('/lead/:leadId', async (req: Request, res: Response) => {
  const { label_id } = req.body as { label_id?: string }
  if (!label_id) { res.status(400).json({ error: 'label_id is required' }); return }

  // Verify label belongs to user
  const { data: label } = await supabase
    .from('lead_labels')
    .select('id')
    .eq('id', label_id)
    .eq('user_id', req.user.id)
    .single()
  if (!label) { res.status(403).json({ error: 'Label not found' }); return }

  const { error } = await supabase
    .from('lead_label_assignments')
    .upsert({ lead_id: req.params.leadId, label_id }, { onConflict: 'lead_id,label_id' })

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(201).json({ ok: true })
})

// DELETE /api/labels/lead/:leadId/:labelId — remove a label from a lead
labelsRouter.delete('/lead/:leadId/:labelId', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('lead_label_assignments')
    .delete()
    .eq('lead_id', req.params.leadId)
    .eq('label_id', req.params.labelId)

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(204).send()
})
