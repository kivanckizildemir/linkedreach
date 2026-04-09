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

import './linkedinAction.worker'
import './qualify.worker'
import './sequenceRunner.worker'
import { startScheduler } from './scheduler'
import { startWarmupWorker } from './warmup.worker'
import { startInboxPoller } from './inboxPoller.worker'
import './salesNavScraper.worker'
import './profileEnrich.worker'
import { startSessionKeepAlive } from './sessionKeepAlive.worker'

startScheduler()
startWarmupWorker()
startInboxPoller()
startSessionKeepAlive()
console.log('All workers started')
