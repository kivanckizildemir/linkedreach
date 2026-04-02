import { Queue } from 'bullmq'
import IORedis from 'ioredis'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
})

export const linkedinActionQueue = new Queue('linkedin-actions', { connection })
export const inboxPollQueue = new Queue('inbox-poll', { connection })
export const qualifyLeadsQueue = new Queue('qualify-leads', { connection })
export const sequenceRunnerQueue = new Queue('sequence-runner', { connection })
export const salesNavScraperQueue = new Queue('sales-nav-scraper', { connection })
