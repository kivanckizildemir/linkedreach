import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium as chromiumExtra } from 'playwright'
import { supabase } from '../lib/supabase'
import { SELECTORS } from './selectors'

// Proxy config — set DISABLE_PROXY=true to bypass all proxies (local dev).
//
// Static residential proxy (priority 1 when per-account proxy not set):
//   PROXY_HOST     = e.g. gate.provider.com
//   PROXY_PORT     = e.g. 10000
//   PROXY_USERNAME = your username
//   PROXY_PASSWORD = your password
//
// Legacy BrightData rotating proxy (lower priority, kept for backwards-compat):
//   BRIGHTDATA_PROXY_URL = http://brd-customer-XXXX-zone-ZONE:PASS@brd.superproxy.io:22225
const DISABLE_PROXY = process.env.DISABLE_PROXY === 'true'

function buildStaticProxySettings(): { server: string; username?: string; password?: string } | null {
  const host = process.env.PROXY_HOST
  const port = process.env.PROXY_PORT ?? '10000'
  const user = process.env.PROXY_USERNAME
  const pass = process.env.PROXY_PASSWORD
  if (!host || !user) return null
  return {
    server:   `http://${host}:${port}`,
    username: user,
    password: pass || undefined,
  }
}

const BD_PROXY_URL = DISABLE_PROXY ? '' : (process.env.BRIGHTDATA_PROXY_URL ?? '')

export interface AccountRecord {
  id: string
  /** JSON string — either a Playwright cookie array OR a full storage_state object
   *  { cookies: [...], origins: [{ origin, localStorage: [{name,value}] }] } */
  cookies: string
  proxy_id: string | null
  status: string
}

// ─── Storage-state helpers ────────────────────────────────────────────────────

interface StorageState {
  cookies: Array<{
    name: string; value: string; domain: string; path: string
    expires: number; httpOnly: boolean; secure: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
  }>
  origins?: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

/**
 * Parse the `cookies` DB column into either a full Playwright storage_state
 * object (preferred) or a plain cookie array (legacy).
 */
function parseSessionData(raw: string): { state: StorageState | null; cookiesOnly: object[] | null } {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'cookies' in parsed) {
      return { state: parsed as StorageState, cookiesOnly: null }
    }
    if (Array.isArray(parsed)) {
      return { state: null, cookiesOnly: parsed }
    }
  } catch { /* corrupt */ }
  return { state: null, cookiesOnly: null }
}

/**
 * Extract a flat cookie array from either storage format.
 * Used by code-paths that only need to read cookies (API calls, health check).
 */
export function extractCookies(cookiesStr: string): Array<{ name: string; value: string }> {
  const { state, cookiesOnly } = parseSessionData(cookiesStr)
  if (state) return state.cookies as Array<{ name: string; value: string }>
  if (cookiesOnly) return cookiesOnly as Array<{ name: string; value: string }>
  return []
}

export interface ProxyRecord {
  proxy_url: string        // e.g. http://user:pass@host:port
}

export async function createSession(account: AccountRecord): Promise<{
  browser: Browser
  context: BrowserContext
  page: Page
}> {
  let browser: Browser
  let context: BrowserContext

  // ── Proxy resolution ────────────────────────────────────────────────────────
  // Priority: account-level DB proxy → env BRIGHTDATA_PROXY_URL → no proxy.
  // When using the env-level BrightData proxy we append a sticky-session suffix
  // derived from the account ID so every action on the same account always
  // routes through the same residential IP — this is the single biggest factor
  // in keeping LinkedIn sessions alive (avoids "new device" rotation).
  let proxySettings: { server: string; username?: string; password?: string } | undefined

  if (!DISABLE_PROXY && account.proxy_id) {
    // 1. Per-account proxy stored in the DB
    const { data: proxy } = await supabase
      .from('proxies')
      .select('proxy_url')
      .eq('id', account.proxy_id)
      .single()

    if (proxy) {
      const url = new URL((proxy as ProxyRecord).proxy_url)
      proxySettings = {
        server:   `${url.protocol}//${url.host}`,
        username: url.username || undefined,
        password: url.password || undefined,
      }
    }
  } else if (!DISABLE_PROXY) {
    // 2. Static residential proxy (PROXY_HOST / PROXY_PORT / PROXY_USERNAME / PROXY_PASSWORD)
    //    — IP is always the same, no sticky-session suffix needed.
    const staticProxy = buildStaticProxySettings()
    if (staticProxy) {
      proxySettings = staticProxy
    } else if (BD_PROXY_URL) {
      // 3. Legacy BrightData rotating proxy with sticky-session suffix
      const url = new URL(BD_PROXY_URL)
      const host = url.hostname
      const port = url.port === '33335' ? '22225' : url.port
      const sessionTag = account.id.replace(/-/g, '').slice(0, 8)
      const baseUser   = decodeURIComponent(url.username)
      const stickyUser = baseUser.includes('-session-')
        ? baseUser
        : `${baseUser}-session-${sessionTag}`
      proxySettings = {
        server:   `http://${host}:${port}`,
        username: stickyUser,
        password: decodeURIComponent(url.password) || undefined,
      }
    }
  }

  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false'

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  browser = await chromiumExtra.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--ignore-certificate-errors',
    ],
  }) as Browser

  // ── Restore session state ───────────────────────────────────────────────────
  // If we have a full Playwright storage_state (cookies + localStorage origins)
  // pass it directly to newContext() — this is the proper API for full session
  // restoration and ensures localStorage-backed LinkedIn state is preserved.
  // Falls back to manually adding cookies for legacy cookie-array records.
  const { state: fullState, cookiesOnly } = account.cookies
    ? parseSessionData(account.cookies)
    : { state: null, cookiesOnly: null }

  context = await browser.newContext({
    proxy: proxySettings,
    // storageState restores BOTH cookies AND localStorage when available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: (fullState ?? undefined) as any,
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })

  // Legacy cookie-array path (no localStorage — sessions will be less stable)
  if (!fullState && cookiesOnly && cookiesOnly.length > 0) {
    await context.addCookies(cookiesOnly as Parameters<BrowserContext['addCookies']>[0])
  }

  const page = await context.newPage()

  // Additional stealth patches (no-op on Bright Data's browser, harmless)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
    // @ts-ignore
    window.chrome = { runtime: {} }
  })

  return { browser, context, page }
}

export async function closeSession(browser: Browser): Promise<void> {
  await browser.close()
}

/**
 * Persist the full Playwright storage_state (cookies + localStorage origins)
 * back to the DB after a session.  This is what you pass back in on the next
 * createSession() call — storing everything (not just cookies) is what keeps
 * LinkedIn sessions alive across requests.
 */
export async function persistCookies(context: BrowserContext, accountId: string): Promise<void> {
  const state = await context.storageState()
  await supabase
    .from('linkedin_accounts')
    .update({ cookies: JSON.stringify(state) })
    .eq('id', accountId)
}

/**
 * Check whether the current page is a LinkedIn security challenge or login redirect.
 * If detected, immediately pause the account and throw.
 */
export async function detectAndHandleChallenge(page: Page, accountId: string): Promise<void> {
  const url = page.url()
  const isCaptcha  = url.includes('/checkpoint') || url.includes('/challenge')
  const isLogin    = url.includes('/login') || url.includes('/uas/login') || url.includes('/sales/login')
  const hasPinForm = await page.$(SELECTORS.security.pinChallenge).then(el => !!el)

  if (isCaptcha || hasPinForm) {
    await supabase
      .from('linkedin_accounts')
      .update({ status: 'paused' })
      .eq('id', accountId)

    throw new Error(`SECURITY_CHALLENGE: Account ${accountId} paused — manual intervention required`)
  }

  if (isLogin) {
    throw new Error(
      'SESSION_EXPIRED: LinkedIn redirected to login. ' +
      'The session cookie is invalid or LinkedIn detected the automated browser. ' +
      'A residential proxy is required for server-side scraping. ' +
      'Go to Accounts → Set Session to refresh your cookie.'
    )
  }
}

/** Navigate to a URL and run challenge detection. */
export async function safeNavigate(page: Page, url: string, accountId: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ERR_TUNNEL_CONNECTION_FAILED') || msg.includes('ERR_PROXY_CONNECTION_FAILED')) {
      throw new Error(
        'PROXY_ERROR: Could not connect through the proxy. ' +
        'Check that your Bright Data proxy credentials are correct in the BRIGHTDATA_PROXY_URL environment variable, ' +
        'or set DISABLE_PROXY=true to run without a proxy (not recommended in production).'
      )
    }
    if (msg.includes('ERR_TOO_MANY_REDIRECTS')) {
      throw new Error(
        'REDIRECT_LOOP: The proxy is causing redirect loops with LinkedIn. ' +
        'This usually means the proxy credentials are invalid or the zone is inactive.'
      )
    }
    throw err
  }
  await detectAndHandleChallenge(page, accountId)
}
