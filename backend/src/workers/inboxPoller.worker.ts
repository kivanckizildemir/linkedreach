/**
 * Inbox Poller Worker — Voyager API edition.
 *
 * Polls LinkedIn's internal Voyager API directly using the stored li_at session
 * cookie — no browser launched, no Playwright, no proxy needed for reads.
 *
 * This is how HeyReach and PhantomBuster do it. It's ~10x faster, uses zero
 * server memory for browsers, and is far less detectable than launching a
 * headless browser every 10 minutes just to read messages.
 *
 * Flow per account:
 *   1. Extract li_at + JSESSIONID from stored cookies
 *   2. GET /voyager/api/messaging/conversations  → list of threads
 *   3. For each thread: GET /voyager/api/messaging/conversations/{urn}/events
 *   4. Match threads to campaign_leads by profileUrn / publicIdentifier
 *   5. Insert new messages, classify replies, update campaign_lead status
 *
 * On session expiry (401 or redirect to /login): marks account paused.
 */

import { supabase } from '../lib/supabase'
import { extractCookies } from '../linkedin/session'
import { classifyReply } from '../ai/classify'
import { acquireAccountLock } from '../lib/accountLock'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { getExistingContext, getOrCreateBrowserSession, invalidateBrowserSession } from '../lib/browserPool'
import type { AccountRecord } from '../linkedin/session'
import type { BrowserContext } from 'playwright'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Account {
  id: string
  cookies: string
  proxy_id: string | null
  status: string
}

interface VoyagerConversation {
  entityUrn: string              // "urn:li:msg_conversation:..."
  conversationParticipants?: {
    com$linkedin$voyager$messaging$MessagingMember?: {
      miniProfile?: {
        publicIdentifier?: string
        objectUrn?: string       // "urn:li:member:123456"
      }
    }
  }[]
  lastActivityAt?: number
  read?: boolean
}

interface VoyagerMessage {
  entityUrn: string
  author: string                 // "urn:li:member:123456"
  createdAt: number
  eventContent?: {
    com$linkedin$voyager$messaging$event$MessageEvent?: {
      attributedBody?: { text?: string }
    }
  }
}

// ── Voyager API helpers ───────────────────────────────────────────────────────

function buildVoyagerHeaders(
  allCookies: Array<{ name: string; value: string }>,
  csrfToken: string
) {
  // Build Cookie header from ALL stored cookies — LinkedIn's messaging API requires
  // more than just li_at+JSESSIONID (bcookie, bscookie, lidc, lang, etc.)
  // Format: name=value pairs separated by "; "
  // JSESSIONID value may be stored with outer quotes ("ajax:XXX") — strip them for the Cookie header
  const cookieHeader = allCookies
    .map(c => {
      const val = c.name === 'JSESSIONID'
        ? c.value.replace(/^"|"$/g, '')   // strip outer quotes → ajax:XXX
        : c.value
      return `${c.name}=${val}`
    })
    .join('; ')

  return {
    'Cookie':                      cookieHeader,
    'Csrf-Token':                  `ajax:${csrfToken}`,
    'User-Agent':                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                      'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language':             'en-US,en;q=0.9',
    'Accept-Encoding':             'gzip, deflate, br',
    'x-li-lang':                   'en_US',
    'x-li-track':                  JSON.stringify({ clientVersion: '2024.4.0', osName: 'web', timezoneOffset: 0 }),
    'x-restli-protocol-version':   '2.0.0',
    'x-li-page-instance':          'urn:li:page:d_flagship3_messaging;',
    'Referer':                     'https://www.linkedin.com/messaging/',
    'Origin':                      'https://www.linkedin.com',
    'sec-fetch-site':              'same-origin',
    'sec-fetch-mode':              'cors',
    'sec-fetch-dest':              'empty',
    'sec-ch-ua':                   '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile':            '?0',
    'sec-ch-ua-platform':          '"Windows"',
    'dnt':                         '1',
  }
}

/**
 * Make a Voyager API request using the Playwright browser context.
 * This uses the browser's own authenticated session, which has all the
 * correct cookies and session state that LinkedIn requires.
 */
async function voyagerGetViaContext(
  path: string,
  csrfToken: string,
  context: BrowserContext
): Promise<unknown> {
  console.log(`[inbox] GET ${path} via playwright-context`)
  const res = await context.request.get(`https://www.linkedin.com${path}`, {
    headers: {
      'Accept':                    'application/vnd.linkedin.normalized+json+2.1',
      'Accept-Language':           'en-US,en;q=0.9',
      'x-li-lang':                 'en_US',
      'x-li-track':                JSON.stringify({ clientVersion: '2024.4.0', osName: 'web', timezoneOffset: 0 }),
      'x-restli-protocol-version': '2.0.0',
      'x-li-page-instance':        'urn:li:page:d_flagship3_messaging;',
      'Csrf-Token':                `ajax:${csrfToken}`,
      'Referer':                   'https://www.linkedin.com/messaging/',
      'Origin':                    'https://www.linkedin.com',
    },
  })
  console.log(`[inbox] context-request response: ${res.status()} for ${path}`)
  if (res.status() === 401) throw new Error('SESSION_EXPIRED')
  if (!res.ok()) {
    const body = await res.text().catch(() => '')
    throw new Error(`Voyager ${path} → ${res.status()} | ${body.slice(0, 300)}`)
  }
  const text = await res.text()
  try { return JSON.parse(text) }
  catch { throw new Error(`Voyager: invalid JSON from ${path}`) }
}

async function voyagerGet(path: string, headers: Record<string, string>, proxyUrl?: string): Promise<unknown> {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const fetchFn = dispatcher ? undiciFetch : fetch

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (fetchFn as any)(`https://www.linkedin.com${path}`, { headers, dispatcher })
  if (res.status === 401 || res.redirected) throw new Error('SESSION_EXPIRED')
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const preview = body.slice(0, 300)
    throw new Error(`Voyager ${path} → ${res.status} | ${preview}`)
  }

  const text = await res.text()
  // Voyager returns normalized+json: strip the outer wrapper if present
  try { return JSON.parse(text) }
  catch { throw new Error(`Voyager: invalid JSON from ${path}`) }
}

/** Extract the other participant's publicIdentifier from a conversation */
function getParticipantIdentifier(conv: VoyagerConversation, myMemberUrn: string): string | null {
  if (!conv.conversationParticipants) return null
  for (const p of conv.conversationParticipants) {
    const member = p['com$linkedin$voyager$messaging$MessagingMember']
    if (!member?.miniProfile) continue
    const memberUrn = member.miniProfile.objectUrn ?? ''
    if (memberUrn === myMemberUrn) continue   // skip self
    return member.miniProfile.publicIdentifier ?? null
  }
  return null
}

/** Extract the text body from a Voyager event */
function getMessageText(event: VoyagerMessage): string {
  return event.eventContent
    ?.['com$linkedin$voyager$messaging$event$MessageEvent']
    ?.attributedBody?.text ?? ''
}

// ── Core per-account poll ─────────────────────────────────────────────────────

async function pollAccountInbox(account: Account): Promise<void> {
  // ── 0. Resolve proxy URL for this account ─────────────────────────────────
  // The li_at session is bound to the proxy IP. Voyager requests must use the
  // same proxy — otherwise LinkedIn rejects messaging endpoints with 500.
  let proxyUrl: string | undefined
  if (account.proxy_id && process.env.DISABLE_PROXY !== 'true') {
    try {
      const { data: proxyRow } = await supabase
        .from('proxies').select('proxy_url').eq('id', account.proxy_id).single()
      if (proxyRow) proxyUrl = (proxyRow as { proxy_url: string }).proxy_url
    } catch { /* proxy fetch failure is non-fatal — proceed without proxy */ }
  }

  // ── 1. Extract session credentials ────────────────────────────────────────
  const allCookies = extractCookies(account.cookies)
  const liAt = allCookies.find(c => c.name === 'li_at')?.value
  if (!liAt) {
    console.log(`[inbox] No li_at for account ${account.id} — skipping`)
    return
  }

  // CSRF token comes from JSESSIONID: strip outer quotes and "ajax:" prefix.
  // The Csrf-Token header needs just the numeric part.
  const jsessionid = allCookies.find(c => c.name === 'JSESSIONID')?.value
  if (!jsessionid) {
    console.log(`[inbox] No JSESSIONID for account ${account.id} — skipping`)
    return
  }
  const jsessionidUnquoted = jsessionid.replace(/^"|"$/g, '')  // → "ajax:XXXXXXXXXX"
  const csrfToken = jsessionidUnquoted.replace(/^ajax:/, '')   // → "XXXXXXXXXX" (numeric only)

  const headers = buildVoyagerHeaders(allCookies, csrfToken)

  // ── 2. Identify self (to skip own messages when parsing threads) ───────────
  let myMemberUrn = ''
  let myPlainId = 0
  try {
    // /me response uses normalized format: data['*miniProfile'] = urn, plainId = numeric
    const me = await voyagerGet('/voyager/api/me', headers, proxyUrl) as {
      data?: { plainId?: number; '*miniProfile'?: string; miniProfile?: { objectUrn?: string } }
      miniProfile?: { objectUrn?: string }
    }
    // New format: data.plainId is the numeric member ID, build the urn manually
    if (me?.data?.plainId) {
      myMemberUrn = `urn:li:member:${me.data.plainId}`
      myPlainId = me.data.plainId
    } else {
      myMemberUrn = me?.data?.miniProfile?.objectUrn ?? me?.miniProfile?.objectUrn ?? ''
    }
  } catch (err) {
    const msg = (err as Error).message
    // Non-fatal — we can still poll without knowing our own URN.
    // Session management is the responsibility of the sequence runner and keep-alive worker.
    console.warn(`[inbox] Could not fetch /me for ${account.id}: ${msg.slice(0, 150)}`)
  }

  // ── 3. Fetch conversations ─────────────────────────────────────────────────
  // Strategy A: use the Playwright browser context.
  // Prefer an existing warm session; if none exists, create one — this is the
  // most reliable approach since the browser carries the full session state that
  // LinkedIn's messaging API requires (which raw HTTP requests cannot replicate).
  // Only use an existing warm browser context — NEVER create a new session here.
  // Creating a new browser session triggers a LinkedIn "new device login" notification
  // and holds the account lock unnecessarily. If no session exists, fall through to
  // direct HTTP (Strategy B). The sequence runner creates sessions when it needs them.
  const browserCtx: BrowserContext | null = getExistingContext(account.id)
  let conversations: VoyagerConversation[] = []
  let convFetched = false

  if (browserCtx) {
    const mailboxUrn = myPlainId ? encodeURIComponent(`urn:li:mailbox:${myPlainId}`) : ''
    const ctxEndpoints = [
      ...(mailboxUrn ? [`/voyager/api/messaging/conversations?mailboxUrn=${mailboxUrn}&start=0&count=20`] : []),
      '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&start=0&count=20',
      '/voyager/api/messaging/conversations?start=0&count=20',
    ]
    for (const endpoint of ctxEndpoints) {
      try {
        const resp = await voyagerGetViaContext(endpoint, csrfToken, browserCtx) as { elements?: VoyagerConversation[] }
        conversations = resp?.elements ?? []
        convFetched = true
        console.log(`[inbox] Context-based fetch succeeded: ${conversations.length} conversations`)
        break
      } catch (err) {
        const msg = (err as Error).message
        if (msg.includes('SESSION_EXPIRED')) {
          // Browser context confirmed session is expired — trigger background reconnect
          // but don't pause the account here (keep-alive handles reconnection)
          console.warn(`[inbox] Browser context got 401 for ${account.id} — invalidating session for reconnect`)
          invalidateBrowserSession(account.id)
          break
        }
        // LinkedIn returns 500 for accounts with empty inboxes — treat as no conversations
        if (msg.includes('→ 500') && msg.includes('{"data":{"status":500}')) {
          console.log(`[inbox] Conversations endpoint returned 500 — likely empty inbox for ${account.id}`)
          convFetched = true  // mark as "fetched" so we don't retry unnecessarily
          break
        }
        console.warn(`[inbox] Context endpoint ${endpoint} failed: ${msg.slice(0, 150)}`)
      }
    }
  }

  // Strategy B: direct HTTP with manually built cookie header (fallback)
  if (!convFetched) {
    const mailboxUrn = myPlainId ? encodeURIComponent(`urn:li:mailbox:${myPlainId}`) : ''
    const convEndpoints = [
      ...(mailboxUrn ? [`/voyager/api/messaging/conversations?mailboxUrn=${mailboxUrn}&start=0&count=20`] : []),
      '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&start=0&count=20',
      '/voyager/api/messaging/conversations?start=0&count=20',
    ]
    for (const endpoint of convEndpoints) {
      try {
        const resp = await voyagerGet(endpoint, headers, proxyUrl) as { elements?: VoyagerConversation[] }
        conversations = resp?.elements ?? []
        convFetched = true
        if (conversations.length > 0) break
      } catch (err) {
        const msg = (err as Error).message
        if (msg.includes('SESSION_EXPIRED')) {
          // Direct HTTP getting 401 is less reliable than browser context (anti-bot, stale cookies).
          // Don't pause — just skip this endpoint and continue.
          console.warn(`[inbox] Direct HTTP got SESSION_EXPIRED for ${account.id} — skipping endpoint`)
          continue
        }
        // LinkedIn returns 500 for accounts with empty inboxes — treat as no conversations
        if (msg.includes('→ 500') && msg.includes('{"data":{"status":500}')) {
          console.log(`[inbox] Conversations endpoint returned 500 — likely empty inbox for ${account.id}`)
          convFetched = true
          break
        }
        console.warn(`[inbox] Direct endpoint ${endpoint} failed: ${msg.slice(0, 150)}`)
      }
    }
  }

  if (!convFetched) {
    console.error(`[inbox] All conversation fetch strategies failed for ${account.id}`)
    return
  }

  if (conversations.length === 0) return

  // ── 4. Process each conversation ──────────────────────────────────────────
  for (const conv of conversations) {
    const publicIdentifier = getParticipantIdentifier(conv, myMemberUrn)
    if (!publicIdentifier) continue

    // Find the lead in DB — match against the /in/ identifier.
    // Leads imported from Sales Nav may still have a /sales/lead/ URL so we
    // search by publicIdentifier substring which works for both URL formats.
    // Also try the normalised full /in/ URL as an exact match for speed.
    const normalizedUrl = `https://www.linkedin.com/in/${publicIdentifier}`
    const { data: leads } = await supabase
      .from('leads')
      .select('id, linkedin_url')
      .or(`linkedin_url.ilike.%${publicIdentifier}%`)
      .limit(5)   // grab a few candidates in case of trailing-slash variants

    // Pick the best match: prefer exact /in/ URL, fall back to first result
    const matchedLead = (leads ?? []).find(
      (l: { id: string; linkedin_url: string }) =>
        l.linkedin_url.replace(/\/$/, '') === normalizedUrl
    ) ?? leads?.[0]

    if (!matchedLead) continue
    const leadId = (matchedLead as { id: string }).id

    // Find the campaign_lead for this account + lead
    const { data: campaignLeads } = await supabase
      .from('campaign_leads')
      .select('id, reply_classification')
      .eq('lead_id', leadId)
      .eq('account_id', account.id)
      .limit(1)

    if (!campaignLeads || campaignLeads.length === 0) continue
    const cl = campaignLeads[0] as { id: string; reply_classification: string }

    // Fetch messages in this conversation
    const convUrnEncoded = encodeURIComponent(conv.entityUrn)
    const eventsPath = `/voyager/api/messaging/conversations/${convUrnEncoded}/events?count=20`
    let events: VoyagerMessage[] = []
    try {
      let eventsResp: { elements?: VoyagerMessage[] } | null = null
      if (browserCtx) {
        try {
          eventsResp = await voyagerGetViaContext(eventsPath, csrfToken, browserCtx) as { elements?: VoyagerMessage[] }
        } catch { /* fall through to direct */ }
      }
      if (!eventsResp) {
        eventsResp = await voyagerGet(eventsPath, headers, proxyUrl) as { elements?: VoyagerMessage[] }
      }
      events = eventsResp?.elements ?? []
    } catch (err) {
      console.warn(`[inbox] Could not fetch events for conv ${conv.entityUrn}: ${(err as Error).message}`)
      continue
    }

    // Build messages array from events
    const messages: { direction: 'sent' | 'received'; content: string; timestamp: string }[] = []
    for (const event of events) {
      const content = getMessageText(event)
      if (!content.trim()) continue

      const isSent = myMemberUrn
        ? event.author === myMemberUrn
        : event.author.includes(':member:')   // fallback heuristic

      messages.push({
        direction: isSent ? 'sent' : 'received',
        content,
        timestamp: new Date(event.createdAt).toISOString(),
      })
    }

    if (messages.length === 0) continue

    // Deduplicate against existing messages in DB
    const { data: existing } = await supabase
      .from('messages')
      .select('content, direction')
      .eq('campaign_lead_id', cl.id)

    const existingSet = new Set(
      (existing ?? []).map((m: { content: string; direction: string }) => `${m.direction}:${m.content}`)
    )

    const newMessages = messages.filter(m => !existingSet.has(`${m.direction}:${m.content}`))
    if (newMessages.length === 0) continue

    // Insert new messages
    await supabase.from('messages').insert(
      newMessages.map(m => ({
        campaign_lead_id: cl.id,
        direction:        m.direction,
        content:          m.content,
        sent_at:          m.timestamp,
      }))
    )

    // Classify the latest received message
    const received = newMessages.filter(m => m.direction === 'received')
    if (received.length > 0) {
      const latest = received[received.length - 1]
      try {
        const { classification } = await classifyReply(latest.content)
        await supabase
          .from('campaign_leads')
          .update({ reply_classification: classification, status: 'replied' })
          .eq('id', cl.id)

        console.log(`[inbox] Lead ${leadId} (${publicIdentifier}) → ${classification}`)
      } catch (err) {
        console.error(`[inbox] Classification failed for lead ${leadId}:`, err)
      }
    }
  }

  console.log(`[inbox] Polled account ${account.id} — ${conversations.length} conversations checked`)
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function pollAllInboxes(): Promise<void> {
  const { data: accounts, error } = await supabase
    .from('linkedin_accounts')
    .select('id, cookies, proxy_id, status')
    .in('status', ['active', 'warming_up'])

  if (error) {
    console.error('[inbox] Failed to fetch accounts:', error.message)
    return
  }

  if (!accounts || accounts.length === 0) return

  for (const acc of accounts as Account[]) {
    const release = await acquireAccountLock(acc.id)
    if (!release) {
      console.log(`[inbox] Account ${acc.id} locked — skipping poll cycle`)
      continue
    }
    try {
      await pollAccountInbox(acc)
    } catch (err) {
      console.error(`[inbox] Failed to poll account ${acc.id}:`, err)
    } finally {
      await release()
    }
  }
}

// Run every 10 minutes; first run after 2 minutes (no browser warm-up needed anymore)
export function startInboxPoller(): void {
  console.log('[inbox] Voyager API poller started — first run in 2 minutes, then every 10 minutes')
  setTimeout(() => {
    pollAllInboxes().catch(console.error)
    setInterval(() => pollAllInboxes().catch(console.error), 10 * 60 * 1000)
  }, 2 * 60 * 1000)
}
