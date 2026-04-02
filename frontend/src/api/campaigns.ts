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
  updates: Partial<Pick<Campaign, 'name' | 'status' | 'icp_config' | 'daily_connection_limit' | 'daily_message_limit'>>
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
