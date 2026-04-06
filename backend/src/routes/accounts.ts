import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { AccountStatus } from '../types'
import { startLogin, startManualSession, submitVerificationCode, getLoginStatus, checkPushApproval, getSessionScreenshot, getSessionPageInfo, getSessionDebugSnapshot, interactWithPage, testProxyRaw, requestVerificationCode } from '../linkedin/login'
import { createSession } from '../linkedin/session'
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { chromium } = require('playwright-extra') as any
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
chromium.use(StealthPlugin())

export const accountsRouter = Router()

accountsRouter.use(requireAuth)

// GET /api/accounts — list all LinkedIn accounts for the user
accountsRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('linkedin_accounts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// GET /api/accounts/:id
accountsRouter.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('linkedin_accounts')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (error) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  res.json({ data })
})

// POST /api/accounts
accountsRouter.post('/', async (req: Request, res: Response) => {
  const { linkedin_email, proxy_id } = req.body as {
    linkedin_email: string
    proxy_id?: string
  }

  if (!linkedin_email) {
    res.status(400).json({ error: 'linkedin_email is required' })
    return
  }

  const { data, error } = await supabase
    .from('linkedin_accounts')
    .insert({
      user_id: req.user.id,
      linkedin_email,
      proxy_id: proxy_id ?? null,
      status: 'warming_up',
      warmup_day: 1,
    })
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(201).json({ data })
})

// PATCH /api/accounts/:id
accountsRouter.patch('/:id', async (req: Request, res: Response) => {
  const allowed = ['status', 'proxy_id', 'cookies', 'warmup_day', 'proxy_country'] as const
  type AllowedKey = (typeof allowed)[number]

  const updates: Partial<Record<AllowedKey, unknown>> = {}
  for (const key of allowed) {
    if (key in req.body) {
      updates[key] = req.body[key] as unknown
    }
  }

  if (updates.status) {
    const validStatuses: AccountStatus[] = ['active', 'paused', 'banned', 'warming_up']
    if (!validStatuses.includes(updates.status as AccountStatus)) {
      res.status(400).json({ error: 'Invalid status value' })
      return
    }
  }

  const { data, error } = await supabase
    .from('linkedin_accounts')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single()

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.json({ data })
})

// POST /api/accounts/:id/connect — credential-based login (works on any server)
accountsRouter.post('/:id/connect', async (req: Request, res: Response) => {
  const { email, password, totp_secret } = req.body as {
    email?: string
    password?: string
    totp_secret?: string
  }

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }

  const { data: account, error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (accountErr || !account) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  // Persist TOTP secret if provided (enables Infinite Login on future re-auths)
  if (totp_secret) {
    await supabase
      .from('linkedin_accounts')
      .update({ totp_secret })
      .eq('id', req.params.id)
  }

  const sessionKey = startLogin(String(req.params.id), email, password, totp_secret)
  res.json({ status: 'starting', session_key: sessionKey })
})

// GET /api/accounts/:id/connect-status/:sessionKey — poll login status
accountsRouter.get('/:id/connect-status/:sessionKey', async (req: Request, res: Response) => {
  const result = getLoginStatus(String(req.params.sessionKey))
  res.json(result)
})

// POST /api/accounts/:id/connect-check/:sessionKey — user tapped approve; navigate to feed immediately
accountsRouter.post('/:id/connect-check/:sessionKey', async (req: Request, res: Response) => {
  const result = await checkPushApproval(String(req.params.sessionKey))
  res.json(result)
})

// GET /api/accounts/:id/connect-debug/:sessionKey — page info for debugging
accountsRouter.get('/:id/connect-debug/:sessionKey', async (req: Request, res: Response) => {
  const info = await getSessionPageInfo(String(req.params.sessionKey))
  if (!info) { res.status(404).json({ error: 'Session not found or no page' }); return }
  res.json(info)
})

// GET /api/accounts/:id/connect-screenshot/:sessionKey — live screenshot for debugging
accountsRouter.get('/:id/connect-screenshot/:sessionKey', async (req: Request, res: Response) => {
  const png = await getSessionScreenshot(String(req.params.sessionKey))
  if (!png) { res.status(404).json({ error: 'Session not found or no page' }); return }
  const buf = Buffer.from(png, 'base64')
  res.setHeader('Content-Type', 'image/png')
  res.send(buf)
})

// GET /api/accounts/:id/connect-error-snapshot/:sessionKey
//   Returns the screenshot + page text captured just before the #username fill attempt.
//   Works after the browser has closed (data stored in session object).
accountsRouter.get('/:id/connect-error-snapshot/:sessionKey', (req: Request, res: Response) => {
  const snap = getSessionDebugSnapshot(String(req.params.sessionKey))
  if (!snap) { res.status(404).json({ error: 'Session not found or no snapshot' }); return }
  if (req.query.format === 'png' && snap.screenshot) {
    const buf = Buffer.from(snap.screenshot, 'base64')
    res.setHeader('Content-Type', 'image/png')
    res.send(buf)
    return
  }
  res.json(snap)
})

// POST /api/accounts/:id/connect-interact/:sessionKey — relay click/type/key to live browser
accountsRouter.post('/:id/connect-interact/:sessionKey', async (req: Request, res: Response) => {
  // Verify account belongs to user
  const { error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()
  if (accountErr) { res.status(404).json({ error: 'Account not found' }); return }

  const { action } = req.body as {
    action?: { type: string; x?: number; y?: number; text?: string; key?: string }
  }
  if (!action?.type) { res.status(400).json({ error: 'action.type is required' }); return }

  const result = await interactWithPage(
    String(req.params.sessionKey),
    action as Parameters<typeof interactWithPage>[1]
  )
  res.json(result)
})

// POST /api/accounts/:id/health-check — verify saved cookies still log into LinkedIn
accountsRouter.post('/:id/health-check', async (req: Request, res: Response) => {
  const { data: account, error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id, cookies, proxy_id, status')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (accountErr || !account) {
    res.status(404).json({ ok: false, message: 'Account not found' })
    return
  }

  if (!account.cookies) {
    res.json({ ok: false, message: 'No session saved — connect this account first.' })
    return
  }

  let browser: import('playwright').Browser | null = null
  try {
    const session = await createSession(account as Parameters<typeof createSession>[0])
    browser = session.browser
    const page = session.page

    // Navigate to the LinkedIn feed — a logged-in user lands here, a logged-out user gets redirected to /login
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const url = page.url()

    if (url.includes('/feed') || url.includes('/in/') || url.includes('/mynetwork')) {
      // Save refreshed cookies back to DB (session may have issued new tokens)
      const freshCookies = await session.context.cookies()
      await supabase
        .from('linkedin_accounts')
        .update({ cookies: JSON.stringify(freshCookies) })
        .eq('id', req.params.id)

      res.json({ ok: true, message: 'Session is active ✓' })
    } else if (url.includes('/checkpoint') || url.includes('/challenge')) {
      res.json({ ok: false, message: 'LinkedIn is asking for verification. Reconnect the account.' })
    } else {
      // Redirected to /login — session expired
      await supabase
        .from('linkedin_accounts')
        .update({ status: 'paused' })
        .eq('id', req.params.id)
      res.json({ ok: false, message: 'Session expired — please reconnect.' })
    }
  } catch (err) {
    res.json({ ok: false, message: `Health check failed: ${(err as Error).message}` })
  } finally {
    if (browser) await browser.close().catch(() => undefined)
  }
})

// POST /api/accounts/:id/request-code/:sessionKey — click "Use another way" to get email/SMS code
accountsRouter.post('/:id/request-code/:sessionKey', async (req: Request, res: Response) => {
  const { error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()
  if (accountErr) { res.status(404).json({ error: 'Account not found' }); return }

  const result = await requestVerificationCode(String(req.params.sessionKey))
  res.json(result)
})

// POST /api/accounts/:id/connect-verify — submit 2FA code
accountsRouter.post('/:id/connect-verify', async (req: Request, res: Response) => {
  const { session_key, code } = req.body as { session_key?: string; code?: string }

  if (!session_key || !code) {
    res.status(400).json({ error: 'session_key and code are required' })
    return
  }

  // Verify account belongs to user
  const { error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (accountErr) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  const result = await submitVerificationCode(session_key, code)
  res.json(result)
})

// POST /api/accounts/:id/login-browser
// Opens a visible Chrome window so the user can log in to LinkedIn.
// Polls for the li_at session cookie, then saves all cookies to the DB.
accountsRouter.post('/:id/login-browser', async (req: Request, res: Response) => {
  const { data: account, error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()

  if (accountErr || !account) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  // Browser login requires a local display — not available on Railway/cloud servers
  const isLinux = process.platform === 'linux'
  const hasDisplay = !!process.env.DISPLAY
  if (isLinux && !hasDisplay) {
    res.status(422).json({
      error: 'NO_DISPLAY',
      message: 'Browser login requires the backend to be running on your local machine. Use "Set Session" to paste your li_at cookie instead.',
    })
    return
  }

  let browser: import('playwright').Browser | null = null

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    }) as import('playwright').Browser

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    })

    const page = await context.newPage()
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 })

    // Poll for li_at cookie — up to 5 minutes
    const TIMEOUT_MS = 5 * 60 * 1000
    const POLL_MS = 2_000
    const deadline = Date.now() + TIMEOUT_MS
    let liAt: string | null = null

    while (Date.now() < deadline) {
      const cookies = await context.cookies()
      const found = cookies.find(c => c.name === 'li_at')
      if (found) {
        liAt = found.value
        // Save all cookies to DB
        await supabase
          .from('linkedin_accounts')
          .update({ cookies: JSON.stringify(cookies), status: 'active' })
          .eq('id', req.params.id)
        break
      }
      await new Promise(r => setTimeout(r, POLL_MS))
    }

    await browser.close()
    browser = null

    if (!liAt) {
      res.status(408).json({ error: 'Login timed out — no session cookie detected after 5 minutes' })
      return
    }

    res.json({ message: 'LinkedIn session saved successfully' })
  } catch (err) {
    if (browser) await browser.close().catch(() => {})
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// GET /api/accounts/:id/proxy-test — raw TCP test against BrightData proxy
accountsRouter.get('/:id/proxy-test', async (req: Request, res: Response) => {
  const result = await testProxyRaw(String(req.params.id))
  const ok = result.includes('200')
  res.json({ result, ok, hint: ok ? 'Proxy authenticated OK' : 'Proxy auth failed or unreachable — check BrightData credentials' })
})

// POST /api/accounts/:id/start-manual-session
// Opens a headless browser at LinkedIn's real login page.
// Frontend polls connect-status and shows a live screenshot viewer — user logs in manually.
accountsRouter.post('/:id/start-manual-session', async (req: Request, res: Response) => {
  const { error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single()
  if (accountErr) { res.status(404).json({ error: 'Account not found' }); return }

  const sessionKey = startManualSession(String(req.params.id))
  res.json({ status: 'starting', session_key: sessionKey })
})

// DELETE /api/accounts/:id
accountsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { error } = await supabase
    .from('linkedin_accounts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  res.status(204).send()
})
