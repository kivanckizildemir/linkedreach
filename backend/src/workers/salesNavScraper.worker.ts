/**
 * Sales Navigator Scraper Worker
 *
 * Processes jobs enqueued by POST /api/leads/import-sales-nav.
 * Uses Playwright through Bright Data residential proxy.
 *
 * Job data: { search_url, account_id, user_id, max_leads }
 */

import { Worker } from 'bullmq'
import { connection, qualifyLeadsQueue } from '../lib/queue'
import { supabase } from '../lib/supabase'
import { createSession, closeSession, persistCookies } from '../linkedin/session'
import { scrapeSalesNavSearch } from '../linkedin/salesNav'

interface SalesNavJob {
  search_url: string
  account_id: string
  user_id:    string
  max_leads:  number
}

export const salesNavScraperWorker = new Worker<SalesNavJob>(
  'sales-nav-scraper',
  async (job) => {
    const { search_url, account_id, user_id, max_leads } = job.data

    const { data: acc, error: accErr } = await supabase
      .from('linkedin_accounts')
      .select('*')
      .eq('id', account_id)
      .single()

    if (accErr || !acc) throw new Error('Account not found')

    await job.updateProgress(0)

    const { browser, context, page } = await createSession(
      acc as { id: string; cookies: string; proxy_id: string | null; status: string }
    )

    let savedCount = 0

    try {
      const leads = await scrapeSalesNavSearch(
        page,
        search_url,
        account_id,
        max_leads,
        async (scraped) => {
          await job.updateProgress(Math.round((scraped / max_leads) * 80))
        }
      )

      console.log(`[sales-nav] Scraped ${leads.length} leads for user ${user_id}`)

      if (leads.length > 0) {
        const rows = leads.map(l => ({
          ...l,
          user_id,
          source: 'sales_nav_import' as const,
        }))

        const { data: inserted, error: insertErr } = await supabase
          .from('leads')
          .upsert(rows, { onConflict: 'linkedin_url' })
          .select('id')

        if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`)

        savedCount = inserted?.length ?? 0

        if (inserted && inserted.length > 0) {
          await qualifyLeadsQueue.addBulk(
            inserted.map((lead: { id: string }) => ({
              name: 'qualify',
              data: { lead_id: lead.id, user_id },
              opts: { attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
            }))
          )
        }
      }

      await persistCookies(context, account_id)
      await job.updateProgress(100)
      return { scraped: leads.length, saved: savedCount }
    } finally {
      await closeSession(browser)
    }
  },
  {
    connection,
    concurrency: 1,
  }
)

salesNavScraperWorker.on('failed', (job, err) => {
  console.error(`[sales-nav] Job ${job?.id} failed:`, err.message)
})

console.log('Sales Nav scraper worker started')
