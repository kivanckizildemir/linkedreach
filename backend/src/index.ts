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
import { errorHandler, notFound } from './middleware/errors'
import { testProxyRaw } from './linkedin/login'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
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

app.use(notFound)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
