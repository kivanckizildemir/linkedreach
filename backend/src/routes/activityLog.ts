import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'

export const activityLogRouter = Router()
activityLogRouter.use(requireAuth)

// GET /api/activity — list recent activity
activityLogRouter.get('/', async (req: Request, res: Response) => {
  const { account_id, limit = '100' } = req.query as {
    account_id?: string
    limit?: string
  }

  let query = supabase
    .from('activity_log')
    .select(`
      id, action, detail, created_at,
      account_id, campaign_id, lead_id
    `)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(Math.min(parseInt(limit, 10) || 100, 500))

  if (account_id) {
    query = query.eq('account_id', account_id)
  }

  const { data, error } = await query
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data: data ?? [] })
})

// POST /api/activity — log an action (used internally by workers too)
activityLogRouter.post('/', async (req: Request, res: Response) => {
  const { account_id, campaign_id, lead_id, action, detail } = req.body as {
    account_id?: string
    campaign_id?: string
    lead_id?: string
    action: string
    detail?: string
  }

  if (!action) { res.status(400).json({ error: 'action is required' }); return }

  const { data, error } = await supabase
    .from('activity_log')
    .insert({
      user_id: req.user.id,
      account_id: account_id ?? null,
      campaign_id: campaign_id ?? null,
      lead_id: lead_id ?? null,
      action,
      detail: detail ?? null,
    })
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(201).json({ data })
})
