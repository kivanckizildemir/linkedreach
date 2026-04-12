import { apiFetch, parseErrorResponse } from '../lib/fetchJson'

export interface Proxy {
  id: string
  label: string | null
  proxy_url: string          // credentials already masked by backend
  assigned_account_id: string | null
  is_available: boolean
  created_at: string
  country: string | null     // ISO 3166-1 alpha-2 (e.g. 'gb') for BrightData geo-targeting
  proxy_type: 'isp' | 'residential' | 'datacenter'  // 'residential' = rotating, needs sticky session
}

export interface BulkImportResult {
  data: Proxy[]
  imported: number
  skipped: number
  invalid: string[]
}

export async function fetchProxies(): Promise<Proxy[]> {
  const res = await apiFetch('/api/proxies')
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: Proxy[] }
  return data
}

export async function addProxy(proxy_url: string, label?: string, country?: string, proxy_type?: string): Promise<Proxy> {
  const res = await apiFetch('/api/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy_url, label: label || undefined, country: country?.toLowerCase() || undefined, proxy_type: proxy_type || undefined }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: Proxy }
  return data
}

export async function updateProxyType(id: string, proxy_type: string): Promise<Proxy> {
  const res = await apiFetch(`/api/proxies/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy_type }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: Proxy }
  return data
}

export async function updateProxyCountry(id: string, country: string | null): Promise<Proxy> {
  const res = await apiFetch(`/api/proxies/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: country?.toLowerCase() || null }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: Proxy }
  return data
}

export async function bulkImportProxies(lines: string, label_prefix?: string, proxy_type?: string): Promise<BulkImportResult> {
  const res = await apiFetch('/api/proxies/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines, label_prefix: label_prefix || undefined, proxy_type: proxy_type || undefined }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<BulkImportResult>
}

export async function updateProxyLabel(id: string, label: string): Promise<Proxy> {
  const res = await apiFetch(`/api/proxies/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  const { data } = await res.json() as { data: Proxy }
  return data
}

export async function assignProxy(proxyId: string, accountId: string | null): Promise<void> {
  const res = await apiFetch(`/api/proxies/${proxyId}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id: accountId }),
  })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}

export async function testProxy(proxyId: string): Promise<{ ok: boolean; result: string }> {
  const res = await apiFetch(`/api/proxies/${proxyId}/test`)
  if (!res.ok) throw new Error(await parseErrorResponse(res))
  return res.json() as Promise<{ ok: boolean; result: string }>
}

export async function deleteProxy(id: string): Promise<void> {
  const res = await apiFetch(`/api/proxies/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await parseErrorResponse(res))
}
