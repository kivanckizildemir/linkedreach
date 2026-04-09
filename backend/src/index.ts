// ── Timestamped logging ───────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
const _log   = console.log.bind(console)
const _warn  = console.warn.bind(console)
const _error = console.error.bind(console)
console.log   = (...a) => _log(`[${ts()}]`, ...a)
console.warn  = (...a) => _warn(`[${ts()}]`, ...a)
console.error = (...a) => _error(`[${ts()}]`, ...a)
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
// override: true forces .env values to win over any empty/stale shell env vars
import { authRouter } from './routes/auth'
import { accountsRouter } from './routes/accounts'
import { campaignsRouter } from './routes/campaigns'
import { leadsRouter } from './routes/leads'
import { sequencesRouter } from './routes/sequences'
import { inboxRouter } from './routes/inbox'
import { templatesRouter } from './routes/templates'
import { analyticsRouter } from './routes/analytics'
import { blacklistRouter } from './routes/blacklist'
import { messageTemplatesRouter } from './routes/messageTemplates'
import { activityLogRouter } from './routes/activityLog'
import { labelsRouter } from './routes/labels'
import { settingsRouter } from './routes/settings'
import { proxiesRouter } from './routes/proxies'
import { leadListsRouter } from './routes/leadLists'
import { scraperRouter } from './routes/scraper'
import { sequenceAiRouter } from './routes/sequenceAi'
import { errorHandler, notFound } from './middleware/errors'
import { testProxyRaw, getLastErrorSnapshot, clearLastErrorSnapshot } from './linkedin/login'

dotenv.config({ override: true })

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: true,          // reflect any origin (all are allowed)
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}))
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Get Railway's outbound IP
app.get('/api/my-ip', async (_req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json')
    const data = await r.json() as { ip: string }
    res.json(data)
  } catch (e) {
    res.json({ error: String(e) })
  }
})

// Unauthenticated proxy diagnostic — raw TCP CONNECT to BrightData
app.get('/api/proxy-diag/:accountId', async (req, res) => {
  const result = await testProxyRaw(String(req.params.accountId))
  const ok = result.includes('200')
  res.json({
    proxyResult: result,
    ok,
    proxyUrl: process.env.BRIGHTDATA_PROXY_URL ? process.env.BRIGHTDATA_PROXY_URL.replace(/:([^:@]+)@/, ':***@') : 'NOT SET',
  })
})

// Unauthenticated login debug snapshot endpoints
// GET /api/login-debug               → in-memory snapshot (JSON) or { message }
// GET /api/login-debug?img=1         → PNG from in-memory snapshot
// GET /api/login-debug/:accountId    → read debug_log from Supabase (cross-instance safe)
// GET /api/login-debug/:accountId?img=1 → PNG from Supabase record

async function serveLoginDebug(
  accountId: string | undefined,
  img: boolean,
  res: import('express').Response
) {
  const { supabase: sb } = await import('./lib/supabase')

  if (accountId) {
    const { data } = await sb
      .from('linkedin_accounts')
      .select('debug_log')
      .eq('id', accountId)
      .single()
    const snap = (data as { debug_log?: Record<string, unknown> } | null)?.debug_log
    if (snap) {
      if (img && snap.screenshot) {
        const buf = Buffer.from(snap.screenshot as string, 'base64')
        res.setHeader('Content-Type', 'image/png')
        res.send(buf)
        return
      }
      const { screenshot, ...rest } = snap
      res.json({ ...rest, hasScreenshot: !!screenshot, source: 'supabase' })
      return
    }
  }

  const snap = getLastErrorSnapshot()
  if (!snap) {
    res.json({ message: 'No snapshot stored yet. Try connecting an account first.' })
    return
  }
  if (img && snap.screenshot) {
    const buf = Buffer.from(snap.screenshot, 'base64')
    res.setHeader('Content-Type', 'image/png')
    res.send(buf)
    return
  }
  const { screenshot, ...rest } = snap
  res.json({ ...rest, hasScreenshot: !!screenshot, source: 'memory' })
}

app.get('/api/login-debug', (req, res) => {
  void serveLoginDebug(undefined, req.query.img === '1', res)
})

app.get('/api/login-debug/:accountId', (req, res) => {
  void serveLoginDebug(req.params.accountId, req.query.img === '1', res)
})
app.delete('/api/login-debug', (_req, res) => {
  clearLastErrorSnapshot()
  res.json({ cleared: true })
})

app.use('/api/auth', authRouter)
app.use('/api/accounts', accountsRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/leads', leadsRouter)
app.use('/api/sequences', sequencesRouter)
app.use('/api/inbox', inboxRouter)
app.use('/api/templates', templatesRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/blacklist', blacklistRouter)
app.use('/api/message-templates', messageTemplatesRouter)
app.use('/api/activity', activityLogRouter)
app.use('/api/labels', labelsRouter)
app.use('/api/settings', settingsRouter)
app.use('/api/proxies', proxiesRouter)
app.use('/api/lead-lists', leadListsRouter)
app.use('/api/scraper', scraperRouter)
app.use('/api/sequence-ai', sequenceAiRouter)

app.use(notFound)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
