import { Worker, Job } from 'bullmq'
import { connection } from '../lib/queue'

interface LinkedInActionJob {
  accountId: string
  action: 'connect' | 'message' | 'view_profile'
  targetProfileUrl: string
  messageContent?: string
  campaignLeadId?: string
}

const MAX_CONNECTIONS_PER_DAY = 25
const MAX_MESSAGES_PER_DAY = 100
const MIN_DELAY_MS = 30_000
const MAX_DELAY_MS = 120_000

function getRandomDelay(): number {
  return Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
}

function isWithinActiveHours(): boolean {
  const hour = new Date().getHours()
  return hour >= 7 && hour < 23
}

async function processLinkedInAction(job: Job<LinkedInActionJob>) {
  const { accountId, action, targetProfileUrl } = job.data

  if (!isWithinActiveHours()) {
    console.log(`[${accountId}] Outside active hours (7am-11pm). Skipping.`)
    return { skipped: true, reason: 'outside_active_hours' }
  }

  console.log(`[${accountId}] Processing ${action} for ${targetProfileUrl}`)

  // Placeholder — Playwright automation will be implemented in Phase 2
  const delay = getRandomDelay()
  console.log(`[${accountId}] Waiting ${delay}ms before next action`)

  return { success: true, action, accountId }
}

export const linkedinActionWorker = new Worker<LinkedInActionJob>(
  'linkedin-actions',
  processLinkedInAction,
  {
    connection,
    concurrency: 1,
    limiter: {
      max: 1,
      duration: MIN_DELAY_MS,
    },
  }
)

linkedinActionWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`)
})

linkedinActionWorker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message)
})

console.log('LinkedIn action worker started')
