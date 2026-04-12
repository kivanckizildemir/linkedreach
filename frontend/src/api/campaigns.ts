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
  lead_priority: 'high_icp' | 'warm' | 'high_icp+warm' | 'low_icp' | 'fifo' | null
  min_icp_score: number
  connection_note: string | null
  target_audience: string | null
  product_id: string | null
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
  updates: Partial<Pick<Campaign, 'name' | 'status' | 'icp_config' | 'daily_connection_limit' | 'daily_message_limit' | 'schedule_start_hour' | 'schedule_end_hour' | 'schedule_days' | 'schedule_timezone' | 'account_id' | 'min_icp_score' | 'connection_note' | 'target_audience' | 'product_id' | 'lead_priority'>> & { message_approach?: string | null; message_tone?: string | null }
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

export type EngagementTrend = 'up' | 'down' | 'stable'

export interface CampaignLead {
  id: string
  status: string
  current_step: number
  last_action_at: string | null
  reply_classification: string
  engagement_score: number | null
  previous_engagement_score: number | null
  engagement_trend: EngagementTrend | null
  engagement_reasoning: string | null
  engagement_updated_at: string | null
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
    raw_data: {
      product_scores?: Record<string, { score: number; flag: string; reasoning: string }>
      best_product_id?: string
    } | null
  }
}

export interface CampaignActivityEntry {
  id: string
  action: string
  detail: string | null
  created_at: string
  account_id: string | null
  campaign_id: string | null
  lead_id: string | null
}

export async function fetchCampaignActivity(campaignId: string, limit = 50): Promise<CampaignActivityEntry[]> {
  const res = await apiFetch(`/api/activity?campaign_id=${campaignId}&limit=${limit}`)
  if (!res.ok) return []
  const { data } = await res.json() as { data: CampaignActivityEntry[] }
  return data ?? []
}

export async function fetchCampaignLeads(campaignId: string): Promise<CampaignLead[]> {
  const res = await apiFetch(`/api/campaigns/${campaignId}/leads`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: CampaignLead[] }
  return data ?? []
}

export async function addLeadsToCampaign(campaignId: string, leadIds: string[], accountId?: string | null): Promise<void> {
  const res = await apiFetch(`/api/campaigns/${campaignId}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lead_ids: leadIds, ...(accountId ? { account_id: accountId } : {}) }),
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

export async function scoreEngagement(campaignId: string, campaignLeadIds?: string[]): Promise<{ scored: number; total: number }> {
  const body = campaignLeadIds ? JSON.stringify({ campaign_lead_ids: campaignLeadIds }) : undefined
  const res = await apiFetch(`/api/campaigns/${campaignId}/score-engagement`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body,
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ scored: number; total: number }>
}

export interface AudienceSuggestion {
  target_titles: string[]
  target_industries: string[]
  target_locations: string[]
  min_company_size: number | null
  max_company_size: number | null
}

export async function extractAudienceFromProducts(
  products: Array<{ name: string; one_liner?: string; description?: string; target_use_case?: string }>,
): Promise<AudienceSuggestion> {
  const res = await apiFetch('/api/campaigns/extract-audience', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: AudienceSuggestion }
  return data
}

// ── Chat-based sequence generation ───────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GeneratedStep {
  type: string
  branch: string
  step_order: number
  message_template: string | null
  subject: string | null
  wait_days: number | null
  ai_generation_mode: boolean
  condition: Record<string, unknown> | null
  parent_step_id: string | null
}

export interface SequenceChatResult {
  reply: string
  steps: GeneratedStep[] | null
}

export async function chatSequence(
  campaignId: string,
  sequenceId: string | null,
  messages: ChatMessage[],
): Promise<SequenceChatResult> {
  const res = await apiFetch(`/api/campaigns/${campaignId}/chat-sequence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, sequenceId }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<SequenceChatResult>
}
