/**
 * LinkedIn Infinite Login — fully async with TOTP auto-fill + residential proxy.
 *
 * POST /connect returns a session_key immediately (< 1s).
 * All browser work happens in a background task.
 * Frontend polls GET /connect-status/:key every 3s.
 *
 * Status lifecycle:
 *   starting → pending_push | needs_verification | success | error
 *
 * Browser strategy (checked in order):
 *   1. BRIGHTDATA_BROWSER_URL set → connectOverCDP to BrightData Scraping Browser
 *      (BrightData runs Chromium on a residential IP — no local browser, no 403)
 *   2. Fallback → local Chromium launch with BRIGHTDATA_PROXY_URL / per-account proxy
 *
 * If totp_secret is stored on the account, 2FA codes are generated
 * automatically via otplib — no user interaction required (Infinite Login).
 */

import type { Browser, BrowserContext, Page } from 'playwright'
import * as net from 'net'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const speakeasy = require('speakeasy') as {
  totp: (opts: { secret: string; encoding: string }) => string
}
import { supabase } from '../lib/supabase'

// playwright-extra + stealth used for local-Chromium fallback only
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { chromium } = require('playwright-extra') as any
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
chromium.use(StealthPlugin())

type SessionStatus = 'starting' | 'pending_push' | 'needs_verification' | 'success' | 'error'

interface LoginSession {
  browser?:        Browser
  context?:        BrowserContext
  page?:           Page
  accountId:       string
  createdAt:       number
  status:          SessionStatus
  hint:            string
  error?:          string
  totpSecret?:     string
  debugScreenshot?: string   // base64 PNG captured just before login form interaction
  debugPageText?:  string    // visible text at time of capture
  debugUrl?:       string    // URL at time of capture
}

const sessions = new Map<string, LoginSession>()

// Module-level store for the last login error snapshot (unauthenticated debug endpoint)
let lastErrorSnapshot: { screenshot?: string; url?: string; text?: string; html?: string; capturedAt: string } | null = null

export function getLastErrorSnapshot() { return lastErrorSnapshot }
export function clearLastErrorSnapshot() { lastErrorSnapshot = null }

// Clean up sessions older than 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, s] of sessions) {
    if (now - s.createdAt > 10 * 60 * 1000) {
      s.browser?.close().catch(() => {})
      sessions.delete(key)
    }
  }
}, 60_000)

function randomKey(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

const DELAY = (ms: number) => new Promise(r => setTimeout(r, ms))

async function saveCookies(context: BrowserContext, accountId: string): Promise<void> {
  const cookies = await context.cookies()
  await supabase
    .from('linkedin_accounts')
    .update({ cookies: JSON.stringify(cookies), status: 'active' })
    .eq('id', accountId)
}

// ── Browser configuration helpers ────────────────────────────────────────────

/**
 * Returns a BrightData Scraping Browser CDP WebSocket URL if BRIGHTDATA_BROWSER_URL
 * is configured. Country targeting is appended to the username if the account has
 * proxy_country set.
 *
 * Format: wss://brd-customer-{ID}-zone-{ZONE}:{PASSWORD}@brd.superproxy.io:9222
 */
async function resolveBrowserEndpoint(accountId: string): Promise<string | null> {
  if (process.env.DISABLE_PROXY === 'true') return null
  const browserUrl = process.env.BRIGHTDATA_BROWSER_URL
  if (!browserUrl) return null

  try {
    const { data: account } = await supabase
      .from('linkedin_accounts')
      .select('proxy_country')
      .eq('id', accountId)
      .single()

    const country = (account as { proxy_country?: string } | null)?.proxy_country
    const url = new URL(browserUrl)

    if (country) {
      // BrightData country targeting: append -country-XX to username
      const baseUser = decodeURIComponent(url.username)
      url.username = encodeURIComponent(`${baseUser}-country-${country.toLowerCase()}`)
    }

    return url.toString()
  } catch {
    return null
  }
}

/** Resolve local-proxy settings for an account from DB or env fallback */
async function resolveProxy(accountId: string): Promise<
  { server: string; username?: string; password?: string } | undefined
> {
  const BD_PROXY_URL = process.env.DISABLE_PROXY === 'true'
    ? ''
    : (process.env.BRIGHTDATA_PROXY_URL ?? '')

  const { data: account } = await supabase
    .from('linkedin_accounts')
    .select('proxy_id, proxy_country')
    .eq('id', accountId)
    .single()

  if (account?.proxy_id) {
    const { data: proxy } = await supabase
      .from('proxies')
      .select('proxy_url')
      .eq('id', account.proxy_id)
      .single()
    if (proxy) {
      const url = new URL((proxy as { proxy_url: string }).proxy_url)
      return {
        server:   `${url.protocol}//${url.host}`,
        username: url.username || undefined,
        password: url.password || undefined,
      }
    }
  }

  if (BD_PROXY_URL) {
    const url = new URL(BD_PROXY_URL)
    const host = url.hostname
    const port = url.port
    // Append country targeting to BrightData username if set (e.g. -country-us)
    const baseUsername = decodeURIComponent(url.username) || undefined
    const country = (account as { proxy_country?: string } | null)?.proxy_country
    const username = baseUsername && country
      ? `${baseUsername}-country-${country.toLowerCase()}`
      : baseUsername
    // BrightData: port 33335 is SSL-only and Chromium doesn't support
    // SSL proxy servers. Always connect via the plain HTTP port 22225.
    const proxyPort = host.includes('superproxy.io') ? '22225' : port
    return {
      server:   `http://${host}:${proxyPort}`,
      username,
      password: decodeURIComponent(url.password) || undefined,
    }
  }

  return undefined
}

/**
 * Raw TCP test: send HTTP CONNECT to the proxy and return the response line.
 * Only meaningful when using BRIGHTDATA_PROXY_URL (local-proxy mode).
 * Returns an informational message when Scraping Browser mode is active.
 */
export async function testProxyRaw(accountId: string): Promise<string> {
  // Scraping Browser uses WebSocket, not CONNECT tunnel — no raw test needed
  if (process.env.BRIGHTDATA_BROWSER_URL && process.env.DISABLE_PROXY !== 'true') {
    return 'SCRAPING_BROWSER_MODE — no CONNECT tunnel; BrightData runs the browser on a residential IP'
  }

  const proxy = await resolveProxy(accountId)
  if (!proxy) return 'NO_PROXY_CONFIGURED'

  const serverUrl = new URL(proxy.server)
  const host = serverUrl.hostname
  const port = parseInt(serverUrl.port || '22225', 10)

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      const auth = proxy.username && proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : ''
      socket.write(
        `CONNECT linkedin.com:443 HTTP/1.1\r\nHost: linkedin.com:443\r\n${auth}\r\n`
      )
    })
    socket.setTimeout(8000)
    socket.on('data', (d) => {
      resolve(d.toString().split('\r\n')[0])
      socket.destroy()
    })
    socket.on('timeout', () => { resolve('TIMEOUT connecting to proxy'); socket.destroy() })
    socket.on('error', (e) => resolve(`TCP_ERROR: ${e.message}`))
  })
}

// ── Login runner ──────────────────────────────────────────────────────────────

/** Runs entirely in the background — never awaited by the HTTP handler */
async function runLogin(key: string, email: string, password: string): Promise<void> {
  const session = sessions.get(key)
  if (!session) return

  let browser: Browser | undefined
  try {
    const browserEndpoint = await resolveBrowserEndpoint(session.accountId)

    let context: BrowserContext

    if (browserEndpoint) {
      // ── Strategy 1: BrightData Scraping Browser via CDP ──────────────────
      // BrightData runs Chromium on a residential IP on their infrastructure.
      // Railway just opens a WebSocket — no tunnel, no 403.
      const { chromium: pw } = await import('playwright')
      browser = await pw.connectOverCDP(browserEndpoint) as unknown as Browser

      // Use the existing default context BrightData provides, or create one
      const existingContexts = browser.contexts()
      context = existingContexts.length > 0
        ? existingContexts[0]
        : await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } })

    } else {
      // ── Strategy 2: Local Chromium launch with proxy (dev / fallback) ─────
      const proxy = await resolveProxy(session.accountId)

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      browser = await chromium.launch({
        headless: true,
        ...(proxy ? { proxy } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list',
        ],
      }) as Browser

      context = await browser.newContext({
        proxy:             proxy ?? undefined,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport:          { width: 1280, height: 800 },
        locale:            'en-US',
        ignoreHTTPSErrors: true,
      })

      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
        Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        // @ts-ignore
        window.chrome = { runtime: {} }
      })
    }

    const page = await context.newPage()
    session.browser = browser
    session.context = context
    session.page    = page

    // Navigate to login — force English locale to bypass language selection pages
    // on country-specific subdomains (e.g. pe.linkedin.com from Peruvian residential IPs).
    // Use load (all resources) so the React SPA has time to hydrate and render form inputs.
    // networkidle can time out on BrightData (ongoing background requests never stop).
    await page.goto('https://www.linkedin.com/login?_l=en_US', { waitUntil: 'load', timeout: 45_000 })
    await DELAY(2000 + Math.random() * 500)

    // ── Snapshot immediately after first navigation ───────────────────────────
    // Writes to Supabase so it survives across Railway instances and restarts.
    const captureSnap = async (label: string) => {
      const url = page.url()
      console.log(`[LOGIN DEBUG ${label}] url=${url}`)
      try {
        let text = '(evaluate failed)'
        let html = '(evaluate failed)'
        try { text = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 2000)) } catch { /* ok */ }
        try { html = await page.evaluate(() => document.documentElement.outerHTML.substring(0, 10000)) } catch { /* ok */ }

        let screenshot: string | undefined
        try {
          const buf = await page.screenshot({ type: 'png', fullPage: false })
          screenshot = buf.toString('base64')
        } catch { /* BrightData may not support CDP screenshots */ }

        const snap = { url, text, html, screenshot, capturedAt: new Date().toISOString(), label }
        lastErrorSnapshot = snap
        session.debugUrl        = url
        session.debugPageText   = text
        session.debugScreenshot = screenshot

        console.log(`[LOGIN DEBUG ${label}] text_len=${text.length} has_username_id=${html.includes('id="username"')}`)

        // Persist to Supabase so any Railway instance can read it
        await supabase.from('linkedin_accounts').update({
          debug_log: snap as unknown as Record<string, unknown>
        }).eq('id', session.accountId)
      } catch (snapErr) {
        console.error('[LOGIN DEBUG] snapshot failed:', snapErr)
      }
    }

    await captureSnap('after-goto')

    // JS-based click helper — bypasses header/overlay pointer-event interception
    const jsClick = async (selector: string) => {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (el) el.click()
      }, selector)
    }

    // Dismiss GDPR / cookie consent banners using JS click (no pointer-event issues)
    for (const selector of [
      'button[action-type="ACCEPT"]',
      'button[data-tracking-control-name="cookie_policy_banner_accept"]',
      '#artdeco-global-alert-action--accept',
      'button.artdeco-global-alert__action',
    ]) {
      try {
        const exists = await page.$(selector)
        if (exists) { await jsClick(selector); await DELAY(800); break }
      } catch { /* ok */ }
    }

    // Handle language selection page (shown on country-specific subdomains like pe.linkedin.com)
    // LinkedIn shows this when the IP country doesn't match the browser locale.
    // Look for an English link and click it, then re-navigate to the login page.
    const langPageText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
    const hasLangSelector = langPageText.includes('English (English)') || langPageText.includes('選擇語言') || langPageText.includes('Chọn ngôn ngữ')
    if (hasLangSelector) {
      console.log('[LOGIN DEBUG] Language selection page detected — clicking English')
      // Try to find and click the English option
      const englishLink = await page.$('a[href*="_l=en_US"], a[href*="lang=en"]')
        ?? await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a'))
          return links.find(a => a.textContent?.includes('English (English)')) ? true : null
        }).then(async (found) => {
          if (!found) return null
          // Click via evaluate since we can't return element handles from evaluate
          await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'))
            const link = links.find(a => a.textContent?.includes('English (English)'))
            if (link) (link as HTMLElement).click()
          })
          return true
        })
      if (englishLink) await DELAY(1500)
      // Navigate directly to English login regardless
      await page.goto('https://www.linkedin.com/login?_l=en_US', { waitUntil: 'load', timeout: 45_000 })
      await DELAY(2000)
    }

    // If redirected away from login (e.g. already-logged-in BrightData session), navigate back
    if (!page.url().includes('/login')) {
      console.log(`[LOGIN DEBUG] redirected to ${page.url()} — navigating back to /login`)
      await page.goto('https://www.linkedin.com/login?_l=en_US', { waitUntil: 'load', timeout: 45_000 })
      await DELAY(2000)
    }

    await captureSnap('pre-fill')

    // LinkedIn's login form selector — try the classic #username first, then broader fallbacks.
    // The SPA may render inputs without IDs on some regions/A-B tests.
    const EMAIL_SELECTORS = [
      '#username',
      'input[name="session_key"]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name="email"]',
      'input[id*="email"]',
      'input[placeholder*="Email"], input[placeholder*="email"]',
      'form input[type="text"]:first-of-type',
    ]

    let emailSelector = '#username'
    let foundEmailInput = false
    for (const sel of EMAIL_SELECTORS) {
      try {
        const el = await page.waitForSelector(sel, { timeout: sel === EMAIL_SELECTORS[0] ? 15_000 : 2_000 })
        if (el) { emailSelector = sel; foundEmailInput = true; break }
      } catch { /* try next */ }
    }

    if (!foundEmailInput) {
      await captureSnap('waitForSelector-timeout')
      const url   = page.url()
      const title = await page.title().catch(() => '?')
      let visible = ''
      let allInputs = ''
      try { visible = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 300).replace(/\s+/g, ' ')) } catch { /* ok */ }
      try { allInputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((el: Element) => { const i = el as HTMLInputElement; return `${i.tagName}[id=${i.id}][name=${i.name}][type=${i.type}]` }).join(', ')) } catch { /* ok */ }
      throw new Error(`Login form inputs not found. URL: ${url} | Title: ${title} | Inputs: ${allInputs} | Text: ${visible}`)
    }

    console.log(`[LOGIN DEBUG] Using email selector: ${emailSelector}`)

    // Helper: dismiss any consent/overlay banners using JS click (no pointer-event issues)
    const dismissBanners = async () => {
      for (const selector of [
        'button[action-type="ACCEPT"]',
        'button[data-tracking-control-name="cookie_policy_banner_accept"]',
        '#artdeco-global-alert-action--accept',
        'button.artdeco-global-alert__action',
        'button[data-test-modal-close-btn]',
      ]) {
        try {
          const exists = await page.$(selector)
          if (exists) { await jsClick(selector); await DELAY(500) }
        } catch { /* ok */ }
      }
    }

    // Focus the email field using JS click (avoids pointer-event interception),
    // then type using real keyboard events — works with BrightData's security rules
    // (BrightData blocks JS-based password value setting but allows keyboard input).
    await jsClick(emailSelector)
    await DELAY(300)
    await page.keyboard.type(email, { delay: 40 })
    await DELAY(500 + Math.random() * 300)

    // Re-dismiss any banners that may have appeared after username interaction
    await dismissBanners()

    // Focus the password field using JS click — avoids keyboard Tab focus event
    // which BrightData intercepts. BrightData blocks keyboard events on password
    // fields (Forbidden action: password typing is not allowed) so we must:
    //   1. Use jsClick to focus (not Tab) to avoid the CDP focus interception
    //   2. Use page.keyboard.type() for the actual password characters
    //   3. Move focus back to a non-password field before submitting
    const PASSWORD_SELECTORS = [
      '#password',
      'input[name="session_password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ]

    let passwordSelector = 'input[type="password"]'
    for (const sel of PASSWORD_SELECTORS) {
      try {
        const el = await page.$(sel)
        if (el) { passwordSelector = sel; break }
      } catch { /* try next */ }
    }

    await jsClick(passwordSelector)
    await DELAY(300)
    await page.keyboard.type(password, { delay: 40 })
    await DELAY(300 + Math.random() * 300)

    // Move focus away from password field before submitting — BrightData blocks
    // keyboard.press() (including Enter) when a password input is focused.
    // Click the email field to shift focus away, then click the submit button.
    await jsClick(emailSelector)
    await DELAY(200)

    // Submit via JS click on the submit button (BrightData-safe — no keyboard event needed)
    await jsClick('button[type="submit"], button[data-litms-control-urn="login-submit"], .btn__primary--large')
    await DELAY(300)

    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 })
    await DELAY(2000)

    // Wrong credentials?
    const errorEl = await page.$('.alert-content, #error-for-password, .form__label--error')
    if (errorEl) {
      const msg = (await errorEl.innerText()).trim()
      session.status = 'error'
      session.error  = msg || 'Incorrect email or password.'
      await browser.close()
      return
    }

    const url = page.url()

    // Immediate success
    if (!url.includes('/checkpoint') && !url.includes('/challenge') && !url.includes('verification')) {
      const cookies = await context.cookies()
      if (cookies.find(c => c.name === 'li_at')) {
        await saveCookies(context, session.accountId)
        session.status = 'success'
      } else {
        session.status = 'error'
        session.error  = 'Login appeared to succeed but no session cookie was found.'
      }
      await browser.close()
      return
    }

    // ── 2FA / challenge handling ──────────────────────────────────────────────

    // Check for PIN input (email/phone/authenticator code)
    const hasPinInput = !!(await page.$(
      'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin'
    ))

    if (hasPinInput && session.totpSecret) {
      // Infinite Login — generate TOTP code automatically
      try {
        const code = speakeasy.totp({ secret: session.totpSecret, encoding: 'base32' })
        await page.fill(
          'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin',
          code
        )
        await DELAY(300)
        const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")')
        if (submitBtn) await submitBtn.click()
        else await page.keyboard.press('Enter')

        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 })
        await DELAY(2000)

        const cookies = await context.cookies()
        if (cookies.find(c => c.name === 'li_at')) {
          await saveCookies(context, session.accountId)
          session.status = 'success'
          await browser.close()
          return
        }
        // If TOTP failed, fall through to manual verification
      } catch {
        // Fall through to manual verification
      }
    }

    if (hasPinInput) {
      let hint = ''
      try {
        const hintEl = await page.$('.secondary-action, .challenge-main-content p, [data-test-id="challenge-description"], h1, h2')
        if (hintEl) hint = (await hintEl.innerText()).trim()
      } catch { /* ok */ }
      session.status = 'needs_verification'
      session.hint   = hint || 'Enter the verification code sent to your email or phone.'
      return
    }

    // Push notification challenge — poll for up to 3 minutes
    let hint = ''
    try {
      const hintEl = await page.$('.secondary-action, .challenge-main-content p, [data-test-id="challenge-description"], h1, h2')
      if (hintEl) hint = (await hintEl.innerText()).trim()
    } catch { /* ok */ }

    // Store the original challenge URL so we can return to it if needed
    const challengeUrl = page.url()

    session.status = 'pending_push'
    session.hint   = hint || 'Check your phone and tap "Yes, it\'s me" on the LinkedIn notification.'

    const DEADLINE = Date.now() + 3 * 60 * 1000
    let pollCount  = 0

    while (Date.now() < DEADLINE) {
      await DELAY(2_000)
      pollCount++

      try {
        const cookies = await context.cookies()
        if (cookies.find(c => c.name === 'li_at')) {
          await saveCookies(context, session.accountId)
          session.status = 'success'
          await browser.close()
          return
        }

        const currentUrl = page.url()
        const stillOnChallenge =
          currentUrl.includes('/checkpoint') ||
          currentUrl.includes('/challenge') ||
          currentUrl.includes('verification') ||
          currentUrl.includes('login')

        if (!stillOnChallenge) {
          const freshCookies = await context.cookies()
          if (freshCookies.find(c => c.name === 'li_at')) {
            await saveCookies(context, session.accountId)
            session.status = 'success'
            await browser.close()
            return
          }
        }

        // Every ~20s navigate to feed to force cookie issuance after push approval
        if (pollCount % 10 === 0) {
          try {
            await page.goto('https://www.linkedin.com/feed/', {
              waitUntil: 'domcontentloaded',
              timeout:   10_000,
            })
            await DELAY(2_000)
            const feedCookies = await context.cookies()
            if (feedCookies.find(c => c.name === 'li_at')) {
              await saveCookies(context, session.accountId)
              session.status = 'success'
              await browser.close()
              return
            }
            // If redirected away from feed, go back to the original challenge page
            const feedUrl = page.url()
            if (feedUrl.includes('login') || feedUrl.includes('challenge') || feedUrl.includes('checkpoint') || feedUrl.includes('not-found') || feedUrl.includes('404')) {
              await page.goto(challengeUrl, {
                waitUntil: 'domcontentloaded',
                timeout:   10_000,
              }).catch(() => {})
              await DELAY(1_000)
            }
          } catch { /* keep polling */ }
        }

        // Click any intermediate "Continue" / "Send code" buttons on security check pages
        // Only try on first few polls and after navigations to avoid repeated clicks
        if (pollCount <= 3 || pollCount % 10 === 1) {
          try {
            const continueBtn = await page.$(
              'button:has-text("Continue"), button:has-text("Send verification code"), ' +
              'button:has-text("Send a verification code"), button:has-text("Request a verification code"), ' +
              'button:has-text("Send code"), button:has-text("Get a verification code"), ' +
              'button:has-text("Request verification"), button:has-text("Send"), ' +
              'button[data-litms-control-urn="challenge|primary-action"], ' +
              'button.primary-action-new, ' +
              'form button[type="submit"]'   // last-resort: any form submit button
            )
            if (continueBtn) {
              const btnText = await continueBtn.evaluate((el: Element) => (el as HTMLElement).textContent?.trim())
              // Don't click Cancel or back buttons
              if (btnText && !btnText.toLowerCase().includes('cancel') && !btnText.toLowerCase().includes('back')) {
                await continueBtn.click()
                await DELAY(2000)
                // Update hint after clicking
                const hintEl2 = await page.$('.secondary-action, .challenge-main-content p, h1, h2')
                if (hintEl2) session.hint = (await hintEl2.innerText()).trim()
              }
            }
          } catch { /* ok */ }
        }

        // Did LinkedIn switch to PIN after push confirmation?
        const nowHasPin = !!(await page.$(
          'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin'
        ))
        if (nowHasPin) {
          // Try TOTP first if we have the secret
          if (session.totpSecret) {
            try {
              const code = speakeasy.totp({ secret: session.totpSecret, encoding: 'base32' })
              await page.fill(
                'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin',
                code
              )
              await DELAY(300)
              const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")')
              if (submitBtn) await submitBtn.click()
              else await page.keyboard.press('Enter')
              await page.waitForLoadState('domcontentloaded', { timeout: 15_000 })
              await DELAY(2000)
              const cookies = await context.cookies()
              if (cookies.find(c => c.name === 'li_at')) {
                await saveCookies(context, session.accountId)
                session.status = 'success'
                await browser.close()
                return
              }
            } catch { /* fall through */ }
          }
          let newHint = ''
          try {
            const hintEl = await page.$('.secondary-action, .challenge-main-content p, h1, h2')
            if (hintEl) newHint = (await hintEl.innerText()).trim()
          } catch { /* ok */ }
          session.status = 'needs_verification'
          session.hint   = newHint || 'Enter the verification code sent to your email or phone.'
          return
        }
      } catch {
        // Page navigating — keep polling
      }
    }

    session.status = 'error'
    session.error  = 'Timed out waiting for phone confirmation (3 minutes). Please try again.'
    await browser.close()

  } catch (err) {
    const s = sessions.get(key)
    if (s) {
      s.status = 'error'
      s.error  = err instanceof Error ? err.message : 'Unknown error'
    }
    await browser?.close().catch(() => {})
  }
}

/**
 * Relay an interaction (click / type / key) to the live browser page.
 * Used by the frontend's interactive screenshot UI.
 */
export async function interactWithPage(
  sessionKey: string,
  action:
    | { type: 'click'; x: number; y: number }
    | { type: 'type';  text: string }
    | { type: 'key';   key: string }
): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(sessionKey)
  if (!session?.page) return { ok: false, error: 'Session not found or no active page' }
  try {
    if (action.type === 'click') {
      await session.page.mouse.click(action.x, action.y)
    } else if (action.type === 'type') {
      await session.page.keyboard.type(action.text)
    } else if (action.type === 'key') {
      await session.page.keyboard.press(action.key as Parameters<typeof session.page.keyboard.press>[0])
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

/**
 * Returns the pre-error debug snapshot stored in the session
 * (captured just before #username fill was attempted).
 * Works even after the browser has been closed.
 */
export function getSessionDebugSnapshot(sessionKey: string): {
  screenshot?: string
  url?: string
  text?: string
} | null {
  const session = sessions.get(sessionKey)
  if (!session) return null
  return {
    screenshot: session.debugScreenshot,
    url:        session.debugUrl,
    text:       session.debugPageText,
  }
}

/** Returns a base64 PNG screenshot of the current browser page for debugging */
export async function getSessionScreenshot(sessionKey: string): Promise<string | null> {
  const session = sessions.get(sessionKey)
  if (!session?.page) return null
  try {
    const buf = await session.page.screenshot({ type: 'png', fullPage: false })
    return buf.toString('base64')
  } catch {
    return null
  }
}

/** Returns the page URL and visible text for debugging */
export async function getSessionPageInfo(sessionKey: string): Promise<{ url: string; text: string; buttons: string[] } | null> {
  const session = sessions.get(sessionKey)
  if (!session?.page) return null
  try {
    const url = session.page.url()
    const text = await session.page.evaluate(() => document.body.innerText.substring(0, 2000))
    const buttons = await session.page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'))
        .map(el => (el as HTMLElement).textContent?.trim())
        .filter(Boolean)
    ) as string[]
    return { url, text, buttons }
  } catch {
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns a session_key immediately — all browser work is in the background */
export function startLogin(
  accountId:   string,
  email:       string,
  password:    string,
  totpSecret?: string
): string {
  const key: string = randomKey()
  sessions.set(key, {
    accountId,
    createdAt:  Date.now(),
    status:     'starting',
    hint:       '',
    totpSecret: totpSecret || undefined,
  })
  void runLogin(key, email, password)
  return key
}

export type LoginStatusResult =
  | { status: 'starting' }
  | { status: 'pending_push';       hint: string }
  | { status: 'needs_verification'; hint: string }
  | { status: 'success' }
  | { status: 'error';    message: string }
  | { status: 'not_found' }

export function getLoginStatus(sessionKey: string): LoginStatusResult {
  const s = sessions.get(sessionKey)
  if (!s) return { status: 'not_found' }
  switch (s.status) {
    case 'starting':           return { status: 'starting' }
    case 'success':            return { status: 'success' }
    case 'error':              return { status: 'error', message: s.error ?? 'Login failed.' }
    case 'needs_verification': return { status: 'needs_verification', hint: s.hint }
    default:                   return { status: 'pending_push', hint: s.hint }
  }
}

export async function submitVerificationCode(
  sessionKey: string,
  code:        string
): Promise<{ status: 'success' } | { status: 'error'; message: string }> {
  const session = sessions.get(sessionKey)
  if (!session?.browser || !session.page || !session.context) {
    return { status: 'error', message: 'Session expired. Please start the login process again.' }
  }

  const { browser, context, page, accountId } = session

  try {
    const pinInput = await page.$(
      'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin, input[type="text"]'
    )
    if (!pinInput) {
      sessions.delete(sessionKey)
      await browser.close()
      return { status: 'error', message: 'Could not find the verification code input. Please try again.' }
    }

    await pinInput.fill(code.trim())
    await DELAY(300)

    const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")')
    if (submitBtn) await submitBtn.click()
    else await page.keyboard.press('Enter')

    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 })
    await DELAY(2000)

    const errorEl = await page.$('.alert-content, .form__label--error')
    if (errorEl) {
      const msg = (await errorEl.innerText()).trim()
      return { status: 'error', message: msg || 'Verification code was incorrect.' }
    }

    const cookies = await context.cookies()
    if (!cookies.find(c => c.name === 'li_at')) {
      sessions.delete(sessionKey)
      await browser.close()
      return { status: 'error', message: 'Verification submitted but no session cookie found.' }
    }

    await saveCookies(context, accountId)
    sessions.delete(sessionKey)
    await browser.close()
    return { status: 'success' }
  } catch (err) {
    sessions.delete(sessionKey)
    await browser.close().catch(() => {})
    return { status: 'error', message: err instanceof Error ? err.message : 'Unknown error' }
  }
}
