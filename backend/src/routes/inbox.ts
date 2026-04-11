import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { ReplyClassification } from '../types'
import { createSession, closeSession, persistCookies } from '../linkedin/session'
import { sendMessage } from '../linkedin/actions'
import { suggestReplies } from '../ai/suggest'
import { handleUnsubscribe } from '../ai/unsubscribe'
import { classifyReply } from '../ai/classify'
import { scoreEngagement } from '../ai/engagementScore'

export const inboxRouter = Router()

inboxRouter.use(requireAuth)

// GET /api/inbox/unread-count — total unread received messages
inboxRouter.get('/unread-count', async (req: Request, res: Response) => {
  const { count, error } = await supabase
    .from('messages')
    .select(`
      id,
      campaign_lead:campaign_leads!inner (
        campaign:campaigns!inner (user_id)
      )
    `, { count: 'exact', head: true })
    .eq('direction', 'received')
    .eq('is_read', false)
    .eq('campaign_lead.campaign.user_id', req.user.id)

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ count: count ?? 0 })
})

// POST /api/inbox/:campaignLeadId/mark-read — mark all messages in thread as read
inboxRouter.post('/:campaignLeadId/mark-read', async (req: Request, res: Response) => {
  // Verify ownership
  const { data: cl } = await supabase
    .from('campaign_leads')
    .select('id, campaign:campaigns (user_id)')
    .eq('id', req.params.campaignLeadId)
    .single()

  if (!cl || (cl.campaign as { user_id?: string } | null)?.user_id !== req.user.id) {
    res.status(403).json({ error: 'Forbidden' }); return
  }

  await supabase
    .from('messages')
    .update({ is_read: true })
    .eq('campaign_lead_id', req.params.campaignLeadId)
    .eq('direction', 'received')

  res.json({ ok: true })
})

// GET /api/inbox — messages across the user's campaigns
// ?view=sent  → most recent sent message per campaign_lead (for "Sent" tab)
// ?view=replies (default) → received messages only
inboxRouter.get('/', async (req: Request, res: Response) => {
  const { classification, campaign_id, view } = req.query as {
    classification?: ReplyClassification
    campaign_id?: string
    view?: 'replies' | 'sent'
  }

  const direction = view === 'sent' ? 'sent' : 'received'

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
    .eq('direction', direction)
    .order('sent_at', { ascending: false })

  if (campaign_id) {
    query = query.eq('campaign_lead.campaign_id', campaign_id)
  }

  const { data, error } = await query

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  // Filter to user's own data
  const owned = (data ?? []).filter(
    (msg) =>
      msg.campaign_lead &&
      (msg.campaign_lead as { campaign?: { user_id?: string } }).campaign?.user_id === req.user.id
  )

  // For sent view: deduplicate — keep only the most recent sent message per campaign_lead
  let filtered: typeof owned
  if (view === 'sent') {
    const seen = new Set<string>()
    filtered = owned.filter((msg) => {
      const clId = msg.campaign_lead_id as string
      if (seen.has(clId)) return false
      seen.add(clId)
      return true
    })
  } else {
    filtered = classification
      ? owned.filter(
          (msg) =>
            (msg.campaign_lead as { reply_classification?: string })?.reply_classification ===
            classification
        )
      : owned
  }

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

// POST /api/inbox/:campaignLeadId/receive — called by workers when a new LinkedIn reply arrives
inboxRouter.post('/:campaignLeadId/receive', async (req: Request, res: Response) => {
  const { content, linkedin_message_id } = req.body as {
    content?: string
    linkedin_message_id?: string
  }

  if (!content?.trim()) {
    res.status(400).json({ error: 'content is required' })
    return
  }

  // Verify ownership
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select(`
      id, lead_id,
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

  // Save the received message
  const { data: msg, error: msgErr } = await supabase
    .from('messages')
    .insert({
      campaign_lead_id: req.params.campaignLeadId,
      direction: 'received',
      content: content.trim(),
      linkedin_message_id: linkedin_message_id ?? null,
      sent_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (msgErr) {
    res.status(500).json({ error: msgErr.message })
    return
  }

  // Update campaign_lead status → replied
  await supabase
    .from('campaign_leads')
    .update({ status: 'replied' })
    .eq('id', req.params.campaignLeadId)
    .in('status', ['messaged', 'connected']) // only advance if not already further

  // Run unsubscribe detection (fire-and-forget)
  handleUnsubscribe({
    userId: req.user.id,
    leadId: String(cl.lead_id),
    campaignLeadId: String(req.params.campaignLeadId),
    messageContent: content.trim(),
  }).catch(console.error)

  // Auto-classify the reply with AI (fire-and-forget)
  classifyReply(content.trim()).then(async result => {
    if (result.classification !== 'none') {
      await supabase
        .from('campaign_leads')
        .update({ reply_classification: result.classification })
        .eq('id', req.params.campaignLeadId)
    }
  }).catch(console.error)

  // Recalculate engagement score (fire-and-forget)
  scoreEngagement(String(req.params.campaignLeadId)).catch(console.error)

  res.status(201).json({ data: msg })
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

  const lead = (cl.lead as unknown) as { first_name: string; last_name: string; title?: string | null; company?: string | null } | null
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
