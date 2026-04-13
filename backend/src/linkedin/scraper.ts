/**
 * LinkedIn & Sales Navigator Scraper
 *
 * Uses BrightData Scraping Browser (CDP WebSocket) with account cookies loaded
 * from Supabase for authenticated scraping.
 *
 * Exports:
 *   scrapeLinkedInProfile   — single profile page
 *   scrapeLinkedInSearch    — LinkedIn people search (paginated)
 *   scrapeSalesNavSearch    — Sales Navigator search (paginated, API + DOM fallback)
 */

import type { Browser, BrowserContext, Page } from 'playwright'
import { supabase } from '../lib/supabase'

const DELAY = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinkedInProfile {
  name:              string
  headline:          string | null
  location:          string | null
  about:             string | null
  experience:        ExperienceEntry[]
  education:         EducationEntry[]
  skills:            string[]
  connectionDegree:  number | null
  profilePicUrl:     string | null
  publicProfileUrl:  string
  linkedinId:        string | null
}

export interface ExperienceEntry {
  title:    string
  company:  string
  duration: string | null
}

export interface EducationEntry {
  school:   string
  degree:   string | null
  years:    string | null
}

export interface SearchFilters {
  location?:   string
  industry?:   string
  company?:    string
  title?:      string
  connection?: '1st' | '2nd' | '3rd+'
}

export interface LinkedInSearchResult {
  name:             string
  headline:         string | null
  location:         string | null
  profileUrl:       string
  connectionDegree: number | null
}

export interface SalesNavFilters {
  title?:        string
  company?:      string
  location?:     string
  industry?:     string
  seniorityLevel?: string
}

export interface SalesNavLead {
  name:               string
  title:              string | null
  company:            string | null
  location:           string | null
  profileUrl:         string
  salesNavUrl:        string
  connectionDegree:   number | null
  sharedConnections:  number | null
}

// ── Cookie record interface ───────────────────────────────────────────────────

interface CookieRecord {
  name:     string
  value:    string
  domain?:  string
  path?:    string
  httpOnly?: boolean
  secure?:  boolean
  sameSite?: 'Strict' | 'Lax' | 'None' | 'strict' | 'lax' | 'none'
}

// ── Session helpers ────────────────────────────────────────────────────────────

/**
 * Build a BrightData Scraping Browser CDP WebSocket endpoint URL,
 * optionally with country targeting for the given account.
 */
async function resolveBrowserEndpoint(accountId: string): Promise<string | null> {
  if (process.env.DISABLE_PROXY === 'true') return null
  const browserUrl = process.env.BRIGHTDATA_BROWSER_URL
  if (!browserUrl) return null

  try {
    const { data: account } = await supabase
      .from('linkedin_accounts')
      .select('proxy_country')
      .eq('id', accountId)
      .single()

    const country = (account as { proxy_country?: string } | null)?.proxy_country
    const url = new URL(browserUrl)

    if (country) {
      const baseUser = decodeURIComponent(url.username)
      url.username = encodeURIComponent(`${baseUser}-country-${country.toLowerCase()}`)
    }

    return url.toString()
  } catch {
    return null
  }
}

/**
 * Open a browser+context+page against BrightData CDP, restore account cookies,
 * and return the page.  Caller must close the browser when done.
 */
async function openScraperSession(accountId: string): Promise<{
  browser: Browser
  context: BrowserContext
  page: Page
}> {
  // Load account cookies
  const { data: account, error } = await supabase
    .from('linkedin_accounts')
    .select('cookies')
    .eq('id', accountId)
    .single()

  if (error || !account) throw new Error(`Account ${accountId} not found`)

  let cookies: CookieRecord[] = []
  if (account.cookies) {
    try {
      cookies = JSON.parse(account.cookies) as CookieRecord[]
    } catch {
      throw new Error('Invalid cookie format — please reconnect the account')
    }
  }

  const liAt = cookies.find(c => c.name === 'li_at')
  if (!liAt) throw new Error('No li_at cookie — account session has expired, please reconnect')

  // Prefer BrightData Scraping Browser
  const endpoint = await resolveBrowserEndpoint(accountId)

  let browser: Browser
  let context: BrowserContext

  if (endpoint) {
    const { chromium: pw } = await import('playwright')
    browser = await pw.connectOverCDP(endpoint) as unknown as Browser
    const existingContexts = browser.contexts()
    context = existingContexts.length > 0
      ? existingContexts[0]
      : await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } })
  } else {
    // Fallback: local Chromium with playwright-extra stealth
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const { chromium: chromiumExtra } = require('playwright-extra') as any
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const StealthPlugin = require('puppeteer-extra-plugin-stealth')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    chromiumExtra.use(StealthPlugin())

    // Use the account's own assigned proxy — never fall back to shared env-var credentials
    let proxySettings: { server: string; username?: string; password?: string } | undefined
    const { data: proxyAccount } = await supabase
      .from('linkedin_accounts')
      .select('proxy_id')
      .eq('id', accountId)
      .single()
    if (proxyAccount?.proxy_id) {
      const { data: proxyRow } = await supabase
        .from('proxies')
        .select('proxy_url')
        .eq('id', proxyAccount.proxy_id)
        .single()
      if (proxyRow?.proxy_url) {
        const raw = proxyRow.proxy_url as string
        const normalized = /^(https?|socks[45]):\/\//i.test(raw) ? raw : `http://${raw}`
        const pUrl = new URL(normalized)
        proxySettings = {
          server:   `${pUrl.protocol}//${pUrl.host}`,
          username: decodeURIComponent(pUrl.username) || undefined,
          password: decodeURIComponent(pUrl.password) || undefined,
        }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    browser = await chromiumExtra.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
    }) as Browser

    context = await browser.newContext({
      proxy: proxySettings,
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    })
  }

  // Restore cookies
  try {
    // Normalise sameSite values to what Playwright accepts
    const normCookies = cookies.map(c => ({
      ...c,
      sameSite: (c.sameSite
        ? c.sameSite.charAt(0).toUpperCase() + c.sameSite.slice(1).toLowerCase()
        : 'Lax') as 'Strict' | 'Lax' | 'None',
      domain: c.domain ?? '.linkedin.com',
      path: c.path ?? '/',
    }))
    await context.addCookies(normCookies)
  } catch (cookieErr) {
    console.warn('[scraper] cookie restore warning:', (cookieErr as Error).message)
  }

  const page = await context.newPage()
  return { browser, context, page }
}

/** JS-evaluate click to bypass pointer-event interception */
async function jsClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (el) el.click()
  }, selector)
}

/** Detect and throw on LinkedIn security challenges or login redirects */
async function detectChallenge(page: Page, accountId: string): Promise<void> {
  const url = page.url()
  if (url.includes('/checkpoint') || url.includes('/challenge')) {
    await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', accountId)
    throw new Error(`SECURITY_CHALLENGE: account ${accountId} paused`)
  }
  if (url.includes('/login') || url.includes('/uas/login')) {
    throw new Error('SESSION_EXPIRED: LinkedIn redirected to login — please reconnect the account')
  }
}

// ── Profile scraper ────────────────────────────────────────────────────────────

export async function scrapeLinkedInProfile(
  profileUrl: string,
  accountId: string
): Promise<LinkedInProfile> {
  const { browser, page } = await openScraperSession(accountId)

  try {
    console.log(`[scraper:profile] navigating to ${profileUrl}`)
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await detectChallenge(page, accountId)

    // Wait for the main profile card
    try {
      await page.waitForSelector('h1, .text-heading-xlarge, [data-generated-suggestion-target]', { timeout: 20_000 })
    } catch { /* proceed with what we have */ }

    await DELAY(1500)

    // Scroll to load lazy sections
    await page.evaluate(() => window.scrollBy(0, 800))
    await DELAY(1000)
    await page.evaluate(() => window.scrollBy(0, 800))
    await DELAY(1000)

    // Expand "Show more" sections
    for (const sel of [
      'button[aria-label*="Show more skills"]',
      'button[aria-label*="Show all skills"]',
      'button span:has-text("Show more")',
    ]) {
      try {
        const btn = await page.$(sel)
        if (btn) { await jsClick(page, sel); await DELAY(500) }
      } catch { /* ok */ }
    }

    const result = await page.evaluate((): LinkedInProfile => {
      const getText = (sel: string, root: Element | Document = document): string =>
        (root.querySelector(sel) as HTMLElement)?.innerText?.trim() ?? ''

      // Name
      const name = getText('h1')
        || getText('.text-heading-xlarge')
        || getText('[data-generated-suggestion-target]')

      // Headline
      const headline = getText('.text-body-medium.break-words')
        || getText('[data-generated-suggestion-target] ~ div')
        || null

      // Location
      const location = getText('.text-body-small.inline.t-black--light.break-words')
        || getText('[data-field="location_summary"]')
        || null

      // About
      const about = getText('#about ~ div .visually-hidden')
        || getText('.pv-shared-text-with-see-more span:not(.visually-hidden)')
        || null

      // Experience
      const experience: { title: string; company: string; duration: string | null }[] = []
      const expSection = document.querySelector('#experience')?.closest('section')
        ?? document.querySelector('[data-view-name*="experience"]')
      if (expSection) {
        const items = expSection.querySelectorAll('li.artdeco-list__item')
        items.forEach(item => {
          const title = (item.querySelector('.t-bold span[aria-hidden]') as HTMLElement)?.innerText?.trim()
            || (item.querySelector('.mr1.t-bold') as HTMLElement)?.innerText?.trim()
            || ''
          const company = (item.querySelector('.t-14.t-normal span[aria-hidden]') as HTMLElement)?.innerText?.trim()
            || (item.querySelector('.pv-entity__secondary-title') as HTMLElement)?.innerText?.trim()
            || ''
          const duration = (item.querySelector('.pvs-entity__caption-wrapper') as HTMLElement)?.innerText?.trim()
            || (item.querySelector('.pv-entity__date-range') as HTMLElement)?.innerText?.trim()
            || null
          if (title || company) experience.push({ title, company, duration })
        })
      }

      // Education
      const education: { school: string; degree: string | null; years: string | null }[] = []
      const eduSection = document.querySelector('#education')?.closest('section')
        ?? document.querySelector('[data-view-name*="education"]')
      if (eduSection) {
        const items = eduSection.querySelectorAll('li.artdeco-list__item')
        items.forEach(item => {
          const school = (item.querySelector('.mr1.t-bold span[aria-hidden]') as HTMLElement)?.innerText?.trim()
            || (item.querySelector('.pv-entity__school-name') as HTMLElement)?.innerText?.trim()
            || ''
          const degree = (item.querySelector('.t-14.t-normal span[aria-hidden]') as HTMLElement)?.innerText?.trim()
            || (item.querySelector('.pv-entity__degree-name') as HTMLElement)?.innerText?.trim()
            || null
          const years = (item.querySelector('.pvs-entity__caption-wrapper') as HTMLElement)?.innerText?.trim()
            || (item.querySelector('.pv-entity__dates') as HTMLElement)?.innerText?.trim()
            || null
          if (school) education.push({ school, degree, years })
        })
      }

      // Skills
      const skills: string[] = []
      const skillsSection = document.querySelector('#skills')?.closest('section')
        ?? document.querySelector('[data-view-name*="skills"]')
      if (skillsSection) {
        skillsSection.querySelectorAll('.mr1.t-bold span[aria-hidden], .pv-skill-category-entity__name span').forEach(el => {
          const t = (el as HTMLElement).innerText?.trim()
          if (t && !skills.includes(t)) skills.push(t)
        })
      }

      // Connection degree
      let connectionDegree: number | null = null
      const degreeEl = document.querySelector('.dist-value, .distance-badge')
      if (degreeEl) {
        const degText = (degreeEl as HTMLElement).innerText?.trim()
        if (degText.startsWith('1')) connectionDegree = 1
        else if (degText.startsWith('2')) connectionDegree = 2
        else if (degText.startsWith('3')) connectionDegree = 3
      }

      // Profile picture
      const picEl = document.querySelector('.pv-top-card-profile-picture__image, .profile-photo-edit__preview, img.presence-entity__image')
      const profilePicUrl = picEl ? (picEl as HTMLImageElement).src ?? null : null

      // Public profile URL — get canonical from <link> or current URL
      const canonical = (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href
        ?? window.location.href
      const publicProfileUrl = canonical

      // LinkedIn member ID from the URL (numeric)
      const idMatch = window.location.pathname.match(/\/in\/([^/]+)/)
      const linkedinId = idMatch ? idMatch[1] : null

      return {
        name,
        headline: headline || null,
        location: location || null,
        about: about || null,
        experience,
        education,
        skills,
        connectionDegree,
        profilePicUrl: profilePicUrl || null,
        publicProfileUrl,
        linkedinId,
      }
    })

    console.log(`[scraper:profile] scraped: ${result.name} @ ${result.publicProfileUrl}`)
    return result
  } finally {
    await browser.close().catch(() => {})
  }
}

// ── LinkedIn Search scraper ────────────────────────────────────────────────────

export async function scrapeLinkedInSearch(
  query: string,
  filters: SearchFilters,
  accountId: string,
  page_num = 1
): Promise<LinkedInSearchResult[]> {
  const { browser, page } = await openScraperSession(accountId)

  try {
    // Build search URL
    const params = new URLSearchParams({
      keywords: query,
      origin: 'GLOBAL_SEARCH_HEADER',
    })
    if (filters.connection) {
      const networkMap: Record<string, string> = { '1st': 'F', '2nd': 'S', '3rd+': 'O' }
      params.set('network', `["${networkMap[filters.connection] ?? 'S'}"]`)
    }
    if (filters.location) params.set('geoUrn', filters.location)
    if (page_num > 1) params.set('page', String(page_num))

    const searchUrl = `https://www.linkedin.com/search/results/people/?${params.toString()}`
    console.log(`[scraper:search] navigating to ${searchUrl}`)

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await detectChallenge(page, accountId)

    // Wait for results
    try {
      await page.waitForSelector('.reusable-search__result-container, .entity-result__item, li.reusable-search-simple-insight', { timeout: 20_000 })
    } catch { /* no results or timed out */ }

    await DELAY(1500)

    const results = await page.evaluate((): LinkedInSearchResult[] => {
      const items = document.querySelectorAll(
        '.reusable-search__result-container li, .search-results-container li.reusable-search-simple-insight, .entity-result__item'
      )

      const leads: LinkedInSearchResult[] = []

      items.forEach(item => {
        const nameEl = item.querySelector('.entity-result__title-text a span[aria-hidden], .app-aware-link span[aria-hidden]')
        const name = (nameEl as HTMLElement)?.innerText?.trim() ?? ''
        if (!name || name === 'LinkedIn Member') return

        const linkEl = item.querySelector('a.app-aware-link[href*="/in/"], a[href*="/in/"]')
        const profileUrl = linkEl
          ? (new URL((linkEl as HTMLAnchorElement).href, window.location.origin)).href
          : ''
        if (!profileUrl) return

        const headlineEl = item.querySelector('.entity-result__primary-subtitle')
        const headline = (headlineEl as HTMLElement)?.innerText?.trim() || null

        const locationEl = item.querySelector('.entity-result__secondary-subtitle')
        const location = (locationEl as HTMLElement)?.innerText?.trim() || null

        const degreeEl = item.querySelector('.dist-value')
        const degText = (degreeEl as HTMLElement)?.innerText?.trim() ?? ''
        const connectionDegree = degText.startsWith('1') ? 1 : degText.startsWith('2') ? 2 : degText.startsWith('3') ? 3 : null

        leads.push({ name, headline, location, profileUrl, connectionDegree })
      })

      return leads
    })

    console.log(`[scraper:search] page ${page_num}: ${results.length} results`)
    return results
  } finally {
    await browser.close().catch(() => {})
  }
}

// ── Sales Navigator scraper ────────────────────────────────────────────────────

/**
 * API-first approach: intercept the XHR response from LinkedIn's salesApiLeadSearch.
 * Falls back to DOM scraping if API interception fails.
 */
export async function scrapeSalesNavSearch(
  query: string,
  filters: SalesNavFilters,
  accountId: string,
  page_num = 1,
  maxLeads = 25
): Promise<SalesNavLead[]> {
  // First try direct API call (no browser needed)
  try {
    const apiLeads = await scrapeSalesNavApi(accountId, query, filters, page_num, maxLeads)
    if (apiLeads.length > 0) return apiLeads
    console.log('[scraper:sales-nav] API returned 0 results, falling back to browser')
  } catch (err) {
    console.warn('[scraper:sales-nav] API approach failed:', (err as Error).message, '— falling back to browser')
  }

  // Browser fallback
  return scrapeSalesNavBrowser(query, filters, accountId, page_num, maxLeads)
}

/** Direct API approach using session cookies */
async function scrapeSalesNavApi(
  accountId: string,
  query: string,
  filters: SalesNavFilters,
  page_num: number,
  maxLeads: number
): Promise<SalesNavLead[]> {
  const { data: account, error } = await supabase
    .from('linkedin_accounts')
    .select('cookies')
    .eq('id', accountId)
    .single()

  if (error || !account?.cookies) throw new Error('Account not found or no cookies')

  let cookies: CookieRecord[]
  try {
    cookies = JSON.parse(account.cookies) as CookieRecord[]
  } catch {
    throw new Error('Invalid cookie format')
  }

  const liAt = cookies.find(c => c.name === 'li_at')
  if (!liAt) throw new Error('No li_at cookie')

  const jsessionId = cookies.find(c => c.name === 'JSESSIONID')?.value ?? `ajax:${Date.now()}`
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const headers = {
    Cookie: cookieHeader,
    'Csrf-Token': jsessionId,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Li-Lang': 'en_US',
    'X-Restli-Protocol-Version': '2.0.0',
    'X-Li-PageInstance': 'urn:li:page:sales_homepage',
  }

  const pageSize = Math.min(maxLeads, 25)
  const start = (page_num - 1) * pageSize

  // Build query params for Sales Navigator API
  const qParams = new URLSearchParams()
  qParams.set('count', String(pageSize))
  qParams.set('start', String(start))
  qParams.set('decorationId', 'com.linkedin.sales.deco.desktop.searchv2.LeadSearchResultV2-6')

  if (query) {
    qParams.set('q', 'searchQuery')
    qParams.set('query', encodeURIComponent(JSON.stringify({
      keywords: query,
      ...(filters.title ? { titleKeywords: filters.title } : {}),
      ...(filters.company ? { companyKeywords: filters.company } : {}),
    })))
  } else {
    qParams.set('q', 'searchQuery')
    qParams.set('query', '{}')
  }

  const apiUrl = `https://www.linkedin.com/sales-api/salesApiLeadSearch?${qParams.toString()}`
  console.log(`[scraper:sales-nav-api] ${apiUrl}`)

  const res = await fetch(apiUrl, { headers })
  console.log(`[scraper:sales-nav-api] status: ${res.status}`)

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Auth error ${res.status} — session may be expired`)
  }
  if (!res.ok) throw new Error(`API error ${res.status}`)

  interface RawSalesNavLead {
    firstName?: string
    lastName?: string
    fullName?: string
    title?: string
    currentPositions?: Array<{ companyName?: string }>
    geoRegion?: string
    degree?: number
    publicProfileUrl?: string
    linkedinMemberUrn?: string
    memberBadges?: { degree?: number }
    numSharedConnections?: number
    entityUrn?: string
  }

  interface ApiResponse {
    elements?: RawSalesNavLead[]
    paging?: { count: number; start: number; total: number }
  }

  const data = await res.json() as ApiResponse
  const elements = data.elements ?? []

  const leads: SalesNavLead[] = []
  for (const el of elements) {
    const firstName = el.firstName?.trim() ?? ''
    const lastName  = el.lastName?.trim() ?? ''
    const name = el.fullName?.trim() || `${firstName} ${lastName}`.trim()
    if (!name) continue

    let profileUrl = el.publicProfileUrl ?? ''
    if (!profileUrl && el.linkedinMemberUrn) {
      const id = el.linkedinMemberUrn.split(':').pop()
      profileUrl = id ? `https://www.linkedin.com/in/${id}/` : ''
    }

    const entityUrn = el.entityUrn ?? ''
    const salesNavId = entityUrn.split(':').pop() ?? ''
    const salesNavUrl = salesNavId
      ? `https://www.linkedin.com/sales/lead/${salesNavId},/`
      : profileUrl

    const degree = el.degree ?? el.memberBadges?.degree ?? null

    leads.push({
      name,
      title: el.title ?? null,
      company: el.currentPositions?.[0]?.companyName ?? null,
      location: el.geoRegion ?? null,
      profileUrl,
      salesNavUrl,
      connectionDegree: degree,
      sharedConnections: el.numSharedConnections ?? null,
    })
  }

  return leads
}

/** Browser-based Sales Navigator scraping with API interception */
async function scrapeSalesNavBrowser(
  query: string,
  filters: SalesNavFilters,
  accountId: string,
  page_num: number,
  maxLeads: number
): Promise<SalesNavLead[]> {
  const { browser, page } = await openScraperSession(accountId)

  try {
    // Build Sales Navigator search URL
    const params = new URLSearchParams()
    if (query) params.set('keywords', query)
    if (filters.title) params.set('titleKeywords', filters.title)
    if (filters.company) params.set('companyKeywords', filters.company)
    if (filters.location) params.set('geoKeywords', filters.location)
    if (page_num > 1) params.set('page', String(page_num))

    const searchUrl = `https://www.linkedin.com/sales/search/people?${params.toString()}`
    console.log(`[scraper:sales-nav-browser] navigating to ${searchUrl}`)

    // Intercept API responses
    const intercepted: Array<{
      firstName?: string; lastName?: string; fullName?: string
      title?: string; currentPositions?: Array<{ companyName?: string }>
      geoRegion?: string; degree?: number; publicProfileUrl?: string
      linkedinMemberUrn?: string; memberBadges?: { degree?: number }
      numSharedConnections?: number; entityUrn?: string
    }> = []

    page.on('response', async (response) => {
      try {
        const rUrl = response.url()
        if (!rUrl.includes('salesApiLeadSearch') && !rUrl.includes('salesApiSearch')) return
        if (response.status() !== 200) return
        const json = await response.json() as { elements?: typeof intercepted }
        if (json.elements) intercepted.push(...json.elements)
        console.log(`[scraper:sales-nav-browser] intercepted ${json.elements?.length ?? 0} leads`)
      } catch { /* not JSON */ }
    })

    // Warm up Sales Navigator first
    await page.goto('https://www.linkedin.com/sales/home', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await detectChallenge(page, accountId)
    await DELAY(2000)

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await detectChallenge(page, accountId)

    // Wait for either API interception or DOM results
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[data-anonymize="person-name"], a[href*="/sales/lead/"]').length > 0,
        { timeout: 30_000, polling: 1000 }
      )
    } catch { /* timed out */ }

    await DELAY(2000)

    // If API data was captured, use it
    if (intercepted.length > 0) {
      console.log(`[scraper:sales-nav-browser] using ${intercepted.length} intercepted leads`)
      return intercepted.slice(0, maxLeads).map(el => {
        const firstName = el.firstName?.trim() ?? ''
        const lastName = el.lastName?.trim() ?? ''
        const name = el.fullName?.trim() || `${firstName} ${lastName}`.trim()
        let profileUrl = el.publicProfileUrl ?? ''
        if (!profileUrl && el.linkedinMemberUrn) {
          const id = el.linkedinMemberUrn.split(':').pop()
          profileUrl = id ? `https://www.linkedin.com/in/${id}/` : ''
        }
        const entityUrn = el.entityUrn ?? ''
        const salesNavId = entityUrn.split(':').pop() ?? ''
        const salesNavUrl = salesNavId ? `https://www.linkedin.com/sales/lead/${salesNavId},/` : profileUrl
        return {
          name,
          title: el.title ?? null,
          company: el.currentPositions?.[0]?.companyName ?? null,
          location: el.geoRegion ?? null,
          profileUrl,
          salesNavUrl,
          connectionDegree: el.degree ?? el.memberBadges?.degree ?? null,
          sharedConnections: el.numSharedConnections ?? null,
        }
      })
    }

    // DOM fallback
    console.log('[scraper:sales-nav-browser] falling back to DOM scraping')
    const leads = await page.evaluate((limit: number): SalesNavLead[] => {
      const items = document.querySelectorAll('li.artdeco-list__item, ol li')
      const results: SalesNavLead[] = []

      items.forEach(item => {
        if (results.length >= limit) return

        const nameEl  = item.querySelector('[data-anonymize="person-name"]')
        const titleEl = item.querySelector('[data-anonymize="title"]')
        const coEl    = item.querySelector('[data-anonymize="company-name"]')
        const locEl   = item.querySelector('[data-anonymize="location"]')
        const degEl   = item.querySelector('.dist-value')

        const name = (nameEl as HTMLElement)?.innerText?.trim() ?? ''
        if (!name) return

        const href = (nameEl as HTMLAnchorElement)?.href
          ?? (nameEl?.closest('a') as HTMLAnchorElement)?.href
          ?? ''
        const salesNavUrl = href || window.location.href
        const profileUrl = href || ''

        const degText = (degEl as HTMLElement)?.innerText?.trim() ?? ''
        const connectionDegree = degText.startsWith('1') ? 1 : degText.startsWith('2') ? 2 : degText.startsWith('3') ? 3 : null

        results.push({
          name,
          title: (titleEl as HTMLElement)?.innerText?.trim() || null,
          company: (coEl as HTMLElement)?.innerText?.trim() || null,
          location: (locEl as HTMLElement)?.innerText?.trim() || null,
          profileUrl,
          salesNavUrl,
          connectionDegree,
          sharedConnections: null,
        })
      })

      return results
    }, maxLeads)

    console.log(`[scraper:sales-nav-browser] DOM: ${leads.length} leads`)
    return leads
  } finally {
    await browser.close().catch(() => {})
  }
}
