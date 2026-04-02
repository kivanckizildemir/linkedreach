/**
 * Sales Navigator scraper using LinkedIn's internal Voyager/Sales API.
 * Makes direct HTTP requests with the session cookie — no browser, no detection.
 */

import { supabase } from '../lib/supabase'

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

interface SalesNavApiLead {
  firstName?: string
  lastName?: string
  title?: string
  currentPositions?: Array<{ companyName?: string }>
  geoRegion?: string
  memberUrn?: string
  linkedinMemberUrn?: string
  degree?: number
  publicProfileUrl?: string
}

interface SalesNavApiResponse {
  elements?: SalesNavApiLead[]
  paging?: { count: number; start: number; total: number }
}

function mapLead(raw: SalesNavApiLead): ScrapedLead | null {
  const firstName = raw.firstName?.trim() ?? ''
  const lastName = raw.lastName?.trim() ?? ''
  if (!firstName && !lastName) return null

  // Extract LinkedIn profile URL from URN
  let linkedinUrl = raw.publicProfileUrl ?? ''
  if (!linkedinUrl && raw.linkedinMemberUrn) {
    const id = raw.linkedinMemberUrn.split(':').pop()
    linkedinUrl = id ? `https://www.linkedin.com/in/${id}/` : ''
  }
  if (!linkedinUrl) return null

  const company = raw.currentPositions?.[0]?.companyName ?? null

  return {
    first_name: firstName,
    last_name: lastName,
    title: raw.title ?? null,
    company,
    location: raw.geoRegion ?? null,
    linkedin_url: linkedinUrl,
    connection_degree: raw.degree ?? null,
  }
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

  let cookies: CookieRecord[]
  try {
    cookies = JSON.parse(account.cookies)
  } catch {
    throw new Error('Invalid cookie format. Please reset the session cookie.')
  }

  const liAt = cookies.find(c => c.name === 'li_at')?.value
  if (!liAt) throw new Error('No li_at cookie found. Please set a session cookie.')

  // JSESSIONID is used as CSRF token (LinkedIn's pattern)
  const jsessionId = cookies.find(c => c.name === 'JSESSIONID')?.value ?? `ajax:${Date.now()}`
  const cookieHeader = parseCookieHeader(cookies)
  const headers = buildHeaders(cookieHeader, jsessionId)

  // Parse saved search ID or query from URL
  const url = new URL(searchUrl)
  const savedSearchId = url.searchParams.get('savedSearchId')
  const query = url.searchParams.get('query')

  const leads: ScrapedLead[] = []
  const pageSize = 25
  let start = 0

  while (leads.length < maxLeads) {
    let apiUrl: string

    if (savedSearchId) {
      apiUrl = `https://www.linkedin.com/sales-api/salesApiLeadSearch?q=savedSearch&savedSearchId=${savedSearchId}&count=${pageSize}&start=${start}&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResultV2-6`
    } else if (query) {
      apiUrl = `https://www.linkedin.com/sales-api/salesApiLeadSearch?q=searchQuery&query=${encodeURIComponent(query)}&count=${pageSize}&start=${start}&decorationId=com.linkedin.sales.deco.desktop.searchv2.LeadSearchResultV2-6`
    } else {
      // Fallback: use the raw URL params
      apiUrl = `https://www.linkedin.com/sales-api/salesApiLeadSearch?count=${pageSize}&start=${start}&${url.searchParams.toString()}`
    }

    console.log(`[sales-nav-api] Fetching page start=${start}: ${apiUrl}`)

    let res: Response
    try {
      res = await fetch(apiUrl, { headers })
    } catch (fetchErr: unknown) {
      const cause = (fetchErr as { cause?: unknown }).cause
      throw new Error(`Network error fetching LinkedIn API: ${(fetchErr as Error).message} — cause: ${JSON.stringify(cause)}`)
    }

    console.log(`[sales-nav-api] Response status: ${res.status}`)

    if (res.status === 401 || res.status === 403) {
      const body = await res.text()
      console.error(`[sales-nav-api] Auth error ${res.status}: ${body.slice(0, 500)}`)
      throw new Error(`Session expired or unauthorized (${res.status}). Please refresh your LinkedIn session cookie.`)
    }

    if (!res.ok) {
      const body = await res.text()
      console.error(`[sales-nav-api] API error ${res.status}: ${body.slice(0, 300)}`)
      break
    }

    const data = await res.json() as SalesNavApiResponse
    const elements = data.elements ?? []

    if (elements.length === 0) break

    for (const el of elements) {
      if (leads.length >= maxLeads) break
      const lead = mapLead(el)
      if (lead) {
        leads.push(lead)
        onProgress?.(leads.length)
      }
    }

    const total = data.paging?.total ?? 0
    start += pageSize

    if (start >= total || start >= maxLeads) break

    // Polite delay between pages
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 500))
  }

  return leads
}
