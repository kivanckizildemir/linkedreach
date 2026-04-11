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

function buildVoyagerHeaders(liAt: string, csrfToken: string) {
  return {
    'Cookie':                      `li_at=${liAt}; JSESSIONID="${csrfToken}"`,
    'Csrf-Token':                  `ajax:${csrfToken}`,
    'User-Agent':                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                      'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language':             'en-US,en;q=0.9',
    'x-li-lang':                   'en_US',
    'x-li-track':                  JSON.stringify({ clientVersion: '2024.4.0', osName: 'web', timezoneOffset: 0 }),
    'x-restli-protocol-version':   '2.0.0',
    'x-li-page-instance':          'urn:li:page:messaging_thread;',
    'Referer':                     'https://www.linkedin.com/messaging/',
  }
}

async function voyagerGet(path: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(`https://www.linkedin.com${path}`, { headers })

  if (res.status === 401 || res.redirected) throw new Error('SESSION_EXPIRED')
  if (!res.ok) throw new Error(`Voyager ${path} → ${res.status}`)

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
  // ── 1. Extract session credentials ────────────────────────────────────────
  const cookies = extractCookies(account.cookies)
  const liAt = cookies.find(c => c.name === 'li_at')?.value
  if (!liAt) {
    console.log(`[inbox] No li_at for account ${account.id} — skipping`)
    return
  }

  // JSESSIONID value is used as the CSRF token (without the "ajax:" prefix in the cookie value)
  const jsessionid = cookies.find(c => c.name === 'JSESSIONID')?.value
  if (!jsessionid) {
    console.log(`[inbox] No JSESSIONID for account ${account.id} — skipping`)
    return
  }
  // JSESSIONID is stored as "ajax:XXXXXXXXXX" in the cookie; strip the quotes if present
  const csrfToken = jsessionid.replace(/^"|"$/g, '').replace(/^ajax:/, '')

  const headers = buildVoyagerHeaders(liAt, csrfToken)

  // ── 2. Identify self (to skip own messages when parsing threads) ───────────
  let myMemberUrn = ''
  try {
    const me = await voyagerGet('/voyager/api/me', headers) as { miniProfile?: { objectUrn?: string } }
    myMemberUrn = me?.miniProfile?.objectUrn ?? ''
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('SESSION_EXPIRED')) {
      console.warn(`[inbox] Session expired for ${account.id}`)
      await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account.id)
      return
    }
    // Non-fatal — we can still poll without knowing our own URN
    console.warn(`[inbox] Could not fetch /me for ${account.id}: ${msg}`)
  }

  // ── 3. Fetch conversations ─────────────────────────────────────────────────
  let conversations: VoyagerConversation[] = []
  try {
    const resp = await voyagerGet(
      '/voyager/api/messaging/conversations?keyVersion=LEGACY_INBOX&start=0&count=20',
      headers
    ) as { elements?: VoyagerConversation[] }
    conversations = resp?.elements ?? []
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('SESSION_EXPIRED')) {
      console.warn(`[inbox] Session expired for ${account.id} — pausing`)
      await supabase.from('linkedin_accounts').update({ status: 'paused' }).eq('id', account.id)
      return
    }
    console.error(`[inbox] Conversation fetch failed for ${account.id}: ${msg}`)
    return
  }

  if (conversations.length === 0) return

  // ── 4. Process each conversation ──────────────────────────────────────────
  for (const conv of conversations) {
    const publicIdentifier = getParticipantIdentifier(conv, myMemberUrn)
    if (!publicIdentifier) continue

    const profileUrl = `https://www.linkedin.com/in/${publicIdentifier}/`

    // Find the lead in DB
    const { data: leads } = await supabase
      .from('leads')
      .select('id')
      .ilike('linkedin_url', `%${publicIdentifier}%`)
      .limit(1)

    if (!leads || leads.length === 0) continue
    const leadId = (leads[0] as { id: string }).id

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
    let events: VoyagerMessage[] = []
    try {
      const eventsResp = await voyagerGet(
        `/voyager/api/messaging/conversations/${convUrnEncoded}/events?count=20`,
        headers
      ) as { elements?: VoyagerMessage[] }
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
