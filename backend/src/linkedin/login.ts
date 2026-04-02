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
 * If totp_secret is stored on the account, 2FA codes are generated
 * automatically via otplib — no user interaction required (Infinite Login).
 */

import type { Browser, BrowserContext, Page } from 'playwright'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const speakeasy = require('speakeasy') as {
  totp: (opts: { secret: string; encoding: string }) => string
}
import { supabase } from '../lib/supabase'

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { chromium } = require('playwright-extra') as any
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
chromium.use(StealthPlugin())

type SessionStatus = 'starting' | 'pending_push' | 'needs_verification' | 'success' | 'error'

interface LoginSession {
  browser?:    Browser
  context?:    BrowserContext
  page?:       Page
  accountId:   string
  createdAt:   number
  status:      SessionStatus
  hint:        string
  error?:      string
  totpSecret?: string
}

const sessions = new Map<string, LoginSession>()

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

/** Resolve proxy settings for an account from DB or env fallback */
async function resolveProxy(accountId: string): Promise<
  { server: string; username?: string; password?: string } | undefined
> {
  const BD_PROXY_URL = process.env.DISABLE_PROXY === 'true'
    ? ''
    : (process.env.BRIGHTDATA_PROXY_URL ?? '')

  const { data: account } = await supabase
    .from('linkedin_accounts')
    .select('proxy_id')
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
    const port = url.port === '33335' ? '22225' : url.port
    return {
      server:   `http://${host}:${port}`,
      username: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
    }
  }

  return undefined
}

/** Runs entirely in the background — never awaited by the HTTP handler */
async function runLogin(key: string, email: string, password: string): Promise<void> {
  const session = sessions.get(key)
  if (!session) return

  let browser: Browser | undefined
  try {
    const proxy = await resolveProxy(session.accountId)

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--ignore-certificate-errors',
      ],
    }) as Browser

    const context = await browser.newContext({
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

    const page = await context.newPage()
    session.browser = browser
    session.context = context
    session.page    = page

    // Navigate to login
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await DELAY(1000 + Math.random() * 500)

    // Fill credentials
    await page.fill('#username', email)
    await DELAY(300 + Math.random() * 300)
    await page.fill('#password', password)
    await DELAY(300 + Math.random() * 300)
    await page.click('button[type="submit"]')

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
