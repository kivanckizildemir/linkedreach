/**
 * Regular LinkedIn People Search scraper using the Voyager API.
 * Accepts standard linkedin.com/search/results/people/... URLs.
 * Makes direct HTTP requests with session cookies — no browser needed.
 */

import { ProxyAgent } from 'undici'
import { supabase } from '../lib/supabase'
import { extractCookies } from './session'
import type { ScrapedLead } from './salesNavApi'

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
  const bdUrl = process.env.BRIGHTDATA_PROXY_URL
  if (bdUrl) return new ProxyAgent(bdUrl)
  return undefined
}

interface CookieRecord { name: string; value: string }

function parseCookieHeader(cookies: CookieRecord[]): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function buildVoyagerHeaders(cookieHeader: string, csrfToken: string) {
  return {
    'Cookie': cookieHeader,
    'Csrf-Token': csrfToken,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-li-lang': 'en_US',
    'x-li-track': JSON.stringify({ clientVersion: '2024.1.0', osName: 'web', timezoneOffset: 0 }),
    'x-restli-protocol-version': '2.0.0',
    'x-li-page-instance': 'urn:li:page:search_people;',
  }
}

// ── Parse LinkedIn search URL into Voyager filter list ───────────────────────
function buildVoyagerFilters(url: URL): string {
  const parts: string[] = ['resultType->PEOPLE']

  const network = url.searchParams.get('network')
  if (network) {
    try {
      const nets = JSON.parse(network) as string[]
      const mapped = nets.map(n =>
        n === 'F' ? 'F' : n === 'S' ? 'S' : n === 'O' ? 'O' : null
      ).filter(Boolean)
      if (mapped.length) parts.push(`network->${mapped.join('|')}`)
    } catch { /* ignore */ }
  }

  const geoUrn = url.searchParams.get('geoUrn')
  if (geoUrn) {
    try {
      const geos = JSON.parse(geoUrn) as string[]
      if (geos.length) parts.push(`geoUrn->${geos.join('|')}`)
    } catch { /* ignore */ }
  }

  const currentCompany = url.searchParams.get('currentCompany')
  if (currentCompany) {
    try {
      const companies = JSON.parse(currentCompany) as string[]
      if (companies.length) parts.push(`currentCompany->${companies.join('|')}`)
    } catch { /* ignore */ }
  }

  const titleFilter = url.searchParams.get('titleFilter')
  if (titleFilter) {
    try {
      const titles = JSON.parse(titleFilter) as string[]
      if (titles.length) parts.push(`title->${titles.join('|')}`)
    } catch { /* ignore */ }
  }

  return `List(${parts.join(',')})`
}

// ── Parse a single search hit from the Voyager blended response ──────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapVoyagerHit(hit: any): ScrapedLead | null {
  try {
    // The hit can be nested differently depending on the API version/decoration.
    // We try several known shapes.
    const profile =
      hit?.hitInfo?.['com.linkedin.voyager.search.SearchProfile']?.profile ??
      hit?.hitInfo?.['com.linkedin.voyager.dash.search.EntityResultViewModel'] ??
      hit?.entityResult ??
      hit?.profile ??
      hit

    // Name
    const firstName: string = profile?.firstName?.trim() ?? ''
    const lastName: string  = profile?.lastName?.trim() ?? ''
    const fullName: string  = profile?.name?.trim() ?? profile?.title?.text?.trim() ?? ''

    let first = firstName
    let last  = lastName
    if (!first && !last && fullName) {
      const parts = fullName.split(' ')
      first = parts[0] ?? ''
      last  = parts.slice(1).join(' ')
    }
    if (!first && !last) return null

    // Title / headline
    const title: string | null =
      profile?.headline?.trim() ||
      profile?.occupation?.trim() ||
      profile?.primarySubtitle?.text?.trim() ||
      null

    // Company — try to extract from headline if not explicit
    const company: string | null =
      profile?.currentPositions?.[0]?.companyName ??
      profile?.currentCompanyName ??
      null

    // Location
    const location: string | null =
      profile?.location?.name?.trim() ||
      profile?.geoRegion?.trim() ||
      profile?.secondarySubtitle?.text?.trim() ||
      null

    // Profile URL
    const publicId: string =
      profile?.publicIdentifier ??
      profile?.miniProfile?.publicIdentifier ??
      ''
    const profileUrl: string =
      profile?.publicProfileUrl ??
      profile?.profileUrl ??
      profile?.navigationUrl ??
      (publicId ? `https://www.linkedin.com/in/${publicId}/` : '')

    if (!profileUrl) return null

    const degree: number | null =
      hit?.hitInfo?.['com.linkedin.voyager.search.SearchProfile']?.degree ??
      profile?.distance?.value ??
      null

    return {
      first_name: first,
      last_name:  last,
      title,
      company,
      location,
      linkedin_url: profileUrl.startsWith('http') ? profileUrl : `https://www.linkedin.com${profileUrl}`,
      connection_degree: degree,
    }
  } catch {
    return null
  }
}

export async function scrapeLinkedInSearchApi(
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
    throw new Error('Account not found or no session cookie.')
  }

  const cookies: CookieRecord[] = extractCookies(account.cookies as string)
  const liAt = cookies.find(c => c.name === 'li_at')?.value
  if (!liAt) throw new Error('No li_at cookie found. Please reconnect from the Accounts page.')

  let cookieHeader = parseCookieHeader(cookies)
  let jsessionId = cookies.find(c => c.name === 'JSESSIONID')?.value?.replace(/^"(.*)"$/, '$1')

  const agent = getProxyAgent()

  // Bootstrap JSESSIONID if missing
  if (!jsessionId) {
    console.log('[linkedin-search-api] Bootstrapping JSESSIONID from LinkedIn home…')
    try {
      const bootstrapRes = await fetch('https://www.linkedin.com/feed/', {
        headers: {
          Cookie: cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'text/html',
        },
        redirect: 'manual',
        ...(agent ? { dispatcher: agent } : {}),
      } as RequestInit)
      const sc = bootstrapRes.headers.get('set-cookie') ?? ''
      const m = sc.match(/JSESSIONID=([^;,]+)/)
      if (m) {
        jsessionId = m[1]
        cookieHeader = `${cookieHeader}; JSESSIONID=${jsessionId}`
        console.log('[linkedin-search-api] Bootstrapped JSESSIONID')
      }
    } catch (e) {
      console.warn('[linkedin-search-api] Bootstrap failed:', (e as Error).message)
    }
  }

  if (!jsessionId) jsessionId = `ajax:${Date.now()}`
  // Strip quotes LinkedIn wraps around it
  const csrfToken = jsessionId.replace(/^"(.*)"$/, '$1')

  const url = new URL(searchUrl)
  const keywords = url.searchParams.get('keywords') ?? ''
  const filters  = buildVoyagerFilters(url)

  const headers  = buildVoyagerHeaders(cookieHeader, csrfToken)
  const pageSize = 10
  let start      = 0
  const leads: ScrapedLead[] = []

  while (leads.length < maxLeads) {
    const params = new URLSearchParams({
      count:   String(pageSize),
      filters,
      origin:  'GLOBAL_SEARCH_HEADER',
      q:       'all',
      start:   String(start),
      ...(keywords ? { keywords } : {}),
    })

    const apiUrl = `https://www.linkedin.com/voyager/api/search/blended?${params.toString()}`
    console.log(`[linkedin-search-api] Fetching start=${start}: ${apiUrl.substring(0, 160)}`)

    let res: Response = null!
    let nextUrl = apiUrl
    let currentHeaders = { ...headers }

    try {
      let redirects = 0
      while (redirects <= 5) {
        const fetchOpts = { headers: currentHeaders, redirect: 'manual', ...(agent ? { dispatcher: agent } : {}) } as RequestInit
        res = await fetch(nextUrl, fetchOpts)
        if (res.status < 300 || res.status >= 400) break
        const location = res.headers.get('location') ?? nextUrl
        const setCookie = res.headers.get('set-cookie')
        if (setCookie) {
          const newCookies = setCookie.split(',').map(c => c.split(';')[0].trim()).join('; ')
          currentHeaders = { ...currentHeaders, Cookie: (currentHeaders['Cookie'] ?? '') + '; ' + newCookies }
        }
        nextUrl = location
        redirects++
      }
    } catch (fetchErr: unknown) {
      const err = fetchErr as Error
      throw new Error(`Network error fetching LinkedIn search API: ${err.message}`)
    }

    console.log(`[linkedin-search-api] Response status: ${res.status}`)

    if (res.status === 401 || res.status === 403) {
      throw new Error(`LinkedIn session expired (HTTP ${res.status}). Please reconnect from the Accounts page.`)
    }
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`LinkedIn redirected repeatedly — session may be expired.`)
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`LinkedIn search API error ${res.status}: ${body.slice(0, 200)}`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json()

    // Extract elements — the blended response nests results under elements[].elements[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allHits: any[] = []

    if (Array.isArray(data.elements)) {
      for (const cluster of data.elements) {
        if (Array.isArray(cluster.elements)) {
          allHits.push(...cluster.elements)
        } else {
          allHits.push(cluster)
        }
      }
    }

    if (allHits.length === 0) {
      console.log('[linkedin-search-api] No results in response — stopping')
      break
    }

    for (const hit of allHits) {
      const lead = mapVoyagerHit(hit)
      if (lead) {
        leads.push(lead)
        if (leads.length >= maxLeads) break
      }
    }

    onProgress?.(leads.length)

    const paging = data.paging ?? {}
    const total  = paging.total ?? 0
    start += pageSize

    if (!total || start >= total || start >= maxLeads) break
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800))
  }

  return leads
}

/** Returns true if the URL is a regular LinkedIn people search */
export function isLinkedInPeopleSearch(searchUrl: string): boolean {
  try {
    const u = new URL(searchUrl)
    return (
      u.hostname.includes('linkedin.com') &&
      u.pathname.startsWith('/search/results/people')
    )
  } catch {
    return false
  }
}
