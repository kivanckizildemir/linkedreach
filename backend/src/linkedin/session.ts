import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium as chromiumExtra } from 'playwright-extra'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
chromiumExtra.use(StealthPlugin())
import { supabase } from '../lib/supabase'
import { SELECTORS } from './selectors'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

// Set DISABLE_PROXY=true to run without any proxy (local dev only).
const DISABLE_PROXY = process.env.DISABLE_PROXY === 'true'

// ── Persistent profile directory ──────────────────────────────────────────────
// Each account gets its own browser profile on disk. This preserves the full
// browser identity (IndexedDB, localStorage, fingerprint data, cookies) across
// browser launches. LinkedIn's Sales Navigator ties li_a to the specific browser
// instance — a persistent profile means the same identity on every launch, so
// li_a stays valid indefinitely without needing to re-login.
export function getProfileDir(accountId: string): string {
  const base = process.env.LINKEDIN_PROFILES_DIR
    ?? path.join(os.homedir(), '.linkedin-profiles')
  return path.join(base, accountId)
}

export async function profileDirExists(accountId: string): Promise<boolean> {
  try {
    await fs.access(getProfileDir(accountId))
    return true
  } catch {
    return false
  }
}

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
  // Proxy comes exclusively from the account's proxy_id (set via the Proxies UI).
  // We append a sticky-session tag derived from the account ID so the proxy
  // provider always routes this account through the same residential IP —
  // LinkedIn binds the session cookie to the login IP, so rotation = instant logout.
  let proxySettings: { server: string; username?: string; password?: string } | undefined

  if (!DISABLE_PROXY && account.proxy_id) {
    const { data: proxy } = await supabase
      .from('proxies')
      .select('proxy_url')
      .eq('id', account.proxy_id)
      .single()

    if (proxy) {
      const url = new URL((proxy as ProxyRecord).proxy_url)
      proxySettings = {
        server:   `${url.protocol}//${url.host}`,
        username: decodeURIComponent(url.username) || undefined,
        password: decodeURIComponent(url.password) || undefined,
      }
    }
  }

  const headless = process.env.PLAYWRIGHT_HEADLESS !== 'false'

  if (proxySettings) {
    console.log(`[session] Using proxy: ${proxySettings.server} (user: ${proxySettings.username ?? 'none'})`)
  } else {
    console.log('[session] WARNING: No proxy configured — Playwright will use the raw server IP')
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--ignore-certificate-errors',
  ]

  const contextOptions = {
    proxy: proxySettings,
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 } as { width: number; height: number },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  }

  // ── Pre-flight: warn if stored li_at is already expired ──────────────────
  if (account.cookies) {
    const { state: checkState, cookiesOnly: checkOnly } = parseSessionData(account.cookies)
    const allCookies = checkState?.cookies ?? (checkOnly as Array<{ name: string; expires?: number }> | null) ?? []
    const liAt = allCookies.find((c: { name: string }) => c.name === 'li_at') as { name: string; expires?: number } | undefined
    if (!liAt) {
      console.warn(`[session] No li_at cookie in DB for ${account.id} — session may be expired before launch`)
    } else if (liAt.expires && liAt.expires > 0 && liAt.expires * 1000 < Date.now()) {
      console.warn(`[session] li_at cookie for ${account.id} expired at ${new Date(liAt.expires * 1000).toISOString()} — expect SESSION_EXPIRED`)
    }
  } else {
    console.warn(`[session] No cookies stored for ${account.id}`)
  }

  const profileDir = getProfileDir(account.id)
  const hasProfile = await profileDirExists(account.id)

  if (hasProfile) {
    // ── Persistent context path ─────────────────────────────────────────────
    // Clean up Chrome singleton locks left by any previous crashed/zombie process
    // before launching. Without this, Chrome detects a stale lock and either
    // refuses to start or runs in a degraded state that crashes mid-session.
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { (await import('fs')).unlinkSync(`${profileDir}/${lock}`) } catch { /* already gone */ }
    }
    // Reuse the exact same browser profile that was created at login.
    // This preserves IndexedDB, localStorage, cookies and browser fingerprint
    // data across launches, which is required for li_a (Sales Navigator) to
    // remain valid — LinkedIn ties li_a to the specific browser identity.
    console.log(`[session] Using persistent profile: ${profileDir}`)
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      context = await (chromiumExtra as any).launchPersistentContext(profileDir, {
        headless,
        args: launchArgs,
        ...contextOptions,
      }) as BrowserContext
    } catch (profileErr) {
      // Profile is corrupted or locked — clean singleton locks and retry once,
      // then fall back to DB-cookie path so work isn't fully blocked.
      console.warn(`[session] launchPersistentContext failed for ${account.id} (${(profileErr as Error).message}) — cleaning locks and retrying`)
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { (await import('fs')).unlinkSync(`${profileDir}/${lock}`) } catch { /* already gone */ }
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        context = await (chromiumExtra as any).launchPersistentContext(profileDir, {
          headless,
          args: launchArgs,
          ...contextOptions,
        }) as BrowserContext
        console.log(`[session] Retry launch succeeded for ${account.id}`)
      } catch (retryErr) {
        console.error(`[session] Profile retry also failed for ${account.id} (${(retryErr as Error).message}) — falling back to DB-cookie launch`)
        // Fall back: launch fresh browser with cookies from DB
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        browser = await chromiumExtra.launch({ headless, proxy: proxySettings, args: launchArgs }) as Browser
        const { state: fullState, cookiesOnly } = account.cookies ? parseSessionData(account.cookies) : { state: null, cookiesOnly: null }
        context = await browser.newContext({ storageState: (fullState ?? undefined) as any, ...contextOptions })
        if (!fullState && cookiesOnly && (cookiesOnly as object[]).length > 0) {
          await context.addCookies(cookiesOnly as Parameters<BrowserContext['addCookies']>[0])
        }
        const page = context.pages()[0] ?? await context.newPage()
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })
          // @ts-ignore
          window.chrome = { runtime: {} }
        })
        return { browser, context, page }
      }
    }

    // launchPersistentContext returns a BrowserContext directly (no separate Browser).
    // We expose a close() via a Browser-shaped wrapper so all callers can use
    // the existing closeSession(browser) pattern unchanged.
    const contextClose = context.close.bind(context)
    browser = { close: contextClose } as unknown as Browser
  } else {
    // ── Legacy path: restore session from DB cookies ────────────────────────
    // Used when no profile dir exists (first-time or cloud deployment).
    console.log(`[session] No profile dir found — restoring session from DB cookies`)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    browser = await chromiumExtra.launch({
      headless,
      proxy: proxySettings,
      args: launchArgs,
    }) as Browser

    const { state: fullState, cookiesOnly } = account.cookies
      ? parseSessionData(account.cookies)
      : { state: null, cookiesOnly: null }

    if (!fullState && !cookiesOnly) {
      console.warn(`[session] No valid cookies to restore for ${account.id} — launching with empty session`)
    }

    context = await browser.newContext({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageState: (fullState ?? undefined) as any,
      ...contextOptions,
    })

    if (!fullState && cookiesOnly && cookiesOnly.length > 0) {
      await context.addCookies(cookiesOnly as Parameters<BrowserContext['addCookies']>[0])
    }
  }

  const page = context.pages()[0] ?? await context.newPage()

  // Stealth patches
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
 * Returns true if the save succeeded.
 */
export async function persistCookies(context: BrowserContext, accountId: string): Promise<boolean> {
  try {
    const state = await context.storageState()
    const liAt = state.cookies.find(c => c.name === 'li_at')
    if (!liAt) {
      console.warn(`[session] persistCookies: no li_at cookie found for ${accountId} — session may already be expired`)
    }
    const { error } = await supabase
      .from('linkedin_accounts')
      .update({ cookies: JSON.stringify(state) })
      .eq('id', accountId)
    if (error) {
      console.error(`[session] persistCookies: failed to save cookies for ${accountId}: ${error.message}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[session] persistCookies: exception for ${accountId}: ${(err as Error).message}`)
    return false
  }
}

/**
 * Check whether the current page is a LinkedIn security challenge or login redirect.
 * If detected, immediately pause the account and throw.
 */
export async function detectAndHandleChallenge(page: Page, accountId: string): Promise<void> {
  const url = page.url()
  const isCaptcha  = url.includes('/checkpoint') || url.includes('/challenge')
                  || url.includes('/authwall')
  const isVerify   = url.includes('/verify') || url.includes('/verification')
                  || url.includes('/security-verification')
  const isLogin    = url.includes('/login') || url.includes('/uas/login') || url.includes('/sales/login')
  const hasPinForm = await page.$(SELECTORS.security.pinChallenge).then(el => !!el).catch(() => false)

  if (isCaptcha || isVerify || hasPinForm) {
    await supabase
      .from('linkedin_accounts')
      .update({ status: 'paused' })
      .eq('id', accountId)

    throw new Error(`SECURITY_CHALLENGE: Account ${accountId} paused — manual intervention required (URL: ${url.substring(0, 80)})`)
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
        'Check that your proxy credentials are correct in the Proxies settings, ' +
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
