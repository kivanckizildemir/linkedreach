/**
 * Inbox Poller Worker
 *
 * Runs every 10 minutes. For each active LinkedIn account:
 *   1. Opens LinkedIn messaging via Playwright
 *   2. Reads unread conversation threads
 *   3. Matches threads to campaign_leads by linkedin_url
 *   4. Saves new messages to the `messages` table
 *   5. Classifies replies using Claude API
 *   6. Updates campaign_lead status → 'replied' and reply_classification
 */

import { supabase } from '../lib/supabase'
import { createSession, closeSession, persistCookies, safeNavigate } from '../linkedin/session'
import { detectAndHandleChallenge } from '../linkedin/session'
import { classifyReply } from '../ai/classify'

interface Account {
  id: string
  cookies: string
  proxy_id: string | null
  status: string
  daily_connection_count: number
  daily_message_count: number
  has_premium: boolean
}

interface ConversationSnippet {
  profileUrl: string
  messages: { direction: 'sent' | 'received'; content: string; timestamp: string }[]
}

async function pollAccountInbox(account: Account): Promise<void> {
  const { browser, context, page } = await createSession(account)

  try {
    await safeNavigate(page, 'https://www.linkedin.com/messaging/', account.id)
    await page.waitForTimeout(3000)

    await detectAndHandleChallenge(page, account.id)

    // Collect all visible conversation list items
    const convItems = await page.$$('.msg-conversation-listitem__link')
    if (convItems.length === 0) return

    const snippets: ConversationSnippet[] = []

    for (const item of convItems.slice(0, 20)) {
      // Click to open conversation
      await item.click()
      await page.waitForTimeout(1500)

      // Get the profile URL from the conversation header link
      const profileLink = await page.$('.msg-thread__link-to-profile')
      if (!profileLink) continue

      const profileUrl = await profileLink.getAttribute('href')
      if (!profileUrl) continue

      const fullProfileUrl = profileUrl.startsWith('http')
        ? profileUrl
        : `https://www.linkedin.com${profileUrl}`

      // Read all messages in the thread
      const msgElements = await page.$$('.msg-s-message-list__event')
      const messages: ConversationSnippet['messages'] = []

      for (const el of msgElements) {
        const isSent = await el.$('.msg-s-message-group--outgoing')
        const contentEl = await el.$('.msg-s-event-listitem__body')
        const timeEl = await el.$('time')

        const content = contentEl ? (await contentEl.innerText()).trim() : ''
        const timestamp = timeEl ? (await timeEl.getAttribute('datetime') ?? new Date().toISOString()) : new Date().toISOString()

        if (content) {
          messages.push({
            direction: isSent ? 'sent' : 'received',
            content,
            timestamp,
          })
        }
      }

      if (messages.length > 0) {
        snippets.push({ profileUrl: fullProfileUrl, messages })
      }
    }

    // Match each conversation to a campaign_lead and persist
    for (const snippet of snippets) {
      // Find lead by linkedin_url (normalize trailing slash)
      const normalised = snippet.profileUrl.replace(/\/$/, '')
      const { data: leads } = await supabase
        .from('leads')
        .select('id')
        .ilike('linkedin_url', `%${normalised.split('/').pop()}%`)
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

      // Check which messages are already saved
      const { data: existing } = await supabase
        .from('messages')
        .select('content, direction')
        .eq('campaign_lead_id', cl.id)

      const existingSet = new Set(
        (existing ?? []).map((m: { content: string; direction: string }) => `${m.direction}:${m.content}`)
      )

      const newMessages = snippet.messages.filter(
        m => !existingSet.has(`${m.direction}:${m.content}`)
      )

      if (newMessages.length === 0) continue

      // Save new messages
      await supabase.from('messages').insert(
        newMessages.map(m => ({
          campaign_lead_id: cl.id,
          direction: m.direction,
          content: m.content,
          sent_at: m.timestamp,
        }))
      )

      // Classify the latest received message if not yet classified
      const receivedMessages = newMessages.filter(m => m.direction === 'received')
      if (receivedMessages.length > 0 && cl.reply_classification === 'none') {
        const latest = receivedMessages[receivedMessages.length - 1]
        try {
          const { classification } = await classifyReply(latest.content)
          await supabase
            .from('campaign_leads')
            .update({
              reply_classification: classification,
              status: 'replied',
            })
            .eq('id', cl.id)

          console.log(`[inbox] Lead ${leadId} classified as: ${classification}`)
        } catch (err) {
          console.error(`[inbox] Classification failed for lead ${leadId}:`, err)
        }
      }
    }

    await persistCookies(context, account.id)
  } finally {
    await closeSession(browser)
  }
}

export async function pollAllInboxes(): Promise<void> {
  const { data: accounts, error } = await supabase
    .from('linkedin_accounts')
    .select('*')
    .in('status', ['active', 'warming_up'])

  if (error) {
    console.error('[inbox] Failed to fetch accounts:', error.message)
    return
  }

  if (!accounts || accounts.length === 0) return

  for (const acc of accounts as Account[]) {
    try {
      await pollAccountInbox(acc)
    } catch (err) {
      console.error(`[inbox] Failed to poll account ${acc.id}:`, err)
    }
  }
}

// Run every 10 minutes
export function startInboxPoller(): void {
  console.log('[inbox] Poller started — running every 10 minutes')
  pollAllInboxes().catch(console.error)
  setInterval(() => pollAllInboxes().catch(console.error), 10 * 60 * 1000)
}
