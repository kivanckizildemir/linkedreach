import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchCampaign,
  fetchCampaignLeads,
  updateCampaign,
  removeCampaignLead,
  deleteCampaign,
  addLeadsToCampaign,
  type CampaignLead,
} from '../api/campaigns'
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
    </div>
  )
}
