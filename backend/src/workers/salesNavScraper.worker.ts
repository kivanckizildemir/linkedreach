/**
 * Sales Navigator Scraper Worker — browser-based (Playwright)
 *
 * Uses a real Chromium browser loaded with the stored session cookie so
 * Cloudflare's JS challenge is satisfied and LinkedIn's bot protection
 * doesn't strip the session.
 *
 * Job data: { search_url, account_id, user_id, max_leads }
 */

import { Worker } from 'bullmq'
import { connection, qualifyLeadsQueue } from '../lib/queue'
import { supabase } from '../lib/supabase'
import { createSession, closeSession } from '../linkedin/session'
import type { AccountRecord } from '../linkedin/session'

interface SalesNavJob {
  search_url: string
  account_id: string
  user_id:    string
  max_leads:  number
}

interface ScrapedLead {
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  location: string | null
  linkedin_url: string
  connection_degree: number | null
  raw_data: Record<string, unknown>
}

export const salesNavScraperWorker = new Worker<SalesNavJob>(
  'sales-nav-scraper',
  async (job) => {
    const { search_url, account_id, user_id, max_leads } = job.data

    const { data: acc, error: accErr } = await supabase
      .from('linkedin_accounts')
      .select('id, cookies, proxy_id, status')
      .eq('id', account_id)
      .single()

    if (accErr || !acc) throw new Error('Account not found')

    await job.updateProgress(5)

    const { browser, context, page } = await createSession(acc as AccountRecord)

    try {
      // Strip sessionId — it's tied to the original browser session
      const url = new URL(search_url)
      url.searchParams.delete('sessionId')
      const cleanUrl = url.toString()

      // Step 1: Navigate to LinkedIn homepage first so LinkedIn can set all session cookies
      // (JSESSIONID, bscookie, bcookie, li_a, liap, etc.) using li_at as the anchor.
      // Without this warm-up, headless browser with only li_at gets redirect loops on Sales Nav.
      console.log('[sales-nav] Warming up session on LinkedIn feed...')
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null)
      await page.waitForTimeout(3000)
      await job.updateProgress(8)

      const feedUrl = page.url()
      if (feedUrl.includes('/login') || feedUrl.includes('/uas/login') || feedUrl.includes('/checkpoint')) {
        throw new Error('SESSION_EXPIRED: LinkedIn redirected to login. Please reconnect from the Accounts page.')
      }
      console.log(`[sales-nav] Feed loaded ok (${feedUrl.substring(0, 80)}), navigating to Sales Nav...`)

      // Step 2: Navigate to the Sales Navigator search URL
      console.log(`[sales-nav] Navigating to: ${cleanUrl.substring(0, 120)}`)
      await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await job.updateProgress(10)

      // Check if redirected to login
      const currentUrl = page.url()
      if (currentUrl.includes('/login') || currentUrl.includes('/uas/login') || currentUrl.includes('/checkpoint')) {
        throw new Error('SESSION_EXPIRED: LinkedIn redirected to login on Sales Nav. Your account may not have a Sales Navigator subscription.')
      }

      // Wait for the page to fully load
      await page.waitForTimeout(5000)
      await job.updateProgress(12)

      // Log current URL and page title for debugging
      const afterUrl = page.url()
      const pageTitle = await page.title()
      console.log(`[sales-nav] After navigation: url=${afterUrl.substring(0, 120)} title=${pageTitle}`)

      // Wait for network to quiet down (React SPA finishes rendering)
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null)
      await page.waitForTimeout(3000)

      // Log page structure to find correct selectors
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 800) ?? '')
      console.log(`[sales-nav] Page text preview: ${bodyText.substring(0, 500)}`)

      // Save screenshot for debugging
      const screenshotPath = `/tmp/salesnav-debug-${Date.now()}.png`
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => null)
      console.log(`[sales-nav] Screenshot saved: ${screenshotPath}`)

      const selectorProbe = await page.evaluate(() => {
        const candidates = [
          '[data-anonymize="person-name"]',
          '.artdeco-entity-lockup__title',
          '.result-lockup__name',
          '.artdeco-list__item',
          '[data-view-name="search-results-lead-result"]',
          '.search-results__result-item',
          '.artdeco-list',
          '[data-x--lead-actions-bar]',
          '.lead-headline',
          'ul li',
          '.search-results',
          'section',
          'main',
        ]
        return candidates.map(sel => ({ sel, count: document.querySelectorAll(sel).length }))
      })
      console.log('[sales-nav] Selector probe:', JSON.stringify(selectorProbe))

      // Wait for search results to render
      await page.waitForSelector(
        '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name',
        { timeout: 30_000 }
      ).catch(() => null)

      await page.waitForTimeout(2000)
      await job.updateProgress(15)

      const leads: ScrapedLead[] = []
      const pageSize = 25
      let pageNum = 0

      while (leads.length < max_leads) {
        // Extract leads from current page
        const pageLeads = await page.evaluate(() => {
          const results: Array<{
            name: string
            title: string | null
            company: string | null
            location: string | null
            profileUrl: string | null
            salesNavUrl: string | null
            degree: number | null
          }> = []

          // Sales Nav result items — try multiple selector patterns across versions
          const items = document.querySelectorAll(
            '.artdeco-list__item, [data-view-name="search-results-lead-result"], .result-lockup'
          )

          items.forEach(item => {
            // Name
            const nameEl = item.querySelector(
              '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name'
            )
            const name = nameEl?.textContent?.trim() ?? ''
            if (!name) return

            // Title
            const titleEl = item.querySelector(
              '[data-anonymize="title"], .artdeco-entity-lockup__subtitle, .result-lockup__highlight-keyword'
            )
            const title = titleEl?.textContent?.trim() ?? null

            // Company
            const companyEl = item.querySelector(
              '[data-anonymize="company-name"], .artdeco-entity-lockup__caption, .result-lockup__position-company'
            )
            const company = companyEl?.textContent?.trim() ?? null

            // Location
            const locationEl = item.querySelector(
              '[data-anonymize="location"], .artdeco-entity-lockup__metadata, .result-lockup__misc-list'
            )
            const location = locationEl?.textContent?.trim() ?? null

            // Profile URL
            const linkEl = item.querySelector<HTMLAnchorElement>(
              'a[href*="/sales/lead/"], a[href*="/in/"]'
            )
            const salesNavUrl = linkEl?.href ?? null
            const profileUrl = salesNavUrl?.includes('/in/')
              ? salesNavUrl
              : null

            // Degree
            const degreeEl = item.querySelector('.dist-value, [data-anonymize="degree"]')
            const degreeText = degreeEl?.textContent?.trim() ?? ''
            const degree = degreeText.includes('1') ? 1 : degreeText.includes('2') ? 2 : degreeText.includes('3') ? 3 : null

            results.push({ name, title, company, location, profileUrl, salesNavUrl, degree })
          })

          return results
        })

        for (const raw of pageLeads) {
          if (leads.length >= max_leads) break

          const parts = raw.name.split(' ')
          const firstName = parts[0] ?? raw.name
          const lastName = parts.slice(1).join(' ')

          const linkedinUrl = raw.profileUrl ?? raw.salesNavUrl ?? ''
          if (!linkedinUrl) continue

          leads.push({
            first_name: firstName,
            last_name: lastName,
            title: raw.title,
            company: raw.company,
            location: raw.location,
            linkedin_url: linkedinUrl,
            connection_degree: raw.degree,
            raw_data: {
              source: 'sales_navigator',
              sales_nav_url: raw.salesNavUrl,
              saved_search_id: url.searchParams.get('savedSearchId'),
            },
          })
        }

        console.log(`[sales-nav] Page ${pageNum + 1}: extracted ${pageLeads.length} items, total leads: ${leads.length}`)
        await job.updateProgress(Math.min(85, 15 + Math.round((leads.length / max_leads) * 70)))

        if (leads.length >= max_leads) break

        // Click "Next" to paginate
        const nextBtn = await page.$('button[aria-label="Next"], .artdeco-pagination__button--next:not([disabled])')
        if (!nextBtn) {
          console.log('[sales-nav] No next button found — end of results')
          break
        }

        await nextBtn.click()
        await page.waitForTimeout(3000 + Math.random() * 2000)
        await page.waitForSelector(
          '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name',
          { timeout: 20_000 }
        ).catch(() => null)

        pageNum++
      }

      await job.updateProgress(85)

      let savedCount = 0

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
