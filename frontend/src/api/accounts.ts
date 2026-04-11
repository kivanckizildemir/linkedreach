import { supabase } from '../lib/supabase'
import { apiFetch, parseErrorResponse } from '../lib/fetchJson'

export interface LinkedInAccount {
  id: string
  user_id: string
  linkedin_email: string
  status: 'active' | 'paused' | 'banned' | 'warming_up'
  daily_connection_count: number
  daily_message_count: number
  warmup_day: number
  last_active_at: string | null
  has_premium: boolean
  inmail_credits: number
  proxy_id: string | null
  proxy_country: string | null
  sender_name: string | null
  sender_headline: string | null
  sender_about: string | null
  sender_experience: string | null
  sender_skills: string[]
  sender_recent_posts: string[]
  created_at: string
  updated_at: string
}

export async function fetchAccounts(): Promise<LinkedInAccount[]> {
  const { data, error } = await supabase
    .from('linkedin_accounts')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as LinkedInAccount[]
}

export async function createAccount(linkedin_email: string): Promise<LinkedInAccount> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const { data, error } = await supabase
    .from('linkedin_accounts')
    .insert({ linkedin_email, status: 'warming_up', warmup_day: 1, user_id: user.id })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as LinkedInAccount
}

export async function updateAccount(
  id: string,
  updates: Partial<Pick<LinkedInAccount, 'status' | 'proxy_country' | 'sender_name'>> & { proxy_id?: string | null; cookies?: string; status?: LinkedInAccount['status'] }
): Promise<LinkedInAccount> {
  const res = await apiFetch(`/api/accounts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: LinkedInAccount }
  return data
}

export async function deleteAccount(id: string): Promise<void> {
  const res = await apiFetch(`/api/accounts/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export type ConnectResult =
  | { status: 'starting'; session_key: string }

export type ConnectStatusResult =
  | { status: 'starting' }
  | { status: 'pending_push';       hint: string; pageUrl?: string }
  | { status: 'needs_verification'; hint: string }
  | { status: 'success' }
  | { status: 'error';   message: string }
  | { status: 'not_found' }

export async function getConnectStatus(accountId: string, sessionKey: string): Promise<ConnectStatusResult> {
  const res = await apiFetch(`/api/accounts/${accountId}/connect-status/${sessionKey}`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<ConnectStatusResult>
}

export async function connectAccount(
  accountId:   string,
  email:       string,
  password:    string,
  totp_secret?: string
): Promise<ConnectResult> {
  const res = await apiFetch(`/api/accounts/${accountId}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, totp_secret }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<ConnectResult>
}

export async function checkPushApproval(accountId: string, sessionKey: string): Promise<ConnectStatusResult> {
  const res = await apiFetch(`/api/accounts/${accountId}/connect-check/${sessionKey}`, { method: 'POST' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<ConnectStatusResult>
}

export async function verifyConnectCode(
  accountId: string,
  sessionKey: string,
  code: string
): Promise<{ status: 'success' } | { status: 'error'; message: string }> {
  const res = await apiFetch(`/api/accounts/${accountId}/connect-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_key: sessionKey, code }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ status: 'success' } | { status: 'error'; message: string }>
}

export async function requestVerificationCode(
  accountId: string,
  sessionKey: string
): Promise<{ status: 'switching' | 'already_on_code' | 'error'; message: string }> {
  const res = await apiFetch(`/api/accounts/${accountId}/request-code/${sessionKey}`, { method: 'POST' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ status: 'switching' | 'already_on_code' | 'error'; message: string }>
}

export async function testHealthCheck(accountId: string): Promise<{ ok: boolean; message: string }> {
  const res = await apiFetch(`/api/accounts/${accountId}/health-check`, { method: 'POST' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ ok: boolean; message: string }>
}

export async function interactWithSession(
  accountId: string,
  sessionKey: string,
  action:
    | { type: 'click'; x: number; y: number }
    | { type: 'type';  text: string }
    | { type: 'key';   key: string }
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`/api/accounts/${accountId}/connect-interact/${sessionKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

export async function startManualSession(accountId: string): Promise<ConnectResult> {
  const res = await apiFetch(`/api/accounts/${accountId}/start-manual-session`, { method: 'POST' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<ConnectResult>
}

export async function loginBrowser(accountId: string): Promise<{ message: string }> {
  const res = await apiFetch(`/api/accounts/${accountId}/login-browser`, { method: 'POST' })
  if (!res.ok) {
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      const body = await res.json() as { error?: string; message?: string }
      // Surface NO_DISPLAY as a recognisable error code
      if (body.error === 'NO_DISPLAY') throw new Error('NO_DISPLAY')
      throw new Error(body.message ?? body.error ?? `Request failed (${res.status})`)
    }
    throw new Error(await parseErrorResponse(res))
  }
  return res.json() as Promise<{ message: string }>
}

export async function requestSessionExport(
  accountId: string
): Promise<{ ok: boolean; cookieCount?: number }> {
  const res = await apiFetch(`/api/accounts/${accountId}/request-session-export`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json() as { error?: string }
    throw new Error(body.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<{ ok: boolean; cookieCount?: number }>
}

