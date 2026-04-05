import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import {
  fetchAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  connectAccount,
  getConnectStatus,
  verifyConnectCode,
  interactWithSession,
  type LinkedInAccount,
} from '../api/accounts'
import {
  fetchProxies,
  addProxy,
  bulkImportProxies,
  updateProxyLabel,
  assignProxy,
  testProxy,
  deleteProxy,
  type Proxy,
} from '../api/proxies'
import { fetchActivity, ACTION_LABELS, ACTION_COLORS } from '../api/activity'
import { apiFetch } from '../lib/fetchJson'

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
  const [quickLoginId, setQuickLoginId] = useState<string | null>(null)
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
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Proxy Country</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {isLoading ? (
                    <tr><td colSpan={7} className="px-4 py-16 text-center text-gray-400">Loading…</td></tr>
                  ) : accounts.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-16 text-center">
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
                            <select
                              value={account.proxy_country ?? ''}
                              onChange={e => updateMutation.mutate({ id: account.id, updates: { proxy_country: e.target.value || null } })}
                              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="">🌍 Any</option>
                              <option value="us">🇺🇸 US</option>
                              <option value="gb">🇬🇧 UK</option>
                              <option value="de">🇩🇪 Germany</option>
                              <option value="fr">🇫🇷 France</option>
                              <option value="nl">🇳🇱 Netherlands</option>
                              <option value="ca">🇨🇦 Canada</option>
                              <option value="au">🇦🇺 Australia</option>
                              <option value="sg">🇸🇬 Singapore</option>
                              <option value="in">🇮🇳 India</option>
                              <option value="ae">🇦🇪 UAE</option>
                              <option value="tr">🇹🇷 Turkey</option>
                            </select>
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
                                onClick={() => setQuickLoginId(account.id)}
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

      {quickLoginId && (
        <QuickLoginModal
          accountId={quickLoginId}
          onClose={() => setQuickLoginId(null)}
          onSaved={() => {
            setQuickLoginId(null)
            void queryClient.invalidateQueries({ queryKey: ['accounts'] })
          }}
        />
      )}
    </div>
  )
}

function ProxiesPanel({ accounts }: { accounts: LinkedInAccount[] }) {
  const [showAdd, setShowAdd] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; result: string; loading: boolean }>>({})
  const [editingLabel, setEditingLabel] = useState<Record<string, string>>({})
  const queryClient = useQueryClient()

  const { data: proxies = [], isLoading } = useQuery({
    queryKey: ['proxies'],
    queryFn: fetchProxies,
  })

  const addMutation = useMutation({
    mutationFn: ({ proxy_url, label }: { proxy_url: string; label?: string }) => addProxy(proxy_url, label),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proxies'] })
      setShowAdd(false)
    },
  })

  const bulkMutation = useMutation({
    mutationFn: ({ lines, label_prefix }: { lines: string; label_prefix?: string }) =>
      bulkImportProxies(lines, label_prefix),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proxies'] })
      setShowAdd(false)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProxy,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proxies'] })
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  const assignMutation = useMutation({
    mutationFn: ({ proxyId, accountId }: { proxyId: string; accountId: string | null }) =>
      assignProxy(proxyId, accountId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['proxies'] })
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
    },
  })

  const labelMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => updateProxyLabel(id, label),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proxies'] }),
  })

  async function handleTest(proxy: Proxy) {
    setTestResults(r => ({ ...r, [proxy.id]: { ok: false, result: '', loading: true } }))
    try {
      const result = await testProxy(proxy.id)
      setTestResults(r => ({ ...r, [proxy.id]: { ...result, loading: false } }))
    } catch (e) {
      setTestResults(r => ({ ...r, [proxy.id]: { ok: false, result: (e as Error).message, loading: false } }))
    }
  }

  const unassignedAccounts = accounts.filter(a => !proxies.some(p => p.assigned_account_id === a.id))

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600">
            One dedicated static IP per LinkedIn account — same IP every session, no rotation.
          </p>
          {unassignedAccounts.length > 0 && (
            <p className="text-xs text-amber-600 mt-1">
              {unassignedAccounts.length} account{unassignedAccounts.length > 1 ? 's have' : ' has'} no proxy assigned.
            </p>
          )}
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          Add Proxies
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Label / URL</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assigned Account</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Test</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">Loading…</td></tr>
            ) : proxies.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-16 text-center">
                  <p className="text-gray-900 font-medium">No proxies added</p>
                  <p className="mt-1 text-sm text-gray-500">
                    Add static residential proxies from IPRoyal, Rayobyte, or similar — one per LinkedIn account.
                  </p>
                </td>
              </tr>
            ) : (
              proxies.map(proxy => {
                const testResult = testResults[proxy.id]
                const assignedAccount = accounts.find(a => a.id === proxy.assigned_account_id)
                const labelVal = editingLabel[proxy.id] ?? proxy.label ?? ''

                return (
                  <tr key={proxy.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 max-w-[220px]">
                      <input
                        value={labelVal}
                        onChange={e => setEditingLabel(prev => ({ ...prev, [proxy.id]: e.target.value }))}
                        onBlur={() => {
                          if (labelVal !== proxy.label) {
                            labelMutation.mutate({ id: proxy.id, label: labelVal })
                          }
                          setEditingLabel(prev => { const n = { ...prev }; delete n[proxy.id]; return n })
                        }}
                        placeholder="Add label…"
                        className="text-xs font-medium text-gray-800 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:outline-none w-full pb-0.5 mb-1"
                      />
                      <p className="font-mono text-[10px] text-gray-400 truncate">{proxy.proxy_url}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${proxy.is_available ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                        {proxy.is_available ? 'Available' : 'In use'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={proxy.assigned_account_id ?? ''}
                        onChange={e => assignMutation.mutate({ proxyId: proxy.id, accountId: e.target.value || null })}
                        className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[180px]"
                      >
                        <option value="">— unassigned —</option>
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.linkedin_email}</option>
                        ))}
                      </select>
                      {assignedAccount && (
                        <p className="text-[10px] text-gray-400 mt-0.5 ml-0.5">
                          {STATUS_LABELS[assignedAccount.status]}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {testResult ? (
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${testResult.loading ? 'bg-yellow-400 animate-pulse' : testResult.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                          <span className="text-[10px] text-gray-500 font-mono truncate max-w-[100px]">
                            {testResult.loading ? 'Testing…' : testResult.result}
                          </span>
                        </div>
                      ) : (
                        <button
                          onClick={() => void handleTest(proxy)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          Test
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => {
                          if (confirm('Remove this proxy? It will be unassigned from any account.')) {
                            deleteMutation.mutate(proxy.id)
                          }
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
        <AddProxyModal
          onClose={() => setShowAdd(false)}
          onAdd={(proxy_url, label) => addMutation.mutate({ proxy_url, label })}
          onBulk={(lines, label_prefix) => bulkMutation.mutate({ lines, label_prefix })}
          isLoading={addMutation.isPending || bulkMutation.isPending}
          error={addMutation.error?.message ?? bulkMutation.error?.message ?? null}
          bulkResult={bulkMutation.data ?? null}
        />
      )}
    </div>
  )
}

function AddProxyModal({
  onClose,
  onAdd,
  onBulk,
  isLoading,
  error,
  bulkResult,
}: {
  onClose: () => void
  onAdd: (proxy_url: string, label?: string) => void
  onBulk: (lines: string, label_prefix?: string) => void
  isLoading: boolean
  error: string | null
  bulkResult: { imported: number; skipped: number; invalid: string[] } | null
}) {
  const [mode, setMode] = useState<'single' | 'bulk'>('single')
  const [proxyUrl, setProxyUrl] = useState('')
  const [label, setLabel] = useState('')
  const [bulkLines, setBulkLines] = useState('')
  const [labelPrefix, setLabelPrefix] = useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (mode === 'single') {
      if (proxyUrl.trim()) onAdd(proxyUrl.trim(), label.trim() || undefined)
    } else {
      if (bulkLines.trim()) onBulk(bulkLines.trim(), labelPrefix.trim() || undefined)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Add Proxies</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
          {(['single', 'bulk'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={[
                'flex-1 py-1.5 text-xs font-medium rounded-md transition-colors',
                mode === m ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700',
              ].join(' ')}
            >
              {m === 'single' ? 'Single Proxy' : 'Bulk Import'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'single' ? (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Label (optional)</label>
                <input
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder="e.g. US East 1"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Proxy URL</label>
                <input
                  value={proxyUrl}
                  onChange={e => setProxyUrl(e.target.value)}
                  placeholder="http://user:pass@host:port"
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-[10px] text-gray-400 mt-1">Supports http://, https://, socks5://</p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Label prefix (optional)</label>
                <input
                  value={labelPrefix}
                  onChange={e => setLabelPrefix(e.target.value)}
                  placeholder="e.g. IPRoyal US → IPRoyal US 1, IPRoyal US 2…"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Proxy URLs (one per line)</label>
                <textarea
                  value={bulkLines}
                  onChange={e => setBulkLines(e.target.value)}
                  placeholder={`http://user1:pass1@host1:port\nhttp://user2:pass2@host2:port\n…`}
                  rows={6}
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
                <p className="text-[10px] text-gray-400 mt-1">
                  Paste the list you get from IPRoyal / Rayobyte / Smartproxy export.
                </p>
              </div>
            </>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          {bulkResult && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-800">
              Imported <strong>{bulkResult.imported}</strong> proxies.
              {bulkResult.skipped > 0 && <span className="text-amber-700"> {bulkResult.skipped} skipped (invalid).</span>}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={isLoading}
              className="flex-1 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-60">
              {isLoading ? 'Importing…' : mode === 'single' ? 'Add Proxy' : 'Import All'}
            </button>
          </div>
        </form>
      </div>
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

// BROWSER_VIEWPORT_* must match the context dimensions set in login.ts
const BROWSER_W = 1280
const BROWSER_H = 800

function PushStep({
  accountId,
  sessionKey,
  hint,
  onCancel,
  onCheckNow,
}: {
  accountId: string
  sessionKey: string
  hint: string
  onCancel: () => void
  onCheckNow: () => Promise<void>
}) {
  const [screenshotUrl, setScreenshotUrl]     = useState<string | null>(null)
  const [screenshotLoading, setScreenshotLoading] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const [interacting, setInteracting]         = useState(false)
  const [checking, setChecking]               = useState(false)
  const [liveUrl, setLiveUrl]                 = useState('')
  const screenshotRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const urlPollRef    = useRef<ReturnType<typeof setInterval> | null>(null)
  const imgRef        = useRef<HTMLImageElement | null>(null)
  const keyInputRef   = useRef<HTMLInputElement | null>(null)

  const isSecurityCheck =
    hint.toLowerCase().includes('security') ||
    hint.toLowerCase().includes('verification') ||
    hint.toLowerCase().includes('verify') ||
    hint.toLowerCase().includes('check')

  // ── Screenshot polling ────────────────────────────────────────────────────

  const fetchScreenshot = useRef(async () => {
    if (!sessionKey) return
    setScreenshotLoading(true)
    try {
      const res = await apiFetch(`/api/accounts/${accountId}/connect-screenshot/${sessionKey}`)
      if (res.ok) {
        const blob = await res.blob()
        const url  = URL.createObjectURL(blob)
        setScreenshotUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url })
      }
    } catch { /* ignore */ }
    finally { setScreenshotLoading(false) }
  }).current

  useEffect(() => {
    if (!sessionKey) return
    void fetchScreenshot()
    screenshotRef.current = setInterval(() => { void fetchScreenshot() }, 2000)
    return () => { if (screenshotRef.current) { clearInterval(screenshotRef.current); screenshotRef.current = null } }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  // ── Live URL polling (every 3s) ───────────────────────────────────────────
  useEffect(() => {
    if (!sessionKey) return
    const poll = async () => {
      try {
        const res = await apiFetch(`/api/accounts/${accountId}/connect-debug/${sessionKey}`)
        if (res.ok) {
          const data = await res.json() as { url?: string }
          if (data.url) {
            const clean = data.url.replace(/^https?:\/\//, '').split('?')[0]
            setLiveUrl(clean.length > 55 ? clean.substring(0, 55) + '…' : clean)
          }
        }
      } catch { /* ignore */ }
    }
    void poll()
    urlPollRef.current = setInterval(() => { void poll() }, 3000)
    return () => { if (urlPollRef.current) { clearInterval(urlPollRef.current); urlPollRef.current = null } }
  }, [accountId, sessionKey])

  // ── Interaction helpers ───────────────────────────────────────────────────

  async function sendInteraction(action: Parameters<typeof interactWithSession>[2]) {
    if (interacting) return
    setInteracting(true)
    try { await interactWithSession(accountId, sessionKey, action) }
    catch { /* ignore */ }
    finally { setInteracting(false) }
  }

  function handleScreenshotClick(e: React.MouseEvent<HTMLImageElement>) {
    const img  = imgRef.current
    if (!img) return
    const rect = img.getBoundingClientRect()
    const x    = Math.round(((e.clientX - rect.left) / rect.width)  * BROWSER_W)
    const y    = Math.round(((e.clientY - rect.top)  / rect.height) * BROWSER_H)
    void sendInteraction({ type: 'click', x, y })
    // Focus the keyboard relay input after clicking
    keyInputRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    e.preventDefault()
    const key = e.key
    if (key === 'Backspace' || key === 'Enter' || key === 'Tab' ||
        key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' ||
        key === 'Delete' || key === 'Home' || key === 'End' || key === 'Escape') {
      void sendInteraction({ type: 'key', key })
    } else if (key.length === 1) {
      void sendInteraction({ type: 'type', text: key })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Status banner */}
      <div className={`border rounded-xl px-4 py-3 flex items-center gap-2 ${isSecurityCheck ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
        <svg className={`w-4 h-4 animate-spin flex-shrink-0 ${isSecurityCheck ? 'text-amber-500' : 'text-blue-500'}`} fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
        <div className="min-w-0">
          <p className={`text-sm font-medium ${isSecurityCheck ? 'text-amber-900' : 'text-blue-900'}`}>
            {isSecurityCheck ? 'Security challenge — interact below' : 'Signing in…'}
          </p>
          {hint && hint !== 'Signing in to LinkedIn…' && (
            <p className={`text-xs mt-0.5 ${isSecurityCheck ? 'text-amber-700' : 'text-blue-700'}`}>{hint}</p>
          )}
        </div>
        <span className="ml-auto text-[10px] text-gray-400 whitespace-nowrap">
          {screenshotLoading ? 'refreshing…' : '● live'}
        </span>
      </div>

      {/* "I approved it" — only for push-notification step (not interactive security check) */}
      {!isSecurityCheck && (
        <button
          type="button"
          disabled={checking}
          onClick={async () => { setChecking(true); try { await onCheckNow() } finally { setChecking(false) } }}
          className="w-full py-2.5 bg-green-600 text-white text-sm font-semibold rounded-xl hover:bg-green-700 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
        >
          {checking ? (
            <>
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Checking…
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              I approved it — check now
            </>
          )}
        </button>
      )}

      {/* Interactive screenshot */}
      <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-900">
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800">
          <span className="text-[11px] text-gray-400 font-mono truncate max-w-[260px]">
            {liveUrl || 'linkedin.com'}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${keyboardFocused ? 'bg-green-600 text-white' : 'bg-gray-600 text-gray-300'}`}>
            {keyboardFocused ? 'keyboard active' : 'click to type'}
          </span>
        </div>

        {screenshotUrl ? (
          <div className="relative">
            <img
              ref={imgRef}
              src={screenshotUrl}
              alt="Live browser"
              className="w-full block cursor-crosshair select-none"
              draggable={false}
              onClick={handleScreenshotClick}
            />
            {interacting && (
              <div className="absolute inset-0 bg-white/10 pointer-events-none" />
            )}
          </div>
        ) : (
          <div className="h-40 flex items-center justify-center">
            <p className="text-xs text-gray-500">{screenshotLoading ? 'Loading…' : 'Waiting for browser…'}</p>
          </div>
        )}

        {/* Invisible keyboard relay input — focused by clicking on screenshot */}
        <div className="px-3 py-2 bg-gray-800 border-t border-gray-700">
          <input
            ref={keyInputRef}
            type="text"
            value=""
            readOnly
            onFocus={() => setKeyboardFocused(true)}
            onBlur={() => setKeyboardFocused(false)}
            onKeyDown={handleKeyDown}
            placeholder={keyboardFocused ? 'Typing goes to the browser…' : 'Click the browser image above, then type here'}
            className="w-full bg-gray-700 text-gray-200 text-xs px-2.5 py-1.5 rounded outline-none placeholder:text-gray-500 focus:ring-1 focus:ring-green-500 cursor-text"
          />
        </div>
      </div>

      <p className="text-[11px] text-gray-400 text-center">
        Click anywhere on the browser image to interact · keyboard input is relayed in real-time
      </p>

      <button type="button" onClick={onCancel}
        className="w-full py-2 border border-gray-200 text-sm text-gray-600 rounded-lg hover:bg-gray-50">
        Cancel
      </button>
    </div>
  )
}

// ── Quick Login Modal ────────────────────────────────────────────────────────
// Opens LinkedIn in the user's real browser, then captures the li_at cookie
// via a one-liner console command. No Playwright / proxy required.

function QuickLoginModal({
  accountId,
  onClose,
  onSaved,
}: {
  accountId: string
  onClose: () => void
  onSaved: () => void
}) {
  const SNIPPET = `copy(document.cookie.match(/li_at=([^;]+)/)?.[1] ?? 'not found')`

  const [step, setStep] = useState<'open' | 'copy' | 'paste'>('open')
  const [cookieVal, setCookieVal] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  function openLinkedIn() {
    window.open('https://www.linkedin.com/login', '_blank', 'noopener,noreferrer')
    setStep('copy')
  }

  function copySnippet() {
    void navigator.clipboard.writeText(SNIPPET).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  async function handleSave() {
    const val = cookieVal.trim()
    if (!val || val === 'not found') {
      setError('Paste the cookie value — it should be a long string of letters and numbers.')
      return
    }
    setSaving(true)
    setError('')
    try {
      // Build a minimal Playwright-compatible cookie array from just the li_at value
      const cookies = JSON.stringify([{
        name: 'li_at',
        value: val,
        domain: '.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        expires: -1,
      }])
      await updateAccount(accountId, { cookies, status: 'active' } as Parameters<typeof updateAccount>[1])
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Connect LinkedIn Account</h2>
            <p className="text-xs text-gray-500 mt-0.5">Sign in with your real browser — takes 30 seconds</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Steps */}
        <div className="px-6 py-5 space-y-5">

          {/* Step 1 */}
          <div className={`flex gap-4 ${step !== 'open' ? 'opacity-50' : ''}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${step === 'open' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>1</div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">Open LinkedIn and log in</p>
              <p className="text-xs text-gray-500 mt-0.5">Sign in with your normal browser — no proxies, no bots.</p>
              <button
                onClick={openLinkedIn}
                className="mt-2.5 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Open LinkedIn Login
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className={`flex gap-4 ${step === 'open' ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${step === 'copy' ? 'bg-blue-600 text-white' : step === 'paste' ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
              {step === 'paste' ? '✓' : '2'}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">Copy your session cookie</p>
              <p className="text-xs text-gray-500 mt-0.5">Once logged in, press <kbd className="px-1 py-0.5 bg-gray-100 rounded text-[10px] font-mono">F12</kbd> → Console tab → paste this command and press Enter:</p>
              <div className="mt-2 bg-gray-900 rounded-lg px-3.5 py-2.5 flex items-center gap-2">
                <code className="text-green-400 text-xs font-mono flex-1 break-all">{SNIPPET}</code>
                <button
                  onClick={copySnippet}
                  title="Copy command"
                  className="shrink-0 text-gray-400 hover:text-white transition-colors"
                >
                  {copied
                    ? <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                  }
                </button>
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">The command copies your <code className="font-mono">li_at</code> cookie to your clipboard automatically.</p>
              {step === 'copy' && (
                <button onClick={() => setStep('paste')} className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-medium">
                  Done → paste it below ↓
                </button>
              )}
            </div>
          </div>

          {/* Step 3 */}
          <div className={`flex gap-4 ${step !== 'paste' ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${step === 'paste' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-500'}`}>3</div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">Paste the cookie value</p>
              <p className="text-xs text-gray-500 mt-0.5">Paste the value that was copied to your clipboard:</p>
              <textarea
                autoFocus={step === 'paste'}
                value={cookieVal}
                onChange={e => setCookieVal(e.target.value)}
                placeholder="AQEDAQbj…"
                rows={3}
                className="mt-2 w-full px-3 py-2.5 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              {error && <p className="mt-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || step !== 'paste' || !cookieVal.trim()}
            className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Connect Account'}
          </button>
        </div>

        {/* Escape hatch to old method */}
        <p className="px-6 pb-4 text-center text-[11px] text-gray-400">
          Prefer automated login?{' '}
          <button
            onClick={() => { onClose(); }}
            className="text-gray-500 hover:text-gray-700 underline"
          >
            Use the advanced browser method
          </button>
        </p>
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

  const [tab, setTab]         = useState<Tab>('signin')
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
  const [detectedCountry, setDetectedCountry] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-detect country via Cloudflare trace on modal open
  useEffect(() => {
    const SUPPORTED = new Set(['us','gb','de','fr','nl','ca','au','sg','in','ae','tr'])
    fetch('https://www.cloudflare.com/cdn-cgi/trace')
      .then(r => r.text())
      .then(text => {
        const match = text.match(/^loc=([A-Z]{2})$/m)
        if (!match) return
        const code = match[1].toLowerCase()
        if (!SUPPORTED.has(code)) return
        setDetectedCountry(code)
        // Silently persist to account so proxy routing uses the right country
        void updateAccount(accountId, { proxy_country: code })
      })
      .catch(() => { /* non-critical */ })
  }, [accountId])

  function stopPolling() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  async function handleStatusResult(s: Awaited<ReturnType<typeof getConnectStatus>>) {
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
  }

  function startPolling(key: string) {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const s = await getConnectStatus(accountId, key)
        await handleStatusResult(s)
      } catch { /* network blip, keep polling */ }
    }, 2000)
  }

  async function handleCheckNow() {
    try {
      const s = await getConnectStatus(accountId, sessionKey)
      await handleStatusResult(s)
    } catch { /* ignore */ }
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
    if (!raw) { setImportError('Paste your cookies JSON first.'); return }
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch { setImportError('Invalid JSON — copy the full output from Cookie Editor.'); return }

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

        {/* ── Push notification / security check waiting ── */}
        {step === 'push' && (
          <PushStep
            accountId={accountId}
            sessionKey={sessionKey}
            hint={hint}
            onCancel={() => { stopPolling(); setStep('form') }}
            onCheckNow={handleCheckNow}
          />
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
                {detectedCountry && (
                  <div className="flex items-center gap-2 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                    <span>📍</span>
                    <span>Location detected: <strong className="text-gray-700">{detectedCountry.toUpperCase()}</strong> — proxy routing set automatically</span>
                  </div>
                )}
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
                <div className="bg-gray-50 rounded-xl p-4 text-xs text-gray-600 space-y-1.5">
                  <p className="font-medium text-gray-700">Export cookies from your browser:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Install <strong>Cookie Editor</strong> extension for Chrome</li>
                    <li>Go to <strong>linkedin.com</strong> while logged in</li>
                    <li>Click Cookie Editor → <strong>Export (JSON)</strong></li>
                    <li>Paste below</li>
                  </ol>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1.5">Cookie JSON</label>
                  <textarea required value={cookieJson} onChange={e => setCookieJson(e.target.value)}
                    placeholder={'[{"name":"li_at","value":"AQE..."}]'}
                    rows={5}
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
