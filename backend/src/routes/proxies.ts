import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import { ProxyAgent } from 'undici'
import { reconnectWithPersistentProfile } from '../lib/browserPool'

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
interface TestResult {
  ok: boolean
  result: string
  ip?: string
  country?: string   // ISO 3166-1 alpha-2, auto-detected from outbound IP
}

async function testProxyUrl(rawUrl: string): Promise<TestResult> {
  // Auto-prepend http:// if no scheme given; preserve socks4:// and socks5:// as-is
  const proxyUrl = /^(https?|socks[45]):\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`
  try {
    new URL(proxyUrl)
  } catch (e) {
    return { ok: false, result: `INVALID_URL: ${(e as Error).message}` }
  }

  // undici's ProxyAgent supports HTTP/HTTPS CONNECT only, not SOCKS.
  // For SOCKS proxies we skip the ipify test and report success-pending-verification.
  if (/^socks[45]:\/\//i.test(proxyUrl)) {
    return { ok: true, result: 'SOCKS proxy stored — connection will be verified during LinkedIn login' }
  }

  const agent = new ProxyAgent(proxyUrl)
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      dispatcher: agent,
      signal: AbortSignal.timeout(10_000),
    } as RequestInit)
    if (!res.ok) return { ok: false, result: `HTTP ${res.status} from proxy` }

    const { ip } = await res.json() as { ip: string }

    // Auto-detect country from outbound IP using ip-api.com (free, no auth)
    let country: string | undefined
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (geoRes.ok) {
        const geo = await geoRes.json() as { countryCode?: string }
        if (geo.countryCode) country = geo.countryCode.toLowerCase()
      }
    } catch { /* geo lookup is best-effort */ }

    const countryLabel = country ? ` (${country.toUpperCase()})` : ''
    return { ok: true, result: `Connected — outbound IP: ${ip}${countryLabel}`, ip, country }
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
    .select('id, label, proxy_url, assigned_account_id, is_available, created_at, country, proxy_type')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) { res.status(500).json({ error: error.message }); return }

  // Mask credentials before sending to frontend
  const masked = (data ?? []).map(p => ({ ...p, proxy_url: maskUrl(p.proxy_url as string) }))
  res.json({ data: masked })
})

// POST /api/proxies — add a single proxy
proxiesRouter.post('/', async (req: Request, res: Response) => {
  const { proxy_url, label, country, proxy_type } = req.body as { proxy_url?: string; label?: string; country?: string; proxy_type?: string }

  if (!proxy_url) { res.status(400).json({ error: 'proxy_url is required' }); return }

  // Preserve socks4:// and socks5:// schemes; only prepend http:// for bare host:port strings
  const normalizedUrl = /^(https?|socks[45]):\/\//i.test(proxy_url) ? proxy_url : `http://${proxy_url}`
  try { new URL(normalizedUrl) } catch {
    res.status(400).json({ error: 'Invalid proxy URL. Format: user:pass@host:port, http://user:pass@host:port, or socks5://user:pass@host:port' })
    return
  }

  const validTypes = ['isp', 'residential', 'datacenter']
  const resolvedType = proxy_type && validTypes.includes(proxy_type) ? proxy_type : 'isp'

  // Auto-detect country from outbound IP if not provided by the user
  let resolvedCountry = country?.toLowerCase().trim() || null
  if (!resolvedCountry) {
    const testResult = await testProxyUrl(normalizedUrl)
    if (testResult.ok && testResult.country) {
      resolvedCountry = testResult.country
      console.log(`[proxies] Auto-detected country '${resolvedCountry}' for new proxy`)
    }
  }

  const { data, error } = await supabase
    .from('proxies')
    .insert({
      proxy_url: normalizedUrl,
      label: label?.trim() || null,
      country: resolvedCountry,
      proxy_type: resolvedType,
      user_id: req.user.id,
      is_available: true,
    })
    .select('id, label, proxy_url, assigned_account_id, is_available, created_at, country, proxy_type')
    .single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.status(201).json({ data: { ...data, proxy_url: maskUrl(data.proxy_url as string) } })
})

// POST /api/proxies/bulk — import multiple proxies from newline-separated list
proxiesRouter.post('/bulk', async (req: Request, res: Response) => {
  const { lines, label_prefix, proxy_type } = req.body as { lines?: string; label_prefix?: string; proxy_type?: string }

  if (!lines?.trim()) { res.status(400).json({ error: 'lines is required' }); return }

  const validTypes = ['isp', 'residential', 'datacenter']
  const resolvedType = proxy_type && validTypes.includes(proxy_type) ? proxy_type : 'isp'

  const urls = lines
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)

  const valid: { proxy_url: string; label: string | null; user_id: string; is_available: boolean; proxy_type: string }[] = []
  const invalid: string[] = []

  urls.forEach((url, i) => {
    try {
      new URL(url)
      valid.push({
        proxy_url: url,
        label: label_prefix ? `${label_prefix} ${i + 1}` : null,
        user_id: req.user.id,
        is_available: true,
        proxy_type: resolvedType,
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

// PATCH /api/proxies/:id — update label, country, and/or proxy_type
proxiesRouter.patch('/:id', async (req: Request, res: Response) => {
  const { label, country, proxy_type } = req.body as { label?: string; country?: string | null; proxy_type?: string }

  const validTypes = ['isp', 'residential', 'datacenter']
  const updates: Record<string, unknown> = {}
  if ('label'      in req.body) updates.label      = label?.trim() || null
  if ('country'    in req.body) updates.country    = typeof country === 'string' ? country.toLowerCase().trim() || null : null
  if ('proxy_type' in req.body && proxy_type && validTypes.includes(proxy_type)) {
    updates.proxy_type = proxy_type
  }

  const { data, error } = await supabase
    .from('proxies')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select('id, label, proxy_url, assigned_account_id, is_available, created_at, country, proxy_type')
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

    // Kick off auto-reconnect in the background so the account immediately
    // establishes a session through the new proxy without manual intervention.
    ;(async () => {
      try {
        const { data: acc } = await supabase
          .from('linkedin_accounts')
          .select('linkedin_email, linkedin_password, totp_secret')
          .eq('id', account_id)
          .single()
        const email      = (acc as any)?.linkedin_email as string | undefined
        const passwd     = (acc as any)?.linkedin_password as string | undefined
        const totpSecret = (acc as any)?.totp_secret as string | null ?? null
        if (email && passwd) {
          console.log(`[proxies] Auto-reconnect triggered for ${account_id} after proxy assignment`)
          await reconnectWithPersistentProfile(account_id, email, passwd, String(req.params.id), totpSecret)
        }
      } catch (e) {
        console.warn(`[proxies] Auto-reconnect after proxy assignment failed for ${account_id}: ${(e as Error).message}`)
      }
    })()

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
    .select('proxy_url, country')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error || !proxy) { res.status(404).json({ error: 'Proxy not found' }); return }

  const testResult = await testProxyUrl((proxy as { proxy_url: string; country: string | null }).proxy_url)

  // Auto-save detected country if none was set or if we just discovered it
  if (testResult.ok && testResult.country && !(proxy as any).country) {
    await supabase
      .from('proxies')
      .update({ country: testResult.country })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
  }

  res.json({ ok: testResult.ok, result: testResult.result, country: testResult.country })
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
