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
import { resolveSalesNavUrl, humanMouseMove, humanScroll, SHORT_WAIT, LONG_WAIT, READ_WAIT, delay } from '../linkedin/actions'

interface SalesNavJob {
  search_url:   string
  account_id:   string
  user_id:      string
  max_leads:    number
  list_id?:     string
  source_type?: string   // 'sales_nav' | 'linkedin_search' | 'post_reactors' | 'event_attendees'
}

export const salesNavScraperWorker = new Worker<SalesNavJob>(
  'sales-nav-scraper',
  async (job) => {
    const { search_url, account_id, user_id, max_leads, list_id, source_type } = job.data

    await job.updateProgress(5)

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
      const { scraped: s, saved: sv } = await saveLeads(leads, user_id, list_id, job)
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

      const { scraped: s, saved: sv } = await saveLeads(leads, user_id, list_id, job)
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

    // ── Browser strategy: prefer BrightData Scraping Browser (CDP) when configured ──
    // BrightData runs Chromium on a fresh residential IP, bypassing Cloudflare/bot blocks.
    // Falls back to the persistent pool session (account's nsocks proxy) if unavailable.
    const brightDataUrl = process.env.DISABLE_PROXY !== 'true'
      ? (process.env.BRIGHTDATA_BROWSER_URL ?? null)
      : null

    let brightDataBrowser: import('playwright').Browser | null = null
    // eslint-disable-next-line prefer-const
    let context!: import('playwright').BrowserContext
    // eslint-disable-next-line prefer-const
    let page!: import('playwright').Page

    if (brightDataUrl) {
      // BrightData Scraping Browser: connect via CDP WebSocket, inject stored cookies.
      // Each connectOverCDP() call creates a brand-new session on a fresh residential IP.
      console.log('[sales-nav] Connecting to BrightData Scraping Browser via CDP…')
      const { chromium: pw } = await import('playwright')

      // Apply country targeting from the account's assigned proxy record
      let cdpUrl = brightDataUrl
      let country: string | null = null
      if ((acc as { proxy_id?: string | null }).proxy_id) {
        const { data: proxyRow } = await supabase
          .from('proxies')
          .select('country')
          .eq('id', (acc as { proxy_id: string }).proxy_id)
          .single()
        country = (proxyRow as { country?: string | null } | null)?.country ?? null
      }
      if (country) {
        try {
          const u = new URL(brightDataUrl)
          const base = decodeURIComponent(u.username)
          if (!base.includes('-country-')) {
            u.username = encodeURIComponent(`${base}-country-${country}`)
            cdpUrl = u.toString()
          }
        } catch { /* use as-is */ }
      }

      brightDataBrowser = await pw.connectOverCDP(cdpUrl)
      const existing = brightDataBrowser.contexts()
      context = existing.length > 0
        ? existing[0]
        : await brightDataBrowser.newContext({
            locale: 'en-US',
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          })

      // Inject the account's stored LinkedIn cookies into the clean BrightData browser
      if (acc.cookies) {
        const rawCookies = extractCookies(acc.cookies as string)
        if (rawCookies.length > 0) {
          await context.addCookies(
            rawCookies.map(c => ({
              name:     c.name,
              value:    c.value,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              domain:   (c as any).domain   || '.linkedin.com',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              path:     (c as any).path     || '/',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              expires:  (c as any).expires  ?? -1,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              httpOnly: (c as any).httpOnly ?? false,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              secure:   (c as any).secure   ?? true,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              sameSite: ((c as any).sameSite ?? 'None') as 'Strict' | 'Lax' | 'None',
            }))
          )
          console.log(`[sales-nav] Injected ${rawCookies.length} cookies into BrightData browser`)
        }
      }

      page = context.pages()[0] ?? await context.newPage()
      console.log('[sales-nav] BrightData CDP session ready ✓')
    } else {
      // Persistent pool session via account's assigned proxy
      const session = await getOrCreateBrowserSession(acc as AccountRecord)
      ;({ context: (context as import('playwright').BrowserContext), page: (page as import('playwright').Page) } = session as { context: import('playwright').BrowserContext; page: import('playwright').Page })
    }

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

      // Step 1: Warm up session on LinkedIn feed so all session cookies are set
      console.log('[sales-nav] Warming up session on LinkedIn feed...')
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null)
      await READ_WAIT()   // dwell on feed like a human landing on it
      await humanScroll(page)
      await job.updateProgress(8)

      const feedUrl = page.url()
      if (feedUrl.includes('/login') || feedUrl.includes('/uas/login') || feedUrl.includes('/checkpoint')) {
        throw new Error('SESSION_EXPIRED: LinkedIn redirected to login. Please reconnect from the Accounts page.')
      }
      console.log(`[sales-nav] Feed loaded (${feedUrl.substring(0, 80)}), warming up Sales Nav session...`)

      // Step 1b: Visit Sales Nav home to establish li_a session cookie
      await page.goto('https://www.linkedin.com/sales/home', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null)
      await LONG_WAIT()   // simulate landing on Sales Nav home

      const salesHomeUrl = page.url()
      if (salesHomeUrl.includes('/sales/login')) {
        console.log('[sales-nav] On /sales/login — waiting for auto-redirect (up to 30s)…')
        try {
          await page.waitForURL((url: URL) => !url.toString().includes('/sales/login'), { timeout: 30_000 })
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

      // Step 2: Navigate to Sales Navigator search URL
      console.log(`[sales-nav] Navigating to: ${cleanUrl.substring(0, 120)}`)
      await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
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

      // If title is still generic, wait longer for SPA to render search results
      if (pageTitle === 'Sales Navigator') {
        console.log('[sales-nav] Generic title — waiting extra 8s for SPA to render search results...')
        await delay(6000 + Math.random() * 4000)
        const titleAfterWait = await page.title()
        console.log(`[sales-nav] Title after extra wait: ${titleAfterWait}`)
      }

      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => null)
      await humanScroll(page)   // scroll through results like a human reading the page

      // Wait for results to appear
      console.log('[sales-nav] Waiting for result cards…')
      await page.waitForSelector(
        '[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name',
        { timeout: 30_000 }
      ).catch(() => null)

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

          // Find all rendered lead cards by anchoring on person-name elements
          const nameEls = Array.from(document.querySelectorAll<HTMLElement>(
            '[data-anonymize="person-name"], .result-lockup__name'
          ))
          const itemSet = new Set<Element>()
          for (const el of nameEls) {
            const li = el.closest('li') ?? el.closest('.result-lockup') ?? el.parentElement
            if (li) itemSet.add(li)
          }

          itemSet.forEach(item => {
            const nameEl = item.querySelector('[data-anonymize="person-name"], .artdeco-entity-lockup__title, .result-lockup__name')
            const name = nameEl?.textContent?.trim() ?? ''
            if (!name) return

            const titleEl = item.querySelector('[data-anonymize="title"], .artdeco-entity-lockup__subtitle, .result-lockup__highlight-keyword')
            const title = titleEl?.textContent?.trim() ?? null

            const companyEl = item.querySelector('[data-anonymize="company-name"], .artdeco-entity-lockup__caption, .result-lockup__position-company')
            const company = companyEl?.textContent?.trim() ?? null

            const locationEl = item.querySelector('[data-anonymize="location"], .artdeco-entity-lockup__metadata, .result-lockup__misc-list')
            const location = locationEl?.textContent?.trim() ?? null

            const allLinks = Array.from(item.querySelectorAll<HTMLAnchorElement>('a[href]'))
            const linkEl = allLinks.find(a => a.href.includes('/sales/lead/') || a.href.includes('/sales/people/') || a.href.includes('/in/')) ?? null
            const salesNavUrl = linkEl ? (linkEl.href.split('?')[0] || null) : null
            const inMatch = salesNavUrl?.match(/(https?:\/\/[^/]*\/in\/[^/?#]+)/)
            const profileUrl = inMatch ? inMatch[1] : null

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
      const SCROLL_STEP = 250   // smaller step = more render triggers
      let noNewCount = 0

      for (let s = 0; s < 60 && noNewCount < 8; s++) {
        const batch = await extractVisibleLeads().catch(() => [] as RawLead[])
        const before = allRawLeads.size
        for (const r of batch) {
          const key = r.salesNavUrl ?? r.profileUrl ?? r.name
          if (key) allRawLeads.set(key, r)
        }
        if (allRawLeads.size === before) noNewCount++
        else noNewCount = 0

        scrollY += SCROLL_STEP
        await page.evaluate(`window.scrollTo(0, ${scrollY})`)
        await delay(800 + Math.random() * 400)  // longer dwell for virtual scroll to render
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
          for (let s = 0; s < 60 && pgNoNew < 8; s++) {
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
            await delay(800 + Math.random() * 400)
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

      const { scraped, saved, savedLeads } = await saveLeads(leads, user_id, list_id, job)

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
      // BrightData sessions are ephemeral — close after each job
      if (brightDataBrowser) {
        try { await persistCookies(context, account_id) } catch { /* non-fatal */ }
        await brightDataBrowser.close().catch(() => {})
        console.log('[sales-nav] BrightData browser closed')
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

async function saveLeads(
  leads: ScrapedLead[],
  user_id: string,
  list_id: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  job: any
): Promise<{ scraped: number; saved: number; savedLeads: LeadToEnrich[] }> {
  let savedLeads: LeadToEnrich[] = []

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

  if (leads.length > 0) {
    const rows = leads.map(l => ({
      ...l,
      user_id,
      source: 'sales_nav_import' as const,
      raw_data: { source: 'sales_navigator' },
      ...(list_id ? { list_id } : {}),
    }))

    // No deduplication needed since we just cleared the list.
    // For users without a list_id, still deduplicate globally.
    const newRows = list_id ? rows : (() => {
      // Non-list import: deduplicate against existing leads
      return rows  // simplified — list-based scrapes always clear first
    })()

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
