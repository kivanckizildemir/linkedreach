import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
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
import { errorHandler, notFound } from './middleware/errors'
import { testProxyRaw, getLastErrorSnapshot, clearLastErrorSnapshot } from './linkedin/login'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
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

// Unauthenticated — returns snapshot captured during login attempt
// GET /api/login-debug                    → in-memory snapshot (JSON)
// GET /api/login-debug?img=1              → PNG screenshot (if captured)
// GET /api/login-debug/:accountId         → read debug_log from Supabase (cross-instance)
// GET /api/login-debug/:accountId?img=1   → PNG from Supabase record
app.get('/api/login-debug/:accountId?', async (req, res) => {
  const { supabase: sb } = await import('./lib/supabase')
  const accountId = (req.params as Record<string, string | undefined>).accountId

  // Try Supabase first if accountId provided
  if (accountId) {
    const { data } = await sb
      .from('linkedin_accounts')
      .select('debug_log')
      .eq('id', accountId)
      .single()
    const snap = (data as { debug_log?: Record<string, unknown> } | null)?.debug_log
    if (snap) {
      if (req.query.img === '1' && snap.screenshot) {
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

  // Fallback: in-memory (same instance only)
  const snap = getLastErrorSnapshot()
  if (!snap) {
    res.json({ message: 'No snapshot stored yet. Try connecting an account first.' })
    return
  }
  if (req.query.img === '1' && snap.screenshot) {
    const buf = Buffer.from(snap.screenshot, 'base64')
    res.setHeader('Content-Type', 'image/png')
    res.send(buf)
    return
  }
  const { screenshot, ...rest } = snap
  res.json({ ...rest, hasScreenshot: !!screenshot, source: 'memory' })
})
app.delete('/api/login-debug', (_req, res) => {
  clearLastErrorSnapshot()
  res.json({ cleared: true })
})

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

app.use(notFound)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
