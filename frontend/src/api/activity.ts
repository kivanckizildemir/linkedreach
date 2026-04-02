import { apiFetch, parseErrorResponse } from '../lib/fetchJson'

export interface ActivityEntry {
  id: string
  account_id: string | null
  campaign_id: string | null
  lead_id: string | null
  action: string
  detail: string | null
  created_at: string
}

export const ACTION_LABELS: Record<string, string> = {
  connection_sent:    'Connection request sent',
  connected:          'Connection accepted',
  message_sent:       'Message sent',
  reply_received:     'Reply received',
  qualified:          'Lead AI-qualified',
  campaign_started:   'Campaign started',
  campaign_paused:    'Campaign paused',
  account_paused:     'Account paused (warning)',
  error:              'Error occurred',
}

export const ACTION_COLORS: Record<string, string> = {
  connection_sent:  'bg-blue-100 text-blue-700',
  connected:        'bg-green-100 text-green-700',
  message_sent:     'bg-indigo-100 text-indigo-700',
  reply_received:   'bg-yellow-100 text-yellow-700',
  qualified:        'bg-purple-100 text-purple-700',
  campaign_started: 'bg-green-100 text-green-700',
  campaign_paused:  'bg-yellow-100 text-yellow-700',
  account_paused:   'bg-red-100 text-red-700',
  error:            'bg-red-100 text-red-700',
}

export async function fetchActivity(accountId?: string): Promise<ActivityEntry[]> {
  const params = accountId ? `?account_id=${accountId}` : ''
  const res = await apiFetch(`/api/activity${params}`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: ActivityEntry[] }
  return data ?? []
}
