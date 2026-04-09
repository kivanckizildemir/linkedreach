import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchLeadLists,
  fetchListLeads,
  createLeadList,
  deleteLeadList,
  renameLeadList,
  combineList,
  intersectList,
  excludeFromList,
  duplicateLeadList,
  getListScrapeStatus,
  type LeadList,
} from '../api/leadLists'

const SOURCE_ICON: Record<LeadList['source'], string> = {
  sales_nav: '🔍',
  excel: '📊',
  manual: '✏️',
  chrome_extension: '🌐',
  linkedin_search: '🔗',
}

export function LeadLists() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newError, setNewError] = useState('')

  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  // Set-operation modal
  type SetOp = 'combine' | 'intersect' | 'exclude'
  const [setOpModal, setSetOpModal] = useState<{ op: SetOp; targetId: string; targetName: string } | null>(null)
  const [setOpSourceId, setSetOpSourceId] = useState('')
  const [setOpLoading, setSetOpLoading] = useState(false)
  const [setOpResult, setSetOpResult] = useState<string | null>(null)
  const [setOpError, setSetOpError] = useState('')

  const [activeJobs, setActiveJobs] = useState<Record<string, { jobId: string; progress: number; name: string }>>({})

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuId) return
    const handler = () => setOpenMenuId(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [openMenuId])

  const { data: lists = [], isLoading } = useQuery({
    queryKey: ['lead-lists'],
    queryFn: fetchLeadLists,
    refetchInterval: Object.keys(activeJobs).length > 0 ? 3000 : false,
  })

  // Poll active scrape jobs
  Object.entries(activeJobs).forEach(([listId, job]) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useQuery({
      queryKey: ['scrape-status', job.jobId],
      queryFn: () => getListScrapeStatus(job.jobId),
      refetchInterval: (data) => {
        if (!data) return 2000
        const state = (data as unknown as { state: string }).state
        const progress = (data as unknown as { progress?: number }).progress ?? 0
        setActiveJobs(prev => prev[listId] ? { ...prev, [listId]: { ...prev[listId], progress } } : prev)
        if (state === 'completed' || state === 'failed') {
          setActiveJobs(prev => { const n = { ...prev }; delete n[listId]; return n })
          void qc.invalidateQueries({ queryKey: ['lead-lists'] })
          return false
        }
        return 2000
      },
      enabled: !!job.jobId,
    })
  })

  const createMutation = useMutation({
    mutationFn: createLeadList,
    onSuccess: (list) => {
      void qc.invalidateQueries({ queryKey: ['lead-lists'] })
      setShowNew(false)
      setNewName('')
      navigate(`/leads/${list.id}`)
    },
    onError: (e) => setNewError((e as Error).message),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteLeadList,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-lists'] }),
  })

  const duplicateMutation = useMutation({
    mutationFn: duplicateLeadList,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-lists'] }),
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameLeadList(id, name),
    onSuccess: () => { setRenameId(null); void qc.invalidateQueries({ queryKey: ['lead-lists'] }) },
  })

  async function handleExportCsv(listId: string, listName: string) {
    const leads = await fetchListLeads(listId)
    const headers = ['First Name', 'Last Name', 'Title', 'Company', 'LinkedIn URL', 'Location', 'ICP Flag', 'ICP Score']
    const rows = (leads as Record<string, unknown>[]).map(l => [
      l.first_name, l.last_name, l.title ?? '', l.company ?? '',
      l.linkedin_url, l.location ?? '', l.icp_flag ?? '', l.icp_score ?? '',
    ])
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${listName}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  async function handleSetOp() {
    if (!setOpModal || !setOpSourceId) return
    setSetOpLoading(true); setSetOpError(''); setSetOpResult(null)
    try {
      let result: { added?: number; removed?: number }
      if (setOpModal.op === 'combine') result = await combineList(setOpModal.targetId, setOpSourceId)
      else if (setOpModal.op === 'intersect') result = await intersectList(setOpModal.targetId, setOpSourceId)
      else result = await excludeFromList(setOpModal.targetId, setOpSourceId)
      const msg = result.added != null ? `${result.added} leads added` : `${result.removed} leads removed`
      setSetOpResult(msg)
      void qc.invalidateQueries({ queryKey: ['lead-lists'] })
    } catch (e) { setSetOpError((e as Error).message) }
    finally { setSetOpLoading(false) }
  }

  function fmt(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  }

  function getLeadCount(list: LeadList) {
    return list.lead_count ?? 0
  }

  function getCampaignCount(list: LeadList) {
    return list.campaign_count ?? 0
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Lead Lists</h1>
          <p className="text-sm text-gray-500 mt-0.5">{lists.length} list{lists.length !== 1 ? 's' : ''}</p>
        </div>
        <button
          onClick={() => { setShowNew(true); setNewError(''); setNewName('') }}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New List
        </button>
      </div>

      {/* Active scrape progress banners */}
      {Object.entries(activeJobs).map(([listId, job]) => (
        <div key={listId} className="mb-4 bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center gap-4">
          <svg className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <div className="flex-1">
            <p className="text-sm font-medium text-blue-900">Scraping "{job.name}"…</p>
            <div className="mt-1.5 h-1.5 bg-blue-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${job.progress}%` }} />
            </div>
          </div>
          <span className="text-sm font-semibold text-blue-700">{job.progress}%</span>
        </div>
      ))}

      {/* Lists table */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
        <div className="grid grid-cols-[1fr_140px_90px_130px_48px] gap-4 px-6 py-3 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider rounded-t-2xl">
          <span>List Name</span>
          <span>Created</span>
          <span>Leads</span>
          <span>Campaign</span>
          <span></span>
        </div>

        {isLoading ? (
          <div className="py-16 text-center text-gray-400 text-sm">Loading…</div>
        ) : lists.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-gray-400 text-sm mb-4">No lead lists yet</p>
            <button
              onClick={() => { setShowNew(true); setNewName('') }}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
            >
              Create your first list
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {(lists as Array<LeadList & { leads?: Array<unknown>; campaign_leads?: Array<{ campaign_leads: Array<{ campaign_id: string }> }> }>).map(list => {
              const leadCount = getLeadCount(list)
              const campaignCount = getCampaignCount(list)
              const isRunning = !!activeJobs[list.id]

              return (
                <div
                  key={list.id}
                  className="grid grid-cols-[1fr_140px_90px_130px_48px] gap-4 px-6 py-4 items-center hover:bg-gray-50/60 transition-colors group cursor-pointer"
                  onClick={() => navigate(`/leads/${list.id}`)}
                >
                  {/* Name */}
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-lg">{SOURCE_ICON[list.source]}</span>
                    <div className="min-w-0">
                      {renameId === list.id ? (
                        <input
                          autoFocus
                          value={renameName}
                          onChange={e => setRenameName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') renameMutation.mutate({ id: list.id, name: renameName })
                            if (e.key === 'Escape') setRenameId(null)
                            e.stopPropagation()
                          }}
                          onClick={e => e.stopPropagation()}
                          className="text-sm font-medium border-b border-blue-400 bg-transparent focus:outline-none text-gray-900 w-full"
                        />
                      ) : (
                        <p className="text-sm font-medium text-gray-900 truncate">{list.name}</p>
                      )}
                    </div>
                  </div>

                  {/* Date */}
                  <span className="text-xs text-gray-500">{fmt(list.created_at)}</span>

                  {/* Lead count */}
                  <div>
                    {isRunning ? (
                      <span className="text-xs text-blue-600 font-medium flex items-center gap-1">
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                        </svg>
                        Scraping…
                      </span>
                    ) : (
                      <span className="text-sm font-semibold text-gray-800">{leadCount.toLocaleString()}</span>
                    )}
                  </div>

                  {/* Campaign status */}
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full w-fit ${
                    campaignCount > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {campaignCount > 0 ? `In ${campaignCount} campaign${campaignCount !== 1 ? 's' : ''}` : 'Not in campaign'}
                  </span>

                  {/* Actions */}
                  <div className="flex justify-end" onClick={e => e.stopPropagation()}>
                    <div className="relative">
                      <button
                        onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === list.id ? null : list.id) }}
                        className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${openMenuId === list.id ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'}`}
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
                        </svg>
                      </button>
                      {openMenuId === list.id && (
                      <div className="absolute right-0 top-8 bg-white border border-gray-100 rounded-xl shadow-lg py-1 w-44 z-20">
                        <button onClick={() => { setSetOpModal({ op: 'combine', targetId: list.id, targetName: list.name }); setSetOpSourceId(''); setSetOpResult(null); setOpenMenuId(null) }} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                          Combine lists
                        </button>
                        <button onClick={() => { setSetOpModal({ op: 'intersect', targetId: list.id, targetName: list.name }); setSetOpSourceId(''); setSetOpResult(null); setOpenMenuId(null) }} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" /></svg>
                          Intersect lists
                        </button>
                        <button onClick={() => { setSetOpModal({ op: 'exclude', targetId: list.id, targetName: list.name }); setSetOpSourceId(''); setSetOpResult(null); setOpenMenuId(null) }} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 12H6" /></svg>
                          Exclude from list
                        </button>
                        <div className="border-t border-gray-100 my-1" />
                        <button onClick={() => { void handleExportCsv(list.id, list.name); setOpenMenuId(null) }} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                          Export to CSV
                        </button>
                        <div className="border-t border-gray-100 my-1" />
                        <button onClick={() => { duplicateMutation.mutate(list.id); setOpenMenuId(null) }} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                          Duplicate
                        </button>
                        <button onClick={() => { setRenameId(list.id); setRenameName(list.name); setOpenMenuId(null) }} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                          Rename
                        </button>
                        <button onClick={() => { if (confirm(`Delete "${list.name}"?`)) { deleteMutation.mutate(list.id); setOpenMenuId(null) } }} className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          Delete
                        </button>
                      </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Set-operation modal */}
      {setOpModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {setOpModal.op === 'combine' ? 'Combine Lists' : setOpModal.op === 'intersect' ? 'Intersect Lists' : 'Exclude from List'}
            </h2>
            <p className="text-sm text-gray-500">
              {setOpModal.op === 'combine'
                ? `Add all leads from another list into "${setOpModal.targetName}".`
                : setOpModal.op === 'intersect'
                ? `Keep only leads in "${setOpModal.targetName}" that also appear in another list.`
                : `Remove from "${setOpModal.targetName}" any leads that appear in another list.`}
            </p>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Select list</label>
              <select
                value={setOpSourceId}
                onChange={e => setSetOpSourceId(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Choose a list…</option>
                {lists.filter(l => l.id !== setOpModal.targetId).map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            {setOpError && <p className="text-xs text-red-600">{setOpError}</p>}
            {setOpResult && <p className="text-xs text-green-600 font-medium">{setOpResult}</p>}
            <div className="flex gap-3 pt-1">
              <button onClick={() => setSetOpModal(null)} className="flex-1 py-2.5 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50">
                {setOpResult ? 'Close' : 'Cancel'}
              </button>
              {!setOpResult && (
                <button
                  onClick={() => void handleSetOp()}
                  disabled={setOpLoading || !setOpSourceId}
                  className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60"
                >
                  {setOpLoading ? 'Working…' : 'Apply'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* New List modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">New Lead List</h2>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">List Name</label>
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) createMutation.mutate(newName) }}
                placeholder="e.g. EMEA SaaS Founders"
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {newError && <p className="text-xs text-red-600">{newError}</p>}
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => { setShowNew(false); setNewName('') }}
                className="flex-1 py-2.5 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => { if (newName.trim()) createMutation.mutate(newName) }}
                disabled={createMutation.isPending || !newName.trim()}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60"
              >
                {createMutation.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
