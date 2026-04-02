import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchLeads, requalifyLead, qualifyAllLeads, importLeads, startSalesNavImport, getScrapeStatus, fetchLeadNotes, addLeadNote, deleteLeadNote, personaliseOpeningLine, fetchLeadCampaigns, bulkDeleteLeads } from '../api/leads'
import type { Lead, LeadNote, LeadCampaignMembership } from '../api/leads'
import { fetchLabels, fetchLeadLabels, assignLabel, removeLabel, createLabel, type LeadLabel } from '../api/labels'
import { fetchAccounts } from '../api/accounts'
import { fetchCampaigns, addLeadsToCampaign } from '../api/campaigns'
import * as XLSX from 'xlsx'

const FLAG_COLORS: Record<NonNullable<Lead['icp_flag']>, string> = {
  hot:          'bg-red-100 text-red-700 border-red-200',
  warm:         'bg-orange-100 text-orange-700 border-orange-200',
  cold:         'bg-blue-100 text-blue-700 border-blue-200',
  disqualified: 'bg-gray-100 text-gray-500 border-gray-200',
}

const FLAG_ICONS: Record<NonNullable<Lead['icp_flag']>, string> = {
  hot: '🔥', warm: '☀️', cold: '❄️', disqualified: '✗',
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 75 ? '#EF4444' : score >= 50 ? '#F97316' : score >= 25 ? '#3B82F6' : '#9CA3AF'
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: color }} />
      </div>
      <span className="text-xs font-semibold tabular-nums" style={{ color }}>{score}</span>
    </div>
  )
}

function ReasoningTooltip({ reasoning }: { reasoning: string }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative inline-block">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        className="ml-1.5 w-4 h-4 rounded-full bg-gray-200 text-gray-500 text-[10px] font-bold flex items-center justify-center hover:bg-gray-300 transition-colors"
      >
        ?
      </button>
      {show && (
        <div className="absolute left-6 top-0 z-50 w-64 bg-gray-900 text-white text-xs rounded-xl p-3 shadow-xl leading-relaxed">
          <p className="font-semibold text-gray-300 mb-1 text-[10px] uppercase tracking-wider">AI Reasoning</p>
          {reasoning}
        </div>
      )}
    </div>
  )
}

export function Leads() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [icpFlag, setIcpFlag] = useState('')
  const [showImportModal, setShowImportModal] = useState(false)
  const [showCsvModal, setShowCsvModal] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showAddToCampaign, setShowAddToCampaign] = useState(false)
  const [targetCampaignId, setTargetCampaignId] = useState('')
  const [notesLead, setNotesLead] = useState<Lead | null>(null)
  const [labelsLead, setLabelsLead] = useState<Lead | null>(null)
  const [showManageLabels, setShowManageLabels] = useState(false)
  const [detailLead, setDetailLead] = useState<Lead | null>(null)

  const { data: leads = [], isLoading } = useQuery({
    queryKey: ['leads', { search, icp_flag: icpFlag }],
    queryFn: () => fetchLeads({ search: search || undefined, icp_flag: icpFlag || undefined }),
  })

  const requalifyMutation = useMutation({
    mutationFn: requalifyLead,
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['leads'] }), 4000)
    },
  })

  const personaliseMutation = useMutation({
    mutationFn: personaliseOpeningLine,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
    },
  })

  const qualifyAllMutation = useMutation({
    mutationFn: qualifyAllLeads,
    onSuccess: (result) => {
      if (result.queued > 0) {
        setTimeout(() => queryClient.invalidateQueries({ queryKey: ['leads'] }), 6000)
      }
    },
  })

  const unscoredCount = leads.filter(l => l.icp_score == null).length

  const { data: labels = [] } = useQuery({
    queryKey: ['labels'],
    queryFn: fetchLabels,
  })

  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => import('../api/campaigns').then(m => m.fetchCampaigns()),
    enabled: showAddToCampaign,
  })

  const addToCampaignMutation = useMutation({
    mutationFn: () => addLeadsToCampaign(targetCampaignId, [...selectedIds]),
    onSuccess: () => {
      setShowAddToCampaign(false)
      setSelectedIds(new Set())
      setTargetCampaignId('')
    },
  })

  const bulkDeleteMutation = useMutation({
    mutationFn: () => bulkDeleteLeads([...selectedIds]),
    onSuccess: () => {
      setSelectedIds(new Set())
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
    },
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="mt-1 text-sm text-gray-500">Import and manage your lead lists</p>
        </div>
        <div className="flex gap-3">
          {unscoredCount > 0 && (
            <button
              onClick={() => qualifyAllMutation.mutate()}
              disabled={qualifyAllMutation.isPending}
              className="px-4 py-2 border border-blue-300 text-blue-700 text-sm font-medium rounded-lg hover:bg-blue-50 transition-colors disabled:opacity-60"
            >
              {qualifyAllMutation.isPending
                ? 'Queuing…'
                : `AI Score All (${unscoredCount})`}
            </button>
          )}
          {leads.length > 0 && (
            <button
              onClick={() => {
                const headers = ['First Name','Last Name','Title','Company','LinkedIn URL','ICP Flag','ICP Score','Email','Location','Industry']
                const rows = leads.map(l => [
                  l.first_name, l.last_name, l.title ?? '', l.company ?? '',
                  l.linkedin_url, l.icp_flag ?? '', l.icp_score ?? '',
                  (l as Record<string,unknown>).email ?? '', (l as Record<string,unknown>).location ?? '',
                  (l as Record<string,unknown>).industry ?? '',
                ])
                const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
                const blob = new Blob([csv], { type: 'text/csv' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url; a.download = `leads-${new Date().toISOString().split('T')[0]}.csv`
                a.click(); URL.revokeObjectURL(url)
              }}
              className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          )}
          <button
            onClick={() => setShowManageLabels(true)}
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            Labels
          </button>
          <button
            onClick={() => setShowCsvModal(true)}
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Import CSV / Excel
          </button>
          <button
            onClick={() => setShowImportModal(true)}
            className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            Import from Sales Nav
          </button>
          <button className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
            Add Lead
          </button>
        </div>
      </div>

      <div className="mt-6 flex gap-4">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search leads…"
          className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={icpFlag}
          onChange={e => setIcpFlag(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All flags</option>
          <option value="hot">🔥 Hot</option>
          <option value="warm">☀️ Warm</option>
          <option value="cold">❄️ Cold</option>
          <option value="disqualified">✗ Disqualified</option>
        </select>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
          <span className="text-sm font-medium text-blue-800">{selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''} selected</span>
          <button
            onClick={() => setShowAddToCampaign(true)}
            className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            + Add to Campaign
          </button>
          <button
            onClick={() => {
              if (confirm(`Delete ${selectedIds.size} lead${selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.`)) {
                bulkDeleteMutation.mutate()
              }
            }}
            disabled={bulkDeleteMutation.isPending}
            className="px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 text-sm font-medium rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
          >
            {bulkDeleteMutation.isPending ? 'Deleting…' : '✕ Delete'}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-sm text-blue-500 hover:text-blue-700"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="mt-4 bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={leads.length > 0 && selectedIds.size === leads.length}
                    onChange={e => setSelectedIds(e.target.checked ? new Set(leads.map(l => l.id)) : new Set())}
                    className="rounded border-gray-300 text-blue-600"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Company</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ICP Score</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Flag</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Labels</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-gray-400 text-sm">Loading…</td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-gray-500">
                    No leads yet. Import from a Sales Navigator Excel export to get started.
                  </td>
                </tr>
              ) : (
                leads.map(lead => {
                  const isQueued = requalifyMutation.isPending && requalifyMutation.variables === lead.id
                  const reasoning = lead.raw_data?.ai_reasoning
                  const openingLine = lead.raw_data?.opening_line
                  return (
                    <tr key={lead.id} className={`hover:bg-gray-50 transition-colors ${selectedIds.has(lead.id) ? 'bg-blue-50' : ''}`}>
                      <td className="px-4 py-3 w-8">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(lead.id)}
                          onChange={e => {
                            const next = new Set(selectedIds)
                            if (e.target.checked) next.add(lead.id)
                            else next.delete(lead.id)
                            setSelectedIds(next)
                          }}
                          className="rounded border-gray-300 text-blue-600"
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                        <button
                          onClick={() => setDetailLead(lead)}
                          className="text-left hover:text-blue-600 hover:underline transition-colors"
                        >
                          {lead.first_name} {lead.last_name}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{lead.title ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{lead.company ?? '—'}</td>
                      <td className="px-4 py-3">
                        {lead.icp_score != null ? (
                          <div className="flex items-center">
                            <ScoreBar score={lead.icp_score} />
                            {reasoning && <ReasoningTooltip reasoning={reasoning} />}
                          </div>
                        ) : (
                          <span className="text-gray-400 text-xs italic">Not scored</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {lead.icp_flag ? (
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${FLAG_COLORS[lead.icp_flag]}`}>
                            <span>{FLAG_ICONS[lead.icp_flag]}</span>
                            {lead.icp_flag}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs italic">Unscored</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <LeadLabelCell leadId={lead.id} allLabels={labels} queryClient={queryClient} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 capitalize">{lead.source.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {openingLine && (
                            <span
                              className="text-[10px] text-purple-500 max-w-[140px] truncate italic cursor-help"
                              title={openingLine}
                            >
                              ✨ {openingLine}
                            </span>
                          )}
                          <button
                            onClick={() => personaliseMutation.mutate(lead.id)}
                            disabled={personaliseMutation.isPending && personaliseMutation.variables === lead.id}
                            className="text-xs text-gray-400 hover:text-purple-600 transition-colors flex items-center gap-1 shrink-0"
                            title="Generate personalised opening line with AI"
                          >
                            {personaliseMutation.isPending && personaliseMutation.variables === lead.id ? (
                              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="20" />
                              </svg>
                            ) : '✨'}
                            Line
                          </button>
                          <button
                            onClick={() => setNotesLead(lead)}
                            className="text-xs text-gray-400 hover:text-amber-600 transition-colors flex items-center gap-1"
                            title="View / add notes"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            Notes
                          </button>
                          <button
                            onClick={() => requalifyMutation.mutate(lead.id)}
                            disabled={isQueued}
                            className="text-xs text-gray-400 hover:text-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                            title="Re-qualify with AI"
                          >
                            {isQueued ? (
                              <>
                                <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="20" />
                                </svg>
                                Queuing…
                              </>
                            ) : (
                              <>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" />
                                </svg>
                                AI Score
                              </>
                            )}
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
        {leads.length > 0 && (
          <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-400 flex items-center gap-2">
            <span>{leads.length} lead{leads.length !== 1 ? 's' : ''}</span>
            <span className="text-gray-300">·</span>
            <span>ICP scores powered by Claude AI</span>
          </div>
        )}
      </div>

      {showCsvModal && (
        <CsvImportModal
          onClose={() => setShowCsvModal(false)}
          onImported={() => {
            setShowCsvModal(false)
            queryClient.invalidateQueries({ queryKey: ['leads'] })
          }}
        />
      )}

      {showImportModal && (
        <SalesNavImportModal
          onClose={() => setShowImportModal(false)}
          onImported={() => {
            setShowImportModal(false)
            setTimeout(() => queryClient.invalidateQueries({ queryKey: ['leads'] }), 3000)
          }}
        />
      )}

      {/* Lead Detail Drawer */}
      {detailLead && (
        <LeadDetailDrawer
          lead={detailLead}
          allLabels={labels}
          onClose={() => setDetailLead(null)}
          onOpenNotes={(lead) => { setDetailLead(null); setNotesLead(lead) }}
          queryClient={queryClient}
        />
      )}

      {/* Lead Notes Drawer */}
      {notesLead && (
        <NotesDrawer
          lead={notesLead}
          onClose={() => setNotesLead(null)}
          queryClient={queryClient}
        />
      )}

      {/* Manage Labels Modal */}
      {showManageLabels && (
        <ManageLabelsModal
          labels={labels}
          onClose={() => setShowManageLabels(false)}
          queryClient={queryClient}
        />
      )}

      {/* Add to Campaign modal */}
      {showAddToCampaign && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Add to Campaign</h2>
            <p className="text-sm text-gray-500 mb-4">Adding {selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''} to a campaign.</p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Select Campaign</label>
              <select
                value={targetCampaignId}
                onChange={e => setTargetCampaignId(e.target.value)}
                className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Choose a campaign…</option>
                {campaigns.map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setShowAddToCampaign(false); setTargetCampaignId('') }}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => addToCampaignMutation.mutate()}
                disabled={!targetCampaignId || addToCampaignMutation.isPending}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {addToCampaignMutation.isPending ? 'Adding…' : 'Add to Campaign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Column name normalizer ───────────────────────────────────────────────────
// Handles various column names from Sales Navigator exports, LinkedIn exports,
// and generic CSVs.

function normalise(header: string): string {
  return header.toLowerCase().replace(/[\s_\-().]+/g, '')
}

function pickCol(row: Record<string, string>, ...candidates: string[]): string {
  for (const c of candidates) {
    const key = Object.keys(row).find(k => normalise(k) === normalise(c))
    if (key && row[key]?.trim()) return row[key].trim()
  }
  return ''
}

interface ParsedLead {
  linkedin_url: string
  first_name: string
  last_name: string
  title?: string
  company?: string
  industry?: string
  location?: string
  connection_degree?: number
  raw_data?: Record<string, unknown>
}

function parseSheet(rows: Record<string, string>[]): ParsedLead[] {
  const leads: ParsedLead[] = []
  for (const row of rows) {
    const linkedin_url = pickCol(row,
      'LinkedIn URL', 'Profile URL', 'linkedin url', 'profile url',
      'LinkedinURL', 'ProfileURL', 'url', 'linkedin', 'profilelink'
    )
    if (!linkedin_url) continue

    const first_name = pickCol(row,
      'First Name', 'firstname', 'first', 'firstName'
    )
    const last_name = pickCol(row,
      'Last Name', 'lastname', 'last', 'lastName', 'surname'
    )
    if (!first_name && !last_name) continue

    const degStr = pickCol(row, 'Degree', 'Connection Degree', 'connectiondegree', 'degree')
    const degNum = degStr ? parseInt(degStr.replace(/\D/g, ''), 10) : undefined

    leads.push({
      linkedin_url,
      first_name: first_name || '—',
      last_name: last_name || '',
      title: pickCol(row,
        'Title', 'Job Title', 'Current Title', 'jobtitle', 'currenttitle', 'position'
      ) || undefined,
      company: pickCol(row,
        'Company', 'Current Company', 'currentcompany', 'organization', 'employer'
      ) || undefined,
      industry: pickCol(row, 'Industry', 'industry') || undefined,
      location: pickCol(row, 'Location', 'Geography', 'location', 'geography', 'region') || undefined,
      connection_degree: !isNaN(degNum!) ? degNum : undefined,
      raw_data: { source_row: row },
    })
  }
  return leads
}

// ── Lead Label Cell ──────────────────────────────────────────────────────────

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#64748b',
]

function LeadLabelCell({
  leadId,
  allLabels,
  queryClient,
}: {
  leadId: string
  allLabels: LeadLabel[]
  queryClient: ReturnType<typeof useQueryClient>
}) {
  const [open, setOpen] = useState(false)

  const { data: assigned = [] } = useQuery({
    queryKey: ['lead-labels', leadId],
    queryFn: () => fetchLeadLabels(leadId),
    enabled: open || true, // always load so chips show
    staleTime: 60_000,
  })

  const assignMutation = useMutation({
    mutationFn: (labelId: string) => assignLabel(leadId, labelId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['lead-labels', leadId] }),
  })

  const removeMutation = useMutation({
    mutationFn: (labelId: string) => removeLabel(leadId, labelId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['lead-labels', leadId] }),
  })

  const assignedIds = new Set(assigned.map((l: LeadLabel) => l.id))

  return (
    <div className="relative flex items-center gap-1 flex-wrap min-w-[80px]">
      {assigned.map((lbl: LeadLabel) => (
        <span
          key={lbl.id}
          className="inline-flex items-center gap-0.5 text-[10px] font-medium px-2 py-0.5 rounded-full text-white cursor-pointer"
          style={{ background: lbl.color }}
          onClick={e => { e.stopPropagation(); removeMutation.mutate(lbl.id) }}
          title={`Remove "${lbl.name}"`}
        >
          {lbl.name}
          <svg className="w-2.5 h-2.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
      ))}
      {allLabels.length > 0 && (
        <div className="relative">
          <button
            onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
            className="w-5 h-5 rounded-full border border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600 text-xs flex items-center justify-center transition-colors"
            title="Add label"
          >
            +
          </button>
          {open && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
              <div className="absolute left-0 top-6 z-40 bg-white rounded-xl shadow-xl border border-gray-200 p-2 min-w-[140px]">
                {allLabels.filter(l => !assignedIds.has(l.id)).map(lbl => (
                  <button
                    key={lbl.id}
                    onClick={() => { assignMutation.mutate(lbl.id); setOpen(false) }}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg hover:bg-gray-50 text-left"
                  >
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ background: lbl.color }} />
                    <span className="text-sm text-gray-700">{lbl.name}</span>
                  </button>
                ))}
                {allLabels.every(l => assignedIds.has(l.id)) && (
                  <p className="text-xs text-gray-400 px-2 py-1">All labels assigned</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Manage Labels Modal ───────────────────────────────────────────────────────

function ManageLabelsModal({
  labels,
  onClose,
  queryClient,
}: {
  labels: LeadLabel[]
  onClose: () => void
  queryClient: ReturnType<typeof useQueryClient>
}) {
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#6366f1')

  const createMutation = useMutation({
    mutationFn: () => createLabel(newName.trim(), newColor),
    onSuccess: () => {
      setNewName('')
      void queryClient.invalidateQueries({ queryKey: ['labels'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => import('../api/labels').then(m => m.deleteLabel(id)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['labels'] })
      void queryClient.invalidateQueries({ queryKey: ['lead-labels'] })
    },
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Manage Labels</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Create new label */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">New Label</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Label name…"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) createMutation.mutate() }}
              />
              <div className="flex gap-1">
                {PRESET_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded-full transition-transform ${newColor === c ? 'scale-125 ring-2 ring-offset-1 ring-gray-400' : ''}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <button
                onClick={() => createMutation.mutate()}
                disabled={!newName.trim() || createMutation.isPending}
                className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Add
              </button>
            </div>
          </div>

          {/* Existing labels */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">
              Existing Labels ({labels.length})
            </label>
            {labels.length === 0 ? (
              <p className="text-sm text-gray-400 py-2">No labels yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {labels.map(lbl => (
                  <div key={lbl.id} className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-gray-50 group">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ background: lbl.color }} />
                    <span className="flex-1 text-sm text-gray-800">{lbl.name}</span>
                    <button
                      onClick={() => deleteMutation.mutate(lbl.id)}
                      disabled={deleteMutation.isPending}
                      className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-600 transition-all"
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="px-6 pb-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Lead Notes Drawer ────────────────────────────────────────────────────────

function NotesDrawer({
  lead,
  onClose,
  queryClient,
}: {
  lead: Lead
  onClose: () => void
  queryClient: ReturnType<typeof useQueryClient>
}) {
  const [noteText, setNoteText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { data: notes = [], isLoading } = useQuery({
    queryKey: ['lead-notes', lead.id],
    queryFn: () => fetchLeadNotes(lead.id),
  })

  const addMutation = useMutation({
    mutationFn: () => addLeadNote(lead.id, noteText.trim()),
    onSuccess: () => {
      setNoteText('')
      void queryClient.invalidateQueries({ queryKey: ['lead-notes', lead.id] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (noteId: string) => deleteLeadNote(noteId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lead-notes', lead.id] })
    },
  })

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white shadow-2xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-200">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{lead.first_name} {lead.last_name}</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {[lead.title, lead.company].filter(Boolean).join(' · ') || 'No title / company'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors mt-0.5">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Notes list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {isLoading ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading notes…</p>
          ) : notes.length === 0 ? (
            <div className="text-center py-10">
              <svg className="w-10 h-10 text-gray-200 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <p className="text-sm text-gray-400">No notes yet</p>
              <p className="text-xs text-gray-300 mt-1">Add your first note below</p>
            </div>
          ) : (
            notes.map((note: LeadNote) => (
              <div key={note.id} className="group bg-amber-50 border border-amber-100 rounded-xl p-4">
                <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{note.content}</p>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-gray-400">{formatDate(note.created_at)}</span>
                  <button
                    onClick={() => deleteMutation.mutate(note.id)}
                    disabled={deleteMutation.isPending}
                    className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-600 transition-all"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Add note */}
        <div className="border-t border-gray-200 px-6 py-4">
          <textarea
            ref={textareaRef}
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && noteText.trim()) {
                e.preventDefault()
                addMutation.mutate()
              }
            }}
            placeholder="Add a note… (Cmd+Enter to save)"
            rows={3}
            className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
          />
          <div className="flex justify-end mt-2">
            <button
              onClick={() => addMutation.mutate()}
              disabled={!noteText.trim() || addMutation.isPending}
              className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
            >
              {addMutation.isPending ? 'Saving…' : 'Save Note'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function CsvImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedLead[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [parseError, setParseError] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number } | null>(null)
  const [importError, setImportError] = useState('')

  function handleFile(file: File) {
    setParseError('')
    setParsed(null)
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' })
        if (rows.length === 0) { setParseError('File appears to be empty.'); return }
        const leads = parseSheet(rows)
        if (leads.length === 0) {
          setParseError(
            'Could not find LinkedIn URL + name columns. Make sure your file has columns like "LinkedIn URL", "First Name", "Last Name".'
          )
          return
        }
        setParsed(leads)
      } catch (err) {
        setParseError(`Failed to parse file: ${(err as Error).message}`)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleImport() {
    if (!parsed) return
    setImporting(true)
    setImportError('')
    try {
      const result = await importLeads(parsed)
      setImportResult(result)
    } catch (e) {
      setImportError((e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Import CSV / Excel</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Upload a Sales Navigator export, LinkedIn CSV, or any spreadsheet with LinkedIn profile URLs.
          </p>
        </div>

        {importResult ? (
          <div className="space-y-4 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">Import complete</p>
              <p className="text-sm text-gray-500 mt-1">
                {importResult.imported} lead{importResult.imported !== 1 ? 's' : ''} imported — AI scoring queued
              </p>
            </div>
            <button
              onClick={onImported}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors"
            >
              View Leads
            </button>
          </div>
        ) : (
          <>
            {/* Drop zone / file picker */}
            <div
              className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                const file = e.dataTransfer.files[0]
                if (file) handleFile(file)
              }}
            >
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {fileName ? (
                <p className="text-sm font-medium text-gray-700">{fileName}</p>
              ) : (
                <>
                  <p className="text-sm text-gray-500">Click to upload or drag & drop</p>
                  <p className="text-xs text-gray-400 mt-1">.xlsx, .xls, .csv</p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
              />
            </div>

            {parseError && <p className="text-sm text-red-600">{parseError}</p>}

            {parsed && (
              <div className="bg-gray-50 rounded-xl p-4 space-y-2">
                <p className="text-sm font-medium text-gray-700">
                  Found <span className="text-blue-600 font-bold">{parsed.length}</span> valid lead{parsed.length !== 1 ? 's' : ''}
                </p>
                <div className="max-h-36 overflow-y-auto space-y-1">
                  {parsed.slice(0, 5).map((l, i) => (
                    <div key={i} className="text-xs text-gray-500 flex gap-2">
                      <span className="font-medium text-gray-700 min-w-[120px]">{l.first_name} {l.last_name}</span>
                      <span className="truncate text-gray-400">{l.company ?? ''}{l.title ? ` · ${l.title}` : ''}</span>
                    </div>
                  ))}
                  {parsed.length > 5 && (
                    <p className="text-xs text-gray-400">…and {parsed.length - 5} more</p>
                  )}
                </div>
              </div>
            )}

            {importError && <p className="text-sm text-red-600">{importError}</p>}

            <div className="flex gap-3 pt-1">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={!parsed || importing}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? 'Importing…' : `Import ${parsed ? parsed.length : ''} Leads`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SalesNavImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [searchUrl, setSearchUrl] = useState('')
  const [accountId, setAccountId] = useState('')
  const [maxLeads, setMaxLeads] = useState(100)
  const [status, setStatus] = useState<'idle' | 'scraping' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<{ scraped: number; saved: number } | null>(null)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  })

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  function isValidSalesNavUrl(url: string) {
    try {
      const u = new URL(url)
      return u.hostname.includes('linkedin.com') && u.pathname.startsWith('/sales/search/people')
    } catch {
      return false
    }
  }

  async function handleStart() {
    if (!isValidSalesNavUrl(searchUrl)) {
      setError('Please enter a valid Sales Navigator people search URL.')
      return
    }
    if (!accountId) {
      setError('Please select a LinkedIn account to use for scraping.')
      return
    }
    setError('')
    setStatus('scraping')
    setProgress(0)

    try {
      const { job_id } = await startSalesNavImport(searchUrl, accountId, maxLeads)

      pollRef.current = setInterval(async () => {
        try {
          const s = await getScrapeStatus(job_id)
          setProgress(s.progress ?? 0)

          if (s.state === 'completed') {
            clearInterval(pollRef.current!)
            setResult(s.result ?? { scraped: 0, saved: 0 })
            setStatus('done')
          } else if (s.state === 'failed') {
            clearInterval(pollRef.current!)
            setError(s.error ?? 'Scrape job failed.')
            setStatus('error')
          }
        } catch {
          // transient poll error — keep trying
        }
      }, 3000)
    } catch (e) {
      setError((e as Error).message)
      setStatus('error')
    }
  }

  const activeAccounts = accounts.filter(a => a.status === 'active')

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Import from Sales Navigator</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Run a search in Sales Navigator, copy the URL from your browser, and paste it below.
          </p>
        </div>

        {status === 'done' ? (
          <div className="space-y-4 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">Import complete</p>
              <p className="text-sm text-gray-500 mt-1">
                Scraped {result?.scraped ?? 0} profiles · {result?.saved ?? 0} leads saved — AI scoring queued
              </p>
            </div>
            <button onClick={onImported}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors">
              View Leads
            </button>
          </div>
        ) : status === 'scraping' ? (
          <div className="space-y-4 py-6">
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700 mb-1">Scraping Sales Navigator…</p>
              <p className="text-xs text-gray-400">This can take a few minutes depending on result count.</p>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                style={{ width: `${Math.max(5, progress)}%` }}
              />
            </div>
            <p className="text-center text-xs text-gray-400">{progress}% complete</p>
            {error && <p className="text-sm text-red-600 text-center">{error}</p>}
          </div>
        ) : (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Sales Navigator Search URL</label>
              <input
                autoFocus
                type="url"
                value={searchUrl}
                onChange={e => setSearchUrl(e.target.value)}
                placeholder="https://www.linkedin.com/sales/search/people?query=..."
                className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">
                Go to Sales Navigator → People search → apply filters → copy the URL from your browser.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">LinkedIn Account</label>
              {activeAccounts.length === 0 ? (
                <p className="text-sm text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                  No active accounts. Add a LinkedIn account in the Accounts page first.
                </p>
              ) : (
                <select
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">Select account…</option>
                  {activeAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.linkedin_email}</option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Max leads to import
                <span className="ml-2 text-blue-600 font-semibold">{maxLeads}</span>
              </label>
              <input
                type="range"
                min={10}
                max={500}
                step={10}
                value={maxLeads}
                onChange={e => setMaxLeads(Number(e.target.value))}
                className="w-full accent-blue-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>10</span><span>500</span>
              </div>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleStart}
                disabled={!searchUrl || !accountId || activeAccounts.length === 0}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors">
                Start Scraping
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Lead Detail Drawer ───────────────────────────────────────────────────────

const CL_STATUS_COLORS: Record<string, string> = {
  pending:          'bg-gray-100 text-gray-600',
  connection_sent:  'bg-blue-100 text-blue-700',
  connected:        'bg-green-100 text-green-700',
  messaged:         'bg-purple-100 text-purple-700',
  replied:          'bg-teal-100 text-teal-700',
  converted:        'bg-emerald-100 text-emerald-700',
  stopped:          'bg-red-100 text-red-600',
}

const CL_CLASS_COLORS: Record<string, string> = {
  interested:   'bg-green-50 text-green-700 border border-green-200',
  not_now:      'bg-yellow-50 text-yellow-700 border border-yellow-200',
  wrong_person: 'bg-gray-50 text-gray-600 border border-gray-200',
  referral:     'bg-blue-50 text-blue-700 border border-blue-200',
  negative:     'bg-red-50 text-red-700 border border-red-200',
  none:         'bg-gray-50 text-gray-500 border border-gray-200',
}

function LeadDetailDrawer({
  lead,
  allLabels,
  onClose,
  onOpenNotes,
  queryClient,
}: {
  lead: Lead
  allLabels: LeadLabel[]
  onClose: () => void
  onOpenNotes: (lead: Lead) => void
  queryClient: ReturnType<typeof useQueryClient>
}) {
  const [noteText, setNoteText] = useState('')

  const { data: campaigns = [], isLoading: campaignsLoading } = useQuery({
    queryKey: ['lead-campaigns', lead.id],
    queryFn: () => fetchLeadCampaigns(lead.id),
  })

  const { data: notes = [] } = useQuery({
    queryKey: ['lead-notes', lead.id],
    queryFn: () => fetchLeadNotes(lead.id),
    staleTime: 30_000,
  })

  const personaliseMutation = useMutation({
    mutationFn: () => personaliseOpeningLine(lead.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['leads'] }),
  })

  const addNoteMutation = useMutation({
    mutationFn: () => addLeadNote(lead.id, noteText.trim()),
    onSuccess: () => {
      setNoteText('')
      void queryClient.invalidateQueries({ queryKey: ['lead-notes', lead.id] })
    },
  })

  const initials = `${lead.first_name[0] ?? ''}${lead.last_name[0] ?? ''}`.toUpperCase()
  const reasoning = lead.raw_data?.ai_reasoning
  const openingLine = lead.raw_data?.opening_line
  const scoreColor = (lead.icp_score ?? 0) >= 75 ? '#EF4444' : (lead.icp_score ?? 0) >= 50 ? '#F97316' : (lead.icp_score ?? 0) >= 25 ? '#3B82F6' : '#9CA3AF'

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-white shadow-2xl z-50 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-slate-50 to-white shrink-0">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-lg shrink-0">
              {initials}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{lead.first_name} {lead.last_name}</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                {[lead.title, lead.company].filter(Boolean).join(' · ') || 'No title or company'}
              </p>
              {lead.linkedin_url && (
                <a
                  href={lead.linkedin_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:text-blue-700 hover:underline mt-0.5 inline-flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
                  </svg>
                  LinkedIn Profile ↗
                </a>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors shrink-0">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto divide-y divide-gray-100">

          {/* ICP Score */}
          <div className="px-6 py-4">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">ICP Score</p>
            {lead.icp_score != null ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${lead.icp_score}%`, background: scoreColor }} />
                  </div>
                  <span className="text-lg font-bold tabular-nums" style={{ color: scoreColor }}>{lead.icp_score}</span>
                  {lead.icp_flag && (
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${FLAG_COLORS[lead.icp_flag]}`}>
                      {FLAG_ICONS[lead.icp_flag]} {lead.icp_flag}
                    </span>
                  )}
                </div>
                {reasoning && (
                  <p className="text-xs text-gray-500 leading-relaxed bg-gray-50 rounded-xl px-3.5 py-2.5">{reasoning}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">Not scored yet</p>
            )}
          </div>

          {/* Profile details */}
          <div className="px-6 py-4">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Profile</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
              {([
                { label: 'Industry', value: lead.industry },
                { label: 'Location', value: lead.location },
                { label: 'Source',   value: lead.source?.replace(/_/g, ' ') },
                { label: 'Added',    value: new Date(lead.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) },
              ] as { label: string; value: string | null | undefined }[]).map(({ label, value }) => value ? (
                <div key={label}>
                  <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
                  <p className="text-sm text-gray-700 mt-0.5 capitalize">{value}</p>
                </div>
              ) : null)}
            </div>
          </div>

          {/* AI Opening Line */}
          <div className="px-6 py-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">AI Opening Line</p>
              <button
                onClick={() => personaliseMutation.mutate()}
                disabled={personaliseMutation.isPending}
                className="text-[10px] text-purple-600 hover:text-purple-800 font-medium flex items-center gap-1 disabled:opacity-50"
              >
                {personaliseMutation.isPending ? (
                  <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeDashoffset="20" />
                  </svg>
                ) : '✨'}
                {openingLine ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            {openingLine ? (
              <p className="text-sm text-gray-700 leading-relaxed bg-purple-50 border border-purple-100 rounded-xl px-3.5 py-2.5 italic">
                &ldquo;{openingLine}&rdquo;
              </p>
            ) : (
              <p className="text-sm text-gray-400 italic">No opening line yet. Click Generate to create one with AI.</p>
            )}
          </div>

          {/* Labels */}
          <div className="px-6 py-4">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Labels</p>
            <LeadLabelCell leadId={lead.id} allLabels={allLabels} queryClient={queryClient} />
          </div>

          {/* Notes */}
          <div className="px-6 py-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                Notes {notes.length > 0 && `(${notes.length})`}
              </p>
              {notes.length > 0 && (
                <button onClick={() => onOpenNotes(lead)} className="text-[10px] text-amber-600 hover:text-amber-800 font-medium">
                  View all →
                </button>
              )}
            </div>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && noteText.trim()) addNoteMutation.mutate() }}
                placeholder="Quick note… (Enter to save)"
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <button
                onClick={() => addNoteMutation.mutate()}
                disabled={!noteText.trim() || addNoteMutation.isPending}
                className="px-3 py-2 bg-amber-500 text-white text-xs font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50 transition-colors"
              >
                {addNoteMutation.isPending ? '…' : 'Add'}
              </button>
            </div>
            {notes.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No notes yet</p>
            ) : (
              <div className="space-y-2">
                {(notes as LeadNote[]).slice(0, 2).map(n => (
                  <div key={n.id} className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    <p className="text-xs text-gray-700 line-clamp-2">{n.content}</p>
                    <p className="text-[10px] text-gray-400 mt-1">
                      {new Date(n.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                ))}
                {notes.length > 2 && (
                  <button onClick={() => onOpenNotes(lead)} className="text-xs text-amber-600 hover:underline">
                    +{notes.length - 2} more note{notes.length - 2 !== 1 ? 's' : ''}…
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Campaign membership */}
          <div className="px-6 py-4">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Campaigns {campaigns.length > 0 && `(${campaigns.length})`}
            </p>
            {campaignsLoading ? (
              <p className="text-xs text-gray-400">Loading…</p>
            ) : campaigns.length === 0 ? (
              <p className="text-sm text-gray-400 italic">Not in any campaign yet</p>
            ) : (
              <div className="space-y-2">
                {(campaigns as LeadCampaignMembership[]).map(cl => (
                  <div key={cl.id} className="flex items-start justify-between gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{cl.campaign.name}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        Added {new Date(cl.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${CL_STATUS_COLORS[cl.status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {cl.status.replace(/_/g, ' ')}
                      </span>
                      {cl.reply_classification && cl.reply_classification !== 'none' && (
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${CL_CLASS_COLORS[cl.reply_classification] ?? ''}`}>
                          {cl.reply_classification.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </>
  )
}
