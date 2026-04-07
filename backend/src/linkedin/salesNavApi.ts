/**
 * Sales Navigator scraper using LinkedIn's internal Voyager/Sales API.
 * Makes direct HTTP requests with the session cookie — no browser, no detection.
 */

import { ProxyAgent } from 'undici'
import { supabase } from '../lib/supabase'
import { extractCookies } from './session'

/** Build a proxy agent for outbound HTTP requests if a static proxy is configured. */
function getProxyAgent(): ProxyAgent | undefined {
  if (process.env.DISABLE_PROXY === 'true') return undefined
  const host = process.env.PROXY_HOST
  const port = process.env.PROXY_PORT ?? '10000'
  const user = process.env.PROXY_USERNAME
  const pass = process.env.PROXY_PASSWORD
  if (host && user) {
    const url = pass
      ? `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`
      : `http://${encodeURIComponent(user)}@${host}:${port}`
    return new ProxyAgent(url)
  }
  // Fallback: BrightData env var
  const bdUrl = process.env.BRIGHTDATA_PROXY_URL
  if (bdUrl) return new ProxyAgent(bdUrl)
  return undefined
}

export interface ScrapedLead {
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  location: string | null
  linkedin_url: string
  connection_degree: number | null
}

interface CookieRecord {
  name: string
  value: string
}

function parseCookieHeader(cookies: CookieRecord[]): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function buildHeaders(cookieHeader: string, csrfToken: string) {
  return {
    'Cookie': cookieHeader,
    'Csrf-Token': csrfToken,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Li-Lang': 'en_US',
    'X-Li-Track': JSON.stringify({ clientVersion: '2024.1.0', osName: 'web', timezoneOffset: 0 }),
    'X-Restli-Protocol-Version': '2.0.0',
    'X-Li-PageInstance': 'urn:li:page:sales_homepage',
  }
}

// LinkedIn Sales API returns different field shapes depending on the
// decorationId / endpoint version. We handle all known variants here.
interface SalesNavApiLead {
  // Name — new API uses split fields; older uses fullName or leadName
  firstName?: string
  lastName?: string
  fullName?: string
  leadName?: { text?: string }
  // Title
  title?: string | { text?: string }
  titleText?: string
  // Company
  currentPositions?: Array<{ companyName?: string; name?: string }>
  companyName?: string
  company?: { name?: string }
  // Location
  geoRegion?: string
  location?: { text?: string }
  // Degree
  degree?: number
  memberBadges?: { degree?: number }
  // Profile URL / URN (try all known variants)
  publicProfileUrl?: string
  profileUrl?: string
  memberUrn?: string
  linkedinMemberUrn?: string
  entityUrn?: string
  objectUrn?: string
  profileUrn?: string
}

interface SalesNavApiResponse {
  elements?:    SalesNavApiLead[]
  results?:     SalesNavApiLead[]
  leadResults?: SalesNavApiLead[]
  paging?:      { count: number; start: number; total: number }
  total?:       number
}

function mapLead(raw: SalesNavApiLead, searchUrl: string): ScrapedLead | null {
  // ── Resolve name ────────────────────────────────────────────────────────────
  let firstName = raw.firstName?.trim() ?? ''
  let lastName  = raw.lastName?.trim()  ?? ''

  if (!firstName && !lastName) {
    const full = (raw.fullName ?? raw.leadName?.text ?? '').trim()
    if (!full) return null
    const parts = full.split(' ')
    firstName = parts[0] ?? ''
    lastName  = parts.slice(1).join(' ')
  }

  if (!firstName && !lastName) return null

  // ── Resolve title ────────────────────────────────────────────────────────────
  let title: string | null = null
  if (typeof raw.title === 'string')       title = raw.title || null
  else if (raw.title?.text)                title = raw.title.text || null
  else if (raw.titleText)                  title = raw.titleText || null

  // ── Resolve company ──────────────────────────────────────────────────────────
  const company =
    raw.currentPositions?.[0]?.companyName ??
    raw.currentPositions?.[0]?.name ??
    raw.companyName ??
    raw.company?.name ??
    null

  // ── Resolve location ─────────────────────────────────────────────────────────
  const location =
    (typeof raw.location === 'object' ? raw.location?.text : null) ??
    raw.geoRegion ??
    null

  // ── Resolve degree ───────────────────────────────────────────────────────────
  const connection_degree = raw.degree ?? raw.memberBadges?.degree ?? null

  // ── Resolve LinkedIn profile URL ─────────────────────────────────────────────
  let linkedin_url =
    raw.publicProfileUrl ??
    raw.profileUrl ??
    ''

  if (!linkedin_url) {
    // Try to build from any URN variant
    const urn =
      raw.linkedinMemberUrn ??
      raw.memberUrn ??
      raw.entityUrn ??
      raw.objectUrn ??
      raw.profileUrn ??
      ''
    const memberId = urn.split(':').pop()
    if (memberId) {
      // entityUrn from Sales Nav contains the sales lead path
      linkedin_url = urn.includes('salesMember') || urn.includes('lead')
        ? `https://www.linkedin.com/sales/lead/${memberId},NAME_SEARCH/`
        : `https://www.linkedin.com/in/${memberId}/`
    }
  }

  // Last resort: use the search URL as a placeholder so the lead isn't silently dropped
  if (!linkedin_url) linkedin_url = searchUrl

  return { first_name: firstName, last_name: lastName, title, company, location, linkedin_url, connection_degree }
}

export async function scrapeSalesNavSearchApi(
  accountId: string,
  searchUrl: string,
  maxLeads: number,
  onProgress?: (n: number) => void
): Promise<ScrapedLead[]> {
  // Load account cookies
  const { data: account, error } = await supabase
    .from('linkedin_accounts')
    .select('cookies')
    .eq('id', accountId)
    .single()

  if (error || !account?.cookies) {
    throw new Error('Account not found or no session cookie. Please set a session cookie first.')
  }

  // Handle both storage formats: full storage_state object OR legacy cookie array
  const cookies: CookieRecord[] = extractCookies(account.cookies as string)

  const liAt = cookies.find(c => c.name === 'li_at')?.value
  if (!liAt) throw new Error('No li_at cookie found. Please reconnect from the Accounts page.')

  // JSESSIONID is used as CSRF token (LinkedIn's pattern)
  const jsessionId = cookies.find(c => c.name === 'JSESSIONID')?.value ?? `ajax:${Date.now()}`
  const cookieHeader = parseCookieHeader(cookies)
  const headers = buildHeaders(cookieHeader, jsessionId)

  // Parse saved search ID or query from URL
  // Strip sessionId — it is tied to the original browser session and will cause
  // 400 errors when replayed from a different context.
  const url = new URL(searchUrl)
  url.searchParams.delete('sessionId')
  const savedSearchId = url.searchParams.get('savedSearchId')
  // The `query` param in Sales Nav URLs is an encoded filter string like
  // "(spRegion:(included:List(...)))".  We pass it verbatim to the API.
  const queryParam = url.searchParams.get('query')

  const leads: ScrapedLead[] = []
  const pageSize = 25
  let start = 0

  while (leads.length < maxLeads) {
    let apiUrl: string

    if (savedSearchId) {
      // Saved-search endpoint
      apiUrl =
        `https://www.linkedin.com/sales-api/salesApiLeadSearch` +
        `?q=savedSearch&savedSearchId=${encodeURIComponent(savedSearchId)}` +
        `&count=${pageSize}&start=${start}` +
        `&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResultV2-6`
    } else if (queryParam) {
      // Live search — pass the entire query string as-is (already URI-encoded by
      // url.searchParams, so we retrieve the raw encoded value)
      const rawQuery = url.searchParams.get('query') ?? ''
      apiUrl =
        `https://www.linkedin.com/sales-api/salesApiLeadSearch` +
        `?q=searchQuery&query=${encodeURIComponent(rawQuery)}` +
        `&count=${pageSize}&start=${start}` +
        `&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResultV2-6`
    } else {
      // Fallback: forward all URL params minus sessionId
      url.searchParams.set('count', String(pageSize))
      url.searchParams.set('start', String(start))
      apiUrl = `https://www.linkedin.com/sales-api/salesApiLeadSearch?${url.searchParams.toString()}`
    }

    console.log(`[sales-nav-api] Fetching page start=${start}: ${apiUrl.substring(0, 160)}`)

    // LinkedIn sometimes returns a 302 self-redirect to set auth cookies before the API response.
    // We follow it once manually: capture the Set-Cookie header and retry with the new cookies.
    // Route through the residential proxy so LinkedIn doesn't detect a datacenter IP and delete session.
    const agent = getProxyAgent()
    let res: Response
    let currentHeaders = { ...headers }
    try {
      const fetchOpts = { headers: currentHeaders, redirect: 'manual', ...(agent ? { dispatcher: agent } : {}) } as RequestInit
      res = await fetch(apiUrl, fetchOpts)
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location') ?? apiUrl
        const setCookie = res.headers.get('set-cookie')
        console.log(`[sales-nav-api] 302 redirect to ${location.substring(0, 80)}, set-cookie: ${setCookie ?? 'none'}`)
        if (setCookie) {
          // Merge new cookies into the cookie header
          const newCookies = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ')
          currentHeaders = { ...currentHeaders, Cookie: currentHeaders['Cookie'] + '; ' + newCookies }
        }
        // Follow the redirect once
        res = await fetch(location, { headers: currentHeaders, redirect: 'manual', ...(agent ? { dispatcher: agent } : {}) } as RequestInit)
        console.log(`[sales-nav-api] After redirect: ${res.status}`)
      }
    } catch (fetchErr: unknown) {
      const err = fetchErr as Error & { cause?: unknown }
      const cause = err.cause
      const causeStr = cause instanceof Error
        ? `${cause.constructor.name}: ${cause.message}`
        : JSON.stringify(cause ?? '')
      console.error('[sales-nav-api] fetch error:', err.message, '| cause:', causeStr)
      throw new Error(`Network error fetching LinkedIn API: ${err.message} — cause: ${causeStr}`)
    }

    console.log(`[sales-nav-api] Response status: ${res.status}`)

    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `LinkedIn API redirected (${res.status}) to: ${res.headers.get('location') ?? 'unknown'}. ` +
        `Session may be expired or Sales Navigator subscription required.`
      )
    }

    if (res.status === 401 || res.status === 403) {
      const body = await res.text()
      console.error(`[sales-nav-api] Auth error ${res.status}: ${body.slice(0, 500)}`)
      throw new Error(
        `LinkedIn session expired or unauthorized (HTTP ${res.status}). ` +
        `Please reconnect from the Accounts page.`
      )
    }

    if (!res.ok) {
      const body = await res.text()
      console.error(`[sales-nav-api] API error ${res.status}: ${body.slice(0, 500)}`)
      throw new Error(
        `LinkedIn Sales API returned HTTP ${res.status}: ${body.slice(0, 200)}`
      )
    }

    const data = await res.json() as SalesNavApiResponse
    const items = data.elements ?? data.results ?? data.leadResults ?? []

    console.log(`[sales-nav-api] Page start=${start}: ${items.length} elements, total=${data.paging?.total ?? data.total ?? '?'}`)

    if (items.length === 0) break

    for (const el of items) {
      if (leads.length >= maxLeads) break
      const lead = mapLead(el, searchUrl)
      if (lead) {
        leads.push(lead)
        onProgress?.(leads.length)
      }
    }

    const total = data.paging?.total ?? data.total ?? 0
    start += pageSize

    if (start >= total || start >= maxLeads) break

    // Polite delay between pages
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800))
  }

  return leads
}
