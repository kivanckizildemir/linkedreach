import { useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchCampaign,
  fetchCampaignLeads,
  updateCampaign,
  removeCampaignLead,
  deleteCampaign,
  addLeadsToCampaign,
  type Campaign,
  type CampaignLead,
} from '../api/campaigns'
import { fetchAccounts } from '../api/accounts'
import { apiFetch } from '../lib/fetchJson'

interface Lead {
  id: string
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  icp_flag: string | null
  icp_score: number | null
}

const STATUS_COLORS: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-700',
  active:    'bg-green-100 text-green-700',
  paused:    'bg-yellow-100 text-yellow-700',
  completed: 'bg-blue-100 text-blue-700',
}

const LEAD_STATUS_COLORS: Record<string, string> = {
  pending:          'bg-gray-100 text-gray-500',
  connection_sent:  'bg-blue-50 text-blue-600',
  connected:        'bg-blue-100 text-blue-700',
  messaged:         'bg-purple-100 text-purple-700',
  replied:          'bg-green-100 text-green-700',
  converted:        'bg-emerald-100 text-emerald-700',
  skipped:          'bg-gray-100 text-gray-400',
}

const ICP_COLORS: Record<string, string> = {
  hot:          'text-red-600',
  warm:         'text-orange-500',
  cold:         'text-blue-500',
  disqualified: 'text-gray-400',
}

const ICP_LABELS: Record<string, string> = {
  hot: '🔥 Hot', warm: '☀️ Warm', cold: '❄️ Cold', disqualified: '✗ Disq.',
}

async function fetchAllLeads(): Promise<Lead[]> {
  const res = await apiFetch('/api/leads?limit=500')
  if (!res.ok) throw new Error('Failed to fetch leads')
  const { data } = await res.json() as { data: Lead[] }
  return data ?? []
}

export function CampaignDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'leads' | 'settings'>('leads')
  const [search, setSearch] = useState('')
  const [showAddLeads, setShowAddLeads] = useState(false)
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set())
  const [leadSearch, setLeadSearch] = useState('')

  const { data: campaign, isLoading: campaignLoading } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => fetchCampaign(id!),
    enabled: !!id,
  })

  const { data: campaignLeads = [], isLoading: leadsLoading } = useQuery({
    queryKey: ['campaign-leads', id],
    queryFn: () => fetchCampaignLeads(id!),
    enabled: !!id,
  })

  const { data: allLeads = [] } = useQuery({
    queryKey: ['all-leads'],
    queryFn: fetchAllLeads,
    enabled: showAddLeads,
  })

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  })

  const statusMutation = useMutation({
    mutationFn: (status: string) => updateCampaign(id!, { status: status as 'active' | 'paused' | 'completed' | 'draft' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
  })

  const removeMutation = useMutation({
    mutationFn: (clId: string) => removeCampaignLead(id!, clId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['campaign-leads', id] }),
  })

  const addMutation = useMutation({
    mutationFn: (leadIds: string[]) => addLeadsToCampaign(id!, leadIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaign-leads', id] })
      setShowAddLeads(false)
      setSelectedLeadIds(new Set())
      setLeadSearch('')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteCampaign(id!),
    onSuccess: () => navigate('/campaigns'),
  })

  const scheduleMutation = useMutation({
    mutationFn: (updates: Parameters<typeof updateCampaign>[1]) => updateCampaign(id!, updates),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
  })

  const [showSchedule, setShowSchedule] = useState(false)

  if (campaignLoading) {
    return <div className="p-8 text-sm text-gray-400">Loading…</div>
  }

  if (!campaign) {
    return <div className="p-8 text-sm text-gray-500">Campaign not found.</div>
  }

  // Stats
  const total = campaignLeads.length
  const sent = campaignLeads.filter(cl => ['connection_sent','connected','messaged','replied','converted'].includes(cl.status)).length
  const connected = campaignLeads.filter(cl => ['connected','messaged','replied','converted'].includes(cl.status)).length
  const messaged = campaignLeads.filter(cl => ['messaged','replied','converted'].includes(cl.status)).length
  const replied = campaignLeads.filter(cl => ['replied','converted'].includes(cl.status)).length
  const converted = campaignLeads.filter(cl => cl.status === 'converted').length

  const filtered = campaignLeads.filter(cl => {
    if (!search) return true
    const q = search.toLowerCase()
    const l = cl.lead
    return `${l.first_name} ${l.last_name} ${l.company ?? ''}`.toLowerCase().includes(q)
  })

  // Leads available to add (not already in campaign)
  const existingLeadIds = new Set(campaignLeads.map(cl => cl.lead.id))
  const availableLeads = allLeads.filter(l =>
    !existingLeadIds.has(l.id) &&
    (!leadSearch || `${l.first_name} ${l.last_name} ${l.company ?? ''}`.toLowerCase().includes(leadSearch.toLowerCase()))
  )

  return (
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={() => navigate('/campaigns')}
            className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 mb-2"
          >
            ← All Campaigns
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{campaign.name}</h1>
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[campaign.status] ?? 'bg-gray-100 text-gray-600'}`}>
              {campaign.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            Created {new Date(campaign.created_at).toLocaleDateString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status === 'draft' && (
            <button
              onClick={() => statusMutation.mutate('active')}
              disabled={statusMutation.isPending}
              className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-60 transition-colors"
            >
              Activate
            </button>
          )}
          {campaign.status === 'active' && (
            <button
              onClick={() => statusMutation.mutate('paused')}
              disabled={statusMutation.isPending}
              className="px-4 py-2 bg-yellow-500 text-white text-sm font-medium rounded-lg hover:bg-yellow-600 disabled:opacity-60 transition-colors"
            >
              Pause
            </button>
          )}
          {campaign.status === 'paused' && (
            <button
              onClick={() => statusMutation.mutate('active')}
              disabled={statusMutation.isPending}
              className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-60 transition-colors"
            >
              Resume
            </button>
          )}
          {(campaign.status === 'active' || campaign.status === 'paused') && (
            <button
              onClick={() => statusMutation.mutate('completed')}
              disabled={statusMutation.isPending}
              className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 disabled:opacity-60 transition-colors"
            >
              Complete
            </button>
          )}
          {campaignLeads.length > 0 && (
            <button
              onClick={() => {
                const headers = ['First Name','Last Name','Title','Company','LinkedIn URL','ICP Flag','ICP Score','Status','Reply']
                const rows = campaignLeads.map(cl => [
                  cl.lead.first_name, cl.lead.last_name,
                  cl.lead.title ?? '', cl.lead.company ?? '',
                  cl.lead.linkedin_url ?? '', cl.lead.icp_flag ?? '',
                  cl.lead.icp_score ?? '', cl.status,
                  cl.reply_classification !== 'none' ? cl.reply_classification : '',
                ])
                const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
                const blob = new Blob([csv], { type: 'text/csv' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url; a.download = `${campaign.name.replace(/[^a-z0-9]/gi,'-')}-leads.csv`
                a.click(); URL.revokeObjectURL(url)
              }}
              className="px-3 py-2 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50 flex items-center gap-1.5 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          )}
          <button
            onClick={() => {
              if (confirm('Delete this campaign? This cannot be undone.')) deleteMutation.mutate()
            }}
            disabled={deleteMutation.isPending}
            className="px-3 py-2 text-red-500 text-sm rounded-lg hover:bg-red-50 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {[
          { label: 'Total Leads', value: total },
          { label: 'Conn. Sent', value: sent },
          { label: 'Connected', value: connected, pct: sent > 0 ? Math.round(connected/sent*100) : null },
          { label: 'Messaged', value: messaged },
          { label: 'Replied', value: replied, pct: messaged > 0 ? Math.round(replied/messaged*100) : null },
          { label: 'Converted', value: converted },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">{s.label}</p>
            <p className="mt-1.5 text-2xl font-bold text-gray-900">{s.value}</p>
            {s.pct != null && (
              <p className="text-[10px] text-gray-400 mt-0.5">{s.pct}%</p>
            )}
          </div>
        ))}
      </div>

      {/* Tab selector */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['leads', 'settings'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors capitalize',
              tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            ].join(' ')}
          >
            {t === 'leads' ? `Leads (${total})` : 'Settings'}
          </button>
        ))}
        <button
          onClick={() => navigate(`/campaigns/${id}/sequence`)}
          className="px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors border-transparent text-gray-500 hover:text-gray-700"
        >
          Sequence
        </button>
      </div>

      {tab === 'leads' && <>
      {/* Funnel chart */}
      {total > 0 && (
        <FunnelChart total={total} sent={sent} connected={connected} messaged={messaged} replied={replied} converted={converted} />
      )}

      {/* Schedule panel */}
      <div className="bg-white rounded-xl border border-gray-200">
        <button
          className="w-full px-5 py-4 flex items-center justify-between text-sm font-semibold text-gray-900 hover:bg-gray-50 transition-colors rounded-xl"
          onClick={() => setShowSchedule(v => !v)}
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Schedule
            <span className="text-xs font-normal text-gray-400 ml-1">
              {DAY_NAMES.filter((_, i) => (campaign.schedule_days ?? [1,2,3,4,5]).includes(i)).join(', ')}
              {' · '}
              {formatHour(campaign.schedule_start_hour ?? 9)}–{formatHour(campaign.schedule_end_hour ?? 17)}
              {' · '}{campaign.schedule_timezone ?? 'UTC'}
            </span>
          </div>
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${showSchedule ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showSchedule && (
          <ScheduleEditor campaign={campaign} onSave={updates => scheduleMutation.mutate(updates)} saving={scheduleMutation.isPending} />
        )}
      </div>

      {/* Leads table */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-900">Leads <span className="text-gray-400 font-normal">({total})</span></h2>
          <div className="flex items-center gap-2 flex-1 max-w-sm">
            <input
              type="text"
              placeholder="Search leads…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={() => setShowAddLeads(true)}
            className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shrink-0"
          >
            + Add Leads
          </button>
        </div>

        {leadsLoading ? (
          <div className="py-10 text-center text-sm text-gray-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-500">No leads in this campaign yet.</p>
            <button
              onClick={() => setShowAddLeads(true)}
              className="mt-3 text-sm text-blue-600 hover:underline"
            >
              Add leads from your database →
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-gray-500 uppercase tracking-wide border-b border-gray-100 bg-gray-50">
                  <th className="px-5 py-3 text-left font-medium">Lead</th>
                  <th className="px-4 py-3 text-left font-medium">Company</th>
                  <th className="px-4 py-3 text-left font-medium">ICP</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Reply</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((cl: CampaignLead) => (
                  <tr key={cl.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3.5">
                      <div>
                        <p className="font-medium text-gray-900">{cl.lead.first_name} {cl.lead.last_name}</p>
                        {cl.lead.title && <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[180px]">{cl.lead.title}</p>}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-gray-600 text-xs">{cl.lead.company ?? '—'}</td>
                    <td className="px-4 py-3.5">
                      {cl.lead.icp_flag ? (
                        <span className={`text-xs font-medium ${ICP_COLORS[cl.lead.icp_flag] ?? 'text-gray-400'}`}>
                          {ICP_LABELS[cl.lead.icp_flag] ?? cl.lead.icp_flag}
                        </span>
                      ) : <span className="text-xs text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${LEAD_STATUS_COLORS[cl.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {cl.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      {cl.reply_classification && cl.reply_classification !== 'none' ? (
                        <span className="text-xs text-gray-600 capitalize">{cl.reply_classification.replace(/_/g, ' ')}</span>
                      ) : <span className="text-xs text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <button
                        onClick={() => {
                          if (confirm(`Remove ${cl.lead.first_name} from this campaign?`)) {
                            removeMutation.mutate(cl.id)
                          }
                        }}
                        className="text-xs text-red-400 hover:text-red-600 transition-colors"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Leads modal */}
      {showAddLeads && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[80vh]">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Add Leads to Campaign</h2>
              <button onClick={() => { setShowAddLeads(false); setSelectedLeadIds(new Set()) }} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="px-6 py-3 border-b border-gray-100">
              <input
                type="text"
                placeholder="Search leads…"
                value={leadSearch}
                onChange={e => setLeadSearch(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-2">
              {availableLeads.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">No available leads found.</p>
              ) : (
                availableLeads.map(lead => (
                  <label key={lead.id} className="flex items-center gap-3 py-2.5 border-b border-gray-50 cursor-pointer hover:bg-gray-50 rounded-lg px-2 -mx-2">
                    <input
                      type="checkbox"
                      checked={selectedLeadIds.has(lead.id)}
                      onChange={e => {
                        const next = new Set(selectedLeadIds)
                        if (e.target.checked) next.add(lead.id)
                        else next.delete(lead.id)
                        setSelectedLeadIds(next)
                      }}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{lead.first_name} {lead.last_name}</p>
                      <p className="text-xs text-gray-400 truncate">{lead.title ?? ''}{lead.company ? ` · ${lead.company}` : ''}</p>
                    </div>
                    {lead.icp_flag && (
                      <span className={`text-xs font-medium ${ICP_COLORS[lead.icp_flag] ?? 'text-gray-400'}`}>
                        {ICP_LABELS[lead.icp_flag] ?? lead.icp_flag}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
              <p className="text-sm text-gray-500">{selectedLeadIds.size} selected</p>
              <div className="flex gap-3">
                <button
                  onClick={() => { setShowAddLeads(false); setSelectedLeadIds(new Set()) }}
                  className="px-4 py-2 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => addMutation.mutate([...selectedLeadIds])}
                  disabled={selectedLeadIds.size === 0 || addMutation.isPending}
                  className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
                >
                  {addMutation.isPending ? 'Adding…' : `Add ${selectedLeadIds.size} Lead${selectedLeadIds.size !== 1 ? 's' : ''}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </>}

      {tab === 'settings' && (
        <CampaignSettings
          campaign={campaign}
          accounts={accounts}
          onSave={updates => scheduleMutation.mutate(updates)}
          saving={scheduleMutation.isPending}
        />
      )}
    </div>
  )
}

// ── Campaign Settings ─────────────────────────────────────────────────────────

function CampaignSettings({
  campaign,
  accounts,
  onSave,
  saving,
}: {
  campaign: Campaign
  accounts: import('../api/accounts').LinkedInAccount[]
  onSave: (updates: Partial<Campaign>) => void
  saving: boolean
}) {
  const [accountId, setAccountId] = useState(campaign.account_id ?? '')
  const [minScore, setMinScore] = useState(campaign.min_icp_score ?? 0)
  const [connLimit, setConnLimit] = useState(campaign.daily_connection_limit)
  const [msgLimit, setMsgLimit] = useState(campaign.daily_message_limit)
  const [connNote, setConnNote] = useState(campaign.connection_note ?? '')

  const isDirty =
    accountId !== (campaign.account_id ?? '') ||
    minScore !== campaign.min_icp_score ||
    connLimit !== campaign.daily_connection_limit ||
    msgLimit !== campaign.daily_message_limit ||
    connNote !== (campaign.connection_note ?? '')

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
      {/* LinkedIn Account */}
      <div>
        <label className="block text-sm font-semibold text-gray-900 mb-1">LinkedIn Account</label>
        <p className="text-xs text-gray-400 mb-2">Which account will run this campaign</p>
        <select
          value={accountId}
          onChange={e => setAccountId(e.target.value)}
          className="w-full max-w-sm px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Auto-select (any active account)</option>
          {accounts.map(acc => (
            <option key={acc.id} value={acc.id}>
              {acc.linkedin_email} · {acc.status} · {acc.daily_connection_count}/{acc.status === 'warming_up' ? Math.min(5 + Math.floor((acc.warmup_day-1)/7)*3, 25) : 25}/day
            </option>
          ))}
        </select>
      </div>

      {/* ICP Score threshold */}
      <div>
        <label className="block text-sm font-semibold text-gray-900 mb-1">Minimum ICP Score</label>
        <p className="text-xs text-gray-400 mb-2">Only reach out to leads at or above this score. 0 = all leads.</p>
        <div className="flex items-center gap-4 max-w-sm">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={minScore}
            onChange={e => setMinScore(Number(e.target.value))}
            className="flex-1"
          />
          <span className={`text-sm font-bold w-12 text-center ${minScore >= 75 ? 'text-red-600' : minScore >= 50 ? 'text-orange-500' : minScore > 0 ? 'text-blue-600' : 'text-gray-400'}`}>
            {minScore > 0 ? `≥${minScore}` : 'Any'}
          </span>
        </div>
      </div>

      {/* Daily limits */}
      <div className="grid grid-cols-2 gap-6 max-w-sm">
        <div>
          <label className="block text-sm font-semibold text-gray-900 mb-1">Connection Limit</label>
          <p className="text-xs text-gray-400 mb-2">Per day, per account</p>
          <input
            type="number"
            min={1}
            max={25}
            value={connLimit}
            onChange={e => setConnLimit(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[10px] text-gray-400 mt-1">Max 25/day (LinkedIn limit)</p>
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-900 mb-1">Message Limit</label>
          <p className="text-xs text-gray-400 mb-2">Per day, per account</p>
          <input
            type="number"
            min={1}
            max={100}
            value={msgLimit}
            onChange={e => setMsgLimit(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[10px] text-gray-400 mt-1">Max 100/day (LinkedIn limit)</p>
        </div>
      </div>

      {/* Default connection note */}
      <div>
        <label className="block text-sm font-semibold text-gray-900 mb-1">
          Default Connection Note
          <span className="text-xs font-normal text-gray-400 ml-2">({(connNote ?? '').length}/300 chars)</span>
        </label>
        <p className="text-xs text-gray-400 mb-2">
          Shown on connection requests. Use <code className="bg-gray-100 px-1 rounded">{'{{first_name}}'}</code>,{' '}
          <code className="bg-gray-100 px-1 rounded">{'{{company}}'}</code> etc. Leave blank to send without a note.
        </p>
        <textarea
          value={connNote}
          onChange={e => setConnNote(e.target.value)}
          maxLength={300}
          rows={3}
          className={`w-full px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none ${connNote.length > 280 ? 'border-orange-300' : 'border-gray-200'}`}
          placeholder="Hi {{first_name}}, I came across your profile and thought it'd be great to connect…"
        />
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => onSave({
            account_id: accountId || null,
            min_icp_score: minScore,
            daily_connection_limit: connLimit,
            daily_message_limit: msgLimit,
            connection_note: connNote || null,
          })}
          disabled={!isDirty || saving}
          className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}

// ── Funnel Chart ──────────────────────────────────────────────────────────────

function FunnelChart({
  total, sent, connected, messaged, replied, converted,
}: {
  total: number; sent: number; connected: number; messaged: number; replied: number; converted: number
}) {
  const stages = [
    { label: 'Total',     value: total,     color: '#e2e8f0', text: '#64748b' },
    { label: 'Req. Sent', value: sent,      color: '#bfdbfe', text: '#1d4ed8' },
    { label: 'Connected', value: connected, color: '#a5f3fc', text: '#0e7490' },
    { label: 'Messaged',  value: messaged,  color: '#c4b5fd', text: '#6d28d9' },
    { label: 'Replied',   value: replied,   color: '#bbf7d0', text: '#15803d' },
    { label: 'Converted', value: converted, color: '#6ee7b7', text: '#065f46' },
  ]

  const max = total || 1

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">Conversion Funnel</h2>
      <div className="space-y-2">
        {stages.map((stage, i) => {
          const pct = Math.round((stage.value / max) * 100)
          const dropPct = i > 0 && stages[i-1].value > 0
            ? Math.round((stage.value / stages[i-1].value) * 100)
            : null
          return (
            <div key={stage.label} className="flex items-center gap-3">
              <span className="text-xs text-gray-500 w-20 shrink-0 text-right">{stage.label}</span>
              <div className="flex-1 h-7 bg-gray-50 rounded-lg overflow-hidden relative">
                <div
                  className="h-full rounded-lg transition-all duration-500 flex items-center pl-3"
                  style={{ width: `${Math.max(pct, 2)}%`, background: stage.color }}
                >
                  <span className="text-xs font-semibold" style={{ color: stage.text }}>
                    {stage.value}
                  </span>
                </div>
              </div>
              <div className="w-20 shrink-0 text-xs text-gray-400 tabular-nums">
                {pct}%{dropPct !== null && dropPct < 100 && (
                  <span className="ml-1 text-gray-300">(↓{dropPct}%)</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatHour(h: number): string {
  if (h === 0) return '12am'
  if (h < 12) return `${h}am`
  if (h === 12) return '12pm'
  return `${h - 12}pm`
}

// Common IANA timezones
const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Vancouver',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Warsaw',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Australia/Sydney',
  'Pacific/Auckland',
]

function ScheduleEditor({
  campaign,
  onSave,
  saving,
}: {
  campaign: Campaign
  onSave: (updates: Partial<Campaign>) => void
  saving: boolean
}) {
  const [days, setDays] = useState<number[]>(campaign.schedule_days ?? [1,2,3,4,5])
  const [startHour, setStartHour] = useState(campaign.schedule_start_hour ?? 9)
  const [endHour, setEndHour] = useState(campaign.schedule_end_hour ?? 17)
  const [timezone, setTimezone] = useState(campaign.schedule_timezone ?? 'UTC')

  const toggleDay = useCallback((d: number) => {
    setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort())
  }, [])

  return (
    <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-5">
      {/* Days of week */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-2">Active Days</label>
        <div className="flex gap-2">
          {DAY_NAMES.map((name, i) => (
            <button
              key={i}
              onClick={() => toggleDay(i)}
              className={[
                'w-10 h-10 rounded-full text-xs font-semibold transition-colors',
                days.includes(i)
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
              ].join(' ')}
            >
              {name}
            </button>
          ))}
        </div>
      </div>

      {/* Time window */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1.5">Start Time</label>
          <select
            value={startHour}
            onChange={e => setStartHour(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i}>{formatHour(i)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1.5">End Time</label>
          <select
            value={endHour}
            onChange={e => setEndHour(Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {Array.from({ length: 24 }, (_, i) => (
              <option key={i} value={i} disabled={i <= startHour}>{formatHour(i)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Timezone */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1.5">Timezone</label>
        <select
          value={timezone}
          onChange={e => setTimezone(e.target.value)}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {TIMEZONES.map(tz => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => onSave({ schedule_days: days, schedule_start_hour: startHour, schedule_end_hour: endHour, schedule_timezone: timezone })}
          disabled={saving || days.length === 0}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          {saving ? 'Saving…' : 'Save Schedule'}
        </button>
      </div>
    </div>
  )
}
