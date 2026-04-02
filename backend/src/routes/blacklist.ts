import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'

export const blacklistRouter = Router()
blacklistRouter.use(requireAuth)

// GET /api/blacklist
blacklistRouter.get('/', async (req: Request, res: Response) => {
  const { type } = req.query as { type?: string }

  let query = supabase
    .from('blacklist')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (type) query = query.eq('type', type)

  const { data, error } = await query
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data: data ?? [] })
})

// POST /api/blacklist
blacklistRouter.post('/', async (req: Request, res: Response) => {
  const { type, value, note } = req.body as {
    type?: string
    value?: string
    note?: string
  }

  if (!type || !value) {
    res.status(400).json({ error: 'type and value are required' })
    return
  }

  if (!['domain', 'email', 'company'].includes(type)) {
    res.status(400).json({ error: 'type must be domain, email or company' })
    return
  }

  const { data, error } = await supabase
    .from('blacklist')
    .insert({ user_id: req.user.id, type, value: value.toLowerCase().trim(), note })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'Entry already in blacklist' })
    } else {
      res.status(500).json({ error: error.message })
    }
    return
  }

  res.status(201).json({ data })
})

// DELETE /api/blacklist/:id
blacklistRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('blacklist')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})
