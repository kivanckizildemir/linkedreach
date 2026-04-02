import { supabase } from '../lib/supabase'
import { apiFetch, parseErrorResponse } from '../lib/fetchJson'

export interface Lead {
  id: string
  user_id: string
  linkedin_url: string
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  industry: string | null
  location: string | null
  icp_score: number | null
  icp_flag: 'hot' | 'warm' | 'cold' | 'disqualified' | null
  raw_data: { ai_reasoning?: string; ai_qualified_at?: string } | null
  source: 'excel_import' | 'chrome_extension' | 'manual'
  created_at: string
  updated_at: string
}

export async function requalifyLead(id: string): Promise<void> {
  const res = await apiFetch(`/api/leads/${id}/qualify`, { method: 'POST' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export async function qualifyAllLeads(): Promise<{ queued: number }> {
  const res = await apiFetch('/api/leads/qualify-all', { method: 'POST' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ queued: number }>
}

export async function importLeads(
  leads: Array<{
    linkedin_url: string
    first_name: string
    last_name: string
    title?: string
    company?: string
    industry?: string
    location?: string
    connection_degree?: number
    raw_data?: Record<string, unknown>
  }>
): Promise<{ imported: number }> {
  const res = await apiFetch('/api/leads/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leads }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ imported: number }>
}

export async function importLinkedInProfiles(
  urls: string[]
): Promise<{ imported: number; scraped: number }> {
  const res = await apiFetch('/api/leads/import-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ imported: number; scraped: number }>
}

export async function startSalesNavImport(
  search_url: string,
  account_id: string,
  max_leads: number
): Promise<{ job_id: string }> {
  const res = await apiFetch('/api/leads/import-sales-nav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search_url, account_id, max_leads }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ job_id: string }>
}

export interface ScrapeStatus {
  state: 'waiting' | 'active' | 'completed' | 'failed'
  progress: number
  result: { scraped: number; saved: number } | null
  error: string | null
}

export async function getScrapeStatus(jobId: string): Promise<ScrapeStatus> {
  const res = await apiFetch(`/api/leads/scrape-status/${jobId}`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<ScrapeStatus>
}

export interface LeadNote {
  id: string
  lead_id: string
  user_id: string
  content: string
  created_at: string
}

export async function fetchLeadNotes(leadId: string): Promise<LeadNote[]> {
  const res = await apiFetch(`/api/message-templates/lead-notes/${leadId}`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: LeadNote[] }
  return data
}

export async function addLeadNote(leadId: string, content: string): Promise<LeadNote> {
  const res = await apiFetch(`/api/message-templates/lead-notes/${leadId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: LeadNote }
  return data
}

export async function deleteLeadNote(noteId: string): Promise<void> {
  const res = await apiFetch(`/api/message-templates/lead-notes/note/${noteId}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export async function fetchLeads(params: {
  icp_flag?: string
  search?: string
} = {}): Promise<Lead[]> {
  let query = supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })

  if (params.icp_flag) {
    query = query.eq('icp_flag', params.icp_flag)
  }
  if (params.search) {
    const s = params.search
    query = query.or(
      `first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%`
    )
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as Lead[]
}
