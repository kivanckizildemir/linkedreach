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
import { persistCookies, extractCookies } from '../linkedin/session'
import type { AccountRecord } from '../linkedin/session'
import { acquireAccountLock } from '../lib/accountLock'
import { getOrCreateBrowserSession, invalidateBrowserSession } from '../lib/browserPool'
import { scrapeLinkedInSearchApi, isLinkedInPeopleSearch } from '../linkedin/linkedinSearchApi'
import { scrapePostReactors } from '../linkedin/postReactorsApi'
import type { ScrapedLead } from '../linkedin/salesNavApi'
import { enrichLeads, type LeadToEnrich } from '../linkedin/enrichProfiles'
import { humanMouseMove, humanScroll, SHORT_WAIT, LONG_WAIT, delay } from '../linkedin/actions'

interface SalesNavJob {
  search_url:   string
  account_id:   string
  user_id:      string
  max_leads:    number
  list_id?:     string
  source_type?: string   // 'sales_nav' | 'linkedin_search' | 'post_reactors' | 'event_attendees'
}

async function isCancelled(jobId: string): Promise<boolean> {
  const flag = await connection.get(`cancel:scrape:${jobId}`)
  return flag === '1'
}

export const salesNavScraperWorker = new Worker<SalesNavJob>(
  'sales-nav-scraper',
  async (job) => {
    const { search_url, account_id, user_id, max_leads, list_id, source_type } = job.data

    await job.updateProgress(5)
    if (await isCancelled(job.id!)) throw new Error('Cancelled by user')

    // ── Post Reactors — Voyager reactions + comments API ─────────────────────
    if (source_type === 'post_reactors') {
      const leads = await scrapePostReactors(
        account_id,
        search_url,
        max_leads,
        (scraped: number) => {
          const pct = Math.min(85, 10 + Math.round((scraped / max_leads) * 75))
          job.updateProgress(pct).catch(() => null)
        }
      )
      console.log(`[sales-nav] Post reactors scraped ${leads.length} leads`)
      await job.updateProgress(88)
      const { scraped: s, saved: sv } = await saveLeads(leads, user_id, list_id, job, 'post_reactors')
      return { scraped: s, saved: sv }
    }

    // ── Regular LinkedIn people search — use Voyager HTTP API ─────────────────
    if (isLinkedInPeopleSearch(search_url)) {
      const leads = await scrapeLinkedInSearchApi(
        account_id,
        search_url,
        max_leads,
        (scraped: number) => {
          const pct = Math.min(85, 10 + Math.round((scraped / max_leads) * 75))
          job.updateProgress(pct).catch(() => null)
        }
      )

      console.log(`[sales-nav] LinkedIn search scraped ${leads.length} leads`)
      await job.updateProgress(88)

      const { scraped: s, saved: sv } = await saveLeads(leads, user_id, list_id, job, 'linkedin_search')
      return { scraped: s, saved: sv }
    }

    // ── Sales Navigator — use Playwright browser (Cloudflare requires JS) ────
    const { data: acc, error: accErr } = await supabase
      .from('linkedin_accounts')
      .select('id, cookies, proxy_id, proxy_country, status')
      .eq('id', account_id)
      .single()

    if (accErr || !acc) throw new Error('Account not found')

    const release = await acquireAccountLock(account_id)
    if (!release) throw new Error(`Account ${account_id} is currently in use — job will retry`)

    // ── Browser: always use the persistent pool session ──
    // BrightData Scraping Browser (CDP) was removed: LinkedIn binds li_at to device
    // fingerprint + IP. Every BrightData job = fresh browser on a rotating IP →
    // LinkedIn rejects it as a new unknown device every time.
    // The persistent pool reuses the same Playwright profile + the account's assigned
    // residential proxy → LinkedIn keeps trusting the session.
    let brightDataBrowser: import('playwright').Browser | null = null
    // eslint-disable-next-line prefer-const
    let context!: import('playwright').BrowserContext
    // eslint-disable-next-line prefer-const
    let page!: import('playwright').Page

    // Persistent pool session via account's assigned proxy
    const session = await getOrCreateBrowserSession(acc as AccountRecord)
    ;({ context: (context as import('playwright').BrowserContext), page: (page as import('playwright').Page) } = session as { context: import('playwright').BrowserContext; page: import('playwright').Page })

    // Set up API intercept BEFORE any navigation so we catch all Sales Nav
    // API responses, including the initial search results page load.
    const entityToLinkedIn = new Map<string, string>()
    const apiHandler = async (response: import('playwright').Response) => {
      const url = response.url()
      // Skip non-LinkedIn, static assets, and tracking
      if (!url.includes('linkedin.com')) return
      if (url.includes('.js') || url.includes('.css') || url.includes('.png') || url.includes('.jpg') || url.includes('.gif') || url.includes('.svg') || url.includes('.woff')) return
      try {
        const contentType = response.headers()['content-type'] ?? ''
        if (!contentType.includes('json') && !contentType.includes('text')) return
        const body = await response.text()
        if (!body.includes('/in/')) return

        const sizeBefore = entityToLinkedIn.size

        // Strategy 0 (highest priority): salesApiProfiles URL encodes the full
        // profile ID directly — e.g. /salesApiProfiles/(profileId:ACwAAA...,authType:...)
        // The DOM Sales Nav link truncates the entity ID to ~24 chars, but this
        // URL has the full ID. Store both full and prefix versions so prefix-match works.
        const profileIdMatch = url.match(/\/salesApiProfiles\/\(profileId:([^,)]+)/)
        if (profileIdMatch) {
          const fullId = profileIdMatch[1]
          const inMatch = body.match(/linkedin\.com\/in\/([a-zA-Z0-9_%-]{3,})(?:\/|"|\\|\s|$)/)
          if (inMatch && inMatch[1] !== 'me') {
            const inUrl = `https://www.linkedin.com/in/${inMatch[1]}`.split('?')[0].replace(/\/$/, '')
            entityToLinkedIn.set(fullId, inUrl)
            // Also store all prefix lengths from 20 chars up so truncated DOM IDs match
            for (let len = 20; len < fullId.length; len++) {
              entityToLinkedIn.set(fullId.substring(0, len), inUrl)
            }
            console.log(`[sales-nav] salesApiProfiles: mapped ${fullId.substring(0, 20)}... → ${inUrl}`)
          }
        }

        // Strategy 1: extract "publicProfileUrl":"https://...linkedin.com/in/handle"
        // paired with nearby entity IDs from entityUrn fields.
        const urlRe = /"publicProfileUrl"\s*:\s*"([^"]*\/in\/[^"]+)"/g
        let urlMatch: RegExpExecArray | null
        while ((urlMatch = urlRe.exec(body)) !== null) {
          const inUrl = urlMatch[1].split('?')[0].replace(/\/$/, '')
          if (!inUrl.includes('/in/') || inUrl.endsWith('/in/me')) continue

          const start = Math.max(0, urlMatch.index - 800)
          const ctx = body.slice(start, urlMatch.index + urlMatch[0].length + 200)
          const entityRe = /ACw[A-Za-z0-9+/\-_]{6,}/g
          let entityMatch: RegExpExecArray | null
          while ((entityMatch = entityRe.exec(ctx)) !== null) {
            if (!entityToLinkedIn.has(entityMatch[0])) entityToLinkedIn.set(entityMatch[0], inUrl)
          }
        }

        // Strategy 2: any /in/handle URLs with nearby ACw... entity IDs
        const inRe = /linkedin\.com\/in\/([a-zA-Z0-9_%-]{3,})(?:\/|"|\\|$)/g
        let m: RegExpExecArray | null
        while ((m = inRe.exec(body)) !== null) {
          if (m[1] === 'me') continue
          const inUrl = `https://www.linkedin.com/in/${m[1]}`.split('?')[0].replace(/\/$/, '')
          const start2 = Math.max(0, (m.index ?? 0) - 800)
          const ctx2 = body.slice(start2, (m.index ?? 0) + 200)
          const entMatch = ctx2.match(/ACw[A-Za-z0-9+/\-_]{6,}/)
          if (entMatch && !entityToLinkedIn.has(entMatch[0])) {
            entityToLinkedIn.set(entMatch[0], inUrl)
          }
        }

        const sizeAfter = entityToLinkedIn.size
        if (sizeAfter > sizeBefore) {
          console.log(`[sales-nav] API intercept: +${sizeAfter - sizeBefore} mappings (total: ${sizeAfter})`)
        }
      } catch { /* non-fatal */ }
    }
    page.on('response', apiHandler)

    try {
      // Strip sessionId — it's tied to the original browser session
      const url = new URL(search_url)
      url.searchParams.delete('sessionId')
      const cleanUrl = url.toString()

      // Step 1: Warm up session on LinkedIn feed so all session cookies are set.
      // LinkedIn's feed page never reaches networkidle (continuous XHR polling), so
      // we only wait for domcontentloaded + a short dwell. The 15s networkidle wait
      // was wasting time on every scrape job.
      // If the feed fails to load (proxy issue, timeout), we continue anyway —
      // the Sales Nav session may still be active from the persistent browser pool.
      console.log('[sales-nav] Warming up session on LinkedIn feed...')
      await job.updateProgress(6)
      try {
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
        // Short dwell — enough for session cookies to settle without the networkidle hang
        await SHORT_WAIT()
        await humanScroll(page)

        const feedUrl = page.url()
        if (feedUrl.includes('/login') || feedUrl.includes('/uas/login') || feedUrl.includes('/checkpoint')) {
          throw new Error('SESSION_EXPIRED: LinkedIn redirected to login. Please reconnect from the Accounts page.')
        }
        console.log(`[sales-nav] Feed loaded (${feedUrl.substring(0, 80)}), warming up Sales Nav session...`)
        // Persist fresh cookies immediately — LinkedIn rotates cookies on every page load.
        // If the job fails later, we still have the refreshed session in DB so the next
        // job (or keep-alive) doesn't start from stale cookies.
        await persistCookies(context, account_id).catch(() => null)
      } catch (feedErr) {
        const feedMsg = (feedErr as Error).message ?? ''
        if (feedMsg.includes('SESSION_EXPIRED')) throw feedErr
        // Network/timeout issues — log and continue, the pool session may still be valid
        console.warn(`[sales-nav] Feed warmup failed (continuing): ${feedMsg.substring(0, 120)}`)
      }
      await job.updateProgress(7)

      // Step 1b: Visit Sales Nav home to establish li_a session cookie
      await page.goto('https://www.linkedin.com/sales/home', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      // Don't wait for networkidle — Sales Nav home also has continuous background XHR
      await LONG_WAIT()
      await job.updateProgress(8)

      const salesHomeUrl = page.url()
      if (salesHomeUrl.includes('/sales/login')) {
        console.log('[sales-nav] On /sales/login — waiting for auto-redirect (up to 30s)…')
        try {
          await page.waitForURL((u: URL) => !u.toString().includes('/sales/login'), { timeout: 30_000 })
          console.log(`[sales-nav] Sales Nav home redirected to: ${page.url().substring(0, 120)}`)
        } catch {
          throw new Error('SESSION_EXPIRED: Stuck on Sales Navigator login page. Set Session again.')
        }
      }
      if (salesHomeUrl.includes('/login') || salesHomeUrl.includes('/uas/login') || salesHomeUrl.includes('/checkpoint')) {
        throw new Error('SESSION_EXPIRED: LinkedIn redirected to login. Please reconnect from the Accounts page.')
      }

      const salesHomeTitle = await page.title()
      console.log(`[sales-nav] Sales Nav home loaded (title=${salesHomeTitle}), navigating to search...`)
      await job.updateProgress(9)

      // Step 2: Navigate to Sales Navigator search URL.
      // Sales Nav is a React SPA — when already on /sales/*, page.goto() often throws
      // net::ERR_ABORTED because the SPA's client-side router intercepts the navigation
      // via pushState and aborts the HTTP request. The page still loads correctly.
      // We catch ERR_ABORTED and verify the URL/content afterwards.
      console.log(`[sales-nav] Navigating to: ${cleanUrl.substring(0, 120)}`)
      try {
        await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      } catch (navErr) {
        const navMsg = (navErr as Error).message ?? ''
        if (navMsg.includes('ERR_ABORTED')) {
          // SPA client-side routing — wait for URL to settle then check if we landed correctly
          console.log('[sales-nav] ERR_ABORTED (SPA routing) — waiting for URL to settle...')
          await page.waitForURL(
            (u: URL) => u.toString().includes('/sales/search') || u.toString().includes('/sales/login'),
            { timeout: 10_000 }
          ).catch(() => null)
          console.log(`[sales-nav] URL after SPA nav: ${page.url().substring(0, 120)}`)
        } else {
          throw navErr   // real error (timeout, proxy failure, etc.)
        }
      }
      await job.updateProgress(10)

      let currentUrl = page.url()
      if (currentUrl.includes('/sales/login')) {
        console.log('[sales-nav] On /sales/login after search nav — waiting for auto-redirect (up to 30s)…')
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

      await LONG_WAIT()   // land on search page — simulate reading before scrolling
      await job.updateProgress(12)

      const afterUrl = page.url()
      const pageTitle = await page.title()
      console.log(`[sales-nav] After nav: url=${afterUrl.substring(0, 120)} title=${pageTitle}`)

      // If title is still generic, wait for SPA to render search results.
      // Use a waitForSelector approach rather than blind sleep — fires as soon as
      // the first result card appears, which is much faster than a fixed 8s delay.
      if (pageTitle === 'Sales Navigator' || !pageTitle.includes('Search')) {
        console.log('[sales-nav] Generic title — waiting for result cards (up to 15s)...')
        await page.waitForSelector(
          '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name, [data-view-name="search-results-lead-result"]',
          { timeout: 15_000 }
        ).catch(() => null)
        const titleAfterWait = await page.title()
        console.log(`[sales-nav] Title after card wait: ${titleAfterWait}`)
      }

      await humanScroll(page)   // scroll through results like a human reading the page

      // Wait for results to appear (may already be present from above wait)
      console.log('[sales-nav] Waiting for result cards…')
      await page.waitForSelector(
        '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name, [data-view-name="search-results-lead-result"]',
        { timeout: 20_000 }
      ).catch(() => null)

      // Expand viewport to 1920x1080 so Sales Nav's virtual scroll renders more cards
      // at once. A small fingerprint viewport (e.g. 1366x768) only shows ~3 cards
      // and virtual scrolling may not trigger for the rest.
      await page.setViewportSize({ width: 1920, height: 1080 })
      await delay(800)  // brief settle after resize

      // Sales Nav uses virtual scrolling — cards are added/removed from the DOM
      // as you scroll. We must collect leads DURING the scroll, not after.
      // Scroll in steps, extract visible cards at each position, deduplicate by URL.

      type RawLead = {
        name: string; title: string | null; company: string | null
        location: string | null; profileUrl: string | null
        salesNavUrl: string | null; degree: number | null
      }

      function extractVisibleLeads(): Promise<RawLead[]> {
        return page.evaluate(() => {
          const results: Array<{
            name: string; title: string | null; company: string | null
            location: string | null; profileUrl: string | null
            salesNavUrl: string | null; degree: number | null
          }> = []

          // Sales Nav 2024/2025 uses data-view-name="search-results-lead-result" on each card.
          // Older versions used [data-anonymize="person-name"] or .result-lockup__name.
          // We anchor on the widest possible set and deduplicate by crawling up to the card root.
          const nameEls = Array.from(document.querySelectorAll<HTMLElement>(
            '[data-anonymize="person-name"], .result-lockup__name, [data-view-name="search-results-lead-result"] [data-anonymize="person-name"]'
          ))
          const itemSet = new Set<Element>()
          for (const el of nameEls) {
            // Walk up to the nearest card root: li, [data-view-name="search-results-lead-result"],
            // .result-lockup, or the artdeco card container
            const card =
              el.closest('[data-view-name="search-results-lead-result"]') ??
              el.closest('li.artdeco-list__item') ??
              el.closest('li') ??
              el.closest('.result-lockup') ??
              el.parentElement
            if (card) itemSet.add(card)
          }

          itemSet.forEach(item => {
            // Person name — try all known selectors in priority order
            const nameEl = item.querySelector(
              '[data-anonymize="person-name"] span:not(.visually-hidden), ' +
              '[data-anonymize="person-name"], ' +
              '.artdeco-entity-lockup__title span, ' +
              '.artdeco-entity-lockup__title, ' +
              '.result-lockup__name'
            )
            const name = nameEl?.textContent?.trim() ?? ''
            if (!name || name.length < 2) return

            // Title / headline
            const titleEl = item.querySelector(
              '[data-anonymize="title"], ' +
              '.artdeco-entity-lockup__subtitle span, ' +
              '.artdeco-entity-lockup__subtitle, ' +
              '.result-lockup__highlight-keyword'
            )
            const title = titleEl?.textContent?.trim() ?? null

            // Company
            const companyEl = item.querySelector(
              '[data-anonymize="company-name"], ' +
              '.artdeco-entity-lockup__caption span, ' +
              '.artdeco-entity-lockup__caption, ' +
              '.result-lockup__position-company'
            )
            const company = companyEl?.textContent?.trim() ?? null

            // Location
            const locationEl = item.querySelector(
              '[data-anonymize="location"], ' +
              '.artdeco-entity-lockup__metadata span, ' +
              '.artdeco-entity-lockup__metadata, ' +
              '.result-lockup__misc-list'
            )
            const location = locationEl?.textContent?.trim() ?? null

            // Sales Nav profile link — prefer /sales/lead/ or /sales/people/ over /in/
            const allLinks = Array.from(item.querySelectorAll<HTMLAnchorElement>('a[href]'))
            const salesLinkEl = allLinks.find(a =>
              a.href.includes('/sales/lead/') || a.href.includes('/sales/people/')
            ) ?? allLinks.find(a => a.href.includes('/in/')) ?? null
            const salesNavUrl = salesLinkEl ? (salesLinkEl.href.split('?')[0] || null) : null
            const inMatch = salesNavUrl?.match(/(https?:\/\/[^/]*\/in\/[^/?#]+)/)
            const profileUrl = inMatch ? inMatch[1] : null

            // Connection degree
            const degreeEl = item.querySelector('.dist-value, [data-anonymize="degree"]')
            const degreeText = degreeEl?.textContent?.trim() ?? ''
            const degree = degreeText.includes('1') ? 1 : degreeText.includes('2') ? 2 : degreeText.includes('3') ? 3 : null

            results.push({ name, title, company, location, profileUrl, salesNavUrl, degree })
          })
          return results
        })
      }

      // Collect all leads by scrolling incrementally through the page.
      // Sales Nav virtual scrolling renders cards only when they enter the viewport,
      // so we must pause long enough at each position for new cards to appear.
      const allRawLeads = new Map<string, RawLead>()  // keyed by salesNavUrl for dedup
      let scrollY = 0
      const SCROLL_STEP = 400   // px per step — larger = reach more of the page faster
      let noNewCount = 0

      for (let s = 0; s < 80 && noNewCount < 15; s++) {
        const batch = await extractVisibleLeads().catch(() => [] as RawLead[])
        const before = allRawLeads.size
        for (const r of batch) {
          const key = r.salesNavUrl ?? r.profileUrl ?? r.name
          if (key) allRawLeads.set(key, r)
        }
        if (allRawLeads.size === before) noNewCount++
        else noNewCount = 0

        console.log(`[sales-nav] Scroll step ${s + 1}: y=${scrollY} leads=${allRawLeads.size} noNew=${noNewCount}`)

        scrollY += SCROLL_STEP
        await page.evaluate(`window.scrollTo(0, ${scrollY})`)
        await delay(1200 + Math.random() * 600)  // longer dwell for virtual scroll to render
      }

      const cardCount = allRawLeads.size
      console.log(`[sales-nav] Found ${cardCount} result cards on page`)

      await SHORT_WAIT()
      await job.updateProgress(15)

      const leads: ScrapedLead[] = []
      const seenUrls = new Set<string>()  // within-batch dedup to handle Sales Nav pagination wraparound
      let pageNum = 0
      let consecutiveEmptyPages = 0

      while (leads.length < max_leads) {
        // For the first page use pre-collected leads; for subsequent pages scroll-collect fresh
        let pageLeads: RawLead[]
        if (pageNum === 0) {
          pageLeads = Array.from(allRawLeads.values())
        } else {
          // Scroll-collect for subsequent pages too (virtual scrolling)
          const pageRaw = new Map<string, RawLead>()
          let pgScrollY = 0
          let pgNoNew = 0
          for (let s = 0; s < 80 && pgNoNew < 15; s++) {
            const batch = await extractVisibleLeads().catch(() => [] as RawLead[])
            const before = pageRaw.size
            for (const r of batch) {
              const key = r.salesNavUrl ?? r.profileUrl ?? r.name
              if (key) pageRaw.set(key, r)
            }
            if (pageRaw.size === before) pgNoNew++
            else pgNoNew = 0
            pgScrollY += SCROLL_STEP
            await page.evaluate(`window.scrollTo(0, ${pgScrollY})`)
            await delay(1200 + Math.random() * 600)
          }
          pageLeads = Array.from(pageRaw.values())
        }

        let newOnPage = 0
        for (const raw of pageLeads) {
          if (leads.length >= max_leads) break

          const parts = raw.name.split(' ')
          const firstName = parts[0] ?? raw.name
          const lastName = parts.slice(1).join(' ')
          const salesNavUrl = raw.salesNavUrl ?? ''
          if (!salesNavUrl && !raw.profileUrl) continue

          // Look up the real /in/ URL from the API intercept map using entity ID
          let linkedinUrl = raw.profileUrl ?? salesNavUrl
          if (salesNavUrl.includes('/sales/lead/') || salesNavUrl.includes('/sales/people/')) {
            const entityId = salesNavUrl.split('/lead/')[1]?.split(',')[0]
              ?? salesNavUrl.split('/people/')[1]?.split(',')[0]
            if (entityId && entityToLinkedIn.has(entityId)) {
              linkedinUrl = entityToLinkedIn.get(entityId)!
            } else if (entityId) {
              // Log misses so we can debug entity ID format
              console.log(`[sales-nav] No /in/ mapping for entity=${entityId?.substring(0, 20)}... (map size=${entityToLinkedIn.size})`)
            }
          }

          // Deduplicate within this scrape batch — Sales Nav wraps around when results are exhausted
          const dedupeKey = linkedinUrl.includes('/in/') ? linkedinUrl : `${firstName}_${lastName}`.toLowerCase()
          if (seenUrls.has(dedupeKey)) continue
          seenUrls.add(dedupeKey)
          newOnPage++

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

        console.log(`[sales-nav] Page ${pageNum + 1}: ${pageLeads.length} items (${newOnPage} new), total: ${leads.length}`)
        await job.updateProgress(Math.min(85, 15 + Math.round((leads.length / max_leads) * 70)))
        if (await isCancelled(job.id!)) { console.log('[sales-nav] Job cancelled by user'); break }

        // Stop if this page had no new unique results — pagination wraparound detected
        if (newOnPage === 0) {
          consecutiveEmptyPages++
          if (consecutiveEmptyPages >= 2) {
            console.log('[sales-nav] Two consecutive pages with no new leads — end of unique results')
            break
          }
        } else {
          consecutiveEmptyPages = 0
        }

        if (leads.length >= max_leads) break

        // Sales Nav 2024/2025 pagination — try multiple selector patterns
        const nextBtn = await page.$(
          'button[aria-label="Next"], ' +
          'button[aria-label="Next page"], ' +
          '.artdeco-pagination__button--next:not([disabled]), ' +
          '.search-results__pagination button:last-child:not([disabled]), ' +
          'li.artdeco-pagination__indicator--number.selected + li button, ' +
          '[data-test-pagination-page-btn="next"]:not([disabled]), ' +
          'button.artdeco-button[data-anonymize="pagination-btn-next"]'
        )

        if (!nextBtn) {
          // Log all pagination-related buttons to diagnose selector mismatch
          const paginationInfo = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'))
            const pageRelated = btns.filter(b =>
              (b.ariaLabel ?? '').toLowerCase().includes('page') ||
              (b.ariaLabel ?? '').toLowerCase().includes('next') ||
              (b.className ?? '').includes('pagination')
            )
            return pageRelated.map(b => `"${b.ariaLabel}" class="${b.className?.substring(0, 40)}"`)
          }).catch(() => [])
          console.log('[sales-nav] No next button. Pagination candidates:', JSON.stringify(paginationInfo))
          break
        }

        // Scroll through the current page results before moving on — simulate reading
        await humanScroll(page)
        await SHORT_WAIT()

        // Scroll the next button into view, move mouse to it, then click
        await nextBtn.evaluate((el: Element) => {
          el.scrollIntoView({ block: 'center' })
        })
        await delay(400 + Math.random() * 600)
        await humanMouseMove(page)
        await nextBtn.evaluate((el: Element) => (el as HTMLElement).click())

        // Dwell on the new page — simulate the human arriving and reading results
        await page.waitForLoadState('domcontentloaded').catch(() => null)
        await LONG_WAIT()
        await page.waitForSelector(
          '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name',
          { timeout: 20_000 }
        ).catch(() => null)
        await humanScroll(page)

        pageNum++
      }

      console.log(`[sales-nav] Scraped ${leads.length} leads via browser`)
      console.log(`[sales-nav] API intercept captured ${entityToLinkedIn.size} /in/ URL mappings`)

      const stillSalesNav = leads.filter(l => l.linkedin_url.includes('/sales/')).length
      if (stillSalesNav > 0) {
        console.log(`[sales-nav] ${stillSalesNav} leads still have Sales Nav URLs — API intercept may not have covered them`)
      }

      await job.updateProgress(88)

      const { scraped, saved, savedLeads } = await saveLeads(leads, user_id, list_id, job, source_type ?? 'sales_nav')

      // Enrich profiles — visit each lead's LinkedIn profile to pull About,
      // experience description, skills, and recent posts. During enrichment,
      // the salesApiProfiles API fires which captures the real /in/ URL.
      if (savedLeads.length > 0) {
        console.log(`[sales-nav] Enriching ${savedLeads.length} profiles...`)
        await enrichLeads(page, savedLeads, user_id)

        // After enrichment, salesApiProfiles API calls have now populated
        // entityToLinkedIn with full profile IDs. Update any leads still
        // using Sales Nav URLs with the resolved /in/ URLs.
        const stillSalesNav = savedLeads.filter(l =>
          l.linkedin_url.includes('/sales/lead/') || l.linkedin_url.includes('/sales/people/')
        )
        if (stillSalesNav.length > 0 && entityToLinkedIn.size > 0) {
          console.log(`[sales-nav] Post-enrichment: resolving ${stillSalesNav.length} remaining Sales Nav URLs...`)
          for (const lead of stillSalesNav) {
            const entityId = lead.linkedin_url.split('/lead/')[1]?.split(',')[0]
              ?? lead.linkedin_url.split('/people/')[1]?.split(',')[0]
            if (!entityId) continue
            const inUrl = entityToLinkedIn.get(entityId)
              ?? [...entityToLinkedIn.entries()].find(([k]) => k.startsWith(entityId) || entityId.startsWith(k))?.[1]
            if (inUrl) {
              const { error } = await supabase.from('leads').update({ linkedin_url: inUrl }).eq('id', lead.id)
              if (!error) console.log(`[sales-nav] ✓ Fixed URL: ${lead.first_name} ${lead.last_name} → ${inUrl}`)
            } else {
              console.log(`[sales-nav] ✗ Still no /in/ URL for ${lead.first_name} ${lead.last_name} (entity=${entityId?.substring(0, 20)}...)`)
            }
          }
        }
      }

      await persistCookies(context, account_id)
      return { scraped, saved }
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('SESSION_EXPIRED') || msg.includes('session') || msg.includes('login')) {
        try { await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account_id) } catch {}
        // Only invalidate pool session — BrightData sessions are per-job, not pooled
        if (!brightDataBrowser) invalidateBrowserSession(account_id)
      }
      throw err
    } finally {
      page.off('response', apiHandler)
      if (brightDataBrowser) {
        // BrightData sessions are ephemeral — close after each job
        try { await persistCookies(context, account_id) } catch { /* non-fatal */ }
        await brightDataBrowser.close().catch(() => {})
        console.log('[sales-nav] BrightData browser closed')
      } else {
        // Pool session: always save cookies on the way out, even on failure.
        // The browser collected fresh LinkedIn cookies during the job (feed load,
        // Sales Nav home, etc.) — persisting them means the next job starts with
        // a valid session instead of stale DB cookies.
        await persistCookies(context, account_id).catch(() => null)
      }
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

// Map job source_type to the leads table source enum value
function resolveSourceField(sourceType: string | undefined): string {
  switch (sourceType) {
    case 'sales_nav':       return 'sales_nav_import'
    case 'linkedin_search': return 'linkedin_search'
    case 'post_reactors':   return 'post_reactors'
    case 'event_attendees': return 'event_attendees'
    default:                return 'sales_nav_import'
  }
}

async function saveLeads(
  leads: ScrapedLead[],
  user_id: string,
  list_id: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  job: any,
  source_type?: string
): Promise<{ scraped: number; saved: number; savedLeads: LeadToEnrich[] }> {
  let savedLeads: LeadToEnrich[] = []
  const sourceField = resolveSourceField(source_type)

  // Normalize a LinkedIn URL: strip query string and Sales Nav comma-separated suffixes
  // e.g. "…/lead/ACwAAA,NAME_SEARCH,ar0N?_ntb=x" → "…/lead/ACwAAA"
  function normalizeUrl(url: string): string {
    return url.split('?')[0].split(',')[0].replace(/\/+$/, '')
  }

  // Normalize all incoming lead URLs before any DB work
  for (const lead of leads) {
    lead.linkedin_url = normalizeUrl(lead.linkedin_url)
  }

  // Deduplicate within the batch itself (keep first occurrence)
  const seenUrls = new Set<string>()
  const dedupedLeads = leads.filter(l => {
    if (seenUrls.has(l.linkedin_url)) return false
    seenUrls.add(l.linkedin_url)
    return true
  })

  // Clear existing leads in this list before adding fresh ones — ensures
  // each scrape cycle gives a clean result rather than appending duplicates.
  if (list_id) {
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('list_id', list_id)
      .eq('user_id', user_id)
    if (existing && existing.length > 0) {
      await supabase.from('leads').delete().in('id', existing.map((e: { id: string }) => e.id))
      console.log(`[sales-nav] Cleared ${existing.length} existing leads from list before re-import`)
    }
  }

  if (dedupedLeads.length > 0) {
    const allUrls = dedupedLeads.map(l => l.linkedin_url)

    // Check which leads already exist for this user (cross-list deduplication)
    const { data: alreadyExisting } = await supabase
      .from('leads')
      .select('id, linkedin_url, first_name, last_name')
      .eq('user_id', user_id)
      .in('linkedin_url', allUrls)

    const existingByUrl = new Map(
      (alreadyExisting ?? []).map((e: { id: string; linkedin_url: string }) => [e.linkedin_url, e])
    )

    const toUpdate = dedupedLeads.filter(l => existingByUrl.has(l.linkedin_url))
    const toInsert = dedupedLeads.filter(l => !existingByUrl.has(l.linkedin_url))

    console.log(`[sales-nav] ${toUpdate.length} existing leads will be overwritten, ${toInsert.length} new leads to insert`)

    // Update (overwrite) existing leads with fresh scraped data
    for (const lead of toUpdate) {
      const existing = existingByUrl.get(lead.linkedin_url)!
      const { data: updated } = await supabase
        .from('leads')
        .update({
          first_name: lead.first_name,
          last_name: lead.last_name,
          title: lead.title,
          company: lead.company,
          location: lead.location,
          source: sourceField,
          raw_data: { source: sourceField },
          ...(list_id ? { list_id } : {}),
        })
        .eq('id', (existing as { id: string }).id)
        .select('id, linkedin_url, first_name, last_name')
        .single()
      if (updated) savedLeads.push(updated as LeadToEnrich)
    }

    // Insert brand-new leads
    if (toInsert.length > 0) {
      const rows = toInsert.map(l => ({
        ...l,
        user_id,
        source: sourceField,
        raw_data: { source: sourceField },
        ...(list_id ? { list_id } : {}),
      }))

      const { data: inserted, error: insertErr } = await supabase
        .from('leads')
        .insert(rows)
        .select('id, linkedin_url, first_name, last_name')
      if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`)

      savedLeads = [...savedLeads, ...(inserted ?? []) as LeadToEnrich[]]
    }

    // Qualification is triggered on-demand when the user opens the lead list,
    // not here — so we don't score leads nobody has looked at yet.
  }

  await job.updateProgress(100)
  return { scraped: dedupedLeads.length, saved: savedLeads.length, savedLeads }
}

salesNavScraperWorker.on('failed', (job, err) => {
  console.error(`[sales-nav] Job ${job?.id} failed: ${err.message}`)
  if (err.stack) console.error(`[sales-nav] Stack: ${err.stack.split('\n').slice(0, 5).join(' | ')}`)
})

salesNavScraperWorker.on('active', (job) => {
  console.log(`[sales-nav] Job ${job.id} started (url=${String(job.data?.search_url ?? '').substring(0, 80)})`)
})

console.log('Sales Nav scraper worker started')
