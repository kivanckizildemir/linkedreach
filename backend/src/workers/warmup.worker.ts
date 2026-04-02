/**
 * Warmup Worker
 *
 * Runs once per day. For every account in `warming_up` status:
 *   - Increments warmup_day
 *   - Graduates to `active` once warmup_day reaches 30
 *
 * Warmup limits enforced in the sequence runner:
 *   Week 1 (days 1–7):   5 connections/day
 *   Week 2 (days 8–14):  8/day
 *   Week 3 (days 15–21): 11/day
 *   Week 4 (days 22–28): 14/day
 *   Week 5+ (days 29+):  17/day → graduates at day 30
 */

import { supabase } from '../lib/supabase'

export function warmupConnectionLimit(warmupDay: number): number {
  const week = Math.floor((warmupDay - 1) / 7)
  return Math.min(5 + week * 3, 25)
}

export async function runWarmupTick(): Promise<void> {
  const { data: accounts, error } = await supabase
    .from('linkedin_accounts')
    .select('id, warmup_day')
    .eq('status', 'warming_up')

  if (error) {
    console.error('[warmup] Failed to fetch warming_up accounts:', error.message)
    return
  }

  if (!accounts || accounts.length === 0) return

  for (const acc of accounts as { id: string; warmup_day: number }[]) {
    const newDay = acc.warmup_day + 1
    const graduate = newDay >= 30

    await supabase
      .from('linkedin_accounts')
      .update(
        graduate
          ? { status: 'active', warmup_day: newDay }
          : { warmup_day: newDay }
      )
      .eq('id', acc.id)

    if (graduate) {
      console.log(`[warmup] Account ${acc.id} graduated to active (day ${newDay})`)
    } else {
      const limit = warmupConnectionLimit(newDay)
      console.log(`[warmup] Account ${acc.id} → day ${newDay}, limit ${limit}/day`)
    }
  }
}

// Run once on startup then every 24 hours
export function startWarmupWorker(): void {
  console.log('[warmup] Worker started — ticking every 24h')
  runWarmupTick().catch(console.error)
  setInterval(() => runWarmupTick().catch(console.error), 24 * 60 * 60 * 1000)
}
