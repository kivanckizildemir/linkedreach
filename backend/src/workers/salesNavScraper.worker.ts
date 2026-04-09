/**
 * Sales Navigator Scraper Worker — browser-based (Playwright) for Sales Nav,
 * API-based (Voyager) for regular LinkedIn people search.
 *
 * LinkedIn's Cloudflare JS challenge blocks direct HTTP API calls to the
 * Sales Navigator endpoint, so we use a real Chromium browser loaded with
 * the stored session cookie for Sales Nav URLs.
 *
 * Regular LinkedIn people search (/search/results/people/...) uses the
 * Voyager API directly which is less aggressively protected.
 *
 * Job data: { search_url, account_id, user_id, max_leads, list_id? }
 */

import { Worker } from 'bullmq'
import { connection } from '../lib/queue'
import { supabase } from '../lib/supabase'
import { persistCookies } from '../linkedin/session'
import type { AccountRecord } from '../linkedin/session'
import { acquireAccountLock } from '../lib/accountLock'
import { getOrCreateBrowserSession, invalidateBrowserSession } from '../lib/browserPool'
import { scrapeLinkedInSearchApi, isLinkedInPeopleSearch } from '../linkedin/linkedinSearchApi'
import type { ScrapedLead } from '../linkedin/salesNavApi'
import { enrichLeads, type LeadToEnrich } from '../linkedin/enrichProfiles'

interface SalesNavJob {
  search_url: string
  account_id: string
  user_id:    string
  max_leads:  number
  list_id?:   string
}

export const salesNavScraperWorker = new Worker<SalesNavJob>(
  'sales-nav-scraper',
  async (job) => {
    const { search_url, account_id, user_id, max_leads, list_id } = job.data

    await job.updateProgress(5)

    // ── Regular LinkedIn people search — use Voyager HTTP API ─────────────────
    if (isLinkedInPeopleSearch(search_url)) {
      const leads = await scrapeLinkedInSearchApi(
        account_id,
        search_url,
        max_leads,
        (scraped) => {
          const pct = Math.min(85, 10 + Math.round((scraped / max_leads) * 75))
          job.updateProgress(pct).catch(() => null)
        }
      )

      console.log(`[sales-nav] LinkedIn search scraped ${leads.length} leads`)
      await job.updateProgress(88)

      const { scraped: s, saved: sv } = await saveLeads(leads, user_id, list_id, job)
      return { scraped: s, saved: sv }
    }

    // ── Sales Navigator — use Playwright browser (Cloudflare requires JS) ────
    const { data: acc, error: accErr } = await supabase
      .from('linkedin_accounts')
      .select('id, cookies, proxy_id, status')
      .eq('id', account_id)
      .single()

    if (accErr || !acc) throw new Error('Account not found')

    const release = await acquireAccountLock(account_id)
    if (!release) throw new Error(`Account ${account_id} is currently in use — job will retry`)

    const { context, page } = await getOrCreateBrowserSession(acc as AccountRecord)

    try {
      // Strip sessionId — it's tied to the original browser session
      const url = new URL(search_url)
      url.searchParams.delete('sessionId')
      const cleanUrl = url.toString()

      // Step 1: Warm up session on LinkedIn feed so all session cookies are set
      console.log('[sales-nav] Warming up session on LinkedIn feed...')
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null)
      await page.waitForTimeout(3000)
      await job.updateProgress(8)

      const feedUrl = page.url()
      if (feedUrl.includes('/login') || feedUrl.includes('/uas/login') || feedUrl.includes('/checkpoint')) {
        throw new Error('SESSION_EXPIRED: LinkedIn redirected to login. Please reconnect from the Accounts page.')
      }
      console.log(`[sales-nav] Feed loaded (${feedUrl.substring(0, 80)}), navigating to Sales Nav...`)

      // Step 2: Navigate to Sales Navigator search URL
      console.log(`[sales-nav] Navigating to: ${cleanUrl.substring(0, 120)}`)
      await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      await job.updateProgress(10)

      // If we land on /sales/login, LinkedIn is establishing the li_a session from
      // the existing li_at. With a persistent browser profile this should auto-redirect
      // within a few seconds. Wait up to 30s for it to resolve before giving up.
      let currentUrl = page.url()
      if (currentUrl.includes('/sales/login')) {
        console.log('[sales-nav] On /sales/login — waiting for auto-redirect (up to 30s)…')
        try {
          await page.waitForURL((url: URL) => !url.toString().includes('/sales/login'), { timeout: 30_000 })
          currentUrl = page.url()
          console.log(`[sales-nav] Redirected to: ${currentUrl.substring(0, 120)}`)
        } catch {
          throw new Error('SESSION_EXPIRED: Stuck on Sales Navigator login page. Set Session again.')
        }
      }

      if (currentUrl.includes('/login') || currentUrl.includes('/uas/login') || currentUrl.includes('/checkpoint')) {
        throw new Error('SESSION_EXPIRED: LinkedIn redirected to login. Please reconnect from the Accounts page.')
      }

      await page.waitForTimeout(3000)
      await job.updateProgress(12)

      const afterUrl = page.url()
      const pageTitle = await page.title()
      console.log(`[sales-nav] After nav: url=${afterUrl.substring(0, 120)} title=${pageTitle}`)

      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null)
      await page.waitForTimeout(3000)

      // Log page structure to understand what we're looking at
      const bodySnippet = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? '').catch(() => '')
      console.log(`[sales-nav] Page text preview: ${bodySnippet.replace(/\s+/g, ' ').substring(0, 200)}`)

      // Wait for results to appear
      console.log('[sales-nav] Waiting for result cards…')
      await page.waitForSelector(
        '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name',
        { timeout: 30_000 }
      ).catch(() => null)

      const cardCount = await page.evaluate(() =>
        document.querySelectorAll('[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name').length
      ).catch(() => 0)
      console.log(`[sales-nav] Found ${cardCount} result cards on page`)

      await page.waitForTimeout(2000)
      await job.updateProgress(15)

      const leads: ScrapedLead[] = []
      let pageNum = 0

      while (leads.length < max_leads) {
        // Extract leads from current page via DOM
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

          const items = document.querySelectorAll(
            '.artdeco-list__item, [data-view-name="search-results-lead-result"], .result-lockup'
          )

          items.forEach(item => {
            const nameEl = item.querySelector(
              '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name'
            )
            const name = nameEl?.textContent?.trim() ?? ''
            if (!name) return

            const titleEl = item.querySelector(
              '[data-anonymize="title"], .artdeco-entity-lockup__subtitle, .result-lockup__highlight-keyword'
            )
            const title = titleEl?.textContent?.trim() ?? null

            const companyEl = item.querySelector(
              '[data-anonymize="company-name"], .artdeco-entity-lockup__caption, .result-lockup__position-company'
            )
            const company = companyEl?.textContent?.trim() ?? null

            const locationEl = item.querySelector(
              '[data-anonymize="location"], .artdeco-entity-lockup__metadata, .result-lockup__misc-list'
            )
            const location = locationEl?.textContent?.trim() ?? null

            const linkEl = item.querySelector<HTMLAnchorElement>(
              'a[href*="/sales/lead/"], a[href*="/in/"]'
            )
            const salesNavUrl = linkEl?.href ?? null
            const profileUrl = salesNavUrl?.includes('/in/') ? salesNavUrl : null

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
          })
        }

        console.log(`[sales-nav] Page ${pageNum + 1}: ${pageLeads.length} items, total: ${leads.length}`)
        await job.updateProgress(Math.min(85, 15 + Math.round((leads.length / max_leads) * 70)))

        if (leads.length >= max_leads) break

        const nextBtn = await page.$('button[aria-label="Next"], .artdeco-pagination__button--next:not([disabled])')
        if (!nextBtn) {
          console.log('[sales-nav] No next button — end of results')
          break
        }

        // Scroll into view then JS-click to avoid sticky-header interception
        await nextBtn.evaluate((el: Element) => {
          el.scrollIntoView({ block: 'center' })
        })
        await page.waitForTimeout(500)
        await nextBtn.evaluate((el: Element) => (el as HTMLElement).click())
        await page.waitForTimeout(3000 + Math.random() * 2000)
        await page.waitForSelector(
          '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name',
          { timeout: 20_000 }
        ).catch(() => null)

        pageNum++
      }

      console.log(`[sales-nav] Scraped ${leads.length} leads via browser`)
      await job.updateProgress(88)

      const { scraped, saved, savedLeads } = await saveLeads(leads, user_id, list_id, job)

      // Enrich profiles — visit each lead's LinkedIn profile to pull About,
      // experience description, skills, and recent posts. Run after saving so
      // leads exist in DB even if enrichment fails.
      // Note: Sales Nav URLs (/sales/lead/...) are redirected to /in/ by LinkedIn,
      // so we enrich all saved leads regardless of URL format.
      if (savedLeads.length > 0) {
        console.log(`[sales-nav] Enriching ${savedLeads.length} profiles...`)
        await enrichLeads(page, savedLeads, user_id)
      }

      await persistCookies(context, account_id)
      return { scraped, saved }
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('SESSION_EXPIRED') || msg.includes('session') || msg.includes('login')) {
        // Mark paused immediately so the UI reflects the broken state.
        try { await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account_id) } catch {}
        invalidateBrowserSession(account_id)
      }
      throw err
    } finally {
      await release()
    }
  },
  {
    connection,
    concurrency: 1,
    // Rate-limit: max 1 scraping job per 60 seconds per account to avoid
    // triggering LinkedIn's rapid-automation detection which kills the session.
    limiter: {
      max: 1,
      duration: 60_000,
    },
  }
)

async function saveLeads(
  leads: ScrapedLead[],
  user_id: string,
  list_id: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  job: any
): Promise<{ scraped: number; saved: number; savedLeads: LeadToEnrich[] }> {
  let savedLeads: LeadToEnrich[] = []

  if (leads.length > 0) {
    const rows = leads.map(l => ({
      ...l,
      user_id,
      source: 'sales_nav_import' as const,
      raw_data: { source: 'sales_navigator' },
      ...(list_id ? { list_id } : {}),
    }))

    // Deduplicate against existing leads for this user
    const urls = rows.map(r => r.linkedin_url)
    const { data: existing } = await supabase
      .from('leads')
      .select('linkedin_url')
      .in('linkedin_url', urls)
      .eq('user_id', user_id)
    const existingUrls = new Set((existing ?? []).map((e: { linkedin_url: string }) => e.linkedin_url))
    const newRows = rows.filter(r => !existingUrls.has(r.linkedin_url))

    if (newRows.length > 0) {
      const { data: inserted, error: insertErr } = await supabase
        .from('leads')
        .insert(newRows)
        .select('id, linkedin_url, first_name, last_name')
      if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`)

      savedLeads = (inserted ?? []) as LeadToEnrich[]

      // Qualification is triggered on-demand when the user opens the lead list,
      // not here — so we don't score leads nobody has looked at yet.
    }
  }

  await job.updateProgress(100)
  return { scraped: leads.length, saved: savedLeads.length, savedLeads }
}

salesNavScraperWorker.on('failed', (job, err) => {
  console.error(`[sales-nav] Job ${job?.id} failed:`, err.message)
})

console.log('Sales Nav scraper worker started')
