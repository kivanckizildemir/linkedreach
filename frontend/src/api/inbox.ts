import { apiFetch } from '../lib/fetchJson'

export interface InboxMessage {
  id: string
  campaign_lead_id: string
  direction: 'sent' | 'received'
  content: string
  sent_at: string
  linkedin_message_id: string | null
  campaign_lead: {
    id: string
    status: string
    reply_classification: string
    lead: {
      id: string
      first_name: string
      last_name: string
      linkedin_url: string
      title: string | null
      company: string | null
    }
    campaign: {
      id: string
      name: string
    }
  }
}

export interface ThreadMessage {
  id: string
  campaign_lead_id: string
  direction: 'sent' | 'received'
  content: string
  sent_at: string
}

export type ReplyClassification = 'interested' | 'not_now' | 'wrong_person' | 'referral' | 'negative' | 'none'

export async function fetchInbox(classification?: string, campaign_id?: string): Promise<InboxMessage[]> {
  const params = new URLSearchParams()
  if (classification) params.set('classification', classification)
  if (campaign_id) params.set('campaign_id', campaign_id)
  const res = await apiFetch(`/api/inbox?${params}`)
  if (!res.ok) throw new Error('Failed to fetch inbox')
  const { data } = await res.json() as { data: InboxMessage[] }
  return data ?? []
}

export async function fetchThread(campaignLeadId: string): Promise<ThreadMessage[]> {
  const res = await apiFetch(`/api/inbox/${campaignLeadId}`)
  if (!res.ok) throw new Error('Failed to fetch thread')
  const { data } = await res.json() as { data: ThreadMessage[] }
  return data ?? []
}

export async function updateClassification(
  campaignLeadId: string,
  reply_classification: ReplyClassification
): Promise<void> {
  const res = await apiFetch(`/api/inbox/${campaignLeadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply_classification }),
  })
  if (!res.ok) throw new Error('Failed to update classification')
}

export async function getSuggestions(campaignLeadId: string): Promise<string[]> {
  const res = await apiFetch(`/api/inbox/${campaignLeadId}/suggest`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to get suggestions')
  const { suggestions } = await res.json() as { suggestions: string[] }
  return suggestions ?? []
}

export async function replyToConversation(
  campaignLeadId: string,
  message: string
): Promise<void> {
  const res = await apiFetch(`/api/inbox/${campaignLeadId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'Failed to send message')
  }
}
