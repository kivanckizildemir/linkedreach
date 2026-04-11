import React, { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useAuth } from '../contexts/AuthContext'
import {
  fetchAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  connectAccount,
  getConnectStatus,
  verifyConnectCode,
  testHealthCheck,
  requestVerificationCode,
  type LinkedInAccount,
} from '../api/accounts'
import { apiFetch } from '../lib/fetchJson'
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
  useAuth()
  const [tab, setTab] = useState<PageTab>('accounts')
  const [showAddAccount, setShowAddAccount] = useState(false)
  const [sessionAccount, setSessionAccount] = useState<LinkedInAccount | null>(null)
  const [healthResults, setHealthResults] = useState<Record<string, { ok: boolean; message: string } | 'loading'>>({})
  const [expandedSenderId, setExpandedSenderId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  })

  // System status — queue counts + last activity
  const { data: systemStatus } = useQuery({
    queryKey: ['system-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/system/status')
      if (!res.ok) return null
      return res.json() as Promise<{
        queues: {
          sequence_runner: Record<string, number>
          scraper: Record<string, number>
          qualify: Record<string, number>
        }
        last_activity: { action: string; detail: string | null; created_at: string } | null
        accounts: Array<{ id: string; status: string; last_active_at: string | null }>
      }>
    },
    refetchInterval: 10_000,
  })

  // Poll for which user accounts have the Chrome extension connected
  const { data: extensionStatus } = useQuery({
    queryKey: ['extension-online-users'],
    queryFn: async () => {
      const res = await apiFetch('/api/extension/online-users')
      if (!res.ok) return { users: [] as string[] }
      return res.json() as Promise<{ users: string[] }>
    },
    refetchInterval: 10_000,  // re-check every 10s
  })
  const extensionOnlineUsers = new Set(extensionStatus?.users ?? [])

  const createMutation = useMutation({
    mutationFn: createAccount,
    onSuccess: (newAccount) => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      setShowAddAccount(false)
      // Auto-open connect modal so user goes straight from Add → Connect
      setSessionAccount(newAccount)
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

  async function runHealthCheck(accountId: string) {
    setHealthResults(prev => ({ ...prev, [accountId]: 'loading' }))
    try {
      const result = await testHealthCheck(accountId)
      setHealthResults(prev => ({ ...prev, [accountId]: result }))
      if (result.ok) void queryClient.invalidateQueries({ queryKey: ['accounts'] })
      // Auto-clear after 6 seconds
      setTimeout(() => setHealthResults(prev => { const n = { ...prev }; delete n[accountId]; return n }), 6000)
    } catch (err) {
      setHealthResults(prev => ({ ...prev, [accountId]: { ok: false, message: (err as Error).message } }))
      setTimeout(() => setHealthResults(prev => { const n = { ...prev }; delete n[accountId]; return n }), 6000)
    }
  }

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

      {/* ── System Status Bar ──────────────────────────────────────────── */}
      {systemStatus && (() => {
        const seq = systemStatus.queues.sequence_runner
        const activeJobs   = seq.active  ?? 0
        const waitingJobs  = seq.waiting ?? 0
        const failedJobs   = seq.failed  ?? 0
        const lastAct      = systemStatus.last_activity

        const seqStatus =
          activeJobs  > 0 ? { label: `Running — ${activeJobs} job${activeJobs > 1 ? 's' : ''} active`, dot: 'bg-green-400 animate-pulse', text: 'text-green-700' } :
          waitingJobs > 0 ? { label: `Queued — ${waitingJobs} job${waitingJobs > 1 ? 's' : ''} waiting`, dot: 'bg-yellow-400', text: 'text-yellow-700' } :
          failedJobs  > 0 ? { label: `${failedJobs} job${failedJobs > 1 ? 's' : ''} failed`, dot: 'bg-red-400', text: 'text-red-700' } :
          { label: 'Idle — no jobs queued', dot: 'bg-gray-300', text: 'text-gray-500' }

        const accountsStatuses = systemStatus.accounts
        const allActive  = accountsStatuses.every(a => a.status === 'active')
        const anyPaused  = accountsStatuses.some(a => a.status === 'paused')
        const anyBanned  = accountsStatuses.some(a => a.status === 'banned')
        const linkedInStatus =
          anyBanned  ? { label: 'Account banned', dot: 'bg-red-500', text: 'text-red-700' } :
          anyPaused  ? { label: 'Session paused — reconnect needed', dot: 'bg-yellow-400', text: 'text-yellow-700' } :
          allActive  ? { label: 'Session live', dot: 'bg-green-400', text: 'text-green-700' } :
          { label: 'No accounts', dot: 'bg-gray-300', text: 'text-gray-500' }

        function timeAgo(iso: string) {
          const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
          if (mins < 1)   return 'just now'
          if (mins < 60)  return `${mins}m ago`
          const hrs = Math.floor(mins / 60)
          if (hrs < 24)   return `${hrs}h ago`
          return `${Math.floor(hrs / 24)}d ago`
        }

        const scr = systemStatus.queues.scraper
        const scraperActive  = scr.active  ?? 0
        const scraperWaiting = scr.waiting ?? 0
        const scraperFailed  = scr.failed  ?? 0
        const scraperStatus =
          scraperActive  > 0 ? { label: `Scraping — ${scraperActive} job${scraperActive > 1 ? 's' : ''} active`, dot: 'bg-green-400 animate-pulse', text: 'text-green-700' } :
          scraperWaiting > 0 ? { label: `Queued — ${scraperWaiting} job${scraperWaiting > 1 ? 's' : ''} waiting`, dot: 'bg-yellow-400', text: 'text-yellow-700' } :
          scraperFailed  > 0 ? { label: `${scraperFailed} job${scraperFailed > 1 ? 's' : ''} failed`, dot: 'bg-red-400', text: 'text-red-700' } :
          { label: 'Idle — no scrapes queued', dot: 'bg-gray-300', text: 'text-gray-500' }

        return (
          <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* LinkedIn session */}
            <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <span className={`relative flex h-2.5 w-2.5 shrink-0`}>
                <span className={`${linkedInStatus.dot} rounded-full h-2.5 w-2.5 ${anyPaused ? '' : allActive ? 'animate-pulse' : ''}`} />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">LinkedIn session</p>
                <p className={`text-xs font-semibold ${linkedInStatus.text} truncate`}>{linkedInStatus.label}</p>
              </div>
            </div>

            {/* Sequence worker */}
            <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${seqStatus.dot}`} />
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Sequence worker</p>
                <p className={`text-xs font-semibold ${seqStatus.text} truncate`}>{seqStatus.label}</p>
              </div>
            </div>

            {/* Scraper worker */}
            <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${scraperStatus.dot}`} />
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Scraper worker</p>
                <p className={`text-xs font-semibold ${scraperStatus.text} truncate`}>{scraperStatus.label}</p>
              </div>
            </div>

            {/* Last action */}
            <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full shrink-0 bg-blue-300" />
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Last action</p>
                {lastAct ? (
                  <p className="text-xs font-semibold text-gray-700 truncate">
                    {lastAct.action.replace(/_/g, ' ')}
                    {lastAct.detail ? ` · ${lastAct.detail}` : ''}
                    <span className="text-gray-400 font-normal ml-1">{timeAgo(lastAct.created_at)}</span>
                  </p>
                ) : (
                  <p className="text-xs text-gray-400 font-medium">No activity logged yet</p>
                )}
              </div>
            </div>
          </div>
        )
      })()}

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
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sender Profile</th>
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
                      const isExpanded = expandedSenderId === account.id
                      const hasSenderData = !!(account.sender_name || account.sender_headline || account.sender_about)
                      return (
                        <React.Fragment key={account.id}>
                        <tr className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              {account.linkedin_email}
                              {account.has_premium && (
                                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">Premium</span>
                              )}
                              {extensionOnlineUsers.has(account.user_id) && (
                                <span
                                  title="Chrome extension connected — actions run in your browser"
                                  className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
                                >
                                  <span className="relative flex h-1.5 w-1.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                                  </span>
                                  Extension
                                </span>
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
                            <button
                              onClick={() => setExpandedSenderId(isExpanded ? null : account.id)}
                              className="flex items-center gap-2 text-left group"
                            >
                              {hasSenderData ? (
                                <div>
                                  <p className="text-xs font-semibold text-gray-800 group-hover:text-violet-700 transition-colors">
                                    {account.sender_name ?? '—'}
                                  </p>
                                  {account.sender_headline && (
                                    <p className="text-[11px] text-gray-400 truncate max-w-[160px]">{account.sender_headline}</p>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs text-gray-400 italic group-hover:text-violet-600 transition-colors">No profile — Connect to scrape</span>
                              )}
                              <svg
                                className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
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
                                onClick={() => setSessionAccount(account)}
                                className="text-xs text-indigo-700 hover:underline font-medium"
                              >
                                Connect
                              </button>
                              {(() => {
                                const hr = healthResults[account.id]
                                if (hr === 'loading') {
                                  return (
                                    <span className="text-xs text-gray-500 flex items-center gap-1">
                                      <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                                      </svg>
                                      Testing…
                                    </span>
                                  )
                                }
                                if (hr) {
                                  return (
                                    <span className={`text-xs font-medium ${hr.ok ? 'text-green-600' : 'text-red-600'}`}>
                                      {hr.ok ? '✓' : '✗'} {hr.message}
                                    </span>
                                  )
                                }
                                return (
                                  <button
                                    onClick={() => void runHealthCheck(account.id)}
                                    className="text-xs text-teal-700 hover:underline"
                                  >
                                    Test Health
                                  </button>
                                )
                              })()}
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

                        {/* Sender profile expandable row */}
                        {isExpanded && (
                          <tr className="bg-violet-50/60 border-t border-violet-100">
                            <td colSpan={7} className="px-6 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {/* Name + Headline editable */}
                                <div className="space-y-2">
                                  <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider">Name</p>
                                  <input
                                    type="text"
                                    defaultValue={account.sender_name ?? ''}
                                    onBlur={e => {
                                      const val = e.target.value.trim()
                                      if (val !== (account.sender_name ?? '')) {
                                        updateMutation.mutate({ id: account.id, updates: { sender_name: val || null } })
                                      }
                                    }}
                                    placeholder="Full name"
                                    className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-full bg-white focus:outline-none focus:ring-2 focus:ring-violet-400"
                                  />
                                  <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider mt-2">Headline</p>
                                  <p className="text-xs text-gray-600">{account.sender_headline ?? <span className="italic text-gray-400">Not scraped yet</span>}</p>
                                </div>

                                {/* Skills */}
                                <div>
                                  <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider mb-1">Skills</p>
                                  {account.sender_skills && account.sender_skills.length > 0 ? (
                                    <div className="flex flex-wrap gap-1.5">
                                      {account.sender_skills.map((s, i) => (
                                        <span key={i} className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">{s}</span>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-xs text-gray-400 italic">Not scraped yet</p>
                                  )}
                                </div>

                                {/* About */}
                                {account.sender_about && (
                                  <div className="md:col-span-2">
                                    <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider mb-1">About</p>
                                    <p className="text-xs text-gray-600 leading-relaxed line-clamp-4">{account.sender_about}</p>
                                  </div>
                                )}

                                {/* Experience */}
                                {account.sender_experience && (
                                  <div className="md:col-span-2">
                                    <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider mb-1">Experience</p>
                                    <p className="text-xs text-gray-600 leading-relaxed line-clamp-3">{account.sender_experience}</p>
                                  </div>
                                )}

                                {/* Recent Posts */}
                                {account.sender_recent_posts && account.sender_recent_posts.length > 0 && (
                                  <div className="md:col-span-2">
                                    <p className="text-[10px] font-bold text-violet-500 uppercase tracking-wider mb-2">Recent Posts</p>
                                    <div className="space-y-1.5">
                                      {account.sender_recent_posts.map((post, i) => (
                                        <p key={i} className="text-xs text-gray-600 bg-white border border-gray-100 rounded-lg px-3 py-2 line-clamp-2">
                                          {post}
                                        </p>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {!hasSenderData && (
                                  <div className="md:col-span-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                                    No profile data yet. Click <strong>Connect</strong> on this account to scrape the sender's LinkedIn profile automatically.
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
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

      {sessionAccount && (
        <ConnectModal
          account={sessionAccount}
          onClose={() => setSessionAccount(null)}
          onSaved={() => {
            setSessionAccount(null)
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
                        <div className="flex items-start gap-1.5 group relative">
                          <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 mt-1 ${testResult.loading ? 'bg-yellow-400 animate-pulse' : testResult.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                          <span className="text-[11px] font-mono truncate max-w-[120px] cursor-default">
                            {testResult.loading ? 'Testing…' : testResult.result}
                          </span>
                          {!testResult.loading && (
                            <div className="absolute left-0 top-6 z-50 hidden group-hover:block bg-gray-900 text-white text-[10px] font-mono rounded p-2 w-72 break-all shadow-lg whitespace-pre-wrap select-text cursor-text">
                              {testResult.result}
                            </div>
                          )}
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


// ── Connect Modal ─────────────────────────────────────────────────────────────
// Credentials-only login: email + password (+ optional TOTP secret)

type ConnectStep = 'form' | 'connecting' | 'push' | 'verify' | 'done' | 'error'

export function ConnectModal({
  account,
  onClose,
  onSaved,
}: {
  account: LinkedInAccount
  onClose: () => void
  onSaved: () => void
}) {
  const accountId = account.id

  const [step, setStep]             = useState<ConnectStep>('form')
  const [password, setPassword]     = useState('')
  const [totpSecret, setTotpSecret] = useState('')
  const [showTotp, setShowTotp]     = useState(false)
  const [code, setCode]             = useState('')
  const [hint, setHint]             = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [error, setError]           = useState('')
  const [requestingCode, setRequestingCode] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [])

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
      setHint(s.hint); setStep('push')
    }
  }

  function startPolling(key: string) {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try { await handleStatusResult(await getConnectStatus(accountId, key)) }
      catch { /* network blip */ }
    }, 2000)
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    setStep('connecting'); setError('')
    try {
      const secret = totpSecret.trim() || undefined
      const result = await connectAccount(accountId, account.linkedin_email, password, secret)
      setSessionKey(result.session_key)
      startPolling(result.session_key)
    } catch (err) {
      setError((err as Error).message); setStep('error')
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setStep('connecting'); setError('')
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

  if (step === 'done') {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8 flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold text-gray-900">Connected!</p>
            <p className="text-sm text-gray-500 mt-1">Account is now active and ready to run campaigns.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">
            {step === 'push'    ? 'Check your phone'
             : step === 'verify' ? 'Enter verification code'
             : 'Connect LinkedIn Account'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5">

          {/* ── Credentials form ── */}
          {step === 'form' && (
            <form onSubmit={handleSignIn} className="space-y-4">
              {/* Email — pre-filled, read-only */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">LinkedIn email</label>
                <input
                  type="email"
                  readOnly
                  value={account.linkedin_email}
                  className="w-full px-3.5 py-2.5 border border-gray-200 rounded-xl text-sm bg-gray-50 text-gray-500 cursor-default"
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                <input
                  required autoFocus
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              {/* Optional 2FA secret */}
              <div>
                <button type="button" onClick={() => setShowTotp(v => !v)}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                  <svg className={`h-3 w-3 transition-transform ${showTotp ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
                  </svg>
                  Save 2FA secret for auto-reconnect (optional)
                </button>
                {showTotp && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-gray-500">We'll generate TOTP codes automatically so your session never expires.</p>
                    <input type="text" value={totpSecret} onChange={e => setTotpSecret(e.target.value)}
                      placeholder="Base32 secret (e.g. JBSWY3DPEHPK3PXP)"
                      className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                )}
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">{error}</p>}

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={onClose}
                  className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button type="submit"
                  className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
                  Sign in
                </button>
              </div>
            </form>
          )}

          {/* ── Connecting spinner ── */}
          {step === 'connecting' && (
            <div className="py-8 flex flex-col items-center gap-4">
              <svg className="w-8 h-8 animate-spin text-blue-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-700">Logging in to LinkedIn…</p>
                <p className="text-xs text-gray-400 mt-1">This usually takes 10–20 seconds</p>
              </div>
            </div>
          )}

          {/* ── Push notification waiting ── */}
          {step === 'push' && (
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full bg-blue-50 flex items-center justify-center">
                    <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div className="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                    <svg className="w-3 h-3 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                  </div>
                </div>
                <div className="text-center">
                  <p className="text-sm font-semibold text-gray-900">Approve on your LinkedIn app</p>
                  <p className="text-xs text-gray-500 mt-1">
                    Tap <strong>Yes, it's me</strong> on the LinkedIn notification.<br/>
                    We'll detect it automatically.
                  </p>
                </div>
              </div>

              {hint && hint !== 'Signing in to LinkedIn…' && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
                  <p className="text-xs text-blue-800">{hint}</p>
                </div>
              )}

              <button
                type="button"
                disabled={requestingCode}
                onClick={async () => {
                  setRequestingCode(true)
                  try {
                    const result = await requestVerificationCode(accountId, sessionKey)
                    if (result.status === 'already_on_code') {
                      stopPolling(); setHint(result.message); setStep('verify')
                    } else if (result.status === 'switching') {
                      setHint(result.message)
                      try {
                        const statusNow = await getConnectStatus(accountId, sessionKey)
                        if (statusNow.status === 'needs_verification') {
                          stopPolling()
                          if (statusNow.hint) setHint(statusNow.hint)
                          setStep('verify')
                        } else if (statusNow.status === 'success') {
                          stopPolling(); setStep('done'); setTimeout(onSaved, 1500)
                        } else {
                          stopPolling(); setStep('verify')
                        }
                      } catch { stopPolling(); setStep('verify') }
                    } else {
                      stopPolling()
                      setHint('Enter any verification code LinkedIn sent to your email or phone.')
                      setStep('verify')
                    }
                  } catch {
                    stopPolling(); setStep('verify')
                  } finally {
                    setRequestingCode(false)
                  }
                }}
                className="w-full py-2 border border-gray-200 text-sm text-gray-500 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">
                {requestingCode ? 'Requesting…' : 'No notification? Request a code via SMS instead'}
              </button>
              <button type="button" onClick={() => { stopPolling(); setStep('form') }}
                className="w-full py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors">
                Cancel
              </button>
            </div>
          )}

          {/* ── 2FA code entry ── */}
          {step === 'verify' && (
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-sm font-medium text-amber-900">Verification code required</p>
                {hint && <p className="text-xs text-amber-700 mt-1">{hint}</p>}
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

        </div>
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
