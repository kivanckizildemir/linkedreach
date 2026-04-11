import { Queue } from 'bullmq'
import { connection } from './lib/queue'

;(async () => {
  const names = ['sequence-runner', 'linkedin-action', 'profile-enrich', 'qualify']
  for (const name of names) {
    const q = new Queue(name, { connection })
    const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
    console.log(`[${name}] ${JSON.stringify(counts)}`)
    await q.close()
  }
  process.exit(0)
})().catch(e => { console.error(e.message); process.exit(1) })
