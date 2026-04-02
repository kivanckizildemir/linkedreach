import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { ReplyClassification } from '../types'
import { createSession, closeSession, persistCookies } from '../linkedin/session'
import { sendMessage } from '../linkedin/actions'
import { suggestReplies } from '../ai/suggest'

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

// POST /api/inbox/:campaignLeadId/suggest — AI-generated reply suggestions
inboxRouter.post('/:campaignLeadId/suggest', async (req: Request, res: Response) => {
  // Verify ownership
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select(`
      id,
      lead:leads (first_name, last_name, title, company),
      campaign:campaigns (user_id)
    `)
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

  const { data: messages, error: msgErr } = await supabase
    .from('messages')
    .select('direction, content')
    .eq('campaign_lead_id', req.params.campaignLeadId)
    .order('sent_at', { ascending: true })

  if (msgErr) {
    res.status(500).json({ error: msgErr.message })
    return
  }

  const lead = cl.lead as { first_name: string; last_name: string; title?: string | null; company?: string | null } | null
  if (!lead) {
    res.status(400).json({ error: 'Lead not found' })
    return
  }

  try {
    const result = await suggestReplies(
      (messages ?? []) as { direction: 'sent' | 'received'; content: string }[],
      lead
    )
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'AI suggestion failed' })
  }
})

// POST /api/inbox/:campaignLeadId/reply — send a message via LinkedIn Playwright
inboxRouter.post('/:campaignLeadId/reply', async (req: Request, res: Response) => {
  const { message } = req.body as { message?: string }

  if (!message?.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }

  // Verify ownership and get details
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select(`
      id,
      account_id,
      lead:leads (linkedin_url),
      campaign:campaigns (user_id)
    `)
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

  const accountId = cl.account_id as string
  const linkedinUrl = (cl.lead as { linkedin_url?: string } | null)?.linkedin_url
  if (!linkedinUrl) {
    res.status(400).json({ error: 'Lead has no LinkedIn URL' })
    return
  }

  // Get account record
  const { data: account, error: accErr } = await supabase
    .from('linkedin_accounts')
    .select('*')
    .eq('id', accountId)
    .single()

  if (accErr || !account) {
    res.status(404).json({ error: 'LinkedIn account not found' })
    return
  }

  let browser: import('playwright').Browser | undefined

  try {
    const { browser: br, context, page } = await createSession(
      account as { id: string; cookies: string; proxy_id: string | null; status: string }
    )
    browser = br

    await sendMessage(page, linkedinUrl, accountId, message.trim())

    // Save sent message to DB
    await supabase.from('messages').insert({
      campaign_lead_id: req.params.campaignLeadId,
      direction: 'sent',
      content: message.trim(),
      sent_at: new Date().toISOString(),
    })

    await persistCookies(context, accountId)
    await closeSession(browser)

    res.json({ status: 'sent' })
  } catch (err) {
    await browser?.close().catch(() => {})
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send message' })
  }
})
