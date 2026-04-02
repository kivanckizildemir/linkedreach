import { apiFetch, parseErrorResponse } from '../lib/fetchJson'

export interface LeadLabel {
  id: string
  user_id: string
  name: string
  color: string
  created_at: string
}

export async function fetchLabels(): Promise<LeadLabel[]> {
  const res = await apiFetch('/api/labels')
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: LeadLabel[] }
  return data ?? []
}

export async function createLabel(name: string, color: string): Promise<LeadLabel> {
  const res = await apiFetch('/api/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: LeadLabel }
  return data
}

export async function updateLabel(id: string, updates: Partial<Pick<LeadLabel, 'name' | 'color'>>): Promise<LeadLabel> {
  const res = await apiFetch(`/api/labels/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: LeadLabel }
  return data
}

export async function deleteLabel(id: string): Promise<void> {
  const res = await apiFetch(`/api/labels/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export async function fetchLeadLabels(leadId: string): Promise<LeadLabel[]> {
  const res = await apiFetch(`/api/labels/lead/${leadId}`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: LeadLabel[] }
  return data ?? []
}

export async function assignLabel(leadId: string, labelId: string): Promise<void> {
  const res = await apiFetch(`/api/labels/lead/${leadId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label_id: labelId }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export async function removeLabel(leadId: string, labelId: string): Promise<void> {
  const res = await apiFetch(`/api/labels/lead/${leadId}/${labelId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}
