import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'

export const settingsRouter = Router()
settingsRouter.use(requireAuth)

// GET /api/settings — fetch or auto-create user settings
settingsRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle()

  if (error) { res.status(500).json({ error: error.message }); return }

  if (!data) {
    // Auto-create on first access
    const { data: created, error: createErr } = await supabase
      .from('user_settings')
      .insert({ user_id: req.user.id })
      .select()
      .single()
    if (createErr) { res.status(500).json({ error: createErr.message }); return }
    res.json({ data: created })
    return
  }

  res.json({ data })
})

// PATCH /api/settings — update user settings
settingsRouter.patch('/', async (req: Request, res: Response) => {
  const allowed = [
    'icp_config',
    'timezone',
    'daily_connection_limit',
    'daily_message_limit',
  ] as const
  type AllowedKey = (typeof allowed)[number]

  const updates: Partial<Record<AllowedKey, unknown>> = {}
  for (const key of allowed) {
    if (key in req.body) {
      updates[key] = req.body[key] as unknown
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No valid fields to update' })
    return
  }

  // Upsert (auto-create if not exists)
  const { data, error } = await supabase
    .from('user_settings')
    .upsert({ user_id: req.user.id, ...updates, updated_at: new Date().toISOString() })
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data })
})
