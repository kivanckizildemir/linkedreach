import { Queue } from 'bullmq'
import { readFileSync } from 'fs'

const env = readFileSync('/Users/kivanckizildemir/linkedreach/backend/.env', 'utf-8')
env.split('\n').forEach(line => {
  const [k, ...v] = line.split('=')
  if (k && v.length) process.env[k.trim()] = v.join('=').trim()
})

const connection = { url: process.env.REDIS_URL }
const q = new Queue('qualify-leads', { connection })
const [waiting, delayed, active] = await Promise.all([q.getWaiting(), q.getDelayed(), q.getActive()])
console.log(`Waiting: ${waiting.length}, Delayed: ${delayed.length}, Active: ${active.length}`)
await q.drain()
console.log('Queue drained')
await q.close()
process.exit(0)
