import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'
import type { AccountStatus } from '../types'
import { startLogin, startManualSession, submitVerificationCode, getLoginStatus, checkPushApproval, getSessionScreenshot, getSessionPageInfo, getSessionDebugSnapshot, interactWithPage, testProxyRaw, requestVerificationCode } from '../linkedin/login'
import { isExtensionOnline, sendActionToExtension } from '../lib/extensionHub'
import { extractCookies, getProfileDir } from '../linkedin/session'
import { chromium } from 'playwright'
import * as fsSync from 'fs'
import { execSync } from 'child_process'
import { ProxyAgent } from 'undici'

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
  const allowed = ['status', 'proxy_id', 'cookies', 'warmup_day', 'proxy_country', 'linkedin_password', 'totp_secret', 'sender_name'] as const
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

  // Persist credentials for auto-reconnect (Infinite Login)
  // TOTP secret enables fully-automatic 2FA; password alone handles non-2FA accounts
  await supabase
    .from('linkedin_accounts')
    .update({
      linkedin_password: password,
      ...(totp_secret ? { totp_secret } : {}),
    })
    .eq('id', req.params.id)

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
// Uses direct HTTP (no browser). LinkedIn's Voyager API accepts authenticated requests
// from any IP when all cookies + proper headers are sent — no residential proxy needed.
accountsRouter.post('/:id/health-check', async (req: Request, res: Response) => {
  const { data: account, error: accountErr } = await supabase
    .from('linkedin_accounts')
    .select('id, cookies, status, proxy_id')
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

  try {
    // extractCookies handles both storage formats: full storage_state object OR legacy cookie array
    const cookies = extractCookies(account.cookies as string)

    const liAt = cookies.find(c => c.name === 'li_at')?.value
    if (!liAt) {
      res.json({ ok: false, message: 'No li_at cookie found — please reconnect.' })
      return
    }

    // Send ALL saved cookies (not just li_at) — LinkedIn may require bcookie, JSESSIONID, etc.
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    const jsessionid = cookies.find(c => c.name === 'JSESSIONID')?.value?.replace(/"/g, '') ?? 'ajax:0'

    // Build proxy agent — prefer account's own residential proxy (proxy_id → proxies table),
    // fall back to BRIGHTDATA_PROXY_URL env var, then try direct (no proxy).
    // Never use PROXY_HOST/PROXY_USERNAME env vars — those point to nsocks (datacenter IP)
    // which gets 999-blocked by LinkedIn just like Railway's own IP.
    let agent: ProxyAgent | undefined
    if ((account as { proxy_id?: string | null }).proxy_id) {
      const { data: proxyRow } = await supabase
        .from('proxies')
        .select('proxy_url')
        .eq('id', (account as { proxy_id: string }).proxy_id)
        .single()
      if (proxyRow) {
        agent = new ProxyAgent((proxyRow as { proxy_url: string }).proxy_url)
      }
    }
    if (!agent && process.env.BRIGHTDATA_PROXY_URL) {
      agent = new ProxyAgent(process.env.BRIGHTDATA_PROXY_URL)
    }
    // If neither residential proxy is available, try direct — Voyager API often works
    // without a proxy when all auth cookies + LinkedIn headers are present.

    const attemptProbe = async (useAgent: ProxyAgent | undefined) =>
      fetch('https://www.linkedin.com/voyager/api/me', {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'application/vnd.linkedin.normalized+json+2.1',
          'x-li-lang': 'en_US',
          'x-restli-protocol-version': '2.0.0',
          'csrf-token': jsessionid,
        },
        ...(useAgent ? { dispatcher: useAgent } : {}),
        signal: AbortSignal.timeout(12_000),
      } as RequestInit)

    // First attempt (with proxy if available)
    let probe = await attemptProbe(agent)

    // If proxy returned 999/blocked AND we had a proxy, retry without it — direct call
    // might succeed since Voyager API is more permissive than browser-facing endpoints
    if (probe.status === 999 && agent) {
      console.log(`[health-check] ${req.params.id} proxy returned 999 — retrying direct`)
      probe = await attemptProbe(undefined)
    }

    if (probe.status === 200) {
      if (account.status === 'paused') {
        await supabase.from('linkedin_accounts').update({ status: 'active' }).eq('id', req.params.id)
      }
      res.json({ ok: true, message: 'Session is active ✓' })
    } else if (probe.status === 401 || probe.status === 403) {
      await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', req.params.id)
      res.json({ ok: false, message: 'Session expired — please reconnect.' })
    } else {
      // Non-200/401 (e.g. 429 rate limit, 999 bot block) — don't mark as expired, just warn
      res.json({ ok: false, message: `LinkedIn returned ${probe.status} — try again in a moment.` })
    }
  } catch (err) {
    res.json({ ok: false, message: `Health check failed: ${(err as Error).message}` })
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
    .select('id, proxy_id')
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

  // Resolve proxy from the account's proxy_id (set via the Proxies UI).
  const disableProxy = process.env.DISABLE_PROXY === 'true'
  let playwrightProxy: { server: string; username?: string; password?: string } | undefined

  if (!disableProxy && (account as { proxy_id?: string | null }).proxy_id) {
    const { data: proxyRow } = await supabase
      .from('proxies')
      .select('proxy_url')
      .eq('id', (account as { proxy_id: string }).proxy_id)
      .single()

    if (proxyRow) {
      const u = new URL((proxyRow as { proxy_url: string }).proxy_url)
      playwrightProxy = {
        server:   `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username) || undefined,
        password: decodeURIComponent(u.password) || undefined,
      }
    }
  }

  // ── Persistent profile directory ────────────────────────────────────────────
  // We use launchPersistentContext so the browser profile (cookies, IndexedDB,
  // localStorage, fingerprint data) is written to disk and reused by the scraper.
  // This is essential for li_a (Sales Navigator) which LinkedIn ties to the
  // specific browser identity — a fresh browser instance invalidates li_a
  // immediately, but the same profile keeps it alive indefinitely.
  const profileDir = getProfileDir(req.params.id as string)
  fsSync.mkdirSync(profileDir, { recursive: true })

  // Clear Chrome singleton locks left by crashed/killed previous sessions
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fsSync.unlinkSync(`${profileDir}/${lock}`) } catch { /* already gone */ }
  }

  let context: import('playwright').BrowserContext | null = null

  // Calculate screen center for the login window (480×680)
  const WIN_W = 480, WIN_H = 680
  let winX = 400, winY = 60 // sensible fallback
  try {
    const bounds = execSync("osascript -e 'tell application \"Finder\" to get bounds of window of desktop'", { timeout: 3000 }).toString().trim()
    const parts = bounds.split(', ').map(Number)
    if (parts.length === 4) {
      winX = Math.round((parts[2] - WIN_W) / 2)
      winY = Math.round((parts[3] - WIN_H) / 2)
    }
  } catch { /* use fallback */ }

  let windowClosed = false

  try {
    console.log(`[login-browser] ${req.params.id} — launching Chrome with persistent profile${playwrightProxy ? ` via proxy ${playwrightProxy.server}` : ' (no proxy)'}`)

    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--app=https://www.linkedin.com/login', // app mode — no address bar
        `--window-size=${WIN_W},${WIN_H}`,
        `--window-position=${winX},${winY}`,
      ],
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: WIN_W, height: WIN_H },
      locale: 'en-US',
      ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
    })

    // Detect if the user manually closes the window — kill the Chrome process immediately.
    // context.close() alone doesn't terminate the OS process in persistent context mode,
    // so we also pkill by the unique profile directory path.
    const killContext = () => {
      if (windowClosed) return
      windowClosed = true
      console.log('[login-browser] Browser window closed by user — terminating Chrome process')
      context?.close().catch(() => null)
      context = null
      try { execSync(`pkill -f "${profileDir}"`, { timeout: 3000 }) } catch { /* already gone */ }
    }
    context.on('close', killContext)

    const page = context.pages()[0] ?? await context.newPage()
    page.on('close', killContext)

    console.log('[login-browser] Navigating to linkedin.com/login…')
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // Focus the email field so the user can type immediately without clicking
    await page.click('#username').catch(() => null)
    console.log('[login-browser] Login page open — waiting for user to log in…')

    // Phase 1 — wait for li_at (main session cookie, up to 5 min)
    const TIMEOUT_MS = 5 * 60 * 1000
    const POLL_MS    = 2_000
    const deadline   = Date.now() + TIMEOUT_MS
    let liAt: string | null = null

    while (Date.now() < deadline) {
      if (windowClosed) break
      try {
        const cookies = await context.cookies()
        if (cookies.find(c => c.name === 'li_at')) {
          liAt = cookies.find(c => c.name === 'li_at')!.value
          break
        }
      } catch { break } // context destroyed
      await new Promise(r => setTimeout(r, POLL_MS))
    }

    if (windowClosed) {
      // killContext() already closed the context and set context = null
      console.warn('[login-browser] Aborted — user closed the browser window')
      res.status(400).json({ error: 'Login cancelled — browser window was closed' })
      return
    }

    if (!liAt) {
      await context.close()
      context = null
      console.warn('[login-browser] Timed out — no li_at cookie after 5 minutes')
      res.status(408).json({ error: 'Login timed out — no session cookie detected after 5 minutes' })
      return
    }

    console.log('[login-browser] ✓ li_at detected — saving session and closing browser…')

    // Save the session immediately so the browser can close right away.
    // Phase 2 (li_a) and Phase 3 (sender profile) run headlessly in background
    // — the user doesn't need to see the browser navigating to Sales Nav.
    const storageStateEarly = await context.storageState()
    const { error: earlyErr } = await supabase
      .from('linkedin_accounts')
      .update({ cookies: JSON.stringify(storageStateEarly), status: 'active' })
      .eq('id', req.params.id)
    if (earlyErr) console.warn(`[login-browser] Early session save error: ${earlyErr.message}`)

    // Close the visible browser window immediately — user sees it disappear right after login
    windowClosed = true
    await context.close().catch(() => null)
    context = null
    try { execSync(`pkill -f "${profileDir}"`, { timeout: 3000 }) } catch { /* already gone */ }

    // Respond to the client immediately — login is done from the user's perspective
    res.json({ message: 'LinkedIn session saved — finalising Sales Navigator setup in background…' })

    // Background: Phase 2 (li_a) + Phase 3 (sender profile scrape) — fully headless
    ;(async () => {
      console.log('[login-browser] [bg] Starting headless Phase 2+3…')
      let bgContext = null as import('playwright').BrowserContext | null
      try {
        // Clean singleton locks before re-opening the profile
        for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          try { fsSync.unlinkSync(`${profileDir}/${lock}`) } catch { /* ok */ }
        }
        bgContext = await chromium.launchPersistentContext(profileDir, {
          headless: true,
          args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
          ],
          ...(playwrightProxy ? { proxy: playwrightProxy } : {}),
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          locale: 'en-US',
          viewport: { width: 1280, height: 800 },
        })
        const bgPage = bgContext.pages()[0] ?? await bgContext.newPage()

        // Phase 2 — capture li_a by visiting Sales Nav
        try {
          await bgPage.goto('https://www.linkedin.com/sales/home', { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await bgPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null)
          await bgPage.waitForTimeout(3000)
          const bgCookies = await bgContext.cookies()
          const hasLiA = bgCookies.some(c => c.name === 'li_a')
          console.log(`[login-browser] [bg] li_a: ${hasLiA ? '✓ captured' : 'not found (no Sales Nav subscription?)'}`)
        } catch (e) {
          console.warn(`[login-browser] [bg] Sales Nav phase failed: ${(e as Error).message}`)
        }

        // Phase 3 — scrape sender profile
        let senderName: string | null = null
        let senderHeadline: string | null = null
        let senderAbout: string | null = null
        let senderExperience: string | null = null
        let senderSkills: string[] = []
        let senderRecentPosts: string[] = []
        try {
          await bgPage.goto('https://www.linkedin.com/in/me', { waitUntil: 'domcontentloaded', timeout: 20_000 })
          await bgPage.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null)
          await bgPage.waitForTimeout(1500)
          const redirectedUrl = bgPage.url().split('?')[0].replace(/\/$/, '')

          await bgPage.goto(redirectedUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
          await bgPage.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => null)
          await bgPage.waitForTimeout(2000)
          await bgPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2))
          await bgPage.waitForTimeout(1500)
          await bgPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
          await bgPage.waitForTimeout(1500)
          await bgPage.evaluate(() => window.scrollTo(0, 0))
          await bgPage.waitForTimeout(500)

          const pd = await bgPage.evaluate(() => {
            const getText = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
            let name: string | null = null
            for (const sel of ['h1', '.text-heading-xlarge', '.pv-text-details__left-panel h1']) {
              for (const el of Array.from(document.querySelectorAll(sel))) {
                const t = getText(el)
                if (t && t.length > 1 && t.length < 80 && !t.includes('@')) { name = t; break }
              }
              if (name) break
            }
            let headline: string | null = null
            for (const sel of ['.text-body-medium.break-words', '.pv-text-details__left-panel .text-body-medium']) {
              const t = getText(document.querySelector(sel))
              if (t && t.length > 2 && t.length < 250) { headline = t; break }
            }
            let about: string | null = null
            const aboutAnchor = document.querySelector('#about')
            if (aboutAnchor?.closest('section')) {
              const spans = Array.from(aboutAnchor.closest('section')!.querySelectorAll('span[aria-hidden="true"]'))
              const text = spans.map(s => (s.textContent ?? '').trim()).filter(t => t.length > 20).join(' ')
              if (text) about = text.slice(0, 800)
            }
            let experience: string | null = null
            const expAnchor = document.querySelector('#experience')
            if (expAnchor?.closest('section')) {
              const firstItem = expAnchor.closest('section')!.querySelector('li')
              if (firstItem) {
                const descSpans = Array.from(firstItem.querySelectorAll('span[aria-hidden="true"]'))
                  .map(s => getText(s)).filter(t => t.length > 40 && !t.includes('·') && !/^\d/.test(t))
                if (descSpans.length > 0) experience = descSpans.slice(-1)[0]?.slice(0, 600) ?? null
              }
            }
            const skills: string[] = []
            const skillsAnchor = document.querySelector('#skills')
            if (skillsAnchor?.closest('section')) {
              Array.from(skillsAnchor.closest('section')!.querySelectorAll('li')).slice(0, 5).forEach(item => {
                const sp = Array.from(item.querySelectorAll('span[aria-hidden="true"]'))
                  .find(s => { const t = getText(s); return t.length > 1 && t.length < 60 && !t.includes('endorsement') })
                if (sp) skills.push(getText(sp))
              })
            }
            return { name, headline, about, experience, skills }
          }).catch(() => ({ name: null, headline: null, about: null, experience: null, skills: [] as string[] }))

          senderName = pd.name; senderHeadline = pd.headline
          senderAbout = pd.about; senderExperience = pd.experience; senderSkills = pd.skills

          // Recent posts
          try {
            const activityUrl = `${redirectedUrl}/recent-activity/all/`
            await bgPage.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
            await bgPage.waitForTimeout(2500)
            senderRecentPosts = await bgPage.evaluate(() => {
              const found: string[] = []
              for (const sel of ['.feed-shared-update-v2__description span[dir]', '.feed-shared-text span[aria-hidden="true"]', '[data-urn*="activity"] .break-words']) {
                if (found.length >= 3) break
                document.querySelectorAll(sel).forEach(el => {
                  if (found.length >= 3) return
                  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
                  if (text.length > 30 && !found.includes(text)) found.push(text.slice(0, 300))
                })
              }
              return found
            }).catch(() => [] as string[])
          } catch { /* non-fatal */ }

          console.log(`[login-browser] [bg] Sender: ${senderName ?? '(not found)'}${senderHeadline ? ` — ${senderHeadline}` : ''} | skills=${senderSkills.length} posts=${senderRecentPosts.length}`)
        } catch (e) {
          console.warn(`[login-browser] [bg] Sender profile scrape failed: ${(e as Error).message}`)
        }

        // Save final storage state + sender profile
        const finalState = await bgContext.storageState()
        await supabase.from('linkedin_accounts').update({
          cookies:         JSON.stringify(finalState),
          status:          'active',
          sender_name:     senderName     ?? null,
          sender_headline: senderHeadline ?? null,
          sender_about:    senderAbout    ?? null,
        }).eq('id', req.params.id)

        try {
          await supabase.from('linkedin_accounts').update({
            sender_experience:   senderExperience   ?? null,
            sender_skills:       senderSkills,
            sender_recent_posts: senderRecentPosts,
          }).eq('id', req.params.id)
        } catch { /* pre-migration — ignore */ }

        console.log('[login-browser] [bg] Phase 2+3 complete ✓')
      } catch (e) {
        console.warn(`[login-browser] [bg] Background phase failed: ${(e as Error).message}`)
      } finally {
        if (bgContext) await bgContext.close().catch(() => null)
      }
    })().catch(e => console.warn('[login-browser] [bg] Unhandled:', e.message))
  } catch (err) {
    windowClosed = true // disarm handler before closing
    if (context) await context.close().catch(() => {})
    try { execSync(`pkill -f "${profileDir}"`, { timeout: 3000 }) } catch { /* already gone */ }
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// GET /api/accounts/:id/proxy-test — raw TCP test against BrightData proxy
accountsRouter.get('/:id/proxy-test', async (req: Request, res: Response) => {
  const result = await testProxyRaw(String(req.params.id))
  const ok = result.includes('200')
  res.json({ result, ok, hint: ok ? 'Proxy authenticated OK' : 'Proxy auth failed or unreachable — check BrightData credentials' })
})

// POST /api/accounts/:id/request-session-export
// Triggers the Chrome extension (via WebSocket) to export the LinkedIn session for this account.
// Extension must be connected (user has it installed and is logged into the web app).
accountsRouter.post('/:id/request-session-export', async (req: Request, res: Response) => {
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

  if (!isExtensionOnline(req.user.id)) {
    res.status(400).json({ error: 'extension_offline' })
    return
  }

  const jobId = `export-session-${req.params.id}-${Date.now()}`
  try {
    const result = await sendActionToExtension(req.user.id, {
      jobId,
      action:     'export_session',
      accountId:  String(req.params.id),
      profileUrl: '',
    }, 20_000)
    res.json({ ok: true, ...(result as object) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
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
