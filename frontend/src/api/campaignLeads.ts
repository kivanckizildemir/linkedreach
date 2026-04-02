import { apiFetch } from '../lib/fetchJson'
const API = '/api'

export interface CampaignLead {
  id: string
  status: 'pending' | 'connection_sent' | 'connected' | 'messaged' | 'replied' | 'converted' | 'stopped'
  current_step: number
  last_action_at: string | null
  reply_classification: 'interested' | 'not_now' | 'wrong_person' | 'referral' | 'negative' | 'none'
  account_id: string | null
  created_at: string
  lead: {
    id: string
    first_name: string
    last_name: string
    title: string | null
    company: string | null
    industry: string | null
    location: string | null
    linkedin_url: string
    icp_score: number | null
    icp_flag: 'hot' | 'warm' | 'cold' | 'disqualified' | null
  }
}

export async function fetchCampaignLeads(campaignId: string): Promise<CampaignLead[]> {
  const res = await apiFetch(`${API}/campaigns/${campaignId}/leads`)
  if (!res.ok) throw new Error('Failed to fetch campaign leads')
  const { data } = await res.json() as { data: CampaignLead[] }
  return data ?? []
}

export async function assignLeads(
  campaignId: string,
  lead_ids: string[],
  account_id?: string
): Promise<{ added: number }> {
  const res = await apiFetch(`${API}/campaigns/${campaignId}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_ids, account_id }),
  })
  if (!res.ok) throw new Error('Failed to assign leads')
  return res.json() as Promise<{ added: number }>
}

export async function removeCampaignLead(campaignId: string, clId: string): Promise<void> {
  const res = await apiFetch(`${API}/campaigns/${campaignId}/leads/${clId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove lead from campaign')
}
