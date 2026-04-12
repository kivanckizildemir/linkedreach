/**
 * Browser Pool — persistent Playwright sessions per LinkedIn account.
 *
 * Root problem this solves:
 *   Opening a new Chromium process for every BullMQ job means LinkedIn sees
 *   repeated cold browser launches from the same persistent profile, which it
 *   treats as bot activity and immediately invalidates the session cookie.
 *
 * Solution:
 *   Keep one browser context open per account and REUSE it across jobs.
 *   The browser is only launched once (or after a crash/expiry) and stays
 *   warm until it has been idle for IDLE_TIMEOUT_MS.
 *
 * Usage (workers):
 *   const { browser, context, page } = await getOrCreateBrowserSession(account)
 *   // ... do LinkedIn work ...
 *   // DO NOT call closeSession() — pool manages lifetime
 *   await persistCookies(context, account.id)   // still save cookies to DB
 *
 * On session expiry:
 *   Call invalidateBrowserSession(accountId) so the next job gets a fresh one.
 */

import type { Browser, BrowserContext, Page } from 'playwright'
import { createSession, closeSession, getProfileDir, persistCookies } from '../linkedin/session'
import type { AccountRecord } from '../linkedin/session'
import { makeStickyUsernameForPool } from '../linkedin/session'
import { supabase } from '../lib/supabase'
import * as fs from 'fs'
import { chromium } from 'playwright'
import { generateFingerprint, buildFingerprintInitScript } from './fingerprint'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const speakeasy = require('speakeasy') as {
  totp: (opts: { secret: string; encoding: string }) => string
}
import { solveRecaptchaV2 } from './captchaSolver'

// Track in-progress auto-reconnects so concurrent jobs don't each kick one off
const reconnecting = new Set<string>()

const IDLE_TIMEOUT_MS = 25 * 60 * 1000 // close after 25 min idle

interface PoolEntry {
  browser:     Browser
  context:     BrowserContext
  page:        Page
  accountId:   string
  lastUsed:    number
  invalidated: boolean
  refreshing?: boolean
}

const pool = new Map<string, PoolEntry>()

// ── Idle cleanup ──────────────────────────────────────────────────────────────
// Runs every 5 minutes and closes browsers that have been idle too long or
// were explicitly invalidated (e.g. after a session expiry).
const cleanupInterval = setInterval(async () => {
  const now = Date.now()
  for (const [accountId, entry] of pool.entries()) {
    const idleMs = now - entry.lastUsed

    // Proactive refresh: ping /feed/ at 20 min to keep cookies fresh
    const PROACTIVE_REFRESH_MS = 20 * 60 * 1000
    if (!entry.invalidated && !entry.refreshing && idleMs > PROACTIVE_REFRESH_MS && idleMs < IDLE_TIMEOUT_MS) {
      entry.refreshing = true
      console.log(`[browser-pool] Proactive cookie refresh for ${accountId} (${Math.round(idleMs/60000)}m idle)`)
      ;(async () => {
        try {
          await entry.page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 10_000 })
          const url = entry.page.url()
          if (!url.includes('/login') && !url.includes('/checkpoint')) {
            const storage = await entry.context.storageState()
            await supabase.from('linkedin_accounts').update({ cookies: JSON.stringify(storage) }).eq('id', accountId)
            entry.lastUsed = Date.now() // Reset idle timer
            console.log(`[browser-pool] Proactive refresh succeeded for ${accountId}`)
          } else {
            console.warn(`[browser-pool] Proactive refresh redirected to ${url} — invalidating`)
            entry.invalidated = true
          }
        } catch (err) {
          console.warn(`[browser-pool] Proactive refresh failed for ${accountId}: ${(err as Error).message}`)
        } finally {
          entry.refreshing = false
        }
      })()
    }

    if (entry.invalidated || idleMs > IDLE_TIMEOUT_MS) {
      const reason = entry.invalidated ? 'invalidated' : `idle ${Math.round(idleMs / 60000)}m`
      console.log(`[browser-pool] Closing ${reason} session for ${accountId}`)
      pool.delete(accountId)
      await closeSession(entry.browser).catch(() => null)
    }
  }
}, 5 * 60 * 1000)

// Don't keep Node alive just for cleanup
if (cleanupInterval.unref) cleanupInterval.unref()

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get an existing warm browser session for `account` or create a new one.
 * Workers should call this instead of `createSession`.
 */
export async function getOrCreateBrowserSession(account: AccountRecord): Promise<{
  browser: Browser
  context: BrowserContext
  page:    Page
}> {
  const existing = pool.get(account.id)

  if (existing && !existing.invalidated) {
    // Verify the page is still alive and not stranded on a login/challenge page
    try {
      const [readyState, currentUrl] = await Promise.all([
        existing.page.evaluate(() => document.readyState),
        existing.page.evaluate(() => window.location.href).catch(() => ''),
      ])
      const isOnLoginPage = currentUrl.includes('/login') || currentUrl.includes('/authwall')
                         || currentUrl.includes('/checkpoint') || currentUrl.includes('/uas/login')
      if (isOnLoginPage) {
        console.warn(`[browser-pool] Warm session for ${account.id} is on a login/challenge page (${currentUrl.substring(0, 60)}) — invalidating`)
        pool.delete(account.id)
        await closeSession(existing.browser).catch(() => null)
        invalidateBrowserSession(account.id)
        throw new Error('SESSION_EXPIRED: Pooled session was stranded on login page')
      }
      void readyState // used for liveness check
      existing.lastUsed = Date.now()
      console.log(`[browser-pool] Reusing warm session for ${account.id}`)
      return { browser: existing.browser, context: existing.context, page: existing.page }
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('SESSION_EXPIRED')) throw err
      // Page crashed — try opening a fresh page on the same context first
      console.log(`[browser-pool] Page dead for ${account.id} — trying new page on existing context`)
      try {
        const freshPage = await existing.context.newPage()
        existing.page    = freshPage
        existing.lastUsed = Date.now()
        return { browser: existing.browser, context: existing.context, page: freshPage }
      } catch {
        // Context also dead — fall through to full recreate
        console.log(`[browser-pool] Context dead for ${account.id} — recreating browser`)
        pool.delete(account.id)
        await closeSession(existing.browser).catch(() => null)
      }
    }
  } else if (existing?.invalidated) {
    // Explicit invalidation (session expired) — close the old browser first
    console.log(`[browser-pool] Session for ${account.id} was invalidated — recreating`)
    pool.delete(account.id)
    await closeSession(existing.browser).catch(() => null)
  }

  console.log(`[browser-pool] Creating new browser session for ${account.id}`)
  const session = await createSession(account)

  pool.set(account.id, {
    browser:     session.browser,
    context:     session.context,
    page:        session.page,
    accountId:   account.id,
    lastUsed:    Date.now(),
    invalidated: false,
  })

  return session
}

/**
 * Reconnect an account using its persistent Chrome profile (preserves fingerprint).
 * Launches headlessly, navigates to LinkedIn login, fills credentials, waits for li_at.
 * Exported so both the browser pool and keepAlive worker share the same logic.
 */
export async function reconnectWithPersistentProfile(
  accountId: string,
  email: string,
  password: string,
  proxyId: string | null,
  totpSecret?: string | null,
): Promise<void> {
  let bgContext: BrowserContext | null = null
  try {
    let proxySettings: { server: string; username?: string; password?: string } | undefined
    if (proxyId) {
      const { data: proxy } = await supabase.from('proxies').select('proxy_url, proxy_type').eq('id', proxyId).single()
      if (proxy) {
        const url    = new URL((proxy as any).proxy_url)
        const server = `${url.protocol}//${url.host}`
        let username = decodeURIComponent(url.username) || undefined

        // Pin rotating residential proxies to a stable session so LinkedIn
        // always sees the same IP for this account.
        // Default to 'residential' if proxy_type column not yet migrated.
        const pType = (proxy as any).proxy_type ?? 'residential'
        if (username && pType === 'residential') {
          username = makeStickyUsernameForPool(username, server, accountId)
        }

        proxySettings = {
          server,
          username,
          password: decodeURIComponent(url.password) || undefined,
        }
      }
    }

    const profileDir = getProfileDir(accountId)
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(`${profileDir}/${lock}`) } catch { /* ok */ }
    }

    console.log(`[browser-pool] reconnect: launching persistent profile headlessly for ${accountId}`)
    // Load account fingerprint (or generate lazily) for consistent device identity
    const { data: accData } = await supabase
      .from('linkedin_accounts')
      .select('fingerprint, proxy_id')
      .eq('id', accountId)
      .single()
    const fp = (accData as any)?.fingerprint ?? generateFingerprint(accountId)

    bgContext = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer', '--disable-blink-features=AutomationControlled', '--no-first-run', '--disable-extensions', '--disable-sync'],
      proxy: proxySettings,
      userAgent: fp.user_agent,
      locale: fp.locale,
      timezoneId: fp.timezone,
      viewport: { width: fp.screen_width, height: fp.screen_height },
      ignoreHTTPSErrors: true,
    }) as BrowserContext

    // Close all pre-existing tabs from the old session to avoid crashes
    for (const existingPage of bgContext.pages()) {
      await existingPage.close().catch(() => null)
    }
    const page = await bgContext.newPage()

    // Handle unexpected page close during reconnect
    let pageClosed = false
    page.on('close', () => { pageClosed = true })
    page.on('crash', () => { pageClosed = true; console.warn(`[browser-pool] reconnect: page crashed for ${accountId}`) })

    await page.addInitScript({ content: buildFingerprintInitScript(fp) })

    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(2000)
    if (pageClosed) throw new Error('Page closed during navigation to /login')

    const landedUrl = page.url()
    if (!landedUrl.includes('/login') && !landedUrl.includes('/uas/login')) {
      console.log(`[browser-pool] reconnect: session still valid (${landedUrl.substring(0, 60)}) — saving cookies`)
      await persistCookies(bgContext, accountId)
      await supabase.from('linkedin_accounts').update({ status: 'active' }).eq('id', accountId)
      return
    }

    await page.fill('#username', email).catch(() => page.fill('input[name="session_key"]', email).catch(() => null))
    await page.waitForTimeout(800)
    await page.fill('#password', password).catch(() => page.fill('input[name="session_password"]', password).catch(() => null))
    await page.waitForTimeout(800)
    await page.click('button[type="submit"]').catch(() => page.keyboard.press('Enter').catch(() => null))

    const deadline = Date.now() + 2 * 60 * 1000
    let loggedIn = false
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000).catch(() => null)
      if (pageClosed) {
        console.warn(`[browser-pool] reconnect: page/browser closed unexpectedly for ${accountId}`)
        await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', accountId)
        return
      }
      const cur = page.url()
      const cookies = await bgContext.cookies()
      if (cookies.find(c => c.name === 'li_at') || cur.includes('/feed') || cur.includes('/mynetwork')) {
        loggedIn = true; break
      }
      if (cur.includes('/checkpoint') || cur.includes('/challenge') || cur.includes('/verification')) {
        console.warn(`[browser-pool] reconnect: challenge page for ${accountId} — URL: ${cur.substring(0, 80)}`)

        // ── 1. reCAPTCHA V2 challenge ─────────────────────────────────────────
        const captchaSiteKey = await page.evaluate(() =>
          (document.querySelector('input[name="captchaSiteKey"]') as HTMLInputElement)?.value ?? ''
        ).catch(() => '')
        const pageInstance = await page.evaluate(() =>
          (document.querySelector('input[name="pageInstance"]') as HTMLInputElement)?.value ?? ''
        ).catch(() => '')

        if (captchaSiteKey && pageInstance.includes('captchaV2')) {
          console.log(`[browser-pool] reconnect: reCAPTCHA V2 detected — solving via 2captcha…`)
          const token = await solveRecaptchaV2(captchaSiteKey, cur)
          if (token) {
            // Inject token and submit the form
            await page.evaluate((t: string) => {
              const el = document.querySelector('input[name="captchaUserResponseToken"]') as HTMLInputElement | null
              if (el) el.value = t
              // Also set the global grecaptcha callback if present
              ;(window as any).___grecaptcha_cfg?.clients?.[0]?.aa?.l?.callback?.(t)
            }, token)
            await page.waitForTimeout(500)
            await page.evaluate(() => {
              const form = document.querySelector('form') as HTMLFormElement | null
              if (form) form.submit()
            })
            await page.waitForTimeout(4000)
            if (pageClosed) break
            const afterUrl     = page.url()
            const afterCookies = await bgContext!.cookies()
            if (afterCookies.find((c: { name: string }) => c.name === 'li_at') || afterUrl.includes('/feed') || afterUrl.includes('/mynetwork')) {
              loggedIn = true
              break
            }
            console.warn(`[browser-pool] reconnect: captcha solved but login did not complete — URL: ${afterUrl.substring(0, 60)}`)
          }
          // If solve failed or login still didn't complete, pause
          await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', accountId)
          return
        }

        // ── 2. TOTP / PIN challenge ───────────────────────────────────────────
        if (totpSecret) {
          try {
            const PIN_SEL = 'input#input__email_verification_pin, input[name="pin"], input#input__phone_verification_pin, input[autocomplete="one-time-code"]'
            let pinInput = await page.$(PIN_SEL).catch(() => null)
            if (!pinInput) {
              const continueBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Get a code")').catch(() => null)
              if (continueBtn) {
                await continueBtn.click()
                await page.waitForTimeout(2000)
                pinInput = await page.$(PIN_SEL).catch(() => null)
              }
            }
            if (pinInput) {
              const code = speakeasy.totp({ secret: totpSecret, encoding: 'base32' })
              console.log(`[browser-pool] reconnect: filling TOTP code for ${accountId}`)
              await page.fill(PIN_SEL, code)
              await page.waitForTimeout(400)
              const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Verify")').catch(() => null)
              if (submitBtn) await submitBtn.click()
              else await page.keyboard.press('Enter')
              await page.waitForTimeout(3000)
              const afterUrl     = page.url()
              const afterCookies = await bgContext!.cookies()
              if (afterCookies.find((c: { name: string }) => c.name === 'li_at') || afterUrl.includes('/feed') || afterUrl.includes('/mynetwork')) {
                loggedIn = true
                break
              }
              console.warn(`[browser-pool] reconnect: TOTP fill did not resolve challenge for ${accountId}`)
              continue
            }
          } catch (totpErr) {
            console.warn(`[browser-pool] reconnect: TOTP attempt error — ${(totpErr as Error).message}`)
          }
        }

        // ── 3. Unknown challenge — cannot resolve automatically ───────────────
        const pageTitle = await page.title().catch(() => '?')
        console.warn(`[browser-pool] reconnect: unresolvable challenge for ${accountId} — "${pageTitle}" — pausing`)
        await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', accountId)
        return
      }
    }

    if (loggedIn) {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null)
      await page.waitForTimeout(2000)
      await persistCookies(bgContext, accountId)
      await supabase.from('linkedin_accounts').update({ status: 'active' }).eq('id', accountId)
      console.log(`[browser-pool] reconnect: ✓ ${accountId}`)
    } else {
      console.warn(`[browser-pool] reconnect: timed out for ${accountId}`)
      await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', accountId)
    }
  } finally {
    if (bgContext) await bgContext.close().catch(() => null)
  }
}

/**
 * Mark a session as invalid. The next getOrCreateBrowserSession will recreate it.
 * If credentials are stored, kicks off headless auto-reconnect in the background.
 */
export function invalidateBrowserSession(accountId: string): void {
  const entry = pool.get(accountId)
  if (entry) {
    entry.invalidated = true
    console.log(`[browser-pool] Marked session for ${accountId} as invalid`)
  }

  if (!reconnecting.has(accountId)) {
    reconnecting.add(accountId)
    ;(async () => {
      try {
        const { data: acc } = await supabase
          .from('linkedin_accounts')
          .select('linkedin_email, linkedin_password, proxy_id, totp_secret')
          .eq('id', accountId)
          .single()

        const email      = (acc as any)?.linkedin_email as string | undefined
        const passwd     = (acc as any)?.linkedin_password as string | undefined
        const proxyId    = (acc as any)?.proxy_id as string | null ?? null
        const totpSecret = (acc as any)?.totp_secret as string | null ?? null

        if (!email || !passwd) {
          console.log(`[browser-pool] No credentials for ${accountId} — marking paused`)
          await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', accountId)
          return
        }

        await reconnectWithPersistentProfile(accountId, email, passwd, proxyId, totpSecret)
      } catch (e) {
        console.error(`[browser-pool] Auto-reconnect error for ${accountId}: ${(e as Error).message}`)
      } finally {
        reconnecting.delete(accountId)
      }
    })()
  }
}

/**
 * Forcibly close and remove a session from the pool.
 * Used by sessionKeepAlive when it wants a guaranteed fresh login.
 */
export async function closeBrowserSession(accountId: string): Promise<void> {
  const entry = pool.get(accountId)
  if (entry) {
    pool.delete(accountId)
    await closeSession(entry.browser).catch(() => null)
  }
}

/** How many sessions are currently pooled (for diagnostics). */
export function poolSize(): number {
  return pool.size
}
