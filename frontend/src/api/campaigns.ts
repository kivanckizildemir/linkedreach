import { supabase } from '../lib/supabase'
import { apiFetch, parseErrorResponse } from '../lib/fetchJson'

export interface Campaign {
  id: string
  user_id: string
  name: string
  status: 'draft' | 'active' | 'paused' | 'completed'
  icp_config: Record<string, unknown>
  daily_connection_limit: number
  daily_message_limit: number
  schedule_start_hour: number
  schedule_end_hour: number
  schedule_days: number[]
  schedule_timezone: string
  account_id: string | null
  min_icp_score: number
  connection_note: string | null
  created_at: string
  updated_at: string
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as Campaign[]
}

export async function createCampaign(name: string): Promise<Campaign> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { data, error } = await supabase
    .from('campaigns')
    .insert({ name, status: 'draft', user_id: user.id })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as Campaign
}

export async function updateCampaign(
  id: string,
  updates: Partial<Pick<Campaign, 'name' | 'status' | 'icp_config' | 'daily_connection_limit' | 'daily_message_limit' | 'schedule_start_hour' | 'schedule_end_hour' | 'schedule_days' | 'schedule_timezone' | 'account_id' | 'min_icp_score' | 'connection_note'>>
): Promise<Campaign> {
  const res = await apiFetch(`/api/campaigns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: Campaign }
  return data
}

export async function fetchCampaign(id: string): Promise<Campaign> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw new Error(error.message)
  return data as Campaign
}

export interface CampaignLead {
  id: string
  status: string
  reply_classification: string
  created_at: string
  lead: {
    id: string
    first_name: string
    last_name: string
    title: string | null
    company: string | null
    linkedin_url: string
    icp_flag: string | null
    icp_score: number | null
  }
}

export async function fetchCampaignLeads(campaignId: string): Promise<CampaignLead[]> {
  const res = await apiFetch(`/api/campaigns/${campaignId}/leads`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: CampaignLead[] }
  return data ?? []
}

export async function addLeadsToCampaign(campaignId: string, leadIds: string[]): Promise<void> {
  const res = await apiFetch(`/api/campaigns/${campaignId}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_ids: leadIds }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export async function removeCampaignLead(campaignId: string, clId: string): Promise<void> {
  const res = await apiFetch(`/api/campaigns/${campaignId}/leads/${clId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export async function deleteCampaign(id: string): Promise<void> {
  const res = await apiFetch(`/api/campaigns/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}
