import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import Anthropic from '@anthropic-ai/sdk'

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

// POST /api/settings/extract-product — fetch a URL and extract product info via AI
settingsRouter.post('/extract-product', async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string }
  if (!url?.trim()) { res.status(400).json({ error: 'url is required' }); return }

  // Normalise URL
  let target = url.trim()
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target

  // Fetch the page with a 10s timeout
  let html: string
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkedReach/1.0)' },
      redirect: 'follow',
    })
    clearTimeout(timer)
    if (!response.ok) { res.status(422).json({ error: `Site returned ${response.status}` }); return }
    html = await response.text()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch URL'
    res.status(422).json({ error: msg }); return
  }

  // Extract priority signals before stripping tags
  const titleMatch   = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const descMatch    = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
                    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
  const ogDescMatch  = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
                    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)

  const metaSignals = [
    titleMatch?.[1],
    ogTitleMatch?.[1],
    descMatch?.[1],
    ogDescMatch?.[1],
  ].filter(Boolean).join('\n')

  // Strip scripts, styles, nav, footer, then all tags; keep body text
  const bodyText = html
    .replace(/<(script|style|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 4000)

  const pageContent = `META SIGNALS:\n${metaSignals}\n\nPAGE TEXT (truncated):\n${bodyText}`

  // Ask Claude to extract product info
  const message = await ai.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `You are analysing a company website to extract product/service information for a sales outreach tool.

From the page content below, extract:
1. The main product or service name (concise, 2–6 words)
2. A clear description of what it does and the problem it solves (2–3 sentences)
3. The ideal target customer / use case (1–2 sentences describing who benefits most)

Page content:
${pageContent}

Respond ONLY with valid JSON, no markdown:
{
  "name": "...",
  "description": "...",
  "target_use_case": "..."
}`,
    }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

  try {
    const result = JSON.parse(json) as { name: string; description: string; target_use_case: string }
    res.json({ data: result })
  } catch {
    res.status(500).json({ error: 'AI returned unexpected format' })
  }
})

// Shared handler for PATCH and POST /api/settings
async function handleSettingsUpdate(req: Request, res: Response) {
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
}

// PATCH /api/settings — update user settings
settingsRouter.patch('/', handleSettingsUpdate)

// POST /api/settings — alias for PATCH (proxy-friendly for Cloudflare)
settingsRouter.post('/', handleSettingsUpdate)
