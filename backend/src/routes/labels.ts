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

// GET /api/labels/assignments — all label assignments for this user's leads (batch, avoids N+1)
labelsRouter.get('/assignments', async (req: Request, res: Response) => {
  // Step 1: get all lead IDs for this user
  const { data: userLeads, error: leadsErr } = await supabase
    .from('leads')
    .select('id')
    .eq('user_id', req.user.id)

  if (leadsErr) { res.status(500).json({ error: leadsErr.message }); return }

  const leadIds = (userLeads ?? []).map((l: { id: string }) => l.id)
  if (leadIds.length === 0) { res.json({ data: {} }); return }

  // Step 2: fetch all assignments for those leads in one query
  const { data, error } = await supabase
    .from('lead_label_assignments')
    .select('lead_id, label:lead_labels(id, name, color)')
    .in('lead_id', leadIds)

  if (error) { res.status(500).json({ error: error.message }); return }

  // Group by lead_id (Supabase returns label as an array from the join)
  const grouped: Record<string, Array<{ id: string; name: string; color: string }>> = {}
  for (const row of (data ?? []) as unknown as Array<{ lead_id: string; label: Array<{ id: string; name: string; color: string }> | null }>) {
    const labels = Array.isArray(row.label) ? row.label : row.label ? [row.label] : []
    if (labels.length === 0) continue
    if (!grouped[row.lead_id]) grouped[row.lead_id] = []
    grouped[row.lead_id].push(...labels)
  }
  res.json({ data: grouped })
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
