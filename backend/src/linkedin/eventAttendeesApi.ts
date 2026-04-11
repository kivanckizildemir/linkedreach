/**
 * LinkedIn Event Attendees scraper.
 *
 * Fetches people attending or interested in a LinkedIn event using the
 * Voyager API with the stored session cookie — no browser required.
 *
 * Supported URL formats:
 *   https://www.linkedin.com/events/1234567890/
 *   https://www.linkedin.com/events/event-name-1234567890/
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
    'x-li-page-instance': 'urn:li:page:d_flagship3_event;',
  }
}

/** Extract numeric event ID from LinkedIn event URL */
function extractEventId(eventUrl: string): string | null {
  try {
    const u = new URL(eventUrl)
    // /events/1234567890/ or /events/event-name-1234567890/
    const match = u.pathname.match(/\/events\/(?:[^/]*-)?(\d{10,20})\/?/)
    if (match) return match[1]
    return null
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapAttendee(entity: any): ScrapedLead | null {
  const profile = entity?.member ?? entity?.profileView ?? entity?.miniProfile ?? entity
  if (!profile) return null

  const firstName: string = profile.firstName ?? profile.first_name ?? ''
  const lastName: string = profile.lastName ?? profile.last_name ?? ''
  const name: string = profile.name?.text ?? profile.name ?? `${firstName} ${lastName}`.trim()

  if (!name) return null

  const parts = name.trim().split(' ')
  const first = firstName || (parts[0] ?? '')
  const last = lastName || parts.slice(1).join(' ')

  const title: string | null = profile.occupation ?? profile.headline?.text ?? profile.title ?? null
  const location: string | null = profile.location?.basicLocation?.countryCode
    ? `${profile.location.basicLocation.city ?? ''} ${profile.location.basicLocation.countryCode}`.trim()
    : null

  const publicId: string = profile.publicIdentifier ?? profile.entityUrn?.split(':').pop() ?? ''
  const linkedin_url = publicId ? `https://www.linkedin.com/in/${publicId}/` : ''
  if (!linkedin_url) return null

  return { first_name: first, last_name: last, title, company: null, location, linkedin_url, connection_degree: null }
}

export async function scrapeEventAttendees(
  accountId: string,
  eventUrl: string,
  maxLeads: number,
  onProgress?: (n: number) => void
): Promise<ScrapedLead[]> {
  const eventId = extractEventId(eventUrl)
  if (!eventId) throw new Error(`Could not extract event ID from URL: ${eventUrl}`)

  console.log(`[event-attendees] Event ID: ${eventId}`)

  const { data: account, error } = await supabase
    .from('linkedin_accounts')
    .select('cookies')
    .eq('id', accountId)
    .single()

  if (error || !account?.cookies) throw new Error('Account not found or missing session cookie.')

  const cookies: CookieRecord[] = extractCookies(account.cookies as string)
  const liAt = cookies.find(c => c.name === 'li_at')?.value
  if (!liAt) throw new Error('No li_at cookie. Please reconnect from Accounts.')

  const cookieHeader = parseCookieHeader(cookies)
  let csrfToken = cookies.find(c => c.name === 'JSESSIONID')?.value ?? `ajax:${Date.now()}`
  csrfToken = csrfToken.replace(/^"(.*)"$/, '$1')

  const agent = getProxyAgent()
  const headers = buildHeaders(cookieHeader, csrfToken)

  const leads: ScrapedLead[] = []
  const seen = new Set<string>()

  // LinkedIn event attendees endpoint
  // /voyager/api/socialEvents/{eventId}/interests?q=attending
  // Statuses: ATTENDING, INTERESTED
  const statuses = ['ATTENDING', 'INTERESTED']

  for (const status of statuses) {
    if (leads.length >= maxLeads) break
    let start = 0
    const pageSize = 50

    while (leads.length < maxLeads) {
      const url = `https://www.linkedin.com/voyager/api/socialEvents/${eventId}/interests?q=${status.toLowerCase()}&count=${pageSize}&start=${start}`
      console.log(`[event-attendees] Fetching ${status} page start=${start}`)

      let res: Response
      try {
        res = await fetch(url, {
          headers,
          redirect: 'manual',
          ...(agent ? { dispatcher: agent } : {}),
        } as RequestInit)
      } catch (e) {
        console.warn(`[event-attendees] Fetch error for ${status}:`, (e as Error).message)
        break
      }

      if (res.status === 401 || res.status === 403) {
        console.warn(`[event-attendees] Auth error ${res.status} — stopping`)
        break
      }
      if (!res.ok) {
        console.warn(`[event-attendees] API returned ${res.status} for ${status} — skipping`)
        break
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any
      const elements = data?.elements ?? []
      if (!elements.length) break

      for (const el of elements) {
        if (leads.length >= maxLeads) break
        const lead = mapAttendee(el)
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
  }

  console.log(`[event-attendees] Total scraped: ${leads.length}`)
  return leads
}
