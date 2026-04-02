import { supabase } from './supabase'

/** Returns Authorization header with current Supabase session token. */
async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return {}
  return { Authorization: `Bearer ${session.access_token}` }
}

/** fetch() wrapper that auto-attaches the Supabase JWT. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const auth = await authHeaders()
  return fetch(input, {
    ...init,
    headers: {
      ...auth,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}

/** Parses error from a non-ok fetch response gracefully. */
export async function parseErrorResponse(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    try {
      const body = await res.json() as { error?: string; message?: string }
      return body.error ?? body.message ?? `Request failed (${res.status})`
    } catch { /* fall through */ }
  }
  return `Server error (${res.status}) — make sure the backend is running and configured.`
}
