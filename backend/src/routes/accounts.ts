import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { AccountStatus } from '../types'
import { startLogin, submitVerificationCode, getLoginStatus, getSessionScreenshot, getSessionPageInfo } from '../linkedin/login'
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
  const allowed = ['status', 'proxy_id', 'cookies', 'warmup_day'] as const
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

// GET /api/accounts/:id/connect-debug/:sessionKey — page info for debugging
accountsRouter.get('/:id/connect-debug/:sessionKey', async (req: Request, res: Response) => {
  const info = await getSessionPageInfo(String(req.params.sessionKey))
  if (!info) { res.status(404).json({ error: 'Session not found or no page' }); return }
  res.json(info)
})

// GET /api/accounts/:id/connect-screenshot/:sessionKey — screenshot for debugging
accountsRouter.get('/:id/connect-screenshot/:sessionKey', async (req: Request, res: Response) => {
  const png = await getSessionScreenshot(String(req.params.sessionKey))
  if (!png) { res.status(404).json({ error: 'Session not found or no page' }); return }
  const buf = Buffer.from(png, 'base64')
  res.setHeader('Content-Type', 'image/png')
  res.send(buf)
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
