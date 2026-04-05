/**
 * Sales Navigator lead scraper.
 *
 * Strategy: intercept the XHR response that LinkedIn's SPA fires when loading
 * search results (salesApiLeadSearch). This gives us clean JSON instead of
 * trying to parse a React-rendered DOM that may be blank in headless mode.
 *
 * Falls back to DOM scraping if no API response is captured.
 */

import type { Page } from 'playwright'
import { safeNavigate, detectAndHandleChallenge } from './session'

export interface ScrapedLead {
  first_name:        string
  last_name:         string
  title:             string | null
  company:           string | null
  location:          string | null
  linkedin_url:      string
  connection_degree: number | null
}

const DELAY = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── API interception approach ────────────────────────────────────────────────

interface SalesNavApiLead {
  fullName?:       string
  leadName?:       { text?: string }
  titleText?:      string
  title?:          { text?: string }
  companyName?:    string
  company?:        { name?: string }
  geoRegion?:      string
  location?:       { text?: string }
  memberBadges?:   { degree?: number }
  degree?:         number
  publicProfileUrl?: string
  profileUrl?:     string
  entityUrn?:      string
  objectUrn?:      string
  profileUrn?:     string
}

interface SalesNavApiResponse {
  elements?:  SalesNavApiLead[]
  results?:   SalesNavApiLead[]
  paging?:    { total: number; start: number; count: number }
  total?:     number
}

function parseApiLeads(data: SalesNavApiResponse, searchUrl: string): ScrapedLead[] {
  const items = data.elements ?? data.results ?? []
  const leads: ScrapedLead[] = []

  for (const item of items) {
    const fullName = (
      item.fullName ??
      item.leadName?.text ??
      ''
    ).trim()

    if (!fullName) continue

    const parts     = fullName.split(' ')
    const first_name = parts[0] ?? ''
    const last_name  = parts.slice(1).join(' ') || ''

    const title   = item.titleText ?? item.title?.text ?? null
    const company = item.companyName ?? item.company?.name ?? null
    const location = item.geoRegion ?? item.location?.text ?? null

    const degree = item.degree ?? item.memberBadges?.degree ?? null

    // Resolve LinkedIn profile URL
    let linkedin_url = item.publicProfileUrl ?? item.profileUrl ?? ''
    if (!linkedin_url) {
      // Fall back to the Sales Nav entity URN (worker can handle later)
      const urn = item.entityUrn ?? item.objectUrn ?? item.profileUrn ?? ''
      const memberId = urn.split(':').pop()
      linkedin_url = memberId
        ? `https://www.linkedin.com/sales/lead/${memberId},/`
        : searchUrl
    }

    leads.push({ first_name, last_name, title, company, location, linkedin_url, connection_degree: degree })
  }

  return leads
}

// ─── DOM scraping fallback ───────────────────────────────────────────────────

async function scrapePageDom(page: Page): Promise<{
  salesNavUrls: string[]
  partials: Partial<ScrapedLead>[]
}> {
  try {
    await page.waitForSelector(
      'a[href*="/sales/lead/"], [data-anonymize="person-name"], ol li',
      { timeout: 20_000 }
    )
  } catch { /* nothing found */ }
  await DELAY(2000)

  let items = await page.$$('li.artdeco-list__item')
  if (items.length === 0) items = await page.$$('ol li')
  if (items.length === 0) items = await page.$$('li[class*="result"]')

  const salesNavUrls: string[] = []
  const partials: Partial<ScrapedLead>[] = []

  for (const item of items) {
    const nameEl  = await item.$('[data-anonymize="person-name"]')
    const titleEl = await item.$('[data-anonymize="title"]')
    const coEl    = await item.$('[data-anonymize="company-name"]')
    const locEl   = await item.$('[data-anonymize="location"]')
    const degEl   = await item.$('.dist-value')

    const fullName = nameEl ? (await nameEl.innerText()).trim() : ''
    if (!fullName) continue

    const nameParts  = fullName.split(' ')
    const first_name = nameParts[0] ?? ''
    const last_name  = nameParts.slice(1).join(' ') || ''

    const href = nameEl ? await nameEl.getAttribute('href') : null
    if (!href) continue

    const salesNavUrl = href.startsWith('http') ? href : `https://www.linkedin.com${href}`
    salesNavUrls.push(salesNavUrl)

    const degText = degEl ? (await degEl.innerText()).trim() : ''
    const degree  = degText === '1st' ? 1 : degText === '2nd' ? 2 : degText === '3rd' ? 3 : null

    partials.push({
      first_name,
      last_name,
      title:             titleEl ? (await titleEl.innerText()).trim() || null : null,
      company:           coEl    ? (await coEl.innerText()).trim()    || null : null,
      location:          locEl   ? (await locEl.innerText()).trim()   || null : null,
      connection_degree: degree,
    })
  }

  return { salesNavUrls, partials }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function scrapeSalesNavSearch(
  page: Page,
  searchUrl: string,
  accountId: string,
  maxLeads: number,
  onProgress?: (scraped: number) => void
): Promise<ScrapedLead[]> {
  const url = new URL(searchUrl)
  if (!url.pathname.startsWith('/sales/search/people')) {
    throw new Error('URL must be a Sales Navigator people search URL (/sales/search/people?...)')
  }

  // Collect all intercepted API responses keyed by page number
  const interceptedPages = new Map<number, SalesNavApiResponse>()
  let totalFromApi = 0

  page.on('response', async (response) => {
    try {
      const rUrl = response.url()
      if (!rUrl.includes('salesApiLeadSearch') && !rUrl.includes('salesApiSearch')) return
      if (response.status() !== 200) return

      const json = await response.json() as SalesNavApiResponse
      const start = Number(new URL(rUrl).searchParams.get('start') ?? '0')
      const pageNum = Math.floor(start / 25)
      interceptedPages.set(pageNum, json)
      if (json.paging?.total) totalFromApi = json.paging.total
      console.log(`[sales-nav] API intercepted page ${pageNum}: ${(json.elements ?? json.results ?? []).length} leads`)
    } catch { /* not JSON or irrelevant */ }
  })

  // Warm up: visit sales home first (via safeNavigate so proxy/challenge errors surface clearly)
  console.log('[sales-nav] Warming up Sales Navigator home…')
  await safeNavigate(page, 'https://www.linkedin.com/sales/home', accountId)

  if (page.url().includes('/sales/contract-chooser')) {
    try {
      const btn = await page.waitForSelector('button, a[href*="/sales/"]', { timeout: 8_000 })
      if (btn) await btn.click()
      await page.waitForURL(u => !u.toString().includes('/sales/contract-chooser'), { timeout: 15_000 })
    } catch { /* proceed */ }
  }

  try { await page.waitForLoadState('networkidle', { timeout: 15_000 }) } catch { /* ok */ }
  await DELAY(2000)

  // Navigate to the search URL — this triggers the API call
  console.log('[sales-nav] Navigating to search URL…')
  await safeNavigate(page, searchUrl, accountId)

  if (page.url().includes('/sales/contract-chooser')) {
    try {
      await page.waitForURL(u => !u.toString().includes('/sales/contract-chooser'), { timeout: 20_000 })
    } catch { /* proceed */ }
  }

  // Wait for either API response or DOM results (up to 45s)
  console.log('[sales-nav] Waiting for results…')
  try {
    await page.waitForFunction(
      () => {
        const hasApiData = (window as unknown as { __lrApiCaptured?: boolean }).__lrApiCaptured
        const hasDom = document.querySelectorAll('[data-anonymize="person-name"]').length > 0 ||
                       document.querySelectorAll('a[href*="/sales/lead/"]').length > 0
        return hasApiData || hasDom
      },
      { timeout: 45_000, polling: 1000 }
    )
  } catch { /* timed out — will check what we have */ }

  // Give a moment for any in-flight API responses to be processed
  await DELAY(2000)

  const landedUrl = page.url()
  const pageTitle = await page.title()
  console.log(`[sales-nav] Landed: ${landedUrl} | Title: ${pageTitle}`)
  console.log(`[sales-nav] Intercepted API pages: ${interceptedPages.size}`)

  // ── Use API data if captured ───────────────────────────────────────────────
  if (interceptedPages.size > 0) {
    console.log('[sales-nav] Using intercepted API data')
    const leads: ScrapedLead[] = []
    let pageNum = 0

    while (leads.length < maxLeads) {
      const apiData = interceptedPages.get(pageNum)

      if (!apiData) {
        // Need to paginate — click next or navigate to next page URL
        if (pageNum === 0) break // First page already loaded, no data = end

        const nextUrl = new URL(searchUrl)
        nextUrl.searchParams.set('page', String(pageNum + 1))
        await safeNavigate(page, nextUrl.toString(), accountId)
        try { await page.waitForLoadState('networkidle', { timeout: 20_000 }) } catch { /* ok */ }
        await DELAY(3000)

        // Check if the API response for this page was captured
        const newData = interceptedPages.get(pageNum)
        if (!newData) break
      }

      const pageData = interceptedPages.get(pageNum)!
      const pageLeads = parseApiLeads(pageData, searchUrl)
      console.log(`[sales-nav] Page ${pageNum}: ${pageLeads.length} leads parsed`)

      for (const lead of pageLeads) {
        if (leads.length >= maxLeads) break
        leads.push(lead)
        onProgress?.(leads.length)
      }

      if (pageLeads.length === 0) break

      pageNum++

      // Navigate to next page
      if (leads.length < maxLeads) {
        const nextBtn = await page.$('button[aria-label="Next"]')
        if (!nextBtn) break
        const disabled = await nextBtn.getAttribute('disabled')
        if (disabled !== null) break

        await nextBtn.click()
        await DELAY(2500 + Math.random() * 1000)
        await detectAndHandleChallenge(page, accountId)

        // Wait for next page API response
        const prevSize = interceptedPages.size
        for (let i = 0; i < 15; i++) {
          if (interceptedPages.size > prevSize) break
          await DELAY(1000)
        }
      }

      if (pageNum > 100) break
    }

    console.log(`[sales-nav] Total via API: ${leads.length}`)
    return leads
  }

  // ── Fall back to DOM scraping ──────────────────────────────────────────────
  console.log('[sales-nav] API not captured — falling back to DOM scraping')

  // Log what's on the page to help diagnose
  try {
    const domInfo = await page.evaluate(() => ({
      nameAnon: document.querySelectorAll('[data-anonymize="person-name"]').length,
      leadLinks: document.querySelectorAll('a[href*="/sales/lead/"]').length,
      olLis: document.querySelectorAll('ol li').length,
      artdeco: document.querySelectorAll('li.artdeco-list__item').length,
      bodyLen: document.body?.innerHTML?.length ?? 0,
    }))
    console.log(`[sales-nav] DOM state: ${JSON.stringify(domInfo)}`)
    if (domInfo.bodyLen < 5000) {
      console.log('[sales-nav] WARNING: Page body is very short — likely bot-detected or not logged in')
    }
  } catch { /* ok */ }

  const leads: ScrapedLead[] = []
  let page_num = 1

  while (leads.length < maxLeads) {
    const { salesNavUrls, partials } = await scrapePageDom(page)
    console.log(`[sales-nav] DOM scrape page ${page_num}: ${salesNavUrls.length} items`)

    if (salesNavUrls.length === 0) break

    for (let i = 0; i < salesNavUrls.length && leads.length < maxLeads; i++) {
      const partial = partials[i]
      if (!partial?.first_name) continue

      leads.push({
        first_name:        partial.first_name!,
        last_name:         partial.last_name ?? '',
        title:             partial.title ?? null,
        company:           partial.company ?? null,
        location:          partial.location ?? null,
        linkedin_url:      salesNavUrls[i],
        connection_degree: partial.connection_degree ?? null,
      })

      onProgress?.(leads.length)
    }

    if (leads.length >= maxLeads) break

    const nextBtn = await page.$('button[aria-label="Next"]')
    if (!nextBtn) break
    const disabled = await nextBtn.getAttribute('disabled')
    if (disabled !== null) break

    page_num++
    await nextBtn.click()
    await DELAY(2000 + Math.random() * 1000)
    await detectAndHandleChallenge(page, accountId)

    try {
      await page.waitForSelector(
        'a[href*="/sales/lead/"], [data-anonymize="person-name"]',
        { timeout: 20_000 }
      )
    } catch { /* ok */ }

    if (page_num > 100) break
  }

  return leads
}
