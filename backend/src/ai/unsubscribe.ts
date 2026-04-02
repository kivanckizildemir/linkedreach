/**
 * Unsubscribe / opt-out keyword detection.
 * Called when a new inbound message arrives.
 * If the message matches unsubscribe intent, auto-adds the lead to the blacklist.
 */

import { supabase } from '../lib/supabase'

const UNSUBSCRIBE_PATTERNS = [
  /\bplease (remove|unsubscribe|stop|opt.?out)\b/i,
  /\b(unsubscribe|opt.?out|remove me|stop emailing|stop messaging|not interested|do not contact|don.?t contact|leave me alone|take me off)\b/i,
  /\bno (thanks|thank you|interest)\b/i,
]

export function detectUnsubscribe(text: string): boolean {
  return UNSUBSCRIBE_PATTERNS.some(p => p.test(text))
}

/**
 * Auto-blacklist a lead's LinkedIn profile URL when an unsubscribe is detected.
 * Also records in activity_log.
 */
export async function handleUnsubscribe(params: {
  userId: string
  leadId: string
  campaignLeadId: string
  messageContent: string
}): Promise<void> {
  const { userId, leadId, campaignLeadId, messageContent } = params

  if (!detectUnsubscribe(messageContent)) return

  // Fetch the lead's LinkedIn URL
  const { data: lead } = await supabase
    .from('leads')
    .select('linkedin_url, first_name, last_name')
    .eq('id', leadId)
    .single()

  if (!lead?.linkedin_url) return

  // Extract domain-like identifier from LinkedIn URL
  const profileSlug = lead.linkedin_url.replace(/\/$/, '').split('/').pop() ?? lead.linkedin_url

  // Add to blacklist (ignore duplicates) — store the normalized LinkedIn profile URL
  await supabase
    .from('blacklist')
    .upsert(
      {
        user_id: userId,
        type: 'domain',
        value: lead.linkedin_url.toLowerCase().trim().replace(/\/$/, ''),
        note: `Auto-blacklisted: opt-out detected — "${messageContent.slice(0, 80)}"`,
      },
      { onConflict: 'user_id,type,value', ignoreDuplicates: true }
    )

  // Update campaign_lead status to stopped (opted out)
  await supabase
    .from('campaign_leads')
    .update({ status: 'stopped', reply_classification: 'negative' })
    .eq('id', campaignLeadId)

  // Log to activity
  await supabase
    .from('activity_log')
    .insert({
      user_id: userId,
      lead_id: leadId,
      action: 'unsubscribed',
      detail: `${lead.first_name} ${lead.last_name} opted out — profile blacklisted`,
    })
}
