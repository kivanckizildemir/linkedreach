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
  challengeUrl?:   string    // saved challenge URL so we can navigate back after /feed/ check
  checkNow?:       boolean   // signal from checkPushApproval to trigger immediate /feed/ check
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

/**
 * Click "Use another way" on a LinkedIn push challenge page, then select
 * email or SMS and click the "Send code" button.
 * Returns true if it successfully triggered a code send (or PIN is already visible).
 */
async function switchToAltVerification(page: Page, session: LoginSession): Promise<boolean> {
  // Step 1 — click "Use another way" type link
  const step1Selectors = [
    'button:has-text("Use another verification method")',
    'a:has-text("Use another verification method")',
    'button:has-text("Use another way")',
    'a:has-text("Use another way")',
    'button:has-text("Try another way")',
    'a:has-text("Try another way")',
    "button:has-text(\"Don't have access\")",
    "a:has-text(\"Don't have access\")",
    'button:has-text("More ways to verify")',
    'a:has-text("More ways to verify")',
  ]
  let clickedStep1 = false
  for (const sel of step1Selectors) {
    const el = await page.$(sel).catch(() => null)
    if (el) {
      console.log('[LOGIN DEBUG] switchToAlt step1 clicked:', sel)
      await el.click()
      await DELAY(2_500)
      clickedStep1 = true
      break
    }
  }
  if (!clickedStep1) {
    console.log('[LOGIN DEBUG] switchToAlt: no step-1 button found')
    return false
  }

  // Step 2 — select email option if a method-selection screen appeared
  const step2Selectors = [
    'button:has-text("Email")',
    'label:has-text("Email")',
    'a:has-text("Email a verification")',
    'button:has-text("Email a verification")',
    'input[value="email"]',
    'input[type="radio"][value*="email"]',
    '[data-test-id*="email"]',
  ]
  for (const sel of step2Selectors) {
    const el = await page.$(sel).catch(() => null)
    if (el) {
      console.log('[LOGIN DEBUG] switchToAlt step2 clicked:', sel)
      await el.click()
      await DELAY(1_500)
      break
    }
  }

  // Step 3 — click "Send verification code" / "Continue" / Submit
  const step3Selectors = [
    'button[data-litms-control-urn="challenge|primary-action"]',
    'button.primary-action-new',
    'button:has-text("Send verification code")',
    'button:has-text("Send a verification code")',
    'button:has-text("Get a verification code")',
    'button:has-text("Send code")',
    'button:has-text("Send")',
    'button:has-text("Continue")',
    'form button[type="submit"]',
  ]
  for (const sel of step3Selectors) {
    const el = await page.$(sel).catch(() => null)
    if (el) {
      const btnText = await el.evaluate((e: Element) => (e as HTMLElement).textContent?.trim() ?? '').catch(() => '')
      if (btnText && !btnText.toLowerCase().includes('cancel') && !btnText.toLowerCase().includes('back')) {
        console.log('[LOGIN DEBUG] switchToAlt step3 clicked:', btnText)
        await el.click()
        await DELAY(3_000)
        break
      }
    }
  }

  // Step 4 — check if PIN input appeared
  const hasPin = !!(await page.$(
    'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin, input[id*="verification"]'
  ).catch(() => null))

  if (hasPin) {
    session.status = 'needs_verification'
    session.hint   = 'Enter the verification code sent to your email or phone.'
    console.log('[LOGIN DEBUG] switchToAlt: PIN input visible → needs_verification')
  } else {
    session.hint = 'A verification code is on its way. Check your email or phone.'
    console.log('[LOGIN DEBUG] switchToAlt: no PIN yet, hint updated')
  }
  return true
}

/**
 * Actively check if push was approved by navigating to /feed/ and checking for li_at.
 * If not approved, navigates back to challengeUrl.
 */
async function checkFeedForApproval(
  page: Page,
  context: import('playwright').BrowserContext,
  session: LoginSession,
  browser: Browser
): Promise<boolean> {
  const challengeUrl = session.challengeUrl || page.url()
  try {
    console.log('[LOGIN DEBUG] checkFeed: navigating to /feed/')
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 12_000 })
    const cookies = await context.cookies()
    if (cookies.find(c => c.name === 'li_at')) {
      await saveCookies(context, session.accountId)
      session.status = 'success'
      console.log('[LOGIN DEBUG] checkFeed: li_at found → success')
      await browser.close()
      return true
    }
    // Not approved yet — navigate back to challenge
    console.log('[LOGIN DEBUG] checkFeed: no li_at, going back to', challengeUrl.substring(0, 80))
    await page.goto(challengeUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => {})
  } catch (err) {
    console.log('[LOGIN DEBUG] checkFeed error:', String(err).substring(0, 80))
    // Try to recover
    await page.goto(challengeUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {})
  }
  return false
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
    // Note: LinkedIn's React SPA generates dynamic IDs like :r0:, :r1: — so we use
    // type/name/autocomplete attributes or position-based selectors as fallbacks.
    const EMAIL_SELECTORS = [
      '#username',
      'input[name="session_key"]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name="email"]',
      'input[id*="email"]',
      'input[placeholder*="Email"], input[placeholder*="email"]',
      'form input[type="text"]:first-of-type',
      // React-generated IDs like :r0: — just wait for any visible text input in the login form
      'input[type="text"]',
    ]

    // First, wait for any input to appear (the form to be hydrated)
    await page.waitForSelector('input', { timeout: 20_000 }).catch(() => {})

    let emailSelector = 'input[type="text"]'
    let foundEmailInput = false
    for (const sel of EMAIL_SELECTORS) {
      try {
        const el = await page.$(sel)
        if (el) { emailSelector = sel; foundEmailInput = true; break }
      } catch { /* try next */ }
    }

    // If still not found, try waiting for the first text input with a longer timeout
    if (!foundEmailInput) {
      try {
        await page.waitForSelector('input[type="text"], input:not([type])', { timeout: 10_000 })
        emailSelector = 'input[type="text"]'
        foundEmailInput = true
      } catch { /* fall through to error */ }
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

    // ── Credential submission via real browser interaction ────────────────────────
    // LinkedIn's SDUI form now encrypts credentials client-side (encrypted_session_key).
    // Direct HTTP POST can't replicate that encryption. Using page.type() + page.click()
    // lets LinkedIn's own JavaScript handle it, and looks like a real user to their
    // bot-detection systems.

    // Step 1: Extract form fields (non-password) from the login form.
    // LinkedIn's newer SPA uses Shadow DOM / web components, so document.querySelector
    // may not find inputs. We use a deep search that traverses shadow roots.
    const formFields = await page.evaluate((args: { emailVal: string }) => {
      // Helper: collect all inputs from the entire DOM including shadow roots
      function collectInputs(root: Document | ShadowRoot | Element): HTMLInputElement[] {
        const inputs: HTMLInputElement[] = []
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
        let node = walker.currentNode as Element
        while (node) {
          if (node.tagName === 'INPUT') {
            inputs.push(node as HTMLInputElement)
          }
          // Check shadow DOM
          if (node.shadowRoot) {
            inputs.push(...collectInputs(node.shadowRoot))
          }
          node = walker.nextNode() as Element
          if (!node) break
        }
        return inputs
      }

      try {
        const allInputs = collectInputs(document)

        // Find CSRF input first — it's the best anchor
        const csrfInput = allInputs.find(i => i.name === 'loginCsrfParam' || i.name === 'csrfToken')
        let form: HTMLFormElement | null = csrfInput?.closest('form') as HTMLFormElement | null

        // Try to find form from session_key input
        if (!form) {
          const sessionKeyInput = allInputs.find(i => i.name === 'session_key')
          if (sessionKeyInput) form = sessionKeyInput.closest('form') as HTMLFormElement | null
        }

        // Try to find form from any named input
        if (!form) {
          for (const inp of allInputs) {
            if (inp.name) {
              const f = inp.closest('form') as HTMLFormElement | null
              if (f) { form = f; break }
            }
          }
        }

        // If still no form, check if inputs are directly in page (no form wrapper)
        // This happens in some SPA frameworks — collect all inputs and use the login endpoint
        const inputsInForm = form
          ? (Array.from(form.querySelectorAll('input:not([type="password"])')) as HTMLInputElement[])
          : allInputs.filter(i => i.type !== 'password')

        if (inputsInForm.length === 0 && allInputs.length === 0) {
          return { error: 'No form found via any method' }
        }

        const fields: Record<string, string> = {}
        for (const inp of inputsInForm) {
          if (inp.name && !inp.disabled) {
            fields[inp.name] = inp.value
          }
        }
        // Override session_key with the email we want to submit
        fields['session_key'] = args.emailVal

        const formAction = form?.getAttribute('action') ?? ''

        return { fields, action: formAction, inputCount: inputsInForm.length, totalInputs: allInputs.length }
      } catch (e) {
        return { error: String(e) }
      }
    }, { emailVal: email })

    console.log('[LOGIN DEBUG] formFields:', JSON.stringify(formFields))

    if (!formFields || 'error' in formFields || !formFields.fields) {
      session.status = 'error'
      session.error  = `Could not extract form fields: ${JSON.stringify(formFields)}`
      await browser.close()
      return
    }

    // Detect if we're on the new SDUI form (has encrypted_session_key instead of loginCsrfParam).
    // The new form requires RSA-encrypted credentials — we can't handle it yet.
    // Retry with the classic checkpoint login page which has standard form fields.
    const isNewSPAForm = 'encrypted_session_key' in formFields.fields && !('loginCsrfParam' in formFields.fields)
    if (isNewSPAForm) {
      console.log('[LOGIN DEBUG] Detected new SDUI form — retrying with classic login page')
      // Try the classic checkpoint login page
      await page.goto('https://www.linkedin.com/login?fromSignIn=true&trk=guest_homepage-basic_nav-header-signin', { waitUntil: 'load', timeout: 30_000 }).catch(() => {})
      await DELAY(2000)

      // Re-extract form fields from the classic page
      const classicFormFields = await page.evaluate((emailVal: string) => {
        // Only collect non-password inputs at top-level (classic form, no shadow DOM)
        const inputs = Array.from(document.querySelectorAll('input:not([type="password"])')) as HTMLInputElement[]
        const fields: Record<string, string> = {}
        for (const inp of inputs) {
          if (inp.name && !inp.disabled) fields[inp.name] = inp.value
        }
        fields['session_key'] = emailVal
        const form = document.querySelector('form') as HTMLFormElement | null
        return { fields, action: form?.getAttribute('action') ?? '', hasLoginCsrf: 'loginCsrfParam' in fields }
      }, email).catch(() => null)

      if (classicFormFields && 'loginCsrfParam' in (classicFormFields.fields ?? {})) {
        // Successfully got classic form
        const newFormFields = classicFormFields as unknown as typeof formFields
        formFields.fields = newFormFields.fields
        formFields.action = newFormFields.action
        console.log('[LOGIN DEBUG] Classic form found with loginCsrfParam')
      } else {
        console.log('[LOGIN DEBUG] Classic form retry failed, proceeding with new form fields')
      }
    }

    // Step 2: Type credentials into the form fields with human-like delays.
    // page.type() fires real keyboard events — LinkedIn's JS tracks these for bot detection.
    const passSelector = '#password, input[name="session_password"], input[type="password"]'
    await page.waitForSelector(passSelector, { timeout: 10_000 }).catch(() => {
      console.log('[LOGIN DEBUG] Password field not visible via waitForSelector')
    })

    await dismissBanners()

    // Clear then type — ensures React state updates correctly
    await page.fill(emailSelector, '')
    await page.type(emailSelector, email, { delay: 55 + Math.floor(Math.random() * 70) })
    await DELAY(400 + Math.random() * 400)

    await page.fill(passSelector, '')
    await page.type(passSelector, password, { delay: 55 + Math.floor(Math.random() * 70) })
    await DELAY(400 + Math.random() * 400)

    await captureSnap('pre-submit')

    // Step 3: Click the submit button — LinkedIn's JS will encrypt credentials and submit.
    const submitBtn = await page.$(
      'button[type="submit"], .btn__primary--large, ' +
      'button[data-litms-control-urn="guest|submit"], ' +
      'button[data-id="sign-in-form__submit-btn"], ' +
      'form .sign-in-form__submit-btn'
    ).catch(() => null)

    const preSubmitUrl = page.url()
    if (submitBtn) {
      console.log('[LOGIN DEBUG] Clicking submit button')
      await submitBtn.click()
    } else {
      console.log('[LOGIN DEBUG] No submit button found — pressing Enter')
      await page.keyboard.press('Enter')
    }

    // Wait for navigation away from the login page
    try {
      await page.waitForURL(
        (u) => !String(u).includes('/login') || String(u).includes('/checkpoint') || String(u).includes('/challenge'),
        { timeout: 25_000, waitUntil: 'domcontentloaded' }
      )
    } catch {
      console.log('[LOGIN DEBUG] waitForURL timed out after submit — checking page state anyway')
    }
    await DELAY(1500)
    await captureSnap('post-submit')

    // Map browser state into the variable names used by the rest of this function
    const redirectLocation = page.url()
    const submitDiag = `post-submit url=${redirectLocation.substring(0, 80)}`
    console.log('[LOGIN DEBUG]', submitDiag)

    // Check if li_at is now in the browser context (login succeeded without challenge)
    const cookiesAfterPost = await context.cookies()
    const liAtCookie = cookiesAfterPost.find(c => c.name === 'li_at' && c.value && c.value.length > 5)

    if (liAtCookie) {
      await saveCookies(context, session.accountId)
      session.status = 'success'
      await browser.close()
      return
    }

    // Check for bad credentials (stayed on /login or redirected back with error)
    const isLoginRedirect = redirectLocation.includes('/login') && !redirectLocation.includes('/checkpoint') && !redirectLocation.includes('/challenge')
    const isErrorRedirect = redirectLocation.includes('errorKey') || redirectLocation.includes('unexpected_error')
    const isChallenge = redirectLocation.includes('/checkpoint') || redirectLocation.includes('/challenge') || redirectLocation.includes('verification')

    const url = redirectLocation

    // Read any inline error message from the page (wrong password, account locked, etc.)
    let pageErrorText = ''
    try {
      const errEl = await page.$('[role="alert"], .alert-content, .form__label--error, #error-for-password, #error-for-username')
      if (errEl) pageErrorText = (await errEl.innerText().catch(() => '')).trim()
    } catch { /* ok */ }

    // If redirected to login with error — wrong credentials or unexpected error
    if ((isLoginRedirect && !isChallenge) || isErrorRedirect) {
      session.status = 'error'
      session.error  = pageErrorText || 'Incorrect email or password. Please check your credentials.'
      await browser.close()
      return
    }

    // If we never left the login page and there's no challenge — submission may have silently failed
    if (redirectLocation === preSubmitUrl && !isChallenge) {
      session.status = 'error'
      session.error  = pageErrorText || 'Login form did not submit. LinkedIn may have changed their form structure. Please try reconnecting.'
      await browser.close()
      return
    }

    // If credentials were accepted and we have a challenge URL, but BrightData blocks
    // navigation to /checkpoint pages — set needs_verification so the user can complete
    // verification manually (or the system can handle it via the interactive browser UI).
    if (isChallenge) {
      // LinkedIn blocks with tooManyAttempts when too many verifications attempted recently
      if (url.includes('tooManyAttempts')) {
        session.status = 'error'
        session.error  = 'LinkedIn has temporarily blocked verification attempts on this account. Please wait 30–60 minutes before trying again.'
        await browser.close()
        return
      }

      console.log('[LOGIN DEBUG] Challenge page detected:', url.substring(0, 80))
      // With the browser-click approach, we are ALREADY on the challenge page after submit.
      // Wait for networkidle so the React/JS challenge UI fully renders before we read it.
      // LinkedIn's challenge pages load their content via API calls after the initial HTML.
      let postNavUrl = page.url()
      let postNavText = ''
      try {
        await page.waitForLoadState('networkidle', { timeout: 15_000 })
      } catch { /* ok — some challenges never reach networkidle */ }
      await DELAY(3_000) // extra buffer for any lazy-loaded challenge widgets
      postNavUrl = page.url()
      postNavText = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 600)).catch(() => '') as string
      console.log('[LOGIN DEBUG] Challenge rendered. URL:', postNavUrl)
      console.log('[LOGIN DEBUG] Challenge text:', postNavText.substring(0, 250))

      // If the proxy redirected us back to the login page instead of the challenge page,
      // we can't complete 2FA through it. Ask the user to use Quick Login instead.
      const proxyBlockedChallenge =
        postNavUrl.includes('/login') &&
        (postNavUrl.includes('?') || postNavUrl === 'https://www.linkedin.com/login')
      if (proxyBlockedChallenge) {
        session.status = 'error'
        session.error  = 'LinkedIn requires verification but the proxy is blocking the challenge page. Please use Quick Login (cookie method) to connect this account.'
        await browser.close()
        return
      }

      const finalCookies = await context.cookies()
      if (finalCookies.find(c => c.name === 'li_at')) {
        await saveCookies(context, session.accountId)
        session.status = 'success'
        await browser.close()
        return
      }

      // ── Detect challenge type from the page content ───────────────────────
      const textLower = postNavText.toLowerCase()
      const hasPinInputNow = !!(await page.$(
        'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin, input[id*="verification"], input[name*="verification"]'
      ).catch(() => null))

      // "Let's do a quick security check" / CAPTCHA — page rendered but has no actionable
      // inputs. This is LinkedIn's bot-detection challenge requiring human interaction.
      // It appears when Railway's IP or the proxy IP is flagged as suspicious.
      const isSecurityCheck = (textLower.includes('security check') || textLower.includes('quick security') || textLower.includes('suspicious activity'))
        && !hasPinInputNow
      if (isSecurityCheck) {
        console.log('[LOGIN DEBUG] LinkedIn security check detected — requires manual resolution')
        await supabase.from('linkedin_accounts').update({
          debug_log: { label: 'security_check', postNavUrl, postNavText: postNavText.substring(0, 400), capturedAt: new Date().toISOString() }
        }).eq('id', session.accountId)
        session.status = 'error'
        session.error  = 'LinkedIn is asking for a security check that requires human interaction. Please use the "Set Session Cookie" method: log in to LinkedIn in your browser, copy the li_at cookie, and paste it here instead.'
        await browser.close()
        return
      }

      const isEmailChallenge = textLower.includes('email') || textLower.includes('sent a code') || textLower.includes('check your inbox')
      const isPhoneChallenge = textLower.includes('text message') || textLower.includes('sms') || (textLower.includes('phone') && !textLower.includes('approve'))
      // Includes notification/approve text OR very short page (still loading) → treat as push
      const isAppPush = textLower.includes('approve') || textLower.includes('tap') || textLower.includes('notification') || postNavText.length < 30

      // Auto-click "Send verification code" if visible (email/phone OTP challenge)
      if (!hasPinInputNow && (isEmailChallenge || isPhoneChallenge)) {
        for (const btnSel of [
          'button[data-litms-control-urn="challenge|primary-action"]',
          'button.primary-action-new',
          'button:has-text("Send verification code")',
          'button:has-text("Send a verification code")',
          'button:has-text("Get a verification code")',
          'button:has-text("Send code")',
          'button:has-text("Request a verification code")',
          'form button[type="submit"]',
        ]) {
          try {
            const btn = await page.$(btnSel)
            if (btn) {
              const btnText = await btn.evaluate((el: Element) => (el as HTMLElement).textContent?.trim() ?? '')
              if (btnText && !btnText.toLowerCase().includes('cancel') && !btnText.toLowerCase().includes('back')) {
                console.log('[LOGIN DEBUG] Clicking challenge button:', btnText)
                await btn.click()
                await DELAY(2500)
                break
              }
            }
          } catch { /* ok */ }
        }
        // After clicking, re-read page text and check for PIN input
        postNavText = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 500)).catch(() => '') as string
      }

      // Check again for PIN input after potential button click
      const hasPinAfterClick = !!(await page.$(
        'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin, input[id*="verification"], input[name*="verification"]'
      ).catch(() => null))

      await supabase.from('linkedin_accounts').update({
        debug_log: {
          label: 'challenge',
          challengeUrl: url,
          postNavUrl,
          postNavText: postNavText.substring(0, 400),
          hasPinInput: hasPinAfterClick,
          isEmailChallenge,
          isPhoneChallenge,
          isAppPush,
          capturedAt: new Date().toISOString(),
        }
      }).eq('id', session.accountId)

      if (hasPinAfterClick) {
        // PIN/OTP input is visible — try TOTP auto-fill if secret is set
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
            await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
            await DELAY(2000)
            const cookies = await context.cookies()
            if (cookies.find(c => c.name === 'li_at')) {
              await saveCookies(context, session.accountId)
              session.status = 'success'
              await browser.close()
              return
            }
          } catch { /* fall through to manual */ }
        }
        // Determine where the code was sent for the hint
        const codeDestination = isEmailChallenge
          ? 'your email'
          : isPhoneChallenge
            ? 'your phone via SMS'
            : 'your email or phone'
        session.status = 'needs_verification'
        session.hint   = `LinkedIn sent a verification code to ${codeDestination}. Enter it in the app to complete sign-in.`
        return
      }

      if (isEmailChallenge || isPhoneChallenge) {
        // We clicked send but PIN input not visible yet — set needs_verification
        const dest = isEmailChallenge ? 'your email inbox' : 'your phone via SMS'
        session.status = 'needs_verification'
        session.hint   = `LinkedIn sent a verification code to ${dest}. Enter it in the app to complete sign-in.`
        return
      }

      // Push notification (mobile app approval) or unknown challenge.
      // Click the primary action button ONCE to trigger the push notification.
      // Then stay on the page and poll — do NOT navigate away (causes tooManyAttempts).
      try {
        for (const btnSel of [
          'button[data-litms-control-urn="challenge|primary-action"]',
          'button.primary-action-new',
          'button:has-text("Continue")',
          'button:has-text("Send push")',
          'button:has-text("Use the app")',
          'form button[type="submit"]',
        ]) {
          const btn = await page.$(btnSel).catch(() => null)
          if (btn) {
            const btnText = ((await btn.evaluate((el: Element) => (el as HTMLElement).textContent?.trim()).catch(() => '')) ?? '').toLowerCase()
            if (!btnText.includes('cancel') && !btnText.includes('back') && !btnText.includes('email') && !btnText.includes('sms') && !btnText.includes('text message')) {
              console.log('[LOGIN DEBUG] Clicking push trigger button:', btnText)
              await btn.click()
              await DELAY(2000)
              break
            }
          }
        }
      } catch { /* ok if no button */ }

      session.status       = 'pending_push'
      session.hint         = isAppPush
        ? 'Open the LinkedIn app on your phone and tap "Yes, it\'s me" to approve the sign-in.'
        : 'LinkedIn is verifying your identity. Approve on your phone or we\'ll switch to a code automatically.'
      session.challengeUrl = page.url()

      const PUSH_DEADLINE = Date.now() + 3 * 60 * 1000
      let pollCount = 0
      let altSwitchDone = false

      while (Date.now() < PUSH_DEADLINE) {
        await DELAY(2_000)
        pollCount++
        try {
          // Every 5 polls (~10 s) — or immediately if signalled — actively check /feed/
          // This is the primary approval detection when the challenge page's own JS is
          // blocked by the proxy and cannot auto-redirect.
          if (session.checkNow || pollCount % 5 === 0) {
            session.checkNow = false
            const approved = await checkFeedForApproval(page, context, session, browser)
            if (approved) return
            // After navigating back, re-check for PIN input on the challenge page
          }

          // Fast path: li_at cookie set by auto-redirect (challenge JS working)
          const pushCookies = await context.cookies()
          if (pushCookies.find(c => c.name === 'li_at')) {
            await saveCookies(context, session.accountId)
            session.status = 'success'
            await browser.close()
            return
          }

          // Detect auto-redirect away from challenge (LinkedIn JS working)
          const nowUrl = page.url()
          const leftChallenge =
            !nowUrl.includes('/checkpoint') &&
            !nowUrl.includes('/challenge') &&
            !nowUrl.includes('verification') &&
            !nowUrl.includes('/login')
          if (leftChallenge) {
            const afterCookies = await context.cookies()
            if (afterCookies.find(c => c.name === 'li_at')) {
              await saveCookies(context, session.accountId)
              session.status = 'success'
              await browser.close()
              return
            }
          }

          // PIN input appeared (LinkedIn switched from push to code)
          const pinNow = await page.$('input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin').catch(() => null)
          if (pinNow) {
            if (session.totpSecret) {
              try {
                const totp = speakeasy.totp({ secret: session.totpSecret, encoding: 'base32' })
                await page.fill('input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin', totp)
                await DELAY(300)
                const sb = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")')
                if (sb) await sb.click(); else await page.keyboard.press('Enter')
                await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
                const totpCookies = await context.cookies()
                if (totpCookies.find(c => c.name === 'li_at')) {
                  await saveCookies(context, session.accountId)
                  session.status = 'success'
                  await browser.close()
                  return
                }
              } catch { /* fall through to manual */ }
            }
            session.status = 'needs_verification'
            session.hint   = 'LinkedIn sent a verification code. Check your email or phone.'
            return
          }

          // After ~30 s with no approval, switch to email/SMS code
          if (!altSwitchDone && pollCount >= 15) {
            altSwitchDone = true
            const switched = await switchToAltVerification(page, session)
            if (switched && session.status === 'needs_verification') return
          }
        } catch { /* network blip, keep polling */ }
      }

      session.status = 'error'
      session.error  = 'Verification not completed within 3 minutes. Please try again.'
      await browser.close()
      return
    }

    // Navigate the browser to the redirect URL (non-challenge pages)
    if (url) {
      const navUrl = url.startsWith('http') ? url : `https://www.linkedin.com${url}`
      console.log('[LOGIN DEBUG] Navigating browser to:', navUrl)
      try {
        await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        await DELAY(2000)
      } catch (navErr) {
        console.log('[LOGIN DEBUG] Navigation error (ok):', String(navErr).substring(0, 100))
      }
    }
    const postNavUrl = page.url()
    const postNavText = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 300)).catch(() => '')
    console.log('[LOGIN DEBUG] Post-nav URL:', postNavUrl, 'text:', postNavText.substring(0, 100))

    // Check if we succeeded after navigation
    const finalCookies = await context.cookies()
    if (finalCookies.find(c => c.name === 'li_at')) {
      await saveCookies(context, session.accountId)
      session.status = 'success'
      await browser.close()
      return
    }

    await supabase.from('linkedin_accounts').update({
      debug_log: {
        label: 'post-nav',
        postNavUrl,
        postNavText: postNavText.substring(0, 400),
        cookieNames: finalCookies.map(c => c.name),
        challengeRedirectUrl: url,
        capturedAt: new Date().toISOString(),
      }
    }).eq('id', session.accountId)

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

    // Push notification / unknown challenge — get page text for better hint
    let hint = ''
    try {
      const hintEl = await page.$('.secondary-action, .challenge-main-content p, [data-test-id="challenge-description"], h1, h2')
      if (hintEl) hint = (await hintEl.innerText()).trim()
    } catch { /* ok */ }
    if (!hint) {
      try {
        hint = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 200)).catch(() => '') as string
      } catch { /* ok */ }
    }

    // Store the original challenge URL so we can return to it after /feed/ checks
    const challengeUrl = page.url()
    session.challengeUrl = challengeUrl

    session.status = 'pending_push'
    session.hint   = hint || 'Check your phone and tap "Yes, it\'s me" on the LinkedIn notification.'

    // Click the push trigger button IMMEDIATELY — don't wait for the first loop iteration.
    // This saves ~2 seconds and sends the push notification sooner.
    try {
      const triggerBtn = await page.$(
        'button[data-litms-control-urn="challenge|primary-action"], button.primary-action-new, ' +
        'button:has-text("Continue"), button:has-text("Send push"), button:has-text("Use the app"), ' +
        'form button[type="submit"]'
      ).catch(() => null)
      if (triggerBtn) {
        const triggerText = (await triggerBtn.evaluate((el: Element) => (el as HTMLElement).textContent?.trim()).catch(() => '')).toLowerCase()
        if (!triggerText.includes('cancel') && !triggerText.includes('back') && !triggerText.includes('email') && !triggerText.includes('sms')) {
          console.log('[LOGIN DEBUG] Loop2: clicking trigger button immediately:', triggerText)
          await triggerBtn.click()
          await DELAY(1_500)
          try {
            const updatedHintEl = await page.$('.secondary-action, .challenge-main-content p, h1, h2')
            if (updatedHintEl) session.hint = (await updatedHintEl.innerText()).trim()
          } catch { /* ok */ }
        }
      }
    } catch { /* ok */ }

    const DEADLINE = Date.now() + 3 * 60 * 1000
    let pollCount  = 0
    let altSwitchDone = false

    while (Date.now() < DEADLINE) {
      await DELAY(2_000)
      pollCount++

      try {
        // Every 5 polls (~10 s) — or on demand — actively navigate to /feed/ to check
        // if the push was approved. This is the primary mechanism when the challenge
        // page's own JavaScript is blocked by the proxy.
        if (session.checkNow || pollCount % 5 === 0) {
          session.checkNow = false
          const approved = await checkFeedForApproval(page, context, session, browser)
          if (approved) return
        }

        // Fast-path cookie check (challenge page JS auto-redirected and set li_at)
        const cookies = await context.cookies()
        if (cookies.find(c => c.name === 'li_at')) {
          await saveCookies(context, session.accountId)
          session.status = 'success'
          await browser.close()
          return
        }

        // Auto-redirect detection
        const currentUrl = page.url()
        const leftChallenge =
          !currentUrl.includes('/checkpoint') &&
          !currentUrl.includes('/challenge') &&
          !currentUrl.includes('verification') &&
          !currentUrl.includes('/login')
        if (leftChallenge) {
          const freshCookies = await context.cookies()
          if (freshCookies.find(c => c.name === 'li_at')) {
            await saveCookies(context, session.accountId)
            session.status = 'success'
            await browser.close()
            return
          }
        }

        // PIN input detection — LinkedIn switched from push to code
        const nowHasPin = !!(await page.$(
          'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin, input[id*="verification"]'
        ).catch(() => null))
        if (nowHasPin) {
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
              const totpCookies = await context.cookies()
              if (totpCookies.find(c => c.name === 'li_at')) {
                await saveCookies(context, session.accountId)
                session.status = 'success'
                await browser.close()
                return
              }
            } catch { /* fall through to manual */ }
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

        // After ~30 s with no approval, switch to email/SMS code automatically
        if (!altSwitchDone && pollCount >= 15) {
          altSwitchDone = true
          const switched = await switchToAltVerification(page, session)
          if (switched && session.status === 'needs_verification') return
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
  | { status: 'pending_push';       hint: string; pageUrl?: string }
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
    default:                   return { status: 'pending_push', hint: s.hint, pageUrl: s.page?.url() }
  }
}

// Called when user taps "I approved it" — navigates to feed immediately to force
// cookie issuance rather than waiting for the background poll cycle.
export async function checkPushApproval(sessionKey: string): Promise<LoginStatusResult> {
  const s = sessions.get(sessionKey)
  if (!s) return { status: 'not_found' }
  if (s.status === 'success') return { status: 'success' }
  if (s.status !== 'pending_push') return getLoginStatus(sessionKey)

  // Signal the background polling loop to do an immediate /feed/ check on its next iteration.
  // We don't navigate directly here to avoid racing with the loop's own page.goto() calls.
  s.checkNow = true

  // Give the background loop up to 4 s to complete the check
  await new Promise(r => setTimeout(r, 4_000))

  return getLoginStatus(sessionKey)
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

/**
 * Immediately try to switch to email/SMS code verification.
 * Called when the user clicks "Request a code instead" in the UI.
 */
export async function requestVerificationCode(
  sessionKey: string
): Promise<{ status: 'switching' | 'already_on_code' | 'error'; message: string }> {
  const s = sessions.get(sessionKey)
  if (!s?.page) return { status: 'error', message: 'Session not found or already closed.' }

  // If already waiting for a PIN, nothing to do
  if (s.status === 'needs_verification') {
    return { status: 'already_on_code', message: 'Already waiting for a code.' }
  }

  try {
    const switched = await switchToAltVerification(s.page, s)
    if (!switched) {
      return { status: 'error', message: 'No alternative verification button found on the page. Please wait — we\'ll switch automatically in 30 seconds.' }
    }
    if ((s as LoginSession).status === 'needs_verification') {
      return { status: 'switching', message: 'Code sent! Enter the verification code below.' }
    }
    return { status: 'switching', message: 'A verification code is on its way. Check your email or phone.' }
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'Unknown error' }
  }
}
