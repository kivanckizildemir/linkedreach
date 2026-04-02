import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/fetchJson'

interface AnalyticsResponse {
  overview: {
    active_campaigns:  number
    total_campaigns:   number
    total_leads:       number
    total_connections: number
    total_replies:     number
    total_converted:   number
  }
  icp_breakdown: {
    hot:          number
    warm:         number
    cold:         number
    disqualified: number
    unscored:     number
  }
  accounts: Array<{
    id: string
    linkedin_email: string
    status: string
    daily_connection_count: number
    daily_message_count: number
    warmup_day: number
    last_active_at: string | null
  }>
  campaigns: Array<{
    id: string
    name: string
    status: string
    total: number
    connection_sent: number
    connected: number
    messaged: number
    replied: number
    converted: number
    acceptance_rate: number
    reply_rate: number
    by_classification: Record<string, number>
  }>
}

async function fetchAnalytics(): Promise<AnalyticsResponse> {
  const res = await apiFetch('/api/analytics')
  if (!res.ok) throw new Error('Failed to fetch analytics')
  return res.json() as Promise<AnalyticsResponse>
}

const STATUS_COLOR: Record<string, string> = {
  active:     'bg-green-100 text-green-700',
  paused:     'bg-yellow-100 text-yellow-700',
  banned:     'bg-red-100 text-red-700',
  warming_up: 'bg-blue-100 text-blue-700',
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

function ProgressBar({ value, max, color = '#3B82F6' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs font-medium tabular-nums text-gray-500 w-8 text-right">{pct}%</span>
    </div>
  )
}

export function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics'],
    queryFn: fetchAnalytics,
    refetchInterval: 60_000,
  })

  const ov = data?.overview

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">Overview of your outreach activity</p>
      </div>

      {/* Overview stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard label="Active Campaigns" value={isLoading ? '—' : (ov?.active_campaigns ?? 0)} sub={`of ${ov?.total_campaigns ?? 0} total`} />
        <StatCard label="Total Leads"      value={isLoading ? '—' : (ov?.total_leads ?? 0)} />
        <StatCard label="Connections Sent" value={isLoading ? '—' : (ov?.total_connections ?? 0)} />
        <StatCard label="Replies"          value={isLoading ? '—' : (ov?.total_replies ?? 0)} />
        <StatCard label="Converted"        value={isLoading ? '—' : (ov?.total_converted ?? 0)} />
        <StatCard
          label="Reply Rate"
          value={isLoading ? '—' : (
            ov && ov.total_connections > 0
              ? `${Math.round((ov.total_replies / ov.total_connections) * 100)}%`
              : '—'
          )}
          sub="replies / connections"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lead ICP breakdown */}
        {data?.icp_breakdown && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Lead Quality</h2>
            <div className="space-y-3">
              {[
                { key: 'hot',          label: '🔥 Hot',          color: '#EF4444' },
                { key: 'warm',         label: '☀️ Warm',          color: '#F97316' },
                { key: 'cold',         label: '❄️ Cold',          color: '#3B82F6' },
                { key: 'disqualified', label: '✗ Disqualified',   color: '#9CA3AF' },
                { key: 'unscored',     label: '· Not scored',      color: '#D1D5DB' },
              ].map(({ key, label, color }) => {
                const val   = data.icp_breakdown[key as keyof typeof data.icp_breakdown]
                const total = Object.values(data.icp_breakdown).reduce((a, b) => a + b, 0)
                return (
                  <div key={key}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-gray-600">{label}</span>
                      <span className="font-medium text-gray-700">{val}</span>
                    </div>
                    <ProgressBar value={val} max={total} color={color} />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Account health */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Account Health</h2>
          {isLoading ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : (data?.accounts ?? []).length === 0 ? (
            <p className="text-xs text-gray-400">No accounts yet.</p>
          ) : (
            <div className="space-y-3">
              {(data?.accounts ?? []).map(acc => (
                <div key={acc.id} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-800 truncate">{acc.linkedin_email}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {acc.daily_connection_count}/25 conn · {acc.daily_message_count}/100 msg today
                    </p>
                    {acc.warmup_day > 0 && (
                      <p className="text-[11px] text-gray-400">Warmup day {acc.warmup_day}</p>
                    )}
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLOR[acc.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {acc.status.replace('_', ' ')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Getting started (only when no campaigns yet) */}
        {(data?.campaigns ?? []).length === 0 && !isLoading && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Getting Started</h2>
            <ol className="space-y-3 text-sm text-gray-600 list-decimal list-inside">
              <li>Add a LinkedIn account under <strong>Accounts</strong></li>
              <li>Import leads from Sales Navigator under <strong>Leads</strong></li>
              <li>Create a campaign under <strong>Campaigns</strong></li>
              <li>Monitor replies in the <strong>Inbox</strong></li>
            </ol>
          </div>
        )}
      </div>

      {/* Per-campaign breakdown */}
      {(data?.campaigns ?? []).length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-900">Campaign Performance</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-gray-500 uppercase tracking-wide border-b border-gray-100 bg-gray-50">
                  <th className="px-5 py-3 text-left font-medium">Campaign</th>
                  <th className="px-4 py-3 text-right font-medium">Leads</th>
                  <th className="px-4 py-3 text-right font-medium">Sent</th>
                  <th className="px-4 py-3 text-right font-medium">Connected</th>
                  <th className="px-4 py-3 text-right font-medium">Acceptance</th>
                  <th className="px-4 py-3 text-right font-medium">Messaged</th>
                  <th className="px-4 py-3 text-right font-medium">Replied</th>
                  <th className="px-4 py-3 text-right font-medium">Reply Rate</th>
                  <th className="px-4 py-3 text-right font-medium">Converted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {(data?.campaigns ?? []).map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          c.status === 'active'    ? 'bg-green-100 text-green-700' :
                          c.status === 'paused'    ? 'bg-yellow-100 text-yellow-700' :
                          c.status === 'completed' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-500'
                        }`}>{c.status}</span>
                        <span className="font-medium text-gray-900">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right text-gray-600">{c.total}</td>
                    <td className="px-4 py-3.5 text-right text-gray-600">{c.connection_sent}</td>
                    <td className="px-4 py-3.5 text-right text-gray-600">{c.connected}</td>
                    <td className="px-4 py-3.5 text-right">
                      <span className={`font-semibold ${c.acceptance_rate >= 30 ? 'text-green-600' : c.acceptance_rate >= 15 ? 'text-orange-500' : 'text-gray-500'}`}>
                        {c.connection_sent > 0 ? `${c.acceptance_rate}%` : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right text-gray-600">{c.messaged}</td>
                    <td className="px-4 py-3.5 text-right text-gray-600">{c.replied}</td>
                    <td className="px-4 py-3.5 text-right">
                      <span className={`font-semibold ${c.reply_rate >= 20 ? 'text-green-600' : c.reply_rate >= 10 ? 'text-orange-500' : 'text-gray-500'}`}>
                        {c.messaged > 0 ? `${c.reply_rate}%` : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-right text-gray-600">{c.converted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
