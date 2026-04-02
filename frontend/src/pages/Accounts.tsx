import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import {
  fetchAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  fetchProxies,
  addProxy,
  deleteProxy,
  assignProxy,
  connectAccount,
  getConnectStatus,
  verifyConnectCode,
  type LinkedInAccount,
} from '../api/accounts'
import { fetchActivity, ACTION_LABELS, ACTION_COLORS } from '../api/activity'

const STATUS_COLORS: Record<LinkedInAccount['status'], string> = {
  active:     'bg-green-100 text-green-700',
  paused:     'bg-yellow-100 text-yellow-700',
  banned:     'bg-red-100 text-red-700',
  warming_up: 'bg-blue-100 text-blue-700',
}

const STATUS_LABELS: Record<LinkedInAccount['status'], string> = {
  active:     'Active',
  paused:     'Paused',
  banned:     'Banned',
  warming_up: 'Warming Up',
}

const WARMUP_LIMIT = (day: number) => {
  const week = Math.floor((day - 1) / 7)
  return Math.min(5 + week * 3, 25)
}

// Day at which warmup reaches full 25 connections (week 7 = day 43, week 8 = day 50 → 25)
const WARMUP_MAX_DAY = 50

function WarmupProgress({ day }: { day: number }) {
  const currentLimit = WARMUP_LIMIT(day)
  const pct = Math.min((day / WARMUP_MAX_DAY) * 100, 100)
  const weeksLeft = Math.max(0, Math.ceil((WARMUP_MAX_DAY - day) / 7))
  return (
    <div className="min-w-[140px]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-700">Day {day}</span>
        <span className="text-xs text-blue-600 font-semibold">{currentLimit}/day limit</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[10px] text-gray-400 mt-1">
        {currentLimit >= 25 ? 'Ready to activate' : `~${weeksLeft}w to full activity`}
      </p>
    </div>
  )
}

function DailyCounter({ value, max, color }: { value: number; max: number; color: 'blue' | 'purple' }) {
  const pct = Math.min((value / max) * 100, 100)
  const colorClass = color === 'blue'
    ? 'bg-blue-500'
    : 'bg-purple-500'
  const textClass = color === 'blue' ? 'text-blue-700' : 'text-purple-700'
  return (
    <div className="min-w-[80px]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-600">{value}</span>
        <span className={`text-xs font-medium ${textClass}`}>/ {max}</span>
      </div>
      <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

type PageTab = 'accounts' | 'proxies' | 'activity'

export function Accounts() {
  const [tab, setTab] = useState<PageTab>('accounts')
  const [showAddAccount, setShowAddAccount] = useState(false)
  const [sessionAccountId, setSessionAccountId] = useState<string | null>(null)
  const [browserLoginId, setBrowserLoginId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  })

  const createMutation = useMutation({
    mutationFn: createAccount,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      setShowAddAccount(false)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Parameters<typeof updateAccount>[1] }) =>
      updateAccount(id, updates),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Accounts & Proxies</h1>
          <p className="mt-1 text-sm text-gray-500">Manage LinkedIn accounts and residential proxy assignments</p>
        </div>
        {tab === 'accounts' && (
          <button
            onClick={() => setShowAddAccount(true)}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add Account
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 border-b border-gray-200">
        {([
          ['accounts', 'LinkedIn Accounts'],
          ['proxies', 'Proxies'],
          ['activity', 'Activity Log'],
        ] as const).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'accounts' && (
        <>
          <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Connections Today</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Messages Today</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Warmup Day</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {isLoading ? (
                    <tr><td colSpan={6} className="px-4 py-16 text-center text-gray-400">Loading…</td></tr>
                  ) : accounts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-16 text-center">
                        <p className="text-gray-900 font-medium">No accounts connected</p>
                        <p className="mt-1 text-sm text-gray-500">Add a LinkedIn account to start running campaigns.</p>
                      </td>
                    </tr>
                  ) : (
                    accounts.map(account => {
                      const limit = account.status === 'warming_up' ? WARMUP_LIMIT(account.warmup_day) : 25
                      return (
                        <tr key={account.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              {account.linkedin_email}
                              {account.has_premium && (
                                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">Premium</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[account.status]}`}>
                              {STATUS_LABELS[account.status]}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <DailyCounter value={account.daily_connection_count} max={limit} color="blue" />
                          </td>
                          <td className="px-4 py-3">
                            <DailyCounter value={account.daily_message_count} max={100} color="purple" />
                          </td>
                          <td className="px-4 py-3">
                            {account.status === 'warming_up' ? (
                              <WarmupProgress day={account.warmup_day} />
                            ) : (
                              <span className="text-gray-400 text-sm">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {account.status === 'active' && (
                                <button
                                  onClick={() => updateMutation.mutate({ id: account.id, updates: { status: 'paused' } })}
                                  className="text-xs text-yellow-700 hover:underline"
                                >
                                  Pause
                                </button>
                              )}
                              {account.status === 'paused' && (
                                <button
                                  onClick={() => updateMutation.mutate({ id: account.id, updates: { status: 'active' } })}
                                  className="text-xs text-green-700 hover:underline"
                                >
                                  Resume
                                </button>
                              )}
                              {account.status === 'warming_up' && (
                                <button
                                  onClick={() => updateMutation.mutate({ id: account.id, updates: { status: 'active' } })}
                                  className="text-xs text-blue-700 hover:underline"
                                >
                                  Activate now
                                </button>
                              )}
                              <button
                                onClick={() => setBrowserLoginId(account.id)}
                                className="text-xs text-indigo-700 hover:underline font-medium"
                              >
                                Connect
                              </button>
                              <button
                                onClick={() => setSessionAccountId(account.id)}
                                className="text-xs text-purple-700 hover:underline"
                              >
                                Set Session
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`Remove ${account.linkedin_email}?`)) {
                                    deleteMutation.mutate(account.id)
                                  }
                                }}
                                className="text-xs text-red-600 hover:underline"
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
            <strong>Safety limits:</strong> max 25 connections/day (warming up accounts start at 5/day +3/week),
            max 100 messages/day, no actions between 11pm–7am.
          </div>
        </>
      )}

      {tab === 'proxies' && <ProxiesPanel accounts={accounts} />}

      {tab === 'activity' && <ActivityPanel />}

      {showAddAccount && (
        <AddAccountModal
          onClose={() => setShowAddAccount(false)}
          onSubmit={email => createMutation.mutate(email)}
          isLoading={createMutation.isPending}
          error={createMutation.error?.message ?? null}
        />
      )}

      {sessionAccountId && (
        <SetSessionModal
          accountId={sessionAccountId}
          onClose={() => setSessionAccountId(null)}
          onSaved={() => {
            setSessionAccountId(null)
            void queryClient.invalidateQueries({ queryKey: ['accounts'] })
          }}
        />
      )}

      {browserLoginId && (
        <BrowserLoginModal
          accountId={browserLoginId}
          onClose={() => setBrowserLoginId(null)}
          onSaved={() => {
            setBrowserLoginId(null)
            void queryClient.invalidateQueries({ queryKey: ['accounts'] })
          }}
        />
      )}
    </div>
  )
}

function ProxiesPanel({ accounts }: { accounts: LinkedInAccount[] }) {
  const [showAdd, setShowAdd] = useState(false)
  const queryClient = useQueryClient()

  const { data: proxies = [], isLoading } = useQuery({
    queryKey: ['proxies'],
    queryFn: fetchProxies,
  })

  const addMutation = useMutation({
    mutationFn: addProxy,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proxies'] })
      setShowAdd(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProxy,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proxies'] }),
  })

  const assignMutation = useMutation({
    mutationFn: ({ accountId, proxyId }: { accountId: string; proxyId: string | null }) =>
      assignProxy(accountId, proxyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proxies'] })
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-600">
          Assign one residential proxy per LinkedIn account to avoid IP-based detection.
        </p>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Add Proxy
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Proxy URL</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assigned Account</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={4} className="px-4 py-12 text-center text-gray-400">Loading…</td></tr>
            ) : proxies.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center">
                  <p className="text-gray-900 font-medium">No proxies added</p>
                  <p className="mt-1 text-sm text-gray-500">Add a residential proxy to assign to an account.</p>
                </td>
              </tr>
            ) : (
              proxies.map(proxy => {
                // Mask credentials for display
                let displayUrl = proxy.proxy_url
                try {
                  const u = new URL(proxy.proxy_url)
                  if (u.password) u.password = '••••'
                  displayUrl = u.toString()
                } catch { /* leave as-is */ }

                return (
                  <tr key={proxy.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 max-w-xs truncate">{displayUrl}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${proxy.is_available ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                        {proxy.is_available ? 'Available' : 'In use'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={proxy.assigned_account_id ?? ''}
                        onChange={e =>
                          assignMutation.mutate({
                            accountId: e.target.value || (proxy.assigned_account_id ?? ''),
                            proxyId: e.target.value ? proxy.id : null,
                          })
                        }
                        className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        <option value="">— unassigned —</option>
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.linkedin_email}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => {
                          if (confirm('Remove this proxy?')) deleteMutation.mutate(proxy.id)
                        }}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-900">Add Proxy</h2>
            <p className="text-sm text-gray-500">Enter a proxy URL in the format <code className="bg-gray-100 px-1 rounded text-xs">protocol://user:pass@host:port</code></p>
            <form onSubmit={e => {
              e.preventDefault()
              const url = (e.currentTarget.elements.namedItem('proxy_url') as HTMLInputElement).value.trim()
              if (url) addMutation.mutate(url)
            }} className="space-y-3">
              <input
                name="proxy_url"
                type="text"
                placeholder="socks5://user:pass@host:1080"
                autoFocus
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {addMutation.isError && (
                <p className="text-sm text-red-600">{(addMutation.error as Error).message}</p>
              )}
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowAdd(false)}
                  className="flex-1 py-2 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={addMutation.isPending}
                  className="flex-1 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-60">
                  {addMutation.isPending ? 'Adding…' : 'Add Proxy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function SetSessionModal({
  accountId,
  onClose,
  onSaved,
}: {
  accountId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [liAt, setLiAt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    const value = liAt.trim()
    if (!value) { setError('Paste your li_at cookie value.'); return }
    setSaving(true)
    setError('')
    try {
      // Format as a Playwright cookie array — only li_at is needed to authenticate
      const cookies = JSON.stringify([{
        name: 'li_at',
        value,
        domain: '.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      }])
      await updateAccount(accountId, { cookies })
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Set LinkedIn Session Cookie</h2>
          <p className="mt-1 text-sm text-gray-500">
            This lets the scraper log into LinkedIn as this account.
          </p>
        </div>

        <div className="bg-gray-50 rounded-xl p-4 text-xs text-gray-600 space-y-2">
          <p className="font-medium text-gray-700">How to get your li_at cookie:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Open LinkedIn in Chrome and log in</li>
            <li>Press F12 → Application tab → Cookies → <code className="bg-gray-200 px-1 rounded">https://www.linkedin.com</code></li>
            <li>Find the cookie named <code className="bg-gray-200 px-1 rounded">li_at</code></li>
            <li>Copy its Value and paste it below</li>
          </ol>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1.5">li_at cookie value</label>
          <textarea
            autoFocus
            value={liAt}
            onChange={e => setLiAt(e.target.value)}
            placeholder="AQEDATxxxxxx..."
            rows={3}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-none"
          />
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex gap-3">
          <button type="button" onClick={onClose}
            className="flex-1 py-2.5 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Save Session'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BrowserLoginModal({
  accountId,
  onClose,
  onSaved,
}: {
  accountId: string
  onClose: () => void
  onSaved: () => void
}) {
  type Tab  = 'signin' | 'import'
  type Step = 'form' | 'loading' | 'push' | 'verify' | 'done' | 'error'

  const [tab, setTab]         = useState<Tab>('import')
  const [step, setStep]       = useState<Step>('form')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [totpSecret, setTotpSecret] = useState('')
  const [code, setCode]       = useState('')
  const [hint, setHint]       = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [error, setError]     = useState('')
  const [cookieJson, setCookieJson] = useState('')
  const [importError, setImportError] = useState('')
  const [importSaving, setImportSaving] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  function startPolling(key: string) {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const s = await getConnectStatus(accountId, key)
        if (s.status === 'success') {
          stopPolling(); setStep('done'); setTimeout(onSaved, 1500)
        } else if (s.status === 'needs_verification') {
          stopPolling(); setHint(s.hint); setStep('verify')
        } else if (s.status === 'error') {
          stopPolling(); setError(s.message); setStep('error')
        } else if (s.status === 'not_found') {
          stopPolling(); setError('Session expired. Please try again.'); setStep('error')
        } else if (s.status === 'pending_push') {
          setHint(s.hint)
        }
      } catch { /* network blip, keep polling */ }
    }, 3000)
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    setStep('loading'); setError('')
    try {
      const result = await connectAccount(accountId, email, password, totpSecret || undefined)
      setSessionKey(result.session_key)
      setStep('push'); setHint('Signing in to LinkedIn…')
      startPolling(result.session_key)
    } catch (err) {
      setError((err as Error).message); setStep('error')
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setStep('loading'); setError('')
    try {
      const result = await verifyConnectCode(accountId, sessionKey, code)
      if (result.status === 'success') {
        setStep('done'); setTimeout(onSaved, 1500)
      } else {
        setError(result.message); setStep('verify')
      }
    } catch (err) {
      setError((err as Error).message); setStep('verify')
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault()
    setImportError('')
    const raw = cookieJson.trim()
    if (!raw) { setImportError('Paste your li_at value or cookie JSON first.'); return }

    // Accept plain li_at value (not JSON) — wrap it automatically
    let parsed: unknown
    if (!raw.startsWith('[') && !raw.startsWith('{')) {
      parsed = [{ name: 'li_at', value: raw, domain: '.linkedin.com', path: '/' }]
    } else {
      try { parsed = JSON.parse(raw) }
      catch { setImportError('Invalid JSON — copy the full output from Cookie Editor.'); return }
    }

    type C = { name: string; value: string; domain?: string; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; expirationDate?: number; expires?: number }
    const arr = (Array.isArray(parsed) ? parsed : [parsed]) as C[]
    if (!arr.find(c => c.name === 'li_at')) {
      setImportError('No li_at cookie found. Export from linkedin.com while logged in.'); return
    }
    const playwright = arr.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain ?? '.linkedin.com', path: c.path ?? '/',
      httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
      sameSite: (c.sameSite ?? 'None') as 'None' | 'Lax' | 'Strict',
      expires: c.expirationDate ?? c.expires ?? -1,
    }))
    setImportSaving(true)
    try {
      await updateAccount(accountId, { cookies: JSON.stringify(playwright), status: 'active' } as Parameters<typeof updateAccount>[1])
      setStep('done'); setTimeout(onSaved, 1500)
    } catch (err) {
      setImportError((err as Error).message); setImportSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-5">

        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Connect LinkedIn Account</h2>
            <p className="mt-0.5 text-sm text-gray-500">Sign in once — we manage your session forever.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 mt-0.5">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ── Done ── */}
        {step === 'done' && (
          <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl p-4">
            <svg className="w-5 h-5 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="text-sm font-medium text-green-900">Connected! Account is now active.</p>
          </div>
        )}

        {/* ── Push notification waiting ── */}
        {step === 'push' && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-600 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                <p className="text-sm font-medium text-blue-900">Signing in…</p>
              </div>
              {hint && hint !== 'Signing in to LinkedIn…' && (
                <p className="text-xs text-blue-700 mt-1">{hint}</p>
              )}
            </div>
            <button type="button" onClick={() => { stopPolling(); setStep('form') }}
              className="w-full py-2 border border-gray-200 text-sm text-gray-600 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
          </div>
        )}

        {/* ── 2FA code entry ── */}
        {step === 'verify' && (
          <form onSubmit={handleVerify} className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p className="text-sm font-medium text-amber-900">Verification code required</p>
              <p className="text-xs text-amber-700 mt-1">{hint}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Enter code</label>
              <input autoFocus type="text" inputMode="numeric" maxLength={8}
                value={code} onChange={e => setCode(e.target.value)}
                placeholder="123456"
                className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>}
            <button type="submit"
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700">
              Verify
            </button>
          </form>
        )}

        {/* ── Error state ── */}
        {step === 'error' && (
          <div className="space-y-4">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm font-medium text-red-900">Connection failed</p>
              <p className="text-xs text-red-700 mt-1">{error}</p>
            </div>
            <button type="button" onClick={() => { setStep('form'); setError('') }}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700">
              Try Again
            </button>
          </div>
        )}

        {/* ── Main form (signin + import tabs) ── */}
        {(step === 'form' || step === 'loading') && (
          <>
            <div className="flex gap-1 p-1 bg-gray-100 rounded-xl">
              {(['signin', 'import'] as Tab[]).map(t => (
                <button key={t} type="button"
                  onClick={() => { setTab(t); setError(''); setImportError('') }}
                  className={['flex-1 py-2 text-sm font-medium rounded-lg transition-colors',
                    tab === t ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'].join(' ')}>
                  {t === 'signin' ? 'Sign In' : 'Paste Cookies'}
                </button>
              ))}
            </div>

            {/* Sign In tab */}
            {tab === 'signin' && (
              <form onSubmit={handleSignIn} className="space-y-4">
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                  ⚠️ <span className="font-semibold">May show a CAPTCHA.</span> LinkedIn sometimes blocks server-based logins. If it fails, use the <button type="button" className="underline font-semibold" onClick={() => setTab('import')}>Paste Cookies</button> tab instead.
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800">
                  <span className="font-semibold">Infinite Login:</span> add your 2FA secret key below and we'll never ask for a verification code again.
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">LinkedIn email</label>
                  <input required type="email" autoFocus value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                  <input required type="password" value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    2FA secret key <span className="text-gray-400 font-normal">(optional — for Infinite Login)</span>
                  </label>
                  <input type="text" value={totpSecret} onChange={e => setTotpSecret(e.target.value)}
                    placeholder="e.g. JBSWY3DPEHPK3PXP"
                    className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <p className="mt-1 text-xs text-gray-400">
                    Find it in LinkedIn Settings → Sign in &amp; Security → Two-step verification → Authenticator app setup (the QR code secret).
                  </p>
                </div>
                {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{error}</p>}
                <div className="flex gap-3 pt-1">
                  <button type="button" onClick={onClose}
                    className="flex-1 py-2.5 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50">
                    Cancel
                  </button>
                  <button type="submit" disabled={step === 'loading'}
                    className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60">
                    {step === 'loading' ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </form>
            )}

            {/* Paste Cookies tab */}
            {tab === 'import' && (
              <form onSubmit={handleImport} className="space-y-4">
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-xs text-green-800 space-y-1.5">
                  <p className="font-semibold text-green-900">✓ Most reliable method</p>
                  <p className="font-medium text-green-800">Option A — paste just the <code className="bg-green-100 px-1 rounded font-mono">li_at</code> value:</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>Open <strong>linkedin.com</strong> in Chrome while logged in</li>
                    <li>Press <strong>F12</strong> → Application → Cookies → linkedin.com</li>
                    <li>Find <code className="bg-green-100 px-1 rounded font-mono">li_at</code> → copy its <strong>Value</strong></li>
                    <li>Paste it below</li>
                  </ol>
                  <p className="font-medium text-green-800 pt-1">Option B — full JSON via Cookie Editor extension:</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>Install <strong>Cookie Editor</strong> for Chrome</li>
                    <li>On linkedin.com → Cookie Editor → <strong>Export (JSON)</strong></li>
                    <li>Paste below</li>
                  </ol>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">li_at value <span className="text-gray-400 font-normal">— or full Cookie Editor JSON</span></label>
                  <textarea required value={cookieJson} onChange={e => setCookieJson(e.target.value)}
                    placeholder={'Paste li_at value (AQE...) or full JSON cookie export'}
                    rows={4}
                    className="w-full px-3 py-2.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-none" />
                </div>
                {importError && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">{importError}</p>}
                <div className="flex gap-3">
                  <button type="button" onClick={onClose}
                    className="flex-1 py-2.5 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={importSaving}
                    className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60">
                    {importSaving ? 'Saving…' : 'Import & Connect'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function AddAccountModal({
  onClose, onSubmit, isLoading, error,
}: {
  onClose: () => void
  onSubmit: (email: string) => void
  isLoading: boolean
  error: string | null
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<{ email: string }>()

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900">Add LinkedIn Account</h2>
        <p className="mt-1 text-sm text-gray-500">
          The account will start in warmup mode (5 connections/day, +3 each week).
        </p>
        <form onSubmit={handleSubmit(d => onSubmit(d.email))} className="mt-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">LinkedIn email</label>
            <input
              type="email"
              autoFocus
              className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com"
              {...register('email', {
                required: 'Email is required',
                pattern: { value: /\S+@\S+\.\S+/, message: 'Enter a valid email' },
              })}
            />
            {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={isLoading}
              className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors">
              {isLoading ? 'Adding…' : 'Add Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Activity Log Panel ────────────────────────────────────────────────────────

function ActivityPanel() {
  const [accountFilter, setAccountFilter] = useState('')

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => import('../api/accounts').then(m => m.fetchAccounts()),
  })

  const { data: activity = [], isLoading } = useQuery({
    queryKey: ['activity', accountFilter],
    queryFn: () => fetchActivity(accountFilter || undefined),
    refetchInterval: 30_000,
  })

  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-3">
        <select
          value={accountFilter}
          onChange={e => setAccountFilter(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All accounts</option>
          {accounts.map(acc => (
            <option key={acc.id} value={acc.id}>{acc.linkedin_email}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400">Auto-refreshes every 30s</span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
        ) : activity.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-500">No activity yet</p>
            <p className="text-xs text-gray-400 mt-1">Actions will appear here as campaigns run</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {activity.map(entry => (
              <div key={entry.id} className="flex items-start gap-4 px-5 py-3.5 hover:bg-gray-50 transition-colors">
                <span className={`mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${ACTION_COLORS[entry.action] ?? 'bg-gray-100 text-gray-500'}`}>
                  {entry.action.replace(/_/g, ' ')}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800">{ACTION_LABELS[entry.action] ?? entry.action.replace(/_/g, ' ')}</p>
                  {entry.detail && (
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{entry.detail}</p>
                  )}
                </div>
                <span className="text-xs text-gray-400 shrink-0 tabular-nums">{timeAgo(entry.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
