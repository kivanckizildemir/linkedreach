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
import { errorHandler, notFound } from './middleware/errors'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api/accounts', accountsRouter)
app.use('/api/campaigns', campaignsRouter)
app.use('/api/leads', leadsRouter)
app.use('/api/sequences', sequencesRouter)
app.use('/api/inbox', inboxRouter)
app.use('/api/templates', templatesRouter)
app.use('/api/analytics', analyticsRouter)

app.use(notFound)
app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
