import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { generateMessage } from '../ai/generate-message'
import type { MessageType, Approach, SenderContext } from '../ai/generate-message'

export const messageTemplatesRouter = Router()
messageTemplatesRouter.use(requireAuth)

// GET /api/message-templates
messageTemplatesRouter.get('/', async (req: Request, res: Response) => {
  const { type } = req.query as { type?: string }

  let query = supabase
    .from('message_templates')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (type) query = query.eq('type', type)

  const { data, error } = await query
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data: data ?? [] })
})

// POST /api/message-templates
messageTemplatesRouter.post('/', async (req: Request, res: Response) => {
  const { name, type, subject, body } = req.body as {
    name?: string
    type?: string
    subject?: string
    body?: string
  }

  if (!name || !body) {
    res.status(400).json({ error: 'name and body are required' })
    return
  }

  // Extract variables like {{first_name}}, {{company}} from body
  const matches = body.match(/\{\{[a-z_]+\}\}/g) ?? []
  const variables = [...new Set(matches)]

  const { data, error } = await supabase
    .from('message_templates')
    .insert({
      user_id: req.user.id,
      name,
      type: type ?? 'message',
      subject: subject ?? null,
      body,
      variables,
    })
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(201).json({ data })
})

// PATCH /api/message-templates/:id
messageTemplatesRouter.patch('/:id', async (req: Request, res: Response) => {
  const { name, type, subject, body } = req.body as {
    name?: string
    type?: string
    subject?: string
    body?: string
  }

  const updates: Record<string, unknown> = {}
  if (name) updates.name = name
  if (type) updates.type = type
  if (subject !== undefined) updates.subject = subject
  if (body !== undefined) {
    updates.body = body
    updates.variables = [...new Set(body.match(/\{\{[a-z_]+\}\}/g) ?? [])]
  }
  updates.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('message_templates')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data })
})

// POST /api/message-templates/generate
// Body: { type, approach, product_index?, campaign_id? }
//   campaign_id: if provided, pulls tone and sender from that campaign's account
messageTemplatesRouter.post('/generate', async (req: Request, res: Response) => {
  const { type, approach, product_index, campaign_id } = req.body as {
    type?: MessageType
    approach?: Approach
    product_index?: number
    campaign_id?: string
  }

  if (!type || !approach) {
    res.status(400).json({ error: 'type and approach are required' })
    return
  }

  // Fetch ICP config and optionally campaign context in parallel
  const [settingsRes, campaignRes] = await Promise.all([
    supabase.from('user_settings').select('icp_config').eq('user_id', req.user.id).single(),
    campaign_id
      ? supabase.from('campaigns').select('account_id, icp_config').eq('id', campaign_id).eq('user_id', req.user.id).single()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (settingsRes.error || !settingsRes.data) {
    res.status(500).json({ error: 'Could not load your ICP settings' })
    return
  }

  // Resolve campaign tone and sender identity
  let tone: string | null = null
  let sender: SenderContext | null = null

  if (campaignRes.data) {
    const campData = campaignRes.data as { account_id?: string | null; icp_config?: Record<string, unknown> | null }
    const icp = campData.icp_config ?? {}
    tone = (icp.message_tone as string) ?? null

    if (campData.account_id) {
      const { data: acc } = await supabase
        .from('linkedin_accounts')
        .select('sender_name, sender_headline, sender_about')
        .eq('id', campData.account_id)
        .single()
      if (acc && (acc as { sender_name?: string | null }).sender_name) {
        sender = {
          name: (acc as { sender_name: string }).sender_name,
          headline: (acc as { sender_headline?: string | null }).sender_headline ?? null,
          about: (acc as { sender_about?: string | null }).sender_about ?? null,
        }
      }
    }
  }

  try {
    const result = await generateMessage({
      type,
      approach,
      icp_config: settingsRes.data.icp_config as Record<string, unknown> as Parameters<typeof generateMessage>[0]['icp_config'],
      product_index,
      sender,
      tone,
    })
    res.json({ data: result })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'AI generation failed'
    res.status(500).json({ error: msg })
  }
})

// DELETE /api/message-templates/:id
messageTemplatesRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('message_templates')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(204).send()
})

// --- Lead Notes ---

// GET /api/message-templates/lead-notes/:leadId
messageTemplatesRouter.get('/lead-notes/:leadId', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('lead_notes')
    .select('*')
    .eq('lead_id', req.params.leadId)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data: data ?? [] })
})

// POST /api/message-templates/lead-notes/:leadId
messageTemplatesRouter.post('/lead-notes/:leadId', async (req: Request, res: Response) => {
  const { content } = req.body as { content?: string }
  if (!content?.trim()) {
    res.status(400).json({ error: 'content is required' })
    return
  }

  const { data, error } = await supabase
    .from('lead_notes')
    .insert({ user_id: req.user.id, lead_id: req.params.leadId, content: content.trim() })
    .select()
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(201).json({ data })
})

// DELETE /api/message-templates/lead-notes/:noteId
messageTemplatesRouter.delete('/lead-notes/note/:noteId', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('lead_notes')
    .delete()
    .eq('id', req.params.noteId)
    .eq('user_id', req.user.id)

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(204).send()
})
