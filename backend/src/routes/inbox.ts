import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { ReplyClassification } from '../types'

export const inboxRouter = Router()

inboxRouter.use(requireAuth)

// GET /api/inbox — all received messages across the user's campaigns
// Joins campaign_leads → campaigns to enforce ownership
inboxRouter.get('/', async (req: Request, res: Response) => {
  const { classification, campaign_id } = req.query as {
    classification?: ReplyClassification
    campaign_id?: string
  }

  let query = supabase
    .from('messages')
    .select(`
      *,
      campaign_lead:campaign_leads (
        id,
        status,
        reply_classification,
        lead:leads (id, first_name, last_name, linkedin_url, title, company),
        campaign:campaigns (id, name, user_id)
      )
    `)
    .eq('direction', 'received')
    .order('sent_at', { ascending: false })

  if (campaign_id) {
    query = query.eq('campaign_lead.campaign_id', campaign_id)
  }

  const { data, error } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Filter to user's own data (RLS handles this, but we double-check)
  const owned = (data ?? []).filter(
    (msg) =>
      msg.campaign_lead &&
      (msg.campaign_lead as { campaign?: { user_id?: string } }).campaign?.user_id === req.user.id
  )

  const filtered =
    classification
      ? owned.filter(
          (msg) =>
            (msg.campaign_lead as { reply_classification?: string })?.reply_classification ===
            classification
        )
      : owned

  res.json({ data: filtered })
})

// GET /api/inbox/:campaignLeadId — full conversation thread
inboxRouter.get('/:campaignLeadId', async (req: Request, res: Response) => {
  // Verify ownership
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select('id, campaign:campaigns (user_id)')
    .eq('id', req.params.campaignLeadId)
    .single()

  if (clErr || !cl) {
    res.status(404).json({ error: 'Conversation not found' })
    return
  }

  const campaignUserid = (cl.campaign as { user_id?: string } | null)?.user_id
  if (campaignUserid !== req.user.id) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('campaign_lead_id', req.params.campaignLeadId)
    .order('sent_at', { ascending: true })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// PATCH /api/inbox/:campaignLeadId — update reply_classification or status
inboxRouter.patch('/:campaignLeadId', async (req: Request, res: Response) => {
  const { reply_classification, status } = req.body as {
    reply_classification?: ReplyClassification
    status?: string
  }

  // Verify ownership first
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select('id, campaign:campaigns (user_id)')
    .eq('id', req.params.campaignLeadId)
    .single()

  if (clErr || !cl) {
    res.status(404).json({ error: 'Conversation not found' })
    return
  }

  const campaignUserId = (cl.campaign as { user_id?: string } | null)?.user_id
  if (campaignUserId !== req.user.id) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const updates: Record<string, unknown> = {}
  if (reply_classification) updates.reply_classification = reply_classification
  if (status) updates.status = status

  const { data, error } = await supabase
    .from('campaign_leads')
    .update(updates)
    .eq('id', req.params.campaignLeadId)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})
