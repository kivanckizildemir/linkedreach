import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { ProxyAgent } from 'undici'

export const proxiesRouter = Router()
proxiesRouter.use(requireAuth)

// ── Helpers ───────────────────────────────────────────────────────────────────

function maskUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (u.password) u.password = '••••'
    return u.toString()
  } catch {
    return raw
  }
}

/**
 * Test a proxy by making a real HTTP request through it.
 * Uses the same HttpsProxyAgent approach as the rest of the app.
 */
async function testProxyUrl(rawUrl: string): Promise<{ ok: boolean; result: string }> {
  // Auto-prepend http:// if no scheme given
  const proxyUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`
  try {
    new URL(proxyUrl)
  } catch (e) {
    return { ok: false, result: `INVALID_URL: ${(e as Error).message}` }
  }

  const agent = new ProxyAgent(proxyUrl)
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      dispatcher: agent,
      signal: AbortSignal.timeout(10_000),
    } as RequestInit)
    if (res.ok) {
      const { ip } = await res.json() as { ip: string }
      return { ok: true, result: `Connected — outbound IP: ${ip}` }
    }
    return { ok: false, result: `HTTP ${res.status} from proxy` }
  } catch (e) {
    const err = e as Error & { cause?: unknown }
    const cause = err.cause instanceof Error ? err.cause.message : JSON.stringify(err.cause ?? '')
    return { ok: false, result: `PROXY_ERROR: ${err.message} — ${cause}` }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/proxies
proxiesRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('proxies')
    .select('id, label, proxy_url, assigned_account_id, is_available, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) { res.status(500).json({ error: error.message }); return }

  // Mask credentials before sending to frontend
  const masked = (data ?? []).map(p => ({ ...p, proxy_url: maskUrl(p.proxy_url as string) }))
  res.json({ data: masked })
})

// POST /api/proxies — add a single proxy
proxiesRouter.post('/', async (req: Request, res: Response) => {
  const { proxy_url, label } = req.body as { proxy_url?: string; label?: string }

  if (!proxy_url) { res.status(400).json({ error: 'proxy_url is required' }); return }

  try { new URL(proxy_url) } catch {
    res.status(400).json({ error: 'Invalid proxy URL. Format: protocol://user:pass@host:port' })
    return
  }

  const { data, error } = await supabase
    .from('proxies')
    .insert({ proxy_url, label: label?.trim() || null, user_id: req.user.id, is_available: true })
    .select('id, label, proxy_url, assigned_account_id, is_available, created_at')
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(201).json({ data: { ...data, proxy_url: maskUrl(data.proxy_url as string) } })
})

// POST /api/proxies/bulk — import multiple proxies from newline-separated list
proxiesRouter.post('/bulk', async (req: Request, res: Response) => {
  const { lines, label_prefix } = req.body as { lines?: string; label_prefix?: string }

  if (!lines?.trim()) { res.status(400).json({ error: 'lines is required' }); return }

  const urls = lines
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)

  const valid: { proxy_url: string; label: string | null; user_id: string; is_available: boolean }[] = []
  const invalid: string[] = []

  urls.forEach((url, i) => {
    try {
      new URL(url)
      valid.push({
        proxy_url: url,
        label: label_prefix ? `${label_prefix} ${i + 1}` : null,
        user_id: req.user.id,
        is_available: true,
      })
    } catch {
      invalid.push(url)
    }
  })

  if (valid.length === 0) {
    res.status(400).json({ error: 'No valid proxy URLs found', invalid })
    return
  }

  const { data, error } = await supabase
    .from('proxies')
    .insert(valid)
    .select('id, label, proxy_url, assigned_account_id, is_available, created_at')

  if (error) { res.status(500).json({ error: error.message }); return }

  res.status(201).json({
    data: (data ?? []).map(p => ({ ...p, proxy_url: maskUrl(p.proxy_url as string) })),
    imported: valid.length,
    skipped: invalid.length,
    invalid,
  })
})

// PATCH /api/proxies/:id — update label
proxiesRouter.patch('/:id', async (req: Request, res: Response) => {
  const { label } = req.body as { label?: string }

  const { data, error } = await supabase
    .from('proxies')
    .update({ label: label?.trim() || null })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select('id, label, proxy_url, assigned_account_id, is_available, created_at')
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ data: { ...data, proxy_url: maskUrl(data.proxy_url as string) } })
})

// POST /api/proxies/:id/assign — assign proxy to an account (or unassign)
proxiesRouter.post('/:id/assign', async (req: Request, res: Response) => {
  const { account_id } = req.body as { account_id?: string | null }

  // Verify proxy belongs to this user
  const { data: proxy, error: proxyErr } = await supabase
    .from('proxies')
    .select('id, assigned_account_id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (proxyErr || !proxy) { res.status(404).json({ error: 'Proxy not found' }); return }

  if (account_id) {
    // Verify account belongs to this user
    const { data: account, error: accountErr } = await supabase
      .from('linkedin_accounts')
      .select('id')
      .eq('id', account_id)
      .eq('user_id', req.user.id)
      .single()

    if (accountErr || !account) { res.status(404).json({ error: 'Account not found' }); return }

    // Free any proxy currently assigned to this account
    await supabase
      .from('proxies')
      .update({ assigned_account_id: null, is_available: true })
      .eq('assigned_account_id', account_id)
      .eq('user_id', req.user.id)

    // Assign proxy to account
    await supabase
      .from('proxies')
      .update({ assigned_account_id: account_id, is_available: false })
      .eq('id', req.params.id)

    await supabase
      .from('linkedin_accounts')
      .update({ proxy_id: req.params.id })
      .eq('id', account_id)
      .eq('user_id', req.user.id)

  } else {
    // Unassign
    const oldAccountId = (proxy as { assigned_account_id: string | null }).assigned_account_id
    if (oldAccountId) {
      await supabase
        .from('linkedin_accounts')
        .update({ proxy_id: null })
        .eq('id', oldAccountId)
        .eq('user_id', req.user.id)
    }
    await supabase
      .from('proxies')
      .update({ assigned_account_id: null, is_available: true })
      .eq('id', req.params.id)
  }

  res.json({ success: true })
})

// GET /api/proxies/:id/test — real HTTP request through the proxy
proxiesRouter.get('/:id/test', async (req: Request, res: Response) => {
  // Fetch raw proxy_url (not masked) directly from DB
  const { data: proxy, error } = await supabase
    .from('proxies')
    .select('proxy_url')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error || !proxy) { res.status(404).json({ error: 'Proxy not found' }); return }

  const { ok, result } = await testProxyUrl((proxy as { proxy_url: string }).proxy_url)
  res.json({ ok, result })
})

// DELETE /api/proxies/:id
proxiesRouter.delete('/:id', async (req: Request, res: Response) => {
  // First unassign from any account
  const { data: proxy } = await supabase
    .from('proxies')
    .select('assigned_account_id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (proxy?.assigned_account_id) {
    await supabase
      .from('linkedin_accounts')
      .update({ proxy_id: null })
      .eq('id', (proxy as { assigned_account_id: string }).assigned_account_id)
      .eq('user_id', req.user.id)
  }

  const { error } = await supabase
    .from('proxies')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(204).send()
})
