/**
 * Session Keep-Alive Worker
 *
 * Runs every 6 hours. For every active LinkedIn account that has been IDLE
 * for 8+ hours (no sequence/enrich activity):
 *   1. Checks the account is not currently locked (browser in use)
 *   2. Acquires the account lock
 *   3. Opens the persistent Chrome profile, visits LinkedIn feed
 *   4. Saves refreshed cookies back to DB
 *   5. If session expired AND credentials stored → auto-reconnects silently
 *   6. If no credentials → marks account paused
 *
 * Accounts active within the last 8 hours are skipped — their cookies are
 * already fresh from normal sequence/enrichment activity.
 */

import { supabase } from '../lib/supabase'
import { createSession, closeSession, persistCookies } from '../linkedin/session'
import { acquireAccountLock } from '../lib/accountLock'
import { reconnectWithPersistentProfile } from '../lib/browserPool'
import type { AccountRecord } from '../linkedin/session'

const INTERVAL_MS           = 15 * 60 * 1000       // Check every 15 min (was 30)
const IDLE_THRESHOLD_MS     = 20 * 60 * 1000       // Refresh if idle 20+ min (was 45)
const RECONNECT_BACKOFF_MS  =  4 * 60 * 60 * 1000  // don't retry paused accounts more than once per 4h

// In-memory map of accountId → last reconnect attempt timestamp.
// Using this instead of updated_at avoids the backoff being reset by unrelated
// DB writes (e.g. status changes that also bump updated_at).
const lastReconnectAttempt = new Map<string, number>()

async function keepAliveTick(): Promise<void> {
  console.log('[keep-alive] Running session refresh for idle accounts…')

  // Also include paused accounts that have stored credentials — auto-reconnect them
  const { data: accounts, error } = await supabase
    .from('linkedin_accounts')
    .select('id, cookies, proxy_id, status, linkedin_email, linkedin_password, totp_secret, updated_at')
    .in('status', ['active', 'warming_up', 'paused'])

  if (error || !accounts || accounts.length === 0) {
    console.log('[keep-alive] No active accounts found')
    return
  }

  for (const account of accounts) {
    const email    = (account as { linkedin_email?: string }).linkedin_email
    const password = (account as { linkedin_password?: string }).linkedin_password
    const totp     = (account as { totp_secret?: string }).totp_secret

    // Paused accounts with credentials — attempt auto-reconnect with backoff
    if (account.status === 'paused') {
      if (!email || !password) {
        console.log(`[keep-alive] Account ${account.id} is paused and has no credentials — skipping`)
        continue
      }
      // Use in-memory timestamp so status/updated_at churn doesn't corrupt the backoff window
      const lastAttempt = lastReconnectAttempt.get(account.id) ?? 0
      const msSinceAttempt = Date.now() - lastAttempt
      if (msSinceAttempt < RECONNECT_BACKOFF_MS) {
        const hoursLeft = Math.round((RECONNECT_BACKOFF_MS - msSinceAttempt) / 3_600_000 * 10) / 10
        console.log(`[keep-alive] Account ${account.id} is paused — backoff: ${hoursLeft}h left before retry`)
        continue
      }
      const release = await acquireAccountLock(account.id)
      if (!release) {
        console.log(`[keep-alive] Account ${account.id} locked — skipping auto-reconnect`)
        continue
      }
      lastReconnectAttempt.set(account.id, Date.now())
      try {
        console.log(`[keep-alive] Account ${account.id} is paused — attempting auto-reconnect…`)
        await reconnectWithPersistentProfile(account.id, email, password, account.proxy_id ?? null, totp ?? null)
      } catch (err) {
        console.error(`[keep-alive] Account ${account.id} auto-reconnect error: ${(err as Error).message}`)
      } finally {
        await release()
      }
      continue
    }

    if (!account.cookies) {
      console.log(`[keep-alive] Account ${account.id} has no session — skipping`)
      continue
    }

    // Only refresh accounts that have been idle for IDLE_THRESHOLD_MS
    const updatedAt = (account as { updated_at?: string }).updated_at
    if (updatedAt) {
      const idleMs = Date.now() - new Date(updatedAt).getTime()
      if (idleMs < IDLE_THRESHOLD_MS) {
        const idleMin = Math.round(idleMs / 60_000)
        console.log(`[keep-alive] Account ${account.id} is active (${idleMin}m idle) — skipping`)
        continue
      }
    }

    // Skip if another worker currently holds this account's browser
    const release = await acquireAccountLock(account.id)
    if (!release) {
      console.log(`[keep-alive] Account ${account.id} locked by another worker — skipping`)
      continue
    }

    let browser, context
    try {
      console.log(`[keep-alive] Refreshing session for account ${account.id}…`)
      const session = await createSession(account as AccountRecord)
      browser = session.browser
      context = session.context
      const page = session.page

      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      await page.waitForTimeout(3000)

      const url = page.url()
      if (url.includes('/login') || url.includes('/uas/login') || url.includes('/checkpoint')) {
        await closeSession(browser).catch(() => null)
        browser = null

        if (email && password) {
          console.log(`[keep-alive] Account ${account.id} session expired — auto-reconnecting…`)
          await reconnectWithPersistentProfile(account.id, email, password, account.proxy_id ?? null, totp ?? null)
        } else {
          console.warn(`[keep-alive] Account ${account.id} session expired, no credentials — marking paused`)
          await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account.id)
        }
      } else {
        await persistCookies(context, account.id)
        console.log(`[keep-alive] Account ${account.id} refreshed ✓`)
      }
    } catch (err) {
      console.error(`[keep-alive] Account ${account.id} failed: ${(err as Error).message}`)
    } finally {
      if (browser) await closeSession(browser).catch(() => null)
      await release()
    }

    await new Promise(r => setTimeout(r, 5000))
  }

  console.log('[keep-alive] Done')
}

export function startSessionKeepAlive(): void {
  console.log('[keep-alive] Worker started — checking every 15min, refreshing accounts idle 20min+')
  // First run after 1 minute — auto-reconnects any paused accounts with stored credentials
  setTimeout(() => keepAliveTick().catch(console.error), 60 * 1000)
  setInterval(() => keepAliveTick().catch(console.error), INTERVAL_MS)
}
