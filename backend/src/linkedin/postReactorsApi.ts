/**
 * LinkedIn Post Reactors scraper.
 *
 * Fetches people who liked or commented on a LinkedIn post using the
 * Voyager API with the stored session cookie — no browser required.
 *
 * Supported URL formats:
 *   https://www.linkedin.com/posts/slug_activity-1234567890-XXXX/
 *   https://www.linkedin.com/feed/update/urn:li:activity:1234567890/
 *   https://www.linkedin.com/posts/slug_activity-1234567890/
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

function buildHeaders(cookieHeader: string, csrfToken: string) {
  return {
    Cookie: cookieHeader,
    'Csrf-Token': csrfToken,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-li-lang': 'en_US',
    'x-li-track': JSON.stringify({ clientVersion: '2024.1.0', osName: 'web', timezoneOffset: 0 }),
    'x-restli-protocol-version': '2.0.0',
    'x-li-page-instance': 'urn:li:page:feed_index_index;',
  }
}

/** Extract the activity URN from various LinkedIn post URL formats */
function extractActivityUrn(postUrl: string): string | null {
  try {
    const u = new URL(postUrl)

    // Format: /feed/update/urn:li:activity:123456/
    const feedMatch = u.pathname.match(/\/feed\/update\/(urn:li:activity:\d+)/)
    if (feedMatch) return feedMatch[1]

    // Format: /posts/slug_activity-123456-XXXX/ or /posts/slug_activity-123456/
    const postsMatch = u.pathname.match(/activity-(\d{15,19})/)
    if (postsMatch) return `urn:li:activity:${postsMatch[1]}`

    // Format: query param activityUrn
    const urnParam = u.searchParams.get('activityUrn')
    if (urnParam) return decodeURIComponent(urnParam)

    return null
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapReactor(entity: any): ScrapedLead | null {
  // Normalized LinkedIn response — navigate through included/elements structure
  const profile = entity?.reacter ?? entity?.commenter ?? entity?.actor ?? entity
  if (!profile) return null

  const name: string = profile.name?.text ?? profile.name ?? ''
  if (!name) return null

  const parts = name.trim().split(' ')
  const first_name = parts[0] ?? ''
  const last_name = parts.slice(1).join(' ')

  const title = profile.occupation ?? profile.headline?.text ?? profile.summary ?? null
  const company: string | null = null // reactions don't include company
  const location: string | null = profile.location?.basicLocation?.countryCode
    ? `${profile.location.basicLocation.city ?? ''} ${profile.location.basicLocation.countryCode}`.trim()
    : null

  const profileId: string = profile.publicIdentifier ?? profile.entityUrn?.split(':').pop() ?? ''
  const linkedin_url = profileId ? `https://www.linkedin.com/in/${profileId}/` : ''
  if (!linkedin_url) return null

  return { first_name, last_name, title, company, location, linkedin_url, connection_degree: null }
}

export async function scrapePostReactors(
  accountId: string,
  postUrl: string,
  maxLeads: number,
  onProgress?: (n: number) => void
): Promise<ScrapedLead[]> {
  const activityUrn = extractActivityUrn(postUrl)
  if (!activityUrn) throw new Error(`Could not extract activity URN from URL: ${postUrl}`)

  console.log(`[post-reactors] Activity URN: ${activityUrn}`)

  const { data: account, error } = await supabase
    .from('linkedin_accounts')
    .select('cookies')
    .eq('id', accountId)
    .single()

  if (error || !account?.cookies) throw new Error('Account not found or missing session cookie.')

  const cookies: CookieRecord[] = extractCookies(account.cookies as string)
  const liAt = cookies.find(c => c.name === 'li_at')?.value
  if (!liAt) throw new Error('No li_at cookie. Please reconnect from Accounts.')

  let cookieHeader = parseCookieHeader(cookies)
  let csrfToken = cookies.find(c => c.name === 'JSESSIONID')?.value ?? `ajax:${Date.now()}`
  // Strip quotes from JSESSIONID value if present
  csrfToken = csrfToken.replace(/^"(.*)"$/, '$1')

  const agent = getProxyAgent()
  const headers = buildHeaders(cookieHeader, csrfToken)

  const leads: ScrapedLead[] = []
  const seen = new Set<string>()

  // Fetch likes (reactions)
  try {
    let start = 0
    const pageSize = 50

    while (leads.length < maxLeads) {
      const url = `https://www.linkedin.com/voyager/api/reactions?entityUrn=${encodeURIComponent(activityUrn)}&count=${pageSize}&start=${start}`
      console.log(`[post-reactors] Fetching likes page start=${start}: ${url.substring(0, 120)}`)

      const res = await fetch(url, {
        headers,
        redirect: 'manual',
        ...(agent ? { dispatcher: agent } : {}),
      } as RequestInit)

      if (res.status === 401 || res.status === 403) {
        console.warn(`[post-reactors] Auth error ${res.status} on reactions endpoint — skipping likes`)
        break
      }
      if (!res.ok) {
        console.warn(`[post-reactors] Reactions endpoint returned ${res.status} — skipping likes`)
        break
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any
      const elements = data?.elements ?? data?.data?.elements ?? []
      if (!elements.length) break

      for (const el of elements) {
        if (leads.length >= maxLeads) break
        const lead = mapReactor(el)
        if (lead && !seen.has(lead.linkedin_url)) {
          seen.add(lead.linkedin_url)
          leads.push(lead)
          onProgress?.(leads.length)
        }
      }

      if (elements.length < pageSize) break
      start += pageSize
      await new Promise(r => setTimeout(r, 800 + Math.random() * 400))
    }
  } catch (e) {
    console.warn('[post-reactors] Likes fetch failed:', (e as Error).message)
  }

  // Fetch comments (commenters)
  try {
    let start = 0
    const pageSize = 50
    const encodedUrn = encodeURIComponent(activityUrn)

    while (leads.length < maxLeads) {
      const url = `https://www.linkedin.com/voyager/api/feed/comments?updateKey=${encodedUrn}&count=${pageSize}&start=${start}&commentsCount=${pageSize}`
      console.log(`[post-reactors] Fetching comments page start=${start}`)

      const res = await fetch(url, {
        headers,
        redirect: 'manual',
        ...(agent ? { dispatcher: agent } : {}),
      } as RequestInit)

      if (!res.ok) {
        console.warn(`[post-reactors] Comments endpoint returned ${res.status} — skipping comments`)
        break
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any
      const elements = data?.elements ?? []
      if (!elements.length) break

      for (const el of elements) {
        if (leads.length >= maxLeads) break
        const lead = mapReactor(el)
        if (lead && !seen.has(lead.linkedin_url)) {
          seen.add(lead.linkedin_url)
          leads.push(lead)
          onProgress?.(leads.length)
        }
      }

      if (elements.length < pageSize) break
      start += pageSize
      await new Promise(r => setTimeout(r, 800 + Math.random() * 400))
    }
  } catch (e) {
    console.warn('[post-reactors] Comments fetch failed:', (e as Error).message)
  }

  console.log(`[post-reactors] Total scraped: ${leads.length}`)
  return leads
}
