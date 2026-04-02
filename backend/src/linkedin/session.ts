import type { Browser, BrowserContext, Page } from 'playwright'
import { supabase } from '../lib/supabase'
import { SELECTORS } from './selectors'

// Use playwright-extra with stealth plugin to reduce bot detection
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { chromium: chromiumExtra } = require('playwright-extra') as any
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
chromiumExtra.use(StealthPlugin())

// Bright Data residential proxy fallback (used when account has no proxy_id)
// Format: http://brd-customer-XXXX-zone-ZONE:PASSWORD@brd.superproxy.io:PORT
// Set DISABLE_PROXY=true locally to bypass proxy (home IPs are already residential)
const BD_PROXY_URL = process.env.DISABLE_PROXY === 'true' ? '' : (process.env.BRIGHTDATA_PROXY_URL ?? '')

export interface AccountRecord {
  id: string
  cookies: string          // JSON-serialised Playwright cookie array
  proxy_id: string | null
  status: string
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

  // Resolve proxy: account-level DB proxy takes priority, then env-level Bright Data proxy
  let proxySettings: { server: string; username?: string; password?: string } | undefined

  if (account.proxy_id) {
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
  } else if (BD_PROXY_URL) {
    const url = new URL(BD_PROXY_URL)
    // Bright Data port 33335 is their "super proxy" — use port 22225 for standard
    // residential which reliably supports HTTPS CONNECT tunneling
    const host = url.hostname
    const port = url.port === '33335' ? '22225' : url.port
    proxySettings = {
      server:   `http://${host}:${port}`,
      username: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
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
      // Ignore SSL errors from Bright Data certificate interception
      '--ignore-certificate-errors',
    ],
  }) as Browser

  context = await browser.newContext({
    // Proxy credentials passed only here — not in launch args (avoids auth conflict)
    proxy: proxySettings,
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

  // Restore saved cookies
  if (account.cookies) {
    try {
      const cookies = JSON.parse(account.cookies)
      await context.addCookies(cookies)
    } catch {
      // Corrupt cookie
    }
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

/** Save updated cookies back to the DB after a session. */
export async function persistCookies(context: BrowserContext, accountId: string): Promise<void> {
  const cookies = await context.cookies()
  await supabase
    .from('linkedin_accounts')
    .update({ cookies: JSON.stringify(cookies) })
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
