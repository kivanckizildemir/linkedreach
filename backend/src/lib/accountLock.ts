/**
 * Account-level distributed mutex using Redis SET NX EX.
 *
 * Guarantees only ONE Playwright browser process is running per LinkedIn
 * account at any given time. Without this, two workers opening the same
 * persistent Chrome profile simultaneously causes LinkedIn to detect a
 * session conflict and invalidate both sessions within minutes.
 *
 * Usage:
 *   const release = await acquireAccountLock(accountId)
 *   if (!release) { skip — another process owns this account }
 *   try { ...do playwright work... } finally { await release() }
 */

import IORedis from 'ioredis'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

// Separate low-latency connection for lock operations
const lockRedis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 200, 2000),
})

lockRedis.on('error', (err) => {
  console.error('[account-lock] Redis error:', err.message)
})

const LOCK_PREFIX = 'account_lock:'
const LOCK_TTL_S  = 30 * 60 // 30 minutes — maximum any browser session should run

function lockKey(accountId: string): string {
  return `${LOCK_PREFIX}${accountId}`
}

/**
 * Try to acquire the lock for an account.
 * Returns a release function on success, or null if already locked.
 *
 * @param accountId   The LinkedIn account ID
 * @param ttlSeconds  How long to hold the lock (default 30 min)
 */
export async function acquireAccountLock(
  accountId: string,
  ttlSeconds = LOCK_TTL_S
): Promise<(() => Promise<void>) | null> {
  const key   = lockKey(accountId)
  const token = `${Date.now()}-${Math.random()}`

  // SET key token NX EX ttl — atomic, only sets if key doesn't exist
  const result = await lockRedis.set(key, token, 'EX', ttlSeconds, 'NX')

  if (result !== 'OK') {
    // Lock already held by another process
    const ttl = await lockRedis.ttl(key)
    console.log(`[account-lock] Account ${accountId} is locked by another process (TTL ${ttl}s) — skipping`)
    return null
  }

  console.log(`[account-lock] Acquired lock for account ${accountId} (TTL ${ttlSeconds}s)`)

  // Return a release function that only deletes the key if WE still own it
  const release = async () => {
    try {
      const current = await lockRedis.get(key)
      if (current === token) {
        await lockRedis.del(key)
        console.log(`[account-lock] Released lock for account ${accountId}`)
      }
    } catch (e) {
      console.warn(`[account-lock] Release error for ${accountId}: ${(e as Error).message}`)
    }
  }

  return release
}

/**
 * Check whether an account is currently locked (browser in use).
 */
export async function isAccountLocked(accountId: string): Promise<boolean> {
  const ttl = await lockRedis.ttl(lockKey(accountId))
  return ttl > 0
}
