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
import { solveRecaptchaV2 } from '../lib/captchaSolver'

import { chromium } from 'playwright'

// ── Approach 1: playwright-extra + stealth plugin ─────────────────────────────
// playwright-extra wraps Playwright with plugin support.
// puppeteer-extra-plugin-stealth patches 24+ JS bot-detection vectors:
//   WebGL vendor/renderer (headless uses SwiftShader, a dead giveaway),
//   navigator.permissions, navigator.plugins, hairline feature, language
//   consistency, chrome.runtime, csp, sourceurl, etc.
// This runs BEFORE any page JavaScript executes so LinkedIn's detection
// code sees a real browser environment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { chromium: chromiumExtra } = require('playwright-extra') as typeof import('playwright')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
// Only register the plugin once (module-level side-effect)
;(chromiumExtra as unknown as { use?: (p: unknown) => void }).use?.(StealthPlugin())

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
  usingCDP?:       boolean   // true when connected via BrightData Scraping Browser CDP
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
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 8_000 })
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
      .select('proxy_id')
      .eq('id', accountId)
      .single()

    // If the account has its own residential proxy, use local Chromium + that proxy
    // instead of BrightData Scraping Browser. This avoids BrightData's CDP restrictions
    // (blocked fetch, blocked keyboard.type on password, non-working page.route intercept)
    // and uses a trusted static IP the user controls.
    if ((account as { proxy_id?: string | null })?.proxy_id) {
      console.log(`[LOGIN DEBUG] Account has own proxy — skipping BrightData, using local Chromium + residential proxy`)
      return null
    }

    // No account proxy → fall back to BrightData Scraping Browser with country targeting.
    const country = process.env.BRIGHTDATA_DEFAULT_COUNTRY ?? 'gb'

    const url = new URL(browserUrl)
    const baseUser = decodeURIComponent(url.username)

    // Always apply the country from DB (or fallback env/default).
    // Strip any -country-xx already in the env var so we never double-append
    // and so the DB value always wins over whatever was hardcoded in the env var.
    const userWithoutCountry = baseUser.replace(/-country-[a-z]{2,3}/gi, '')
    url.username = encodeURIComponent(`${userWithoutCountry}-country-${country.toLowerCase()}`)
    console.log(`[LOGIN DEBUG] BrightData country targeting applied: ${country} (base user: ${userWithoutCountry})`)

    console.log(`[LOGIN DEBUG] BrightData endpoint username: ${decodeURIComponent(url.username).replace(/:.*/, '')}`)
    return url.toString()
  } catch {
    return null
  }
}

/** Resolve local-proxy settings for an account from DB or env fallback */
async function resolveProxy(accountId: string): Promise<
  { server: string; username?: string; password?: string } | undefined
> {
  if (process.env.DISABLE_PROXY === 'true') return undefined

  // Support both a pre-built URL (BRIGHTDATA_PROXY_URL) and separate vars (PROXY_HOST / USERNAME / PASSWORD)
  let BD_PROXY_URL = process.env.BRIGHTDATA_PROXY_URL ?? ''
  if (!BD_PROXY_URL && process.env.PROXY_HOST) {
    const host = process.env.PROXY_HOST
    const port = process.env.PROXY_PORT ?? '10000'
    const user = encodeURIComponent(process.env.PROXY_USERNAME ?? '')
    const pass = encodeURIComponent(process.env.PROXY_PASSWORD ?? '')
    BD_PROXY_URL = user && pass ? `http://${user}:${pass}@${host}:${port}` : `http://${host}:${port}`
  }

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
      const raw = (proxy as { proxy_url: string }).proxy_url
      // Support http://, https://, socks4://, socks5:// — only prepend http:// for bare host:port strings
      const normalized = /^(https?|socks[45]):\/\//i.test(raw) ? raw : `http://${raw}`
      const url = new URL(normalized)
      const resolved = {
        server:   `${url.protocol}//${url.host}`,
        username: decodeURIComponent(url.username) || undefined,
        password: decodeURIComponent(url.password) || undefined,
      }
      console.log(`[login] resolveProxy: using DB proxy for account ${accountId} — server=${resolved.server} user=${resolved.username ?? '(none)'}`)
      return resolved
    }
  }

  if (BD_PROXY_URL) {
    const url = new URL(BD_PROXY_URL)
    const host = url.hostname
    const port = url.port
    // Country targeting: read from the assigned proxy record (proxies.country)
    const baseUsername = decodeURIComponent(url.username) || undefined
    let country: string | null = null
    if ((account as { proxy_id?: string | null })?.proxy_id) {
      const { data: proxyRow } = await supabase
        .from('proxies')
        .select('country')
        .eq('id', (account as { proxy_id: string }).proxy_id)
        .single()
      country = (proxyRow as { country?: string | null } | null)?.country ?? null
    }
    // Strip any -country-xx already baked into the env var username so the DB value wins.
    const baseUsernameClean = baseUsername?.replace(/-country-[a-z]{2,3}/gi, '')
    const username = baseUsernameClean && country
      ? `${baseUsernameClean}-country-${country.toLowerCase()}`
      : baseUsernameClean
    // BrightData: port 33335 is SSL-only and Chromium doesn't support
    // SSL proxy servers. Always connect via the plain HTTP port 22225.
    const proxyPort = host.includes('superproxy.io') ? '22225' : port
    const envResolved = {
      server:   `http://${host}:${proxyPort}`,
      username,
      password: decodeURIComponent(url.password) || undefined,
    }
    console.log(`[login] resolveProxy: using env-var proxy for account ${accountId} — server=${envResolved.server} user=${envResolved.username ?? '(none)'}`)
    return envResolved
  }

  console.log(`[login] resolveProxy: NO proxy configured for account ${accountId} — set proxy in Accounts & Proxies or via PROXY_HOST env var`)
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
    // Use BrightData Scraping Browser for login — it's the only thing that loads LinkedIn
    // reliably from Railway. CDP password typing is blocked, but page.route() interception
    // is NOT blocked — we inject the password directly into the login-submit POST body.
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

      // Inject a MutationObserver init script that auto-clicks the consent Accept
      // button the instant it appears in the DOM — language-agnostic, fires before
      // any page JavaScript can re-render or re-attach the banner.
      // This is more reliable than waitForSelector + click() after the fact because:
      //   1. Works in any language (Norwegian, Ukrainian, Arabic, etc.)
      //   2. Fires synchronously on DOM insertion — no timing race
      //   3. Runs inside the page context so BrightData can't sandbox it
      try {
        await context.addInitScript(() => {
          const tryAccept = () => {
            // Attribute-based: LinkedIn artdeco consent button
            const attrBtn = document.querySelector(
              'button[action-type="ACCEPT"], ' +
              'button[data-tracking-control-name="cookie_policy_banner_accept"], ' +
              '#artdeco-global-alert-action--accept, ' +
              'button[data-control-name="accept"]'
            ) as HTMLElement | null
            if (attrBtn) { attrBtn.click(); return true }
            // Fallback: any button whose FULL text is a single "accept"-like word
            // Covers 30+ languages without needing a hardcoded list
            const allBtns = Array.from(document.querySelectorAll('button'))
            const acceptBtn = allBtns.find(b => {
              const t = (b.textContent ?? '').trim().toLowerCase()
              // Match short single-word accept tokens (≤12 chars, no spaces)
              return t.length > 0 && t.length <= 12 && !/\s/.test(t) &&
                /^(accept|allow|agree|ok|terima|accepter|akkoord|aceptar|accetta|akzept|kabul|прийняти|принять|accep|godta|acceptér|hyväksy|elfogad|قبول|同意|허용|承認|ยอมรับ)/.test(t)
            }) as HTMLElement | undefined
            if (acceptBtn) { acceptBtn.click(); return true }
            return false
          }

          // Try immediately in case the banner is already in the DOM
          if (!tryAccept()) {
            // Watch for banner to be inserted dynamically
            const obs = new MutationObserver(() => {
              if (tryAccept()) obs.disconnect()
            })
            obs.observe(document.documentElement, { childList: true, subtree: true })
            // Stop watching after 15s to avoid memory leaks on pages without a banner
            setTimeout(() => obs.disconnect(), 15_000)
          }
        })
        console.log('[LOGIN DEBUG] Consent MutationObserver init script injected')
      } catch (initErr) {
        console.warn('[LOGIN DEBUG] Could not inject consent init script:', initErr)
      }

    } else {
      // ── Strategy 2: playwright-extra + stealth + proxy ───────────────────
      // Uses chromiumExtra (playwright-extra) instead of raw chromium so the
      // stealth plugin runs its patches before any page script executes.
      const proxy = await resolveProxy(session.accountId)
      console.log('[login] resolvedProxy:', proxy ? `server=${proxy.server} user=${proxy.username}` : 'none')

      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      browser = await (chromiumExtra as unknown as typeof chromium).launch({
        headless: true,
        ...(proxy ? { proxy } : {}),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          // ── Approach 3: Reduce CDP / automation signal surface ───────────────
          // AutomationControlled is the primary JS-visible flag
          '--disable-blink-features=AutomationControlled',
          // Remove "Chrome is being controlled by automated test software" banner
          '--exclude-switches=enable-automation',
          '--disable-infobars',
          // Disable features that leak automation context
          '--disable-features=AutomationControlled,IsolateOrigins,site-per-process',
          // Prevent sites detecting the remote-debugging-port (CDP is present but unlisted)
          '--remote-debugging-port=0',
          // Consistent with a real Windows Chrome: disable the first-run dialog
          '--no-first-run',
          '--no-default-browser-check',
          // Disable telemetry / optimization hints (reduces fingerprint noise)
          '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints',
          // Cloud/Railway environment helpers
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-sync',
          '--password-store=basic',
          '--use-mock-keychain',
        ],
      }) as Browser

      // Keep UA in sync with sec-ch-ua below — both must reflect the same Chrome build
      const CHROME_VERSION = '131'
      const USER_AGENT =
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`

      context = await browser.newContext({
        proxy:             proxy ?? undefined,
        userAgent:         USER_AGENT,
        viewport:          { width: 1280, height: 800 },
        locale:            'en-US',
        ignoreHTTPSErrors: true,
        // Client Hints — real Chrome always sends these; missing = bot signal
        extraHTTPHeaders: {
          'accept-language':     'en-US,en;q=0.9',
          'sec-ch-ua':           `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not_A Brand";v="24"`,
          'sec-ch-ua-mobile':    '?0',
          'sec-ch-ua-platform':  '"Windows"',
        },
      })

      // Comprehensive stealth patches — run before any page script executes
      await context.addInitScript(() => {
        // 1. Remove webdriver flag (primary Playwright fingerprint)
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true })

        // 2. Realistic navigator properties
        Object.defineProperty(navigator, 'vendor',   { get: () => 'Google Inc.' })
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })
        Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 })

        // 3. Realistic plugin list (empty plugins list = headless signal)
        // Inline factory to avoid named arrow function that tsx/esbuild wraps with __name()
        const plugins = [
          ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format', ['application/pdf', 'text/pdf']],
          ['Chrome PDF Viewer', 'internal-pdf-viewer', '', ['application/pdf']],
          ['Chromium PDF Viewer', 'internal-pdf-viewer', '', ['application/pdf']],
          ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', '', ['application/pdf']],
          ['WebKit built-in PDF', 'internal-pdf-viewer', '', ['application/pdf']],
        ].map((args: unknown[]) => {
          const [name, filename, desc, mimeTypes] = args as [string, string, string, string[]]
          const plugin = { name, filename, description: desc, length: mimeTypes.length } as unknown as Plugin
          mimeTypes.forEach((m, i) => {
            const mt = { type: m, suffixes: '', description: '', enabledPlugin: plugin } as unknown as MimeType
            ;(plugin as unknown as Record<string, unknown>)[i] = mt
          })
          return plugin
        })
        Object.defineProperty(navigator, 'plugins', {
          get: () => Object.assign(plugins, { item: (i: number) => plugins[i], namedItem: (n: string) => plugins.find(p => p.name === n) ?? null, refresh: () => {} })
        })
        Object.defineProperty(navigator, 'mimeTypes', {
          get: () => {
            const mimes = [{ type: 'application/pdf', suffixes: 'pdf', description: '', enabledPlugin: plugins[0] }]
            return Object.assign(mimes, { item: (i: number) => mimes[i], namedItem: (n: string) => mimes.find(m => m.type === n) ?? null })
          }
        })

        // 4. Realistic chrome object
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).chrome = {
          app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
          runtime: {
            PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
            PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
            RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
            OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          },
          loadTimes: () => ({ requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: false, wasNpnNegotiated: false, npnNegotiatedProtocol: 'unknown', wasAlternateProtocolAvailable: false, connectionInfo: 'http/1.1' }),
          csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Date.now() - performance.timing?.navigationStart, tran: 15 }),
        }

        // 5. Permissions — headless returns wrong values for some checks
        const origQuery = navigator.permissions?.query?.bind(navigator.permissions)
        if (origQuery) {
          Object.defineProperty(navigator.permissions, 'query', {
            value: (params: PermissionDescriptor) =>
              params.name === 'notifications'
                ? Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
                : origQuery(params)
          })
        }

        // 6. Screen / display properties
        Object.defineProperty(screen, 'colorDepth', { get: () => 24 })
        Object.defineProperty(screen, 'pixelDepth',  { get: () => 24 })
        Object.defineProperty(window, 'devicePixelRatio', { get: () => 1 })
        Object.defineProperty(window, 'outerWidth',  { get: () => 1280 })
        Object.defineProperty(window, 'outerHeight', { get: () => 800 })
      })
    }

    const page = await context.newPage()
    session.browser = browser
    session.context = context
    session.page    = page

    // Track whether we're connected via CDP (BrightData Scraping Browser).
    // In CDP mode, Playwright's keyboard.type() is blocked on password fields by BrightData
    // as a security measure. We use page.evaluate() with the native value setter instead.
    const usingCDP = !!browserEndpoint

    // Navigate to LinkedIn login — retry up to 3× on proxy/timeout errors.
    // BrightData CDP sessions occasionally time out on first navigation (session warm-up);
    // a second attempt typically succeeds within a few seconds.
    const LOGIN_URLS = [
      'https://www.linkedin.com/login',
      'https://www.linkedin.com/uas/login',
    ]
    let gotoSucceeded = false
    for (let attempt = 1; attempt <= 3 && !gotoSucceeded; attempt++) {
      for (const loginUrl of LOGIN_URLS) {
        try {
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
          gotoSucceeded = true
          break
        } catch (gotoErr) {
          const msg = String(gotoErr)
          const isRetryable = msg.includes('502') || msg.includes('no_peer') || msg.includes('no_peers') ||
            msg.includes('ERR_TUNNEL_CONNECTION_FAILED') || msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
            msg.includes('net::ERR_') || msg.includes('Timeout') || msg.includes('timeout')
          if (isRetryable && (attempt < 3 || loginUrl !== LOGIN_URLS[LOGIN_URLS.length - 1])) {
            console.log(`[LOGIN DEBUG] Navigation error on attempt ${attempt} (${loginUrl}): ${msg.substring(0, 120)} — retrying in ${attempt * 3}s`)
            await DELAY(attempt * 3_000)
            continue
          }
          // Final attempt failed — throw with actionable message
          if (isRetryable) {
            throw new Error(
              `LinkedIn login page timed out after 3 attempts (${msg.substring(0, 200)}). ` +
              `BrightData may be experiencing slowness — please try reconnecting in 30 seconds.`
            )
          }
          throw gotoErr
        }
      }
    }
    await DELAY(1500 + Math.random() * 500)

    // If LinkedIn redirected to a country-specific subdomain (e.g. no.linkedin.com, de.linkedin.com),
    // force-navigate to www.linkedin.com with explicit English locale.
    // This happens when BrightData country targeting isn't applied and a non-UK IP is assigned.
    const afterGotoUrl  = page.url()
    const isCountrySubdomain = /^https?:\/\/(?!www\.)[a-z]{2}\.linkedin\.com/i.test(afterGotoUrl)
    if (isCountrySubdomain) {
      console.log(`[LOGIN DEBUG] Country subdomain detected: ${afterGotoUrl} — forcing www.linkedin.com/login`)
      await page.goto('https://www.linkedin.com/login?trk=guest_homepage-basic_nav-header-signin', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await DELAY(2000)
    }

    // If we got a 404 or "page not found" from LinkedIn (bot-detection or regional issue),
    // try the global login URL with explicit locale as fallback.
    const afterGotoText = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 500)).catch(() => '')
    const is404 = afterGotoText.toLowerCase().includes('page not found') ||
      afterGotoText.toLowerCase().includes('this page doesn') ||
      afterGotoText.toLowerCase().includes("uh oh") ||
      afterGotoText.toLowerCase().includes('not found') ||
      // Non-English 404 patterns (Norwegian, etc.)
      afterGotoText.toLowerCase().includes('fant ikke siden') ||
      afterGotoText.toLowerCase().includes('page introuvable') ||
      afterGotoText.toLowerCase().includes('seite nicht gefunden') ||
      page.url().startsWith('chrome-error://')
    if (is404) {
      console.log('[LOGIN DEBUG] LinkedIn returned 404/not-found — retrying with global login URL')
      await page.goto('https://www.linkedin.com/login?trk=guest_homepage-basic_nav-header-signin', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await DELAY(2000)
    }

    // Blank page: LinkedIn's edge may gate headless local Chromium via TLS fingerprint.
    // In BrightData mode this shouldn't happen; in local-Chromium fallback mode it might.
    // If we detect an empty page, wait for networkidle in case it's just slow rendering.
    const afterGotoHtml = await page.evaluate(() => document.documentElement.outerHTML).catch(() => '')
    const isBlank = afterGotoText.trim().length < 20 && !afterGotoHtml.includes('<form')
    if (isBlank) {
      console.log(`[LOGIN DEBUG] Empty page at ${page.url()} — waiting for networkidle then rotating to /uas/login`)
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      const textAfterWait = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 100)).catch(() => '')
      if (textAfterWait.trim().length < 20) {
        await page.goto('https://www.linkedin.com/uas/login', { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await DELAY(2000)
      }
    }

    // ── Snapshot immediately after first navigation ───────────────────────────
    // Fire-and-forget: does NOT block the login flow. Supabase write runs in
    // the background so snapshotting never adds latency to the critical path.
    const captureSnap = (label: string) => {
      const url = page.url()
      console.log(`[LOGIN DEBUG ${label}] url=${url}`)
      // Run async without awaiting — login flow continues immediately
      ;(async () => {
      try {
        let text = '(evaluate failed)'
        let html = '(evaluate failed)'
        try { text = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 2000)) } catch { /* ok */ }
        try { html = await page.evaluate(() => document.documentElement.outerHTML.substring(0, 10000)) } catch { /* ok */ }

        const snap = { url, text, html, capturedAt: new Date().toISOString(), label }
        lastErrorSnapshot = snap
        session.debugUrl        = url
        session.debugPageText   = text

        console.log(`[LOGIN DEBUG ${label}] text_len=${text.length} has_username_id=${html.includes('id="username"')}`)

        // Persist to Supabase so any Railway instance can read it
        await supabase.from('linkedin_accounts').update({
          debug_log: snap as unknown as Record<string, unknown>
        }).eq('id', session.accountId)
      } catch (snapErr) {
        console.error('[LOGIN DEBUG] snapshot failed:', snapErr)
      }
      })() // end fire-and-forget IIFE
    }

    captureSnap('after-goto')

    // JS-based click helper — bypasses header/overlay pointer-event interception
    const jsClick = async (selector: string) => {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (el) el.click()
      }, selector)
    }

    // ── Cookie consent dismissal (banner OR full-page redirect) ─────────────────
    // In CDP mode the consent-first flow above (homepage → accept → /login) should
    // have already set li_gc. This block is a safety net for both modes.
    // Strategy: wait for the Accept button, click it, then wait for it to disappear
    // (confirms LinkedIn processed the click and set its own consent cookie).
    {
      const CONSENT_COMBINED =
        'button[action-type="ACCEPT"], ' +
        'button[data-tracking-control-name="cookie_policy_banner_accept"], ' +
        '#artdeco-global-alert-action--accept, ' +
        'button.artdeco-global-alert__action, ' +
        'button[data-control-name="accept"], ' +
        'button[data-tracking-control-name*="accept"]'

      // Wait up to 5s for any accept button to appear (banner loads async after page)
      const consentEl = await page.waitForSelector(CONSENT_COMBINED, { timeout: 5_000 }).catch(() => null)

      if (consentEl) {
        // Use Playwright's native elementHandle.click() — fires real pointer events,
        // handles BrightData CDP better than jsClick (page.evaluate el.click()).
        console.log('[LOGIN DEBUG] Consent banner found — clicking via native Playwright click')
        await consentEl.click({ force: true }).catch(() => {})
        // Wait for it to become hidden OR detached (LinkedIn uses display:none on dismiss)
        await Promise.race([
          page.waitForSelector(CONSENT_COMBINED, { state: 'hidden',   timeout: 5_000 }).catch(() => {}),
          page.waitForSelector(CONSENT_COMBINED, { state: 'detached', timeout: 5_000 }).catch(() => {}),
        ])
        await DELAY(300)
        console.log('[LOGIN DEBUG] Consent banner dismissed')
      } else {
        // Fallback: language-agnostic text search (catches banners with no matching attributes)
        const clicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a[role="button"]'))
          const accept = btns.find(b =>
            /^(accept|allow|terima|acceptér|accepter|akkoord|aceptar|accetta|akzeptieren|agree|ok|قبول|同意|허용|kabul)$/i
              .test((b.textContent ?? '').trim())
          )
          if (accept) { (accept as HTMLElement).click(); return true }
          return false
        }).catch(() => false)
        if (clicked) {
          console.log('[LOGIN DEBUG] Consent clicked via text fallback')
          await DELAY(1_500)
        } else {
          console.log('[LOGIN DEBUG] No consent banner found — continuing')
        }
      }

      // If URL redirected to a full consent/authwall page, navigate back to /login
      const postConsentUrl = page.url()
      if (/\/cookie|\/consent|\/authwall/i.test(postConsentUrl)) {
        console.log(`[LOGIN DEBUG] Consent page redirect at ${postConsentUrl} — navigating back to /login`)
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await DELAY(2000)
      }
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
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await DELAY(2000)
    }

    // If redirected away from login (e.g. already-logged-in BrightData session), navigate back
    if (!page.url().includes('/login') && !page.url().includes('/uas/login')) {
      console.log(`[LOGIN DEBUG] redirected to ${page.url()} — navigating back to /login`)
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await DELAY(2000)
    }

    captureSnap('pre-fill')

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

    // ── Approach 4: CAPTCHA detection on initial login page ──────────────────
    // LinkedIn occasionally shows a reCAPTCHA V2 challenge on the /login page
    // itself (before the username/password form appears) for flagged IPs.
    // Detect the site key, solve via 2captcha, inject the response token.
    await page.waitForSelector('input, iframe[src*="recaptcha"], .g-recaptcha', { timeout: 20_000 }).catch(() => {})

    const initialCaptchaSiteKey = await page.evaluate(() => {
      // LinkedIn puts captchaSiteKey in a hidden input or a data-sitekey attribute
      const hiddenInput = document.querySelector('input[name="captchaSiteKey"]') as HTMLInputElement | null
      if (hiddenInput?.value) return hiddenInput.value
      const gDiv = document.querySelector('.g-recaptcha') as HTMLElement | null
      if (gDiv?.dataset.sitekey) return gDiv.dataset.sitekey
      const iframeSrc = (document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null)?.src ?? ''
      const m = iframeSrc.match(/[?&]k=([^&]+)/)
      return m ? m[1] : ''
    }).catch(() => '') as string

    if (initialCaptchaSiteKey) {
      console.log(`[LOGIN DEBUG] reCAPTCHA V2 on login page — solving via 2captcha (key=${initialCaptchaSiteKey.substring(0, 12)}…)`)
      const captchaToken = await solveRecaptchaV2(initialCaptchaSiteKey, page.url())
      if (captchaToken) {
        await page.evaluate((token: string) => {
          // Inject into hidden textarea that LinkedIn reads
          const ta = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response') as HTMLTextAreaElement | null
          if (ta) { ta.style.display = 'block'; ta.value = token }
          // Also inject via captchaUserResponseToken hidden input if present
          const inp = document.querySelector('input[name="captchaUserResponseToken"]') as HTMLInputElement | null
          if (inp) inp.value = token
          // Fire the grecaptcha callback if LinkedIn registered one
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cfg = (window as any).___grecaptcha_cfg?.clients
          if (cfg) {
            for (const key of Object.keys(cfg)) {
              const cb = cfg[key]?.aa?.l?.callback ?? cfg[key]?.l?.callback
              if (typeof cb === 'function') try { cb(token) } catch { /* ok */ }
            }
          }
          // Click submit button (fires JS event listeners) rather than form.submit()
          // LinkedIn's SPA intercepts the click; form.submit() bypasses it and returns a bare response
          const btn = document.querySelector('button[type="submit"], .btn__primary--large, [data-id="sign-in-form__submit-btn"]') as HTMLElement | null
          if (btn) btn.click()
          else {
            const form = document.querySelector('form') as HTMLFormElement | null
            if (form) form.submit()
          }
        }, captchaToken)
        // Wait for the page to navigate away from login before continuing
        await Promise.race([
          page.waitForURL(u => !String(u).includes('/login') || String(u).includes('/checkpoint') || String(u).includes('/feed'), { timeout: 12_000 }).catch(() => {}),
          DELAY(12_000),
        ])
        await DELAY(1_000)
        console.log(`[LOGIN DEBUG] CAPTCHA submitted — page now at ${page.url()}`)
      } else {
        console.warn('[LOGIN DEBUG] 2captcha solve failed for initial CAPTCHA — aborting login')
        session.status = 'error'
        session.error  = 'LinkedIn is showing a CAPTCHA that cannot be solved automatically (TWOCAPTCHA_API_KEY not configured). Please try again in a few minutes or use the browser extension method to connect.'
        await browser.close().catch(() => {})
        return
      }
    }

    // First, wait for any login form input to appear (the form to be hydrated)
    await page.waitForSelector('input', { timeout: 15_000 }).catch(() => {})

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
      captureSnap('waitForSelector-timeout')
      const url   = page.url()
      const title = await page.title().catch(() => '?')
      let visible = ''
      let allInputs = ''
      try { visible = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 300).replace(/\s+/g, ' ')) } catch { /* ok */ }
      try { allInputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((el: Element) => { const i = el as HTMLInputElement; return `${i.tagName}[id=${i.id}][name=${i.name}][type=${i.type}]` }).join(', ')) } catch { /* ok */ }
      // Detect Chrome's native network-error page (IP blocked or proxy unreachable)
      const isChromeErrorPage = url.startsWith('chrome-error://') || url.includes('chromewebdata')
      if (isChromeErrorPage) {
        throw new Error(
          'Could not load linkedin.com — the proxy IP was blocked or failed to route. ' +
          'Please try connecting again in 30–60 seconds.'
        )
      }
      // Detect proxy-blocked JS: page loads HTML shell but scripts never execute (no inputs, tiny text)
      // This is different from a blank gate — the HTML arrived but CDN/JS assets were dropped by the proxy.
      const pageText = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0)
      const isJsBlocked = pageText > 50 && !allInputs && !usingCDP
      if (isJsBlocked) {
        throw new Error(
          'Your proxy loaded the LinkedIn page HTML but blocked the JavaScript bundles — ' +
          'the login form never rendered. ' +
          'This is a proxy compatibility issue: datacenter/ISP proxies often drop LinkedIn CDN assets. ' +
          'To fix: (1) remove the proxy from this account so BrightData handles the login, ' +
          'or (2) switch to a residential/mobile proxy that passes HTTPS resources without filtering.'
        )
      }
      // Detect blank-gate page (LinkedIn detected the headless browser or page truly empty)
      const isEmptyPage = (visible?.trim().length ?? 0) < 20 && !allInputs
      if (isEmptyPage) {
        throw new Error(
          'LinkedIn returned a blank page — it may have detected the automated browser. ' +
          'Try again in 30–60 seconds. If this keeps happening, ensure your proxy IP is a clean residential IP ' +
          'that has not been flagged by LinkedIn.'
        )
      }
      throw new Error(`Login form inputs not found. URL: ${url} | Title: ${title} | Inputs: ${allInputs} | Text: ${visible}`)
    }

    console.log(`[LOGIN DEBUG] Using email selector: ${emailSelector}`)

    // Helper: dismiss any consent/overlay banners using JS click.
    // Tries attribute selectors first, then a language-agnostic text search.
    const dismissBanners = async () => {
      for (const selector of [
        'button[action-type="ACCEPT"]',
        'button[data-tracking-control-name="cookie_policy_banner_accept"]',
        '#artdeco-global-alert-action--accept',
        'button.artdeco-global-alert__action',
        'button[data-test-modal-close-btn]',
        'button[data-control-name="accept"]',
      ]) {
        try {
          const exists = await page.$(selector)
          if (exists) { await jsClick(selector); await DELAY(500) }
        } catch { /* ok */ }
      }
      // Language-agnostic text fallback: "Accept" / "Aceptar" / "Terima" / "Acceptér" etc.
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a[role="button"]'))
        const accept = btns.find(b =>
          /^(accept|allow|terima|acceptér|accepter|akkoord|aceptar|accetta|akzeptieren|agree|ok|قبول|同意|허용|kabul)$/i
            .test((b.textContent ?? '').trim())
        )
        if (accept) (accept as HTMLElement).click()
      }).catch(() => {})
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
      try {
        // Collect all inputs from the entire DOM including shadow roots.
        // Uses a stack-based BFS to avoid named recursive functions
        // (tsx/esbuild injects __name() for named arrow functions which
        //  breaks page.evaluate since that helper isn't in the browser context).
        const allInputs: HTMLInputElement[] = []
        const roots: (Document | ShadowRoot | Element)[] = [document]
        while (roots.length > 0) {
          const root = roots.pop()!
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
          let node = walker.currentNode as Element
          while (node) {
            if (node.tagName === 'INPUT') allInputs.push(node as HTMLInputElement)
            if (node.shadowRoot) roots.push(node.shadowRoot)
            node = walker.nextNode() as Element
            if (!node) break
          }
        }

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
    const passExists = await page.waitForSelector(passSelector, { timeout: 10_000 }).catch(() => null)
    if (!passExists) {
      // Email-only (2-step) login form: LinkedIn is serving a minimal form without a password field.
      // This is common on certain BrightData IP geos (DK, etc.) with reduced-JS pages.
      // Strategy: in CDP mode, navigate directly to the classic login URL first — this consistently
      // produces a full form with both email and password fields, bypassing the 2-step flow entirely.
      console.log('[LOGIN DEBUG] Password field not visible — handling 2-step email-first flow')

      let gotPassField = false

      if (usingCDP) {
        // CDP / BrightData path: navigate to classic login URL and look for password field there.
        const classicLoginUrl = 'https://www.linkedin.com/login?fromSignIn=true&trk=guest_homepage-basic_nav-header-signin'
        console.log('[LOGIN DEBUG] CDP mode: navigating to classic login URL to get full form')
        try {
          await page.goto(classicLoginUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
          await DELAY(1_500)
          const textLen2 = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0)
          console.log(`[LOGIN DEBUG] Classic URL text_len=${textLen2}`)
          const passEl = await page.waitForSelector(passSelector, { timeout: 10_000 }).catch(() => null)
          if (passEl) {
            console.log('[LOGIN DEBUG] Password field found at classic login URL ✓')
            gotPassField = true
          } else {
            console.log('[LOGIN DEBUG] Password field still missing at classic login URL')
          }
        } catch (e) {
          console.log('[LOGIN DEBUG] Classic URL navigation failed:', String(e).substring(0, 100))
        }
      }

      if (!gotPassField) {
        // Fallback: fill email → click Continue → wait for password field to appear.
        try {
          await page.click(emailSelector, { noWaitAfter: true, force: true, timeout: 5_000 }).catch(() => {})
          await page.keyboard.press('Control+A')
          await page.keyboard.press('Delete')
          await page.keyboard.type(email, { delay: 30 + Math.floor(Math.random() * 30) })
          await DELAY(500)

          const continueBtn = await page.$(
            'button[type="submit"], [data-litms-control-urn*="continue"], ' +
            '.btn__primary--large, button.sign-in-form__submit-button'
          ).catch(() => null)
          if (continueBtn) {
            console.log('[LOGIN DEBUG] Clicking Continue button for 2-step flow')
            await continueBtn.click()
          } else {
            await page.keyboard.press('Enter')
          }

          console.log('[LOGIN DEBUG] Waiting for password field after Continue…')
          await page.waitForSelector(passSelector, { timeout: 12_000 }).catch(() => {
            console.log('[LOGIN DEBUG] Password field still not visible after Continue')
          })
        } catch (e) {
          console.log('[LOGIN DEBUG] 2-step flow error:', String(e).substring(0, 100))
        }
      }
    } else {
      console.log('[LOGIN DEBUG] Password field found ✓')
    }

    await dismissBanners()

    // Helper: fill a form field using the appropriate strategy for the current browser mode.
    //
    // CDP mode (BrightData Scraping Browser):
    //   BrightData blocks Input.dispatchKeyEvent AND page.evaluate() on password-type inputs.
    //   Strategy A: page.fill() which uses Input.insertText (a paste-like command, not key events).
    //   Strategy B (fallback): temporarily change input type to 'text', inject via evaluate, restore.
    //   This bypasses BrightData's password-field restriction since the field is no longer type=password
    //   at the time of the JS evaluation.
    //
    // Local mode:
    //   page.fill() / locator.fill() block on LinkedIn's soft pushState navigation
    //   (the URL silently changes to ?fromSignIn=true&trk=... when the email field is focused).
    //   page.fill() waits for that navigation to "complete", which never fires, causing a 30s timeout.
    //   keyboard.type() bypasses this because it doesn't wait for navigations.
    const fillField = async (selector: string, value: string) => {
      if (usingCDP) {
        // Strategy A: page.fill() — uses Input.insertText CDP command (paste-like, no key events).
        // BrightData sometimes blocks this on password fields; if it times out we fall through.
        try {
          await page.click(selector, { noWaitAfter: true, force: true, timeout: 5_000 }).catch(() => {})
          await page.fill(selector, value, { timeout: 8_000, force: true })
          return
        } catch (fillErr) {
          console.log('[LOGIN DEBUG] page.fill() failed in CDP mode, trying keyboard.type():', String(fillErr).substring(0, 100))
        }

        // Strategy B: keyboard.type() — fires Input.dispatchKeyEvent CDP commands (individual key presses).
        // BrightData does NOT block these since they're indistinguishable from real keyboard input.
        // This is the most reliable path in CDP mode when page.fill() is blocked.
        try {
          await page.click(selector, { noWaitAfter: true, force: true, timeout: 5_000 }).catch(() => {})
          await page.keyboard.press('Control+A')
          await page.keyboard.press('Delete')
          await page.keyboard.type(value, { delay: 20 + Math.floor(Math.random() * 20) })
          console.log('[LOGIN DEBUG] keyboard.type() succeeded in CDP mode')
          return
        } catch (typeErr) {
          console.log('[LOGIN DEBUG] keyboard.type() failed in CDP mode, trying evaluate fallback:', String(typeErr).substring(0, 100))
        }

        // Strategy C: change type="password"→"text" (BrightData restriction lifted), inject via
        // native value setter (bypasses React's synthetic state — LinkedIn classic form reads raw DOM
        // values on server POST, so this is enough for form.submit()), fire events, restore type.
        const stratCOk = await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
          const el = document.querySelector(sel) as HTMLInputElement | null
          if (!el) return false
          const originalType = el.type
          if (originalType === 'password') el.setAttribute('type', 'text')
          el.focus()
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          if (nativeSetter) nativeSetter.call(el, val)
          else el.value = val
          el.dispatchEvent(new Event('input',  { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.dispatchEvent(new Event('blur',   { bubbles: true }))
          if (originalType === 'password') el.setAttribute('type', originalType)
          return el.value === val
        }, { sel: selector, val: value })
        console.log(`[LOGIN DEBUG] evaluate fallback: value set=${stratCOk}`)

      } else {
        // Local Chromium: click first (noWaitAfter prevents blocking on pushState nav),
        // then type character-by-character with human-like delays
        await page.click(selector, { noWaitAfter: true, force: true, timeout: 8_000 }).catch(() => {})
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Delete')
        await page.keyboard.type(value, { delay: 30 + Math.floor(Math.random() * 30) })
      }
    }

    // ── Approach 5: Human-like mouse movement before form interaction ─────────
    // Real users move their mouse to elements before clicking them.
    // LinkedIn's bot detection scores mouse trajectory — teleporting to a field
    // (immediate CDP click) is a strong automation signal.
    // We simulate a natural Bézier-curve mouse path to the email field first.
    if (!usingCDP) {
      try {
        const emailBox = await page.locator(emailSelector).boundingBox().catch(() => null)
        if (emailBox) {
          // Start from a random position near the top of the viewport
          const startX = 200 + Math.random() * 400
          const startY = 80 + Math.random() * 60
          const endX   = emailBox.x + emailBox.width / 2 + (Math.random() - 0.5) * 8
          const endY   = emailBox.y + emailBox.height / 2 + (Math.random() - 0.5) * 4
          // Move in ~20 steps with slight randomness to look like human hand
          const steps  = 18 + Math.floor(Math.random() * 8)
          await page.mouse.move(startX, startY)
          for (let i = 1; i <= steps; i++) {
            const t  = i / steps
            const jx = (Math.random() - 0.5) * 3
            const jy = (Math.random() - 0.5) * 2
            await page.mouse.move(startX + (endX - startX) * t + jx, startY + (endY - startY) * t + jy)
            await DELAY(12 + Math.random() * 20)
          }
          await DELAY(120 + Math.random() * 200)
        }
      } catch { /* ok — mouse movement is best-effort */ }
    }

    // In CDP mode (BrightData), set up a route interceptor BEFORE filling fields.
    // BrightData blocks keyboard input to password fields, so we intercept the
    // login-submit POST and inject the password directly into the request body.
    // We catch ALL POST requests to linkedin.com during login (not just one URL)
    // because LinkedIn has multiple submit endpoints and rotates between them.
    if (usingCDP) {
      await page.route('https://www.linkedin.com/**', async (route) => {
        const req = route.request()
        if (req.method() !== 'POST') { await route.continue(); return }
        const raw = req.postData() ?? ''
        if (!raw) { await route.continue(); return }
        // Match any login-related POST — LinkedIn uses session_key on classic form
        // and encrypted_session_key / loginCsrfParam on the newer SPA form.
        // Also catch /checkpoint and /uas endpoints.
        const url = req.url()
        const isLoginPost =
          raw.includes('session_key') ||
          raw.includes('loginCsrfParam') ||
          raw.includes('csrfToken') ||
          url.includes('/login') ||
          url.includes('/checkpoint') ||
          url.includes('/uas/')
        if (!isLoginPost) { await route.continue(); return }
        try {
          const postData = new URLSearchParams(raw)
          postData.set('session_password', password)
          console.log(`[LOGIN DEBUG] route-intercept: injecting password into ${url.replace('https://www.linkedin.com', '')} (pass_len=${password.length} fields=${[...postData.keys()].join(',')})`)
          await route.continue({ postData: postData.toString() })
        } catch (e) {
          console.log('[LOGIN DEBUG] route-intercept error:', String(e).substring(0, 100))
          await route.continue()
        }
      }).catch(e => console.log('[LOGIN DEBUG] page.route() setup failed:', String(e).substring(0, 80)))
    }

    await fillField(emailSelector, email)
    await DELAY(150 + Math.random() * 150)

    await fillField(passSelector, password)
    await DELAY(150 + Math.random() * 150)

    captureSnap('pre-submit')

    // Step 3: Submit the form.
    const preSubmitUrl = page.url()
    if (usingCDP) {
      // CDP mode: use page.evaluate to set password via native setter + submit the form.
      // This is the most reliable path in BrightData CDP:
      //   1. Native value setter updates the DOM (and React state via dispatched events)
      //   2. form.submit() sends raw DOM values, bypassing any SPA JS interception
      //   3. page.route() interceptor above also fires as a belt-and-suspenders backup
      // CDP mode: submit via fetch() from page context — does NOT navigate the page so
      // BrightData's CDP session stays alive. form.submit() causes a navigation that
      // drops the WebSocket connection ("Browser session closed unexpectedly").
      console.log('[LOGIN DEBUG] CDP mode: XHR-submit from page context')
      const fetchResult = await page.evaluate((args: { email: string; pass: string }) => {
        return new Promise<{ ok: boolean; status: number; finalUrl: string; error?: string }>((resolve) => {
          const form = document.querySelector('form') as HTMLFormElement | null
          const params = new URLSearchParams()
          Array.from(form?.querySelectorAll('input') ?? []).forEach(inp => {
            const i = inp as HTMLInputElement
            if (i.name && i.type !== 'submit' && !i.disabled) params.set(i.name, i.value)
          })
          params.set('session_key',      args.email)
          params.set('session_password', args.pass)
          const action = form?.getAttribute('action') || '/checkpoint/lg/login-submit'
          const xhr = new XMLHttpRequest()
          xhr.open('POST', action, true)
          xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded')
          xhr.withCredentials = true
          xhr.onload  = () => resolve({ ok: xhr.status >= 200 && xhr.status < 400, status: xhr.status, finalUrl: xhr.responseURL })
          xhr.onerror = () => resolve({ ok: false, status: 0, finalUrl: '', error: 'XHR network error' })
          xhr.ontimeout = () => resolve({ ok: false, status: 0, finalUrl: '', error: 'XHR timeout' })
          xhr.timeout = 15_000
          xhr.send(params.toString())
        })
      }, { email, pass: password }).catch((e: unknown) => ({ ok: false, status: 0, finalUrl: '', error: String(e) }))

      console.log('[LOGIN DEBUG] fetch-submit result:', JSON.stringify(fetchResult))

      // If fetch is completely blocked by BrightData (status 0, TypeError: Failed to fetch),
      // click the submit button instead — the page.route() interceptor set up above will
      // inject the password directly into the outgoing POST body, so no keyboard typing needed.
      if (fetchResult.status === 0 && !fetchResult.finalUrl) {
        console.log('[LOGIN DEBUG] XHR-submit blocked (status 0) — falling back to button click')
        const submitBtn = await page.$(
          'button[type="submit"], .btn__primary--large, ' +
          'button[data-litms-control-urn="guest|submit"], ' +
          'button[data-id="sign-in-form__submit-btn"], ' +
          'form .sign-in-form__submit-btn'
        ).catch(() => null)
        if (submitBtn) {
          console.log('[LOGIN DEBUG] Clicking submit button')
          await submitBtn.click()
        } else {
          console.log('[LOGIN DEBUG] No submit button found — using JS click')
          await page.evaluate(() => {
            const btn = document.querySelector('button[type="submit"], form button') as HTMLElement | null
            if (btn) btn.click()
          })
        }
        try {
          await page.waitForURL(
            (u) => !String(u).includes('/login') || String(u).includes('/checkpoint') || String(u).includes('/challenge'),
            { timeout: 15_000, waitUntil: 'domcontentloaded' }
          )
        } catch {
          console.log('[LOGIN DEBUG] waitForURL timed out after button click — checking page state anyway')
        }
        await DELAY(500)
        // Update fetchResult.finalUrl so the destUrl block below navigates correctly
        ;(fetchResult as any).finalUrl = page.url()
      }

      // If the fetch returned a consent/cookie page URL, the li_gc cookie wasn't valid.
      // Accept the banner NOW (LinkedIn will set its own li_gc), then retry the POST once.
      const destUrl = fetchResult.finalUrl || ''
      if (/\/cookie|\/consent|\/authwall/i.test(destUrl) || destUrl.includes('needsConsent')) {
        console.log('[LOGIN DEBUG] fetch-submit returned consent page — accepting banner and retrying POST')
        await page.goto(destUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
        await DELAY(1_000)
        // Click the consent Accept button on this page and wait for it to be gone
        const consentAccepted = await (async () => {
          for (const sel of [
            'button[action-type="ACCEPT"]',
            'button[data-tracking-control-name="cookie_policy_banner_accept"]',
            '#artdeco-global-alert-action--accept',
          ]) {
            const btn = await page.$(sel).catch(() => null)
            if (btn) {
              await btn.click()
              await page.waitForSelector(sel, { state: 'detached', timeout: 4_000 }).catch(() => {})
              console.log('[LOGIN DEBUG] Consent banner clicked on consent page')
              return true
            }
          }
          return false
        })()
        if (consentAccepted) {
          await DELAY(500)
          // Navigate back to /login and retry submit
          await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
          await DELAY(1_500)
          // Re-submit via XHR
          const retryResult = await page.evaluate((args: { email: string; pass: string }) => {
            return new Promise<{ ok: boolean; status: number; finalUrl: string; error?: string }>((resolve) => {
              const form = document.querySelector('form') as HTMLFormElement | null
              const params = new URLSearchParams()
              Array.from(form?.querySelectorAll('input') ?? []).forEach(inp => {
                const i = inp as HTMLInputElement
                if (i.name && i.type !== 'submit' && !i.disabled) params.set(i.name, i.value)
              })
              params.set('session_key',      args.email)
              params.set('session_password', args.pass)
              const action = form?.getAttribute('action') || '/checkpoint/lg/login-submit'
              const xhr = new XMLHttpRequest()
              xhr.open('POST', action, true)
              xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded')
              xhr.withCredentials = true
              xhr.onload  = () => resolve({ ok: xhr.status >= 200 && xhr.status < 400, status: xhr.status, finalUrl: xhr.responseURL })
              xhr.onerror = () => resolve({ ok: false, status: 0, finalUrl: '', error: 'XHR network error' })
              xhr.timeout = 15_000
              xhr.ontimeout = () => resolve({ ok: false, status: 0, finalUrl: '', error: 'XHR timeout' })
              xhr.send(params.toString())
            })
          }, { email, pass: password }).catch((e: unknown) => ({ ok: false, status: 0, finalUrl: '', error: String(e) }))
          console.log('[LOGIN DEBUG] XHR-submit RETRY result:', JSON.stringify(retryResult))
          const retryDest = retryResult.finalUrl || ''
          if (retryDest && !retryDest.includes('/login')) {
            await page.goto(retryDest, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
          } else {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
          }
          await DELAY(1_500)
        } else {
          // Couldn't accept consent — navigate to login and reload to see state
          await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
          await DELAY(1_500)
        }
      } else {
        // Normal path: navigate to wherever LinkedIn redirected us after the POST
        if (destUrl && !destUrl.includes('/login')) {
          await page.goto(destUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
        } else {
          // Stay on login page — reload to see current session state / error message
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
        }
        await DELAY(1500)
      }
    } else {
      const submitBtn = await page.$(
        'button[type="submit"], .btn__primary--large, ' +
        'button[data-litms-control-urn="guest|submit"], ' +
        'button[data-id="sign-in-form__submit-btn"], ' +
        'form .sign-in-form__submit-btn'
      ).catch(() => null)

      if (submitBtn) {
        console.log('[LOGIN DEBUG] Clicking submit button')
        await submitBtn.click()
      } else {
        console.log('[LOGIN DEBUG] No submit button found — using JS click on form submit')
        const clicked = await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"], form button') as HTMLElement | null
          if (btn) { btn.click(); return true }
          return false
        })
        if (!clicked) {
          console.log('[LOGIN DEBUG] JS click also found nothing — pressing Enter as last resort')
          await page.keyboard.press('Enter')
        }
      }

      // Wait for navigation away from the login page
      try {
        await page.waitForURL(
          (u) => !String(u).includes('/login') || String(u).includes('/checkpoint') || String(u).includes('/challenge'),
          { timeout: 15_000, waitUntil: 'domcontentloaded' }
        )
      } catch {
        console.log('[LOGIN DEBUG] waitForURL timed out after submit — checking page state anyway')
      }
    }
    await DELAY(500)
    captureSnap('post-submit')

    // Map browser state into the variable names used by the rest of this function
    const redirectLocation = page.url()
    const submitDiag = `post-submit url=${redirectLocation.substring(0, 80)}`
    console.log('[LOGIN DEBUG]', submitDiag)

    // Check if li_at is now in the browser context (login succeeded without challenge)
    let cookiesAfterPost: Awaited<ReturnType<typeof context.cookies>> = []
    try {
      cookiesAfterPost = await context.cookies()
    } catch (e) {
      const msg = String(e)
      if (msg.includes('Target page') || msg.includes('browser has been closed') || msg.includes('context has been destroyed') || msg.includes('Target closed')) {
        session.status = 'error'
        session.error  = 'Browser session closed unexpectedly. Please try reconnecting.'
        return
      }
      throw e
    }
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
      // Use Promise.race — Playwright's built-in timeout can hang on certain proxy/redirect
      // states where requests never fully settle, blocking indefinitely.
      let postNavUrl = page.url()
      let postNavText = ''
      await Promise.race([
        page.waitForLoadState('networkidle').catch(() => {}),
        DELAY(8_000),
      ])
      await DELAY(1_000) // extra buffer for any lazy-loaded challenge widgets
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

      // ── Approach 2: 2captcha at checkpoint / security-check page ─────────────
      // When LinkedIn shows a reCAPTCHA V2 challenge after credentials are submitted,
      // auto-solve it via 2captcha before giving up.
      const checkpointCaptchaSiteKey = await page.evaluate(() => {
        const h = document.querySelector('input[name="captchaSiteKey"]') as HTMLInputElement | null
        if (h?.value) return h.value
        const g = document.querySelector('.g-recaptcha') as HTMLElement | null
        if (g?.dataset.sitekey) return g.dataset.sitekey
        const src = (document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null)?.src ?? ''
        const m = src.match(/[?&]k=([^&]+)/)
        return m ? m[1] : ''
      }).catch(() => '') as string

      if (checkpointCaptchaSiteKey) {
        console.log(`[LOGIN DEBUG] reCAPTCHA V2 at checkpoint — solving via 2captcha (key=${checkpointCaptchaSiteKey.substring(0, 12)}…)`)
        const captchaToken = await solveRecaptchaV2(checkpointCaptchaSiteKey, page.url())
        if (captchaToken) {
          await page.evaluate((token: string) => {
            const ta = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response') as HTMLTextAreaElement | null
            if (ta) { ta.style.display = 'block'; ta.value = token }
            const inp = document.querySelector('input[name="captchaUserResponseToken"]') as HTMLInputElement | null
            if (inp) inp.value = token
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cfg = (window as any).___grecaptcha_cfg?.clients
            if (cfg) {
              for (const key of Object.keys(cfg)) {
                const cb = cfg[key]?.aa?.l?.callback ?? cfg[key]?.l?.callback
                if (typeof cb === 'function') try { cb(token) } catch { /* ok */ }
              }
            }
            const form = document.querySelector('form') as HTMLFormElement | null
            if (form) form.submit()
          }, captchaToken)
          await DELAY(5000)
          postNavUrl  = page.url()
          postNavText = await page.evaluate(() => (document.body?.innerText ?? '').substring(0, 500)).catch(() => '') as string
          console.log(`[LOGIN DEBUG] CAPTCHA checkpoint solved — now at ${postNavUrl}`)
          // If we're now past the checkpoint, continue the normal success path
          const postCaptchaCookies = await context.cookies()
          if (postCaptchaCookies.find(c => c.name === 'li_at')) {
            await saveCookies(context, session.accountId)
            session.status = 'success'
            await browser.close()
            return
          }
        }
      }

      if (isSecurityCheck) {
        console.log('[LOGIN DEBUG] LinkedIn security check detected — attempting 2captcha solve if available')
        await supabase.from('linkedin_accounts').update({
          debug_log: { label: 'security_check', postNavUrl, postNavText: postNavText.substring(0, 400), capturedAt: new Date().toISOString() }
        }).eq('id', session.accountId)
        // Only fail if we couldn't solve it automatically above
        if (!checkpointCaptchaSiteKey) {
          session.status = 'error'
          session.error  = 'LinkedIn showed a security check. No CAPTCHA site key found to auto-solve — try again or add a TOTP secret for this account.'
          await browser.close()
          return
        }
      }

      const isEmailChallenge = textLower.includes('email') || textLower.includes('sent a code') || textLower.includes('check your inbox')
      const isPhoneChallenge = textLower.includes('text message') || textLower.includes('sms') || (textLower.includes('phone') && !textLower.includes('approve'))
      // Includes notification/approve text OR very short page (still loading) → treat as push
      const isAppPush = textLower.includes('approve') || textLower.includes('tap') || textLower.includes('notification') || postNavText.length < 30

      // Auto-click "Send verification code" if visible (email/phone OTP challenge)
      // IMPORTANT: skip this if push notification is the primary flow — the challenge page
      // always shows "Verify using SMS" as a fallback option, which makes isPhoneChallenge=true
      // even when push is active. Clicking SMS here would switch away from push prematurely.
      if (!hasPinInputNow && !isAppPush && (isEmailChallenge || isPhoneChallenge)) {
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

      // Check again for PIN input after potential button click.
      // Use ONLY specific selectors and require the field to be VISIBLE —
      // LinkedIn's challenge page has many hidden inputs with "verification" in
      // their name/id that would otherwise create false positives here.
      const pinElAfterClick = await page.$(
        'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin'
      ).catch(() => null)
      const hasPinAfterClick = !!(pinElAfterClick && await pinElAfterClick.isVisible().catch(() => false))
      console.log(`[LOGIN DEBUG] hasPinAfterClick=${hasPinAfterClick} isAppPush=${isAppPush} isEmailChallenge=${isEmailChallenge} isPhoneChallenge=${isPhoneChallenge}`)

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

      if (!isAppPush && (isEmailChallenge || isPhoneChallenge)) {
        // We clicked send but PIN input not visible yet — set needs_verification.
        // Skip this if push is the primary flow — "Verify using SMS" is always present
        // as a fallback option on push challenge pages, making isPhoneChallenge=true even
        // when push notification is the intended path.
        const dest = isEmailChallenge ? 'your email inbox' : 'your phone via SMS'
        session.status = 'needs_verification'
        session.hint   = `LinkedIn sent a verification code to ${dest}. Enter it in the app to complete sign-in.`
        return
      }

      // Push notification (mobile app approval) or unknown challenge.
      // Strategy: try to switch to email/SMS code FIRST (avoids push notification dependency).
      // If switching fails (no alt button found), fall back to push poll.
      console.log('[LOGIN DEBUG] Push challenge — trying email/SMS alt verification first')
      const altSwitchedEarly = await switchToAltVerification(page, session)
      if (altSwitchedEarly && session.status === 'needs_verification') {
        console.log('[LOGIN DEBUG] Switched to alt verification immediately — returning needs_verification')
        return
      }

      // Alt switch didn't work — trigger push notification and poll for approval.
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
      console.log(`[LOGIN DEBUG] ── push poll START ── challenge URL: ${session.challengeUrl}`)
      console.log(`[LOGIN DEBUG] ── push poll: waiting for LinkedIn app approval (primary: cookie check every 1s, /feed/ fallback every 20s)`)

      while (Date.now() < PUSH_DEADLINE) {
        await DELAY(1_000)
        pollCount++
        const remainSec = Math.round((PUSH_DEADLINE - Date.now()) / 1000)
        try {
          // Instant check — no navigation needed
          const instantCookies = await context.cookies()
          const liAt = instantCookies.find(c => c.name === 'li_at' && c.value && c.value.length > 10)
          if (liAt) {
            console.log(`[LOGIN DEBUG] push poll #${pollCount}: ✅ li_at cookie appeared → SUCCESS`)
            await saveCookies(context, session.accountId)
            session.status = 'success'
            await browser.close()
            return
          }

          // Log every 5s so we can see it's alive
          if (pollCount % 5 === 0) {
            const currentUrl = page.url()
            const cookieNames = instantCookies.map(c => c.name).join(', ')
            console.log(`[LOGIN DEBUG] push poll #${pollCount} | ${remainSec}s left | url=${currentUrl.substring(0, 80)} | cookies=[${cookieNames}]`)
          }

          // Every 20 polls (~20 s) — or immediately if signalled — actively check /feed/
          // Kept infrequent because navigating away from the challengesV2 URL (which
          // contains a one-time token) invalidates the push session if done too often.
          // Primary detection is the instant context.cookies() check above.
          if (session.checkNow || pollCount % 20 === 0) {
            console.log(`[LOGIN DEBUG] push poll #${pollCount}: navigating to /feed/ to check approval (fallback)`)
            session.checkNow = false
            const approved = await checkFeedForApproval(page, context, session, browser)
            if (approved) return
            console.log(`[LOGIN DEBUG] push poll #${pollCount}: /feed/ check returned not-approved, back on challenge page`)
            // After navigating back, re-check for PIN input on the challenge page
          }

          // Fast path: li_at cookie set by auto-redirect (challenge JS working)
          const pushCookies = await context.cookies()
          if (pushCookies.find(c => c.name === 'li_at')) {
            console.log(`[LOGIN DEBUG] push poll #${pollCount}: ✅ li_at after feed-check → SUCCESS`)
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
            console.log(`[LOGIN DEBUG] push poll #${pollCount}: page left challenge → ${nowUrl.substring(0, 80)}`)
            const afterCookies = await context.cookies()
            if (afterCookies.find(c => c.name === 'li_at')) {
              console.log(`[LOGIN DEBUG] push poll #${pollCount}: ✅ li_at after auto-redirect → SUCCESS`)
              await saveCookies(context, session.accountId)
              session.status = 'success'
              await browser.close()
              return
            }
          }

          // PIN input appeared (LinkedIn switched from push to code)
          // IMPORTANT: only treat this as a real switch if the input is VISIBLE.
          // LinkedIn's challengesV2 page keeps hidden PIN inputs in the DOM even
          // while showing the push-approval prompt — detecting them too eagerly
          // causes us to jump to needs_verification right as the user approves.
          const pinNow = await page.$('input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin').catch(() => null)
          if (pinNow) {
            const pinVisible = await pinNow.isVisible().catch(() => false)
            console.log(`[LOGIN DEBUG] push poll #${pollCount}: PIN input found, visible=${pinVisible}`)
            if (pinVisible) {
              // Do one final cookie check — approval and PIN detection can race
              await DELAY(500)
              const raceCookies = await context.cookies()
              if (raceCookies.find(c => c.name === 'li_at' && c.value && c.value.length > 10)) {
                console.log(`[LOGIN DEBUG] push poll #${pollCount}: ✅ li_at arrived during PIN-race check → SUCCESS`)
                await saveCookies(context, session.accountId)
                session.status = 'success'
                await browser.close()
                return
              }
              console.log(`[LOGIN DEBUG] push poll #${pollCount}: ⚠️ PIN input VISIBLE — LinkedIn switched from push to code`)
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
            // PIN exists but hidden — part of push challenge page DOM, ignore it
          }

          // After ~20 s with no approval, switch to email/SMS code
          if (!altSwitchDone && pollCount >= 20) {
            console.log(`[LOGIN DEBUG] push poll #${pollCount}: 90s elapsed, attempting to switch to alt verification (SMS/email code)`)
            altSwitchDone = true
            const switched = await switchToAltVerification(page, session)
            if (switched && session.status === 'needs_verification') return
          }
        } catch (pollErr) {
          const errMsg = String(pollErr)
          console.log(`[LOGIN DEBUG] push poll #${pollCount}: caught error — ${errMsg.substring(0, 120)}`)
          if (
            errMsg.includes('Target page, context or browser has been closed') ||
            errMsg.includes('browser has been closed') ||
            errMsg.includes('context has been destroyed') ||
            errMsg.includes('Target closed')
          ) {
            console.log(`[LOGIN DEBUG] push poll: browser/context closed unexpectedly — aborting poll`)
            session.status = 'error'
            session.error  = 'Browser session closed unexpectedly. Please try reconnecting.'
            return
          }
        }
      }

      console.log(`[LOGIN DEBUG] push poll: ⏰ 3-minute deadline expired without approval`)
      session.status = 'error'
      session.error  = 'Verification not completed within 3 minutes. Please try again.'
      await browser.close().catch(() => {})
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
      await DELAY(1_000)
      pollCount++

      try {
        // Instant check — no navigation needed
        const instantCookies = await context.cookies()
        if (instantCookies.find(c => c.name === 'li_at' && c.value && c.value.length > 10)) {
          await saveCookies(context, session.accountId)
          session.status = 'success'
          console.log('[LOGIN DEBUG] push poll: li_at appeared in cookies → success')
          await browser.close()
          return
        }

        // Every 20 polls (~20 s) — or on demand — navigate to /feed/ to check approval.
        // Kept infrequent: the challengesV2 URL has a one-time token and navigating
        // away too often invalidates the push session before the user can approve.
        if (session.checkNow || pollCount % 20 === 0) {
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

        // After ~90 s with no approval, switch to email/SMS code automatically
        if (!altSwitchDone && pollCount >= 90) {
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
  const page = session.page
  const cdp  = session.usingCDP ?? false
  try {
    if (action.type === 'click') {
      // page.mouse.click() works on both BrightData and local Chromium
      await page.mouse.click(action.x, action.y)

    } else if (action.type === 'type') {
      if (cdp) {
        // BrightData blocks Input.dispatchKeyEvent (keyboard.type) on password fields.
        // Append directly to activeElement.value using the native React-compatible setter.
        await page.evaluate((char: string) => {
          const el = document.activeElement as HTMLInputElement | null
          if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          const next = el.value + char
          if (nativeSetter) nativeSetter.call(el, next)
          else el.value = next
          el.dispatchEvent(new Event('input',  { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
        }, action.text)
      } else {
        await page.keyboard.type(action.text)
      }

    } else if (action.type === 'key') {
      if (cdp) {
        if (action.key === 'Backspace') {
          await page.evaluate(() => {
            const el = document.activeElement as HTMLInputElement | null
            if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            const next = el.value.slice(0, -1)
            if (nativeSetter) nativeSetter.call(el, next)
            else el.value = next
            el.dispatchEvent(new Event('input',  { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
          })
        } else if (action.key === 'Enter') {
          // Find & DOM-click the nearest submit button (avoids form.submit() which closes BrightData session)
          await page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null
            const form   = active?.closest('form')
            const btn    = (form?.querySelector('button[type="submit"], [data-id="sign-in-form__submit-btn"]')
                         ?? document.querySelector('button[type="submit"]')) as HTMLElement | null
            if (btn) btn.click()
          })
        } else if (action.key === 'Tab') {
          await page.evaluate(() => {
            const focusable = Array.from(document.querySelectorAll(
              'input:not([disabled]), button:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
            )) as HTMLElement[]
            const idx = focusable.indexOf(document.activeElement as HTMLElement)
            if (idx >= 0 && idx < focusable.length - 1) focusable[idx + 1].focus()
          })
        }
        // Other special keys (Escape, arrows) are non-critical — silently ignore in CDP mode
      } else {
        await page.keyboard.press(action.key as Parameters<typeof page.keyboard.press>[0])
      }
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

/**
 * Opens a headless browser at LinkedIn's real login page so the user can log in
 * interactively via the frontend's screenshot viewer. No credentials are typed
 * automatically — the user sees and controls LinkedIn's own UI.
 * Returns a session_key immediately; the browser runs in the background.
 */
export function startManualSession(accountId: string): string {
  const key = randomKey()
  sessions.set(key, {
    accountId,
    createdAt: Date.now(),
    status:    'starting',
    hint:      'Opening LinkedIn login page…',
  })
  void runManualSession(key)
  return key
}

async function runManualSession(key: string): Promise<void> {
  const session = sessions.get(key)
  if (!session) return

  let browser: Browser | undefined
  try {
    // Prefer BrightData Scraping Browser — it's the only thing that reliably loads
    // LinkedIn's login form from Railway without triggering the bot-detection redirect.
    // CDP restrictions (keyboard.type blocked on password fields) don't matter here
    // because interactWithPage uses JS native-setter for typing in CDP mode.
    const browserEndpoint = process.env.DISABLE_PROXY !== 'true'
      ? (process.env.BRIGHTDATA_BROWSER_URL ?? null)
      : null

    // Fetch account email for pre-fill
    const { data: accountRow } = await supabase
      .from('linkedin_accounts')
      .select('linkedin_email')
      .eq('id', session.accountId)
      .single()
    const accountEmail = (accountRow as { linkedin_email?: string } | null)?.linkedin_email ?? ''

    let context: BrowserContext
    let usingCDP = false

    if (browserEndpoint) {
      const { chromium: pw } = await import('playwright')
      browser = await pw.connectOverCDP(browserEndpoint) as unknown as Browser
      const existing = browser.contexts()
      context = existing.length > 0
        ? existing[0]
        : await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } })
      usingCDP = true
      console.log('[manual-session] Using BrightData Scraping Browser')
    } else {
      // Fallback: local Chromium + account proxy (or no proxy in DISABLE_PROXY mode)
      const proxy = await resolveProxy(session.accountId)
      browser = await chromium.launch({
        headless: true,
        ...(proxy ? { proxy } : {}),
        args: [
          '--no-sandbox', '--disable-setuid-sandbox',
          '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
        ],
      }) as Browser
      context = await browser.newContext({
        proxy:             proxy ?? undefined,
        userAgent:         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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
      console.log('[manual-session] Using local Chromium' + (proxy ? ' + proxy' : ''))
    }

    const page = await context.newPage()
    session.browser  = browser
    session.context  = context
    session.page     = page
    session.usingCDP = usingCDP

    session.hint = 'Opening LinkedIn…'

    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await DELAY(2_000)

    // Pre-fill the email field so the user sees their email + avatar — just like HeyReach.
    // Uses JS native-setter (works on BrightData; bypasses React synthetic events).
    if (accountEmail) {
      const filled = await page.evaluate((email: string) => {
        const selectors = ['#username', 'input[name="session_key"]', 'input[type="email"]', 'input[autocomplete="username"]']
        for (const sel of selectors) {
          const el = document.querySelector(sel) as HTMLInputElement | null
          if (!el) continue
          el.focus()
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          if (nativeSetter) nativeSetter.call(el, email)
          else el.value = email
          el.dispatchEvent(new Event('input',  { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          el.dispatchEvent(new Event('blur',   { bubbles: true }))
          return true
        }
        return false
      }, accountEmail).catch(() => false)

      if (filled) {
        // Wait for LinkedIn to fetch and render the profile avatar
        await DELAY(2_500)
        console.log('[manual-session] Email pre-filled, avatar should load')
      }
    }

    // Browser is ready — show the screenshot to the user
    session.status = 'pending_push'
    session.hint   = 'Enter your password to sign in.'

    // Poll for li_at — up to 5 minutes for the user to log in + handle any 2FA
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      await DELAY(2_000)
      try {
        const cookies = await context.cookies()
        if (cookies.find(c => c.name === 'li_at')) {
          await saveCookies(context, session.accountId)
          session.status = 'success'
          await browser.close()
          return
        }
      } catch {
        // Context closed — browser navigated somewhere unexpected
        break
      }
    }

    session.status = 'error'
    session.error  = 'Login timed out — no session detected after 5 minutes. Please try again.'
    await browser.close().catch(() => {})
  } catch (err) {
    if (session) {
      session.status = 'error'
      session.error  = (err as Error).message ?? 'Browser session failed.'
    }
    if (browser) await browser.close().catch(() => {})
  }
}

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

/**
 * Headless auto-reconnect — resolves true on success, false on failure/timeout.
 * Used by the keep-alive worker to silently refresh expired sessions.
 * Only works when TOTP secret is stored (fully automatic 2FA) or when the
 * account has no 2FA. Accounts requiring push/SMS approval will time out.
 */
export async function loginAndWait(
  accountId:   string,
  email:       string,
  password:    string,
  totpSecret?: string,
  timeoutMs  = 3 * 60 * 1000, // 3 minutes
): Promise<boolean> {
  const key = startLogin(accountId, email, password, totpSecret)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    const s = sessions.get(key)
    if (!s) return false
    if (s.status === 'success') return true
    if (s.status === 'error') return false
    // pending_push or needs_verification — only TOTP can resolve these automatically
    // (the runLogin background task handles TOTP filling); for SMS/push we time out
  }
  // Clean up the dangling session on timeout
  const s = sessions.get(key)
  if (s?.browser) await s.browser.close().catch(() => {})
  sessions.delete(key)
  return false
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

  // Rapid poll: check every 300ms for up to 3s instead of waiting a fixed 4s
  const rapidStart = Date.now()
  while (Date.now() - rapidStart < 3_000) {
    const current = getLoginStatus(sessionKey)
    if (current.status === 'success' || current.status === 'needs_verification' || current.status === 'error') {
      return current
    }
    await new Promise(r => setTimeout(r, 300))
  }

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
