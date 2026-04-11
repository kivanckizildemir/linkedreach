// ── Timestamped logging ───────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
const _log   = console.log.bind(console)
const _warn  = console.warn.bind(console)
const _error = console.error.bind(console)
console.log   = (...a) => _log(`[${ts()}]`, ...a)
console.warn  = (...a) => _warn(`[${ts()}]`, ...a)
console.error = (...a) => _error(`[${ts()}]`, ...a)
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv'
// override: true forces .env values to win over any empty/stale shell env vars
dotenv.config({ override: true })

import { linkedinActionWorker } from './linkedinAction.worker'
import { qualifyWorker } from './qualify.worker'
import { sequenceRunnerWorker } from './sequenceRunner.worker'
import { startScheduler } from './scheduler'
import { startWarmupWorker } from './warmup.worker'
import { startInboxPoller } from './inboxPoller.worker'
import { salesNavScraperWorker } from './salesNavScraper.worker'
import { profileEnrichWorker } from './profileEnrich.worker'
import { startSessionKeepAlive } from './sessionKeepAlive.worker'

startScheduler()
startWarmupWorker()
startInboxPoller()
startSessionKeepAlive()
console.log('All workers started')

// Graceful shutdown — drain active jobs before exiting
async function shutdown(signal: string) {
  console.log(`[workers] ${signal} received — shutting down gracefully…`)
  await Promise.allSettled([
    linkedinActionWorker.close(),
    qualifyWorker.close(),
    sequenceRunnerWorker.close(),
    salesNavScraperWorker.close(),
    profileEnrichWorker.close(),
  ])
  console.log('[workers] All workers closed')
  process.exit(0)
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(console.error) })
process.on('SIGINT',  () => { shutdown('SIGINT').catch(console.error) })
