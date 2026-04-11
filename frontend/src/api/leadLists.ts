import { apiFetch } from '../lib/fetchJson'

export interface LeadList {
  id: string
  name: string
  source: 'sales_nav' | 'excel' | 'manual' | 'chrome_extension' | 'linkedin_search'
  search_url: string | null
  created_at: string
  lead_count?: number
  campaign_count?: number
}

export async function fetchLeadList(id: string): Promise<LeadList> {
  const res = await apiFetch(`/api/lead-lists/${id}`)
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'List not found') }
  const json = await res.json() as { data: LeadList }
  return json.data
}

export async function fetchLeadLists(): Promise<LeadList[]> {
  const res = await apiFetch('/api/lead-lists')
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed to fetch lists') }
  const json = await res.json() as { data: LeadList[] }
  return json.data ?? []
}

export async function createLeadList(name: string): Promise<LeadList> {
  const res = await apiFetch('/api/lead-lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed to create list') }
  const json = await res.json() as { data: LeadList }
  return json.data
}

export async function renameLeadList(id: string, name: string): Promise<LeadList> {
  const res = await apiFetch(`/api/lead-lists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed to rename list') }
  const json = await res.json() as { data: LeadList }
  return json.data
}

export async function deleteLeadList(id: string): Promise<void> {
  await apiFetch(`/api/lead-lists/${id}`, { method: 'DELETE' })
}

export async function importSalesNavList(payload: {
  list_name: string
  search_url: string
  account_id: string
  max_leads?: number
  source_type?: string
}): Promise<{ job_id: string; list_id: string; list_name: string }> {
  const res = await apiFetch('/api/lead-lists/import-sales-nav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Import failed') }
  return res.json() as Promise<{ job_id: string; list_id: string; list_name: string }>
}

export async function importExcelList(file: File, listName: string): Promise<{
  list_id: string; list_name: string; saved: number; skipped: number
}> {
  const form = new FormData()
  form.append('file', file)
  form.append('list_name', listName)
  const res = await apiFetch('/api/lead-lists/import-excel', { method: 'POST', body: form })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Import failed') }
  return res.json() as Promise<{ list_id: string; list_name: string; saved: number; skipped: number }>
}

export async function fetchListLeads(listId: string, params?: { icp_flag?: string; search?: string }) {
  const qs = new URLSearchParams()
  if (params?.icp_flag) qs.set('icp_flag', params.icp_flag)
  if (params?.search) qs.set('search', params.search)
  const res = await apiFetch(`/api/lead-lists/${listId}/leads?${qs}`)
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed to fetch leads') }
  const json = await res.json() as { data: unknown[] }
  return json.data ?? []
}

export async function combineList(id: string, source_list_id: string): Promise<{ added: number }> {
  const res = await apiFetch(`/api/lead-lists/${id}/combine`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_list_id }),
  })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed') }
  return res.json() as Promise<{ added: number }>
}

export async function intersectList(id: string, source_list_id: string): Promise<{ removed: number }> {
  const res = await apiFetch(`/api/lead-lists/${id}/intersect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_list_id }),
  })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed') }
  return res.json() as Promise<{ removed: number }>
}

export async function excludeFromList(id: string, source_list_id: string): Promise<{ removed: number }> {
  const res = await apiFetch(`/api/lead-lists/${id}/exclude`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_list_id }),
  })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed') }
  return res.json() as Promise<{ removed: number }>
}

export async function duplicateLeadList(id: string): Promise<LeadList> {
  const res = await apiFetch(`/api/lead-lists/${id}/duplicate`, { method: 'POST' })
  if (!res.ok) { const e = await res.json() as { error?: string }; throw new Error(e.error ?? 'Failed') }
  const { data } = await res.json() as { data: LeadList }
  return data
}

export async function scrapeIntoList(listId: string, payload: {
  search_url: string
  account_id: string
  max_leads?: number
  source_type?: string
}): Promise<{ job_id: string; list_id: string }> {
  const res = await apiFetch(`/api/lead-lists/${listId}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json() as { error?: string }
    throw new Error(err.error ?? 'Scrape failed')
  }
  return res.json() as Promise<{ job_id: string; list_id: string }>
}

export async function importExcelIntoList(listId: string, file: File): Promise<{ saved: number; skipped: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await apiFetch(`/api/lead-lists/${listId}/import-excel`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json() as { error?: string }
    throw new Error(err.error ?? 'Import failed')
  }
  return res.json() as Promise<{ saved: number; skipped: number }>
}

export async function getListScrapeStatus(jobId: string) {
  const res = await apiFetch(`/api/leads/scrape-status/${jobId}`)
  return res.json() as Promise<{ state: string; progress: number; result?: { scraped: number; saved: number }; error?: string }>
}

export async function cancelScrapeJob(jobId: string) {
  const res = await apiFetch(`/api/leads/scrape-status/${jobId}`, { method: 'DELETE' })
  return res.json() as Promise<{ ok: boolean }>
}
