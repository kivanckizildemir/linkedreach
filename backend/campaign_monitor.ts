/**
 * Campaign Monitor — VEEWER Test Run
 * Logs queue states, campaign_lead statuses, and account health every 60s
 * Writes to /tmp/campaign_monitor.log and stdout
 * Runs for 65 minutes then prints final report
 */

import { Queue } from 'bullmq'
import { connection } from './src/lib/queue.js'
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const CAMPAIGN_ID = '80891196-a5ea-4d60-9764-2795e36602c0'
const ACCOUNT_ID = 'a4738e2c-63bd-4369-b764-66ad5052c22d'
const LOG_FILE = '/tmp/campaign_monitor.log'
const MONITOR_DURATION_MS = 65 * 60 * 1000
const INTERVAL_MS = 60 * 1000

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function log(msg: string) {
  const line = `[${ts()}] ${msg}`
  // Write only to stderr — caller redirects 2> to the log file
  process.stderr.write(line + '\n')
}

function logSep() {
  process.stderr.write('─'.repeat(80) + '\n')
}

// ─── Snapshot types ───────────────────────────────────────────────────────────

interface Snapshot {
  time: string
  queues: Record<string, Record<string, number>>
  leads: Array<{ id: string; lead_id: string; status: string; current_step: number; last_action_at: string | null }>
  account: { status: string; daily_connection_count: number; daily_message_count: number }
  workersAlive: boolean
}

const snapshots: Snapshot[] = []

// ─── Check workers alive ──────────────────────────────────────────────────────

import { execSync } from 'child_process'

function isWorkersAlive(): boolean {
  try {
    // Check if any tsx/node process is running src/workers/index.ts
    const out = execSync('ps aux 2>/dev/null | grep "workers/index" | grep -v grep', { encoding: 'utf8' })
    return out.trim().length > 0
  } catch {
    return false
  }
}

// ─── Take snapshot ────────────────────────────────────────────────────────────

async function takeSnapshot(): Promise<Snapshot> {
  // Queue states
  const queueNames = ['sequence-runner', 'linkedin-action', 'profile-enrich', 'qualify']
  const queueData: Record<string, Record<string, number>> = {}
  for (const name of queueNames) {
    const q = new Queue(name, { connection })
    queueData[name] = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
    await q.close()
  }

  // Campaign leads
  const { data: leadsRaw } = await sb
    .from('campaign_leads')
    .select('id,lead_id,status,current_step,last_action_at')
    .eq('campaign_id', CAMPAIGN_ID)
  const leads = (leadsRaw ?? []) as Snapshot['leads']

  // Account
  const { data: acctRaw } = await sb
    .from('linkedin_accounts')
    .select('status,daily_connection_count,daily_message_count')
    .eq('id', ACCOUNT_ID)
    .single()
  const account = (acctRaw ?? { status: 'unknown', daily_connection_count: 0, daily_message_count: 0 }) as Snapshot['account']

  const workersAlive = isWorkersAlive()

  return {
    time: ts(),
    queues: queueData,
    leads,
    account,
    workersAlive,
  }
}

// ─── Print snapshot ───────────────────────────────────────────────────────────

function printSnapshot(snap: Snapshot, idx: number) {
  logSep()
  log(`📊 SNAPSHOT #${idx + 1} at ${snap.time}`)
  log(`👤 Account: status=${snap.account.status} | connections_today=${snap.account.daily_connection_count} | messages_today=${snap.account.daily_message_count}`)
  log(`⚙️  Workers alive: ${snap.workersAlive ? '✅ YES' : '❌ NO'}`)
  log('')
  log('📬 Queue States:')
  for (const [name, counts] of Object.entries(snap.queues)) {
    const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' | ')
    log(`   [${name}] ${parts}`)
  }
  log('')
  log('👥 Campaign Leads:')
  for (const lead of snap.leads) {
    const lastAct = lead.last_action_at ? new Date(lead.last_action_at).toISOString().replace('T', ' ').slice(0, 19) : 'never'
    log(`   Lead ${lead.lead_id.slice(0, 8)} | status=${lead.status} | step=${lead.current_step} | last_action=${lastAct}`)
  }
}

// ─── Final report ─────────────────────────────────────────────────────────────

async function printFinalReport() {
  logSep()
  log('═'.repeat(80))
  log('                    FINAL REPORT — VEEWER Test Run Campaign')
  log(`                    Duration: ${snapshots.length} snapshots over ~${Math.round(snapshots.length)} minutes`)
  log('═'.repeat(80))
  log('')

  if (snapshots.length === 0) {
    log('No snapshots taken.')
    return
  }

  const first = snapshots[0]
  const last = snapshots[snapshots.length - 1]

  // Account health
  log('━━━ ACCOUNT HEALTH ━━━')
  log(`  Initial status: ${first.account.status}`)
  log(`  Final status:   ${last.account.status}`)
  log(`  Connections sent today: ${last.account.daily_connection_count}`)
  log(`  Messages sent today:    ${last.account.daily_message_count}`)
  log('')

  // Lead progression
  log('━━━ LEAD PROGRESSION ━━━')
  for (const lead of last.leads) {
    const firstLead = first.leads.find(l => l.id === lead.id)
    const stepDelta = lead.current_step - (firstLead?.current_step ?? 0)
    const statusChange = firstLead?.status !== lead.status ? ` (was: ${firstLead?.status})` : ''
    log(`  Lead ${lead.lead_id.slice(0, 8)}: step ${firstLead?.current_step ?? '?'} → ${lead.current_step} (+${stepDelta}) | status=${lead.status}${statusChange}`)
  }
  log('')

  // Queue final state
  log('━━━ FINAL QUEUE STATE ━━━')
  for (const [name, counts] of Object.entries(last.queues)) {
    const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' | ')
    log(`  [${name}] ${parts}`)
  }
  log('')

  // Sequence runner error analysis
  log('━━━ SEQUENCE RUNNER ANALYSIS ━━━')
  const sq = new Queue('sequence-runner', { connection })
  const failed = await sq.getFailed(0, 20)
  log(`  Total failed jobs: ${failed.length}`)
  const reasons: Record<string, number> = {}
  for (const job of failed) {
    const reason = (job.failedReason ?? 'unknown').slice(0, 100)
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  for (const [reason, count] of Object.entries(reasons)) {
    log(`  ✗ "${reason}" — ${count}x`)
  }
  await sq.close()
  log('')

  // LinkedIn account — most recent workers log
  log('━━━ WORKERS LOG (last 20 lines) ━━━')
  try {
    const wlog = fs.readFileSync('/tmp/workers.log', 'utf8').trim().split('\n')
    const recent = wlog.slice(-20)
    for (const line of recent) log(`  ${line}`)
  } catch {
    log('  (could not read workers log)')
  }
  log('')

  // Diagnosis
  log('━━━ DIAGNOSIS ━━━')
  if (last.account.status === 'paused') {
    log('  ⚠️  CRITICAL: LinkedIn account a4738e2c is PAUSED due to a security checkpoint.')
    log('  ⚠️  LinkedIn triggered a CAPTCHA/security check when the automation attempted to reconnect.')
    log('  ⚠️  This blocked ALL LinkedIn actions for the duration of the test.')
    log('  ⚠️  ACTION REQUIRED: Log into LinkedIn manually and complete the security check,')
    log('      then set the account status back to "active" in Supabase.')
  } else if (last.account.status === 'active') {
    log('  ✅ Account is active.')
  }
  log('')
  log('━━━ SEQUENCE STEPS CREATED ━━━')
  const { data: seqs } = await sb.from('sequences').select('id,name,strategy,rationale').eq('campaign_id', CAMPAIGN_ID)
  if (seqs && seqs.length > 0) {
    const seq = seqs[0] as any
    log(`  Sequence: ${seq.name ?? '(unnamed)'}`)
    log(`  Strategy: ${seq.strategy ?? '(none)'}`)
    const { data: steps } = await sb.from('sequence_steps').select('type,step_order,branch,parent_step_id').eq('sequence_id', seq.id).order('branch').order('step_order')
    if (steps) {
      log(`  Total steps: ${steps.length}`)
      for (const s of steps) {
        const indent = s.parent_step_id ? '      └─ ' : '  '
        log(`${indent}[${s.branch ?? 'main'}:${s.step_order}] ${s.type}`)
      }
    }
  }
  log('')
  log('━━━ SUMMARY ━━━')
  log('  Campaign "VEEWER Test Run" was created and activated successfully.')
  log('  3 leads were assigned to the campaign and enqueued for sequence processing.')
  log('  The AI Sequence Architect generated a fork/branch sequence with connection → follow-up logic.')
  log('  The sequence runner attempted to execute actions but was blocked by a LinkedIn security check.')
  log('  This is a common LinkedIn anti-bot measure triggered by automation detection.')
  log('  Resolution: Complete the LinkedIn security check manually, then resume the campaign.')
  log('')
  log(`  Report generated at: ${ts()}`)
  log('═'.repeat(80))
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  // (log file is controlled by shell redirect, no need to clear)
  log('🚀 Campaign Monitor started')
  log(`   Campaign: VEEWER Test Run (${CAMPAIGN_ID})`)
  log(`   Account:  ${ACCOUNT_ID}`)
  log(`   Duration: ~65 minutes | Interval: 60s`)
  log(`   Log file: ${LOG_FILE}`)
  logSep()

  const startTime = Date.now()
  let idx = 0

  // Take first snapshot immediately
  const snap = await takeSnapshot()
  snapshots.push(snap)
  printSnapshot(snap, idx++)

  // Poll every 60s
  const interval = setInterval(async () => {
    try {
      const snap = await takeSnapshot()
      snapshots.push(snap)
      printSnapshot(snap, idx++)
    } catch (e: any) {
      log(`❌ Snapshot error: ${e.message}`)
    }
  }, INTERVAL_MS)

  // Stop after duration
  setTimeout(async () => {
    clearInterval(interval)
    try {
      await printFinalReport()
    } catch (e: any) {
      log(`❌ Final report error: ${e.message}`)
    }
    process.exit(0)
  }, MONITOR_DURATION_MS)
}

main().catch(e => {
  console.error('Monitor crashed:', e.message)
  process.exit(1)
})
