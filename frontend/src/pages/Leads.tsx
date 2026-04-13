import React, { useState, useRef, useEffect, useCallback, useMemo, Fragment, type FormEvent } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchLeads, requalifyLead, qualifyAllLeads, importLeads, startSalesNavImport, getScrapeStatus, fetchLeadNotes, addLeadNote, deleteLeadNote, personaliseOpeningLine, fetchLeadCampaigns, bulkDeleteLeads, createManualLead, enrichProfiles, getEnrichStatus, cancelEnrichJob, cancelQualify } from '../api/leads'
import type { Lead, LeadNote, LeadCampaignMembership } from '../api/leads'
import { supabase } from '../lib/supabase'
import { fetchLabels, fetchLeadLabels, fetchAllLeadLabelAssignments, assignLabel, removeLabel, createLabel, type LeadLabel } from '../api/labels'
import { fetchAccounts } from '../api/accounts'
import { addLeadsToCampaign } from '../api/campaigns'
import { scrapeIntoList, importExcelIntoList, fetchLeadList, cancelScrapeJob, getListScrapeStatus } from '../api/leadLists'
import * as XLSX from 'xlsx'

const FLAG_COLORS: Record<NonNullable<Lead['icp_flag']>, string> = {
  hot:          'bg-green-100 text-green-700 border-green-200',
  warm:         'bg-yellow-100 text-yellow-700 border-yellow-200',
  cold:         'bg-red-100 text-red-600 border-red-200',
  disqualified: 'bg-gray-100 text-gray-500 border-gray-200',
}

const FLAG_ICONS: Record<NonNullable<Lead['icp_flag']>, string> = {
  hot: '★', warm: '◆', cold: '○', disqualified: '✗',
}

// Human-readable ICP fit labels (avoids confusion with engagement "warmth")
const FLAG_LABELS: Record<NonNullable<Lead['icp_flag']>, string> = {
  hot:          'Ideal',
  warm:         'Good',
  cold:         'Weak',
  disqualified: 'No Fit',
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
  const [openUp, setOpenUp] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const handleEnter = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setOpenUp(rect.bottom > window.innerHeight - 160)
    }
    setShow(true)
  }, [])

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setShow(false)}
        className="ml-1.5 w-4 h-4 rounded-full bg-gray-200 text-gray-500 text-[10px] font-bold flex items-center justify-center hover:bg-gray-300 transition-colors"
      >
        ?
      </button>
      {show && (
        <div className={`absolute left-6 z-50 w-64 bg-gray-900 text-white text-xs rounded-xl p-3 shadow-xl leading-relaxed ${openUp ? 'bottom-0' : 'top-0'}`}>
          <p className="font-semibold text-gray-300 mb-1 text-[10px] uppercase tracking-wider">AI Reasoning</p>
          {reasoning}
        </div>
      )}
    </div>
  )
}

type ProductRef = { id: string; name: string }

function BestFitCell({ lead, products }: { lead: Lead; products: ProductRef[] }) {
  const [show, setShow] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  const cellRef = useRef<HTMLDivElement>(null)

  const handleEnter = useCallback(() => {
    if (cellRef.current) {
      const rect = cellRef.current.getBoundingClientRect()
      setOpenUp(rect.bottom > window.innerHeight - 240)
    }
    setShow(true)
  }, [])

  const productScores = lead.raw_data?.product_scores
  const bestId        = lead.raw_data?.best_product_id

  // No per-product data yet — show nothing (ICP Score column covers it)
  if (!productScores || !bestId || !productScores[bestId]) {
    return <span className="text-gray-300 text-xs">—</span>
  }

  const best        = productScores[bestId]
  const bestProduct = products.find(p => p.id === bestId)
  const color       = best.score >= 75 ? '#EF4444' : best.score >= 50 ? '#F97316' : best.score >= 25 ? '#3B82F6' : '#9CA3AF'

  // Sorted list of all products that have a score
  const scoredProducts = products
    .filter(p => productScores[p.id])
    .sort((a, b) => (productScores[b.id]?.score ?? 0) - (productScores[a.id]?.score ?? 0))

  const hasMultiple = scoredProducts.length > 1

  return (
    <div className="relative"
      ref={cellRef}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
    >
      <div className="flex items-center gap-1.5 cursor-default">
        <span className="text-xs font-medium text-gray-700 max-w-[72px] truncate" title={bestProduct?.name}>
          {bestProduct?.name ?? 'Best fit'}
        </span>
        <span className="text-xs font-bold tabular-nums" style={{ color }}>{best.score}</span>
        {hasMultiple && (
          <span className="text-[10px] text-gray-300">▾</span>
        )}
      </div>

      {show && hasMultiple && (
        <div className={`absolute left-0 z-50 bg-white border border-gray-200 rounded-xl shadow-xl p-3 min-w-[220px] ${openUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">All Product Scores</p>
          {scoredProducts.map(p => {
            const ps = productScores[p.id]
            const c  = ps.score >= 75 ? '#EF4444' : ps.score >= 50 ? '#F97316' : ps.score >= 25 ? '#3B82F6' : '#9CA3AF'
            return (
              <div key={p.id} className="flex items-center gap-2 py-1.5 border-t border-gray-50 first:border-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.id === bestId ? 'bg-violet-500' : 'bg-gray-300'}`} />
                <span className="text-xs text-gray-700 flex-1 truncate">{p.name}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="w-14 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${ps.score}%`, background: c }} />
                  </div>
                  <span className="text-xs font-bold tabular-nums w-7 text-right" style={{ color: c }}>{ps.score}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

type SortCol = 'name' | 'title' | 'company' | 'icp_score' | 'icp_flag' | 'source' | 'created_at'

export function Leads() {
  const { listId } = useParams<{ listId?: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [icpFlag, setIcpFlag] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [sortCol, setSortCol] = useState<SortCol>('created_at')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [showImportModal, setShowImportModal] = useState(false)
  const [showCsvModal, setShowCsvModal] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showAddToCampaign, setShowAddToCampaign] = useState(false)
  const [targetCampaignId, setTargetCampaignId] = useState('')
  const [notesLead, setNotesLead] = useState<Lead | null>(null)

  const [showManageLabels, setShowManageLabels] = useState(false)

  const [showManualAdd, setShowManualAdd] = useState(false)
  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null)

  // List-context "Add Leads" wizard
  type AddLeadsSource = 'sales_nav' | 'linkedin_search' | 'post_reactors' | 'event_attendees' | 'csv' | 'sales_nav_accounts' | 'linkedin_companies'
  const [showAddToList, setShowAddToList] = useState(false)
  const [addLeadsStep, setAddLeadsStep] = useState<'source' | 'form'>('source')
  const [addLeadsSource, setAddLeadsSource] = useState<AddLeadsSource | null>(null)
  const [addLeadsUrl, setAddLeadsUrl] = useState('')
  const [addLeadsAccountId, setAddLeadsAccountId] = useState('')
  const [addLeadsMax, setAddLeadsMax] = useState(100)
  const [addLeadsCsvFile, setAddLeadsCsvFile] = useState<File | null>(null)
  const [addLeadsDragging, setAddLeadsDragging] = useState(false)
  const [addLeadsError, setAddLeadsError] = useState('')
  const [addLeadsImporting, setAddLeadsImporting] = useState(false)
  const [addLeadsJobId, setAddLeadsJobId] = useState<string | null>(null)
  const [addLeadsProgress, setAddLeadsProgress] = useState(0)
  const [addLeadsJobError, setAddLeadsJobError] = useState<string | null>(null)
  const addLeadsPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const addLeadsCsvRef = useRef<HTMLInputElement>(null)

  const [showEnrichModal, setShowEnrichModal] = useState(false)
  const [enrichAccountId, setEnrichAccountId] = useState('')
  const [enrichJobId, setEnrichJobId] = useState<string | null>(null)
  const [enrichStatus, setEnrichStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [enrichProgress, setEnrichProgress] = useState(0)
  const [enrichCount, setEnrichCount] = useState(0)
  const [enrichError, setEnrichError] = useState('')
  const enrichPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Re-score All tracking
  const [isScoringAll, setIsScoringAll] = useState(false)
  const [scoringDone, setScoringDone] = useState(0)
  const [scoringTotal, setScoringTotal] = useState(0)
  const scoringStartTimeRef = useRef<number>(0)
  const scoringPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── localStorage persistence keys (scoped by list) ─────────────────────────
  const lsEnrichKey  = `lr_enrich_job_${listId ?? 'global'}`
  const lsScrapeKey  = `lr_scrape_job_${listId ?? 'global'}`
  const lsScoreKey   = `lr_score_job_${listId ?? 'global'}`

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  })

  // ── Resume in-progress jobs after navigation ────────────────────────────────
  useEffect(() => {
    // Enrich job
    try {
      const saved = localStorage.getItem(lsEnrichKey)
      if (saved) {
        const { jobId } = JSON.parse(saved) as { jobId: string }
        setEnrichJobId(jobId)
        setEnrichStatus('running')
        enrichPollRef.current = setInterval(async () => {
          try {
            const status = await getEnrichStatus(jobId)
            setEnrichProgress(status.progress)
            if (status.state === 'completed') {
              clearInterval(enrichPollRef.current!); enrichPollRef.current = null
              localStorage.removeItem(lsEnrichKey)
              setEnrichStatus('done'); setEnrichJobId(null)
              void queryClient.invalidateQueries({ queryKey: ['leads'] })
              setTimeout(() => setEnrichStatus('idle'), 3000)
            } else if (status.state === 'failed') {
              clearInterval(enrichPollRef.current!); enrichPollRef.current = null
              localStorage.removeItem(lsEnrichKey)
              setEnrichStatus('error'); setEnrichJobId(null)
              setTimeout(() => setEnrichStatus('idle'), 4000)
            }
          } catch { /* keep polling */ }
        }, 3000)
      }
    } catch { /* ignore bad localStorage */ }

    // Scrape / add-leads job
    try {
      const saved = localStorage.getItem(lsScrapeKey)
      if (saved) {
        const { jobId } = JSON.parse(saved) as { jobId: string }
        setAddLeadsJobId(jobId)
        setAddLeadsJobError(null)
        addLeadsPollRef.current = setInterval(async () => {
          try {
            const s = await getListScrapeStatus(jobId)
            setAddLeadsProgress(s.progress ?? 0)
            if (s.state === 'completed' || s.state === 'failed') {
              clearInterval(addLeadsPollRef.current!); addLeadsPollRef.current = null
              localStorage.removeItem(lsScrapeKey)
              setAddLeadsJobId(null); setAddLeadsProgress(0)
              if (s.state === 'failed') {
                setAddLeadsJobError(s.error ?? 'Scrape job failed. Check your account session.')
              }
              void queryClient.invalidateQueries({ queryKey: ['leads'] })
              void queryClient.invalidateQueries({ queryKey: ['lead-list', listId] })
            }
          } catch { /* keep polling */ }
        }, 3000)
      }
    } catch { /* ignore bad localStorage */ }

    // Scoring job
    try {
      const saved = localStorage.getItem(lsScoreKey)
      if (saved) {
        const { startTime, total } = JSON.parse(saved) as { startTime: number; total: number }
        scoringStartTimeRef.current = startTime
        setIsScoringAll(true)
        setScoringTotal(total)
        setScoringDone(0)
        scoringPollRef.current = setInterval(() => {
          void queryClient.invalidateQueries({ queryKey: ['leads'] })
        }, 2000)
      }
    } catch { /* ignore bad localStorage */ }

    return () => {
      if (addLeadsPollRef.current) clearInterval(addLeadsPollRef.current)
      if (enrichPollRef.current) clearInterval(enrichPollRef.current)
      if (scoringPollRef.current) clearInterval(scoringPollRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const { data: currentList } = useQuery({
    queryKey: ['lead-list', listId],
    queryFn: () => fetchLeadList(listId!),
    enabled: !!listId,
  })

  const { data: leads = [], isLoading } = useQuery({
    queryKey: ['leads', { search, icp_flag: icpFlag, source: sourceFilter, list_id: listId }],
    queryFn: () => fetchLeads({ search: search || undefined, icp_flag: icpFlag || undefined, source: sourceFilter || undefined, list_id: listId }),
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
    mutationFn: (opts?: { force?: boolean; ids?: string[]; list_id?: string }) => qualifyAllLeads(opts),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] })
    },
  })

  const unscoredCount = leads.filter(l => l.icp_score == null).length

  // Detect when all scoring is done by checking updated_at > scoringStartTime
  useEffect(() => {
    if (!isScoringAll || scoringTotal === 0) return
    const startIso = new Date(scoringStartTimeRef.current).toISOString()
    const freshlyScored = leads.filter(l =>
      l.icp_score != null && (l as unknown as { updated_at?: string }).updated_at
        ? ((l as unknown as { updated_at: string }).updated_at >= startIso)
        : false
    ).length
    setScoringDone(freshlyScored)
    if (freshlyScored >= scoringTotal) {
      if (scoringPollRef.current) clearInterval(scoringPollRef.current)
      scoringPollRef.current = null
      localStorage.removeItem(lsScoreKey)
      setIsScoringAll(false)
    }
  }, [leads, isScoringAll, scoringTotal])

  async function handleCancelScoring() {
    if (scoringPollRef.current) clearInterval(scoringPollRef.current)
    scoringPollRef.current = null
    localStorage.removeItem(lsScoreKey)
    setIsScoringAll(false)
    await cancelQualify(leads.map(l => l.id)).catch(() => null)
  }

  // On-demand qualification: silently score unqualified leads when a list is opened.
  // Fires once per listId — the ref prevents re-triggering when leads reload mid-scoring.
  const qualifiedListRef = useRef<string | null>(null)
  useEffect(() => {
    if (!listId || isLoading) return
    if (qualifiedListRef.current === listId) return   // already triggered for this list
    const unscored = leads.filter(l => l.icp_score == null)
    if (unscored.length === 0) return
    qualifiedListRef.current = listId
    qualifyAllLeads({ list_id: listId }).catch(() => null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, isLoading, leads.length])

  const sortedLeads = useMemo(() => {
    const arr = [...leads]
    arr.sort((a, b) => {
      let av: string | number = ''
      let bv: string | number = ''
      switch (sortCol) {
        case 'name':      av = `${a.first_name} ${a.last_name}`.toLowerCase(); bv = `${b.first_name} ${b.last_name}`.toLowerCase(); break
        case 'title':     av = (a.title ?? '').toLowerCase();   bv = (b.title ?? '').toLowerCase();   break
        case 'company':   av = (a.company ?? '').toLowerCase(); bv = (b.company ?? '').toLowerCase(); break
        case 'icp_score': av = a.icp_score ?? -1;               bv = b.icp_score ?? -1;               break
        case 'icp_flag':  av = a.icp_flag ?? '';                bv = b.icp_flag ?? '';                break
        case 'source':    av = a.source;                        bv = b.source;                        break
        case 'created_at': av = a.created_at;                   bv = b.created_at;                    break
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return arr
  }, [leads, sortCol, sortDir])

  // Returns a sort indicator span — closed over sortCol/sortDir
  const sortArrow = (col: SortCol) =>
    sortCol === col
      ? <span className="text-blue-400 text-[9px]">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
      : <span className="opacity-20 text-[9px]"> ↕</span>

  const { data: labels = [] } = useQuery({
    queryKey: ['labels'],
    queryFn: fetchLabels,
  })

  // Batch-fetch all lead label assignments to avoid N+1 per-lead queries
  const { data: allLeadLabels = {} } = useQuery({
    queryKey: ['lead-labels-all'],
    queryFn: fetchAllLeadLabelAssignments,
    staleTime: 60_000,
  })
  useEffect(() => {
    if (Object.keys(allLeadLabels).length > 0) {
      for (const [leadId, lbls] of Object.entries(allLeadLabels)) {
        queryClient.setQueryData(['lead-labels', leadId], lbls)
      }
    }
  }, [allLeadLabels, queryClient])

  // Real-time subscription — patch the React Query cache surgically as scores arrive.
  // UPDATE events (score writes): merge changed fields directly into the cached row — no refetch.
  // INSERT events (new imports): invalidate so the new row appears in the list.
  useEffect(() => {
    const channelName = `leads-realtime-${Date.now()}`
    let channel: ReturnType<typeof supabase.channel> | null = null
    void supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return
      channel = supabase
        .channel(channelName)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'leads',
          filter: `user_id=eq.${data.user.id}`,
        }, (payload) => {
          // Patch every cached leads query that contains this lead
          queryClient.setQueriesData<Lead[]>({ queryKey: ['leads'] }, (old) => {
            if (!old) return old
            return old.map(l =>
              l.id === (payload.new as Lead).id ? { ...l, ...(payload.new as Lead) } : l
            )
          })
        })
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'leads',
          filter: `user_id=eq.${data.user.id}`,
        }, () => {
          // New lead imported — need full refetch to add it to the list
          void queryClient.invalidateQueries({ queryKey: ['leads'] })
        })
        .subscribe()
    })
    return () => { if (channel) void supabase.removeChannel(channel) }
  }, [queryClient])

  const { data: campaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => import('../api/campaigns').then(m => m.fetchCampaigns()),
    enabled: showAddToCampaign,
  })

  // Fetch product list for "Best Fit" column (cached, served from user-settings key)
  const { data: userSettingsRaw } = useQuery({
    queryKey: ['user-settings'],
    queryFn: async () => {
      const { data } = await supabase.from('user_settings').select('icp_config').single()
      return data as { icp_config: { products_services?: ProductRef[] } } | null
    },
    staleTime: 300_000,
  })
  const products: ProductRef[] = userSettingsRaw?.icp_config?.products_services?.filter(p => p.id && p.name) ?? []

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

  async function handleCancelEnrich() {
    if (enrichPollRef.current) clearInterval(enrichPollRef.current)
    enrichPollRef.current = null
    if (enrichJobId) await cancelEnrichJob(enrichJobId).catch(() => null)
    localStorage.removeItem(lsEnrichKey)
    setEnrichStatus('idle')
    setEnrichJobId(null)
    setEnrichProgress(0)
    setShowEnrichModal(false)
  }

  async function handleEnrichProfiles() {
    if (!enrichAccountId) return
    try {
      setEnrichStatus('running')
      setEnrichProgress(0)
      const result = await enrichProfiles({
        account_id: enrichAccountId,
        ...(listId ? { list_id: listId } : {}),
      })
      setEnrichJobId(result.job_id)
      setEnrichCount(result.count)
      setShowEnrichModal(false)   // close modal — progress shows on button
      localStorage.setItem(lsEnrichKey, JSON.stringify({ jobId: result.job_id }))

      enrichPollRef.current = setInterval(async () => {
        try {
          const status = await getEnrichStatus(result.job_id)
          setEnrichProgress(status.progress)
          if (status.state === 'completed') {
            clearInterval(enrichPollRef.current!); enrichPollRef.current = null
            localStorage.removeItem(lsEnrichKey)
            setEnrichStatus('done'); setEnrichJobId(null)
            void queryClient.invalidateQueries({ queryKey: ['leads'] })
            setTimeout(() => setEnrichStatus('idle'), 3000)
          } else if (status.state === 'failed') {
            clearInterval(enrichPollRef.current!); enrichPollRef.current = null
            localStorage.removeItem(lsEnrichKey)
            setEnrichError('Worker job failed — check server logs')
            setEnrichStatus('error')
            setTimeout(() => setEnrichStatus('idle'), 4000)
          }
        } catch {
          // ignore poll errors
        }
      }, 3000)
    } catch (err) {
      setEnrichError((err as Error).message)
      setEnrichStatus('error')
      console.error(err)
    }
  }

  return (
    <div className="p-8">
      {listId && (
        <button
          onClick={() => navigate('/leads')}
          className="mb-4 flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Lead Lists
        </button>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{listId && currentList ? currentList.name : 'Leads'}</h1>
          <p className="mt-1 text-sm text-gray-500">{listId ? `${leads.length} lead${leads.length !== 1 ? 's' : ''}` : 'Import and manage your lead lists'}</p>
        </div>
        <div className="flex gap-3">
          {leads.length > 0 && (
            <button
              onClick={() => {
                if (isScoringAll) { handleCancelScoring(); return }
                // Start animation immediately, then fire the mutation
                const startTime = Date.now()
                scoringStartTimeRef.current = startTime
                setIsScoringAll(true)
                setScoringTotal(leads.length)
                setScoringDone(0)
                localStorage.setItem(lsScoreKey, JSON.stringify({ startTime, total: leads.length }))
                if (scoringPollRef.current) clearInterval(scoringPollRef.current)
                scoringPollRef.current = setInterval(() => {
                  void queryClient.invalidateQueries({ queryKey: ['leads'] })
                }, 2000)
                qualifyAllMutation.mutate({ force: true, list_id: listId ?? undefined })
              }}
              disabled={qualifyAllMutation.isPending && !isScoringAll}
              className={`px-4 py-2 border text-sm font-medium rounded-lg transition-colors flex items-center gap-2 ${
                isScoringAll
                  ? 'border-violet-400 bg-violet-50 text-violet-700 hover:bg-red-50 hover:border-red-300 hover:text-red-600'
                  : 'border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-60'
              }`}
            >
              {isScoringAll ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <span>Scoring {scoringDone}/{scoringTotal} · click to stop</span>
                </>
              ) : qualifyAllMutation.isPending ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <span>Queuing…</span>
                </>
              ) : unscoredCount > 0
                ? `✨ Score All (${unscoredCount} unscored)`
                : `✨ Re-score All (${leads.length})`}
            </button>
          )}
          {leads.length > 0 && (
            <button
              onClick={() => {
                const headers = ['First Name','Last Name','Title','Company','LinkedIn URL','ICP Flag','ICP Score','Email','Location','Industry']
                const rows = leads.map(l => [
                  l.first_name, l.last_name, l.title ?? '', l.company ?? '',
                  l.linkedin_url, l.icp_flag ?? '', l.icp_score ?? '',
                  (l as unknown as Record<string,unknown>).email ?? '', (l as unknown as Record<string,unknown>).location ?? '',
                  (l as unknown as Record<string,unknown>).industry ?? '',
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
          {listId && leads.length > 0 && (
            <button
              onClick={() => {
                if (enrichStatus === 'running') { handleCancelEnrich(); return }
                setShowEnrichModal(true); setEnrichStatus('idle'); setEnrichProgress(0); setEnrichAccountId(''); setEnrichError('')
              }}
              className={`px-4 py-2 border text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
                enrichStatus === 'running'
                  ? 'border-blue-400 bg-blue-50 text-blue-700 hover:bg-red-50 hover:border-red-300 hover:text-red-600'
                  : enrichStatus === 'done'
                    ? 'border-green-400 bg-green-50 text-green-700'
                    : enrichStatus === 'error'
                      ? 'border-red-300 bg-red-50 text-red-600'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {enrichStatus === 'running' ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <span>Enriching {enrichProgress}% · click to stop</span>
                </>
              ) : enrichStatus === 'done' ? (
                <>
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Enrichment done
                </>
              ) : enrichStatus === 'error' ? (
                <>
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Enrich failed
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Enrich Profiles
                </>
              )}
            </button>
          )}
          {listId ? (
            addLeadsJobId ? (
              <button
                onClick={async () => {
                  if (addLeadsPollRef.current) clearInterval(addLeadsPollRef.current)
                  await cancelScrapeJob(addLeadsJobId).catch(() => null)
                  localStorage.removeItem(lsScrapeKey)
                  setAddLeadsJobId(null)
                  setAddLeadsProgress(0)
                  void queryClient.invalidateQueries({ queryKey: ['leads'] })
                }}
                title="Click to cancel"
                className="group relative flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 hover:bg-red-50 hover:border-red-200 transition-colors"
              >
                <div className="relative w-20 h-1.5 bg-blue-100 group-hover:bg-red-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 group-hover:bg-red-400 rounded-full transition-all duration-500" style={{ width: `${Math.max(addLeadsProgress, 3)}%` }} />
                </div>
                <span className="text-xs font-semibold text-blue-600 group-hover:text-red-600 w-8 text-right">
                  <span className="group-hover:hidden">{addLeadsProgress}%</span>
                  <span className="hidden group-hover:inline">✕</span>
                </span>
              </button>
            ) : addLeadsJobError ? (
              <button
                onClick={() => { setAddLeadsJobError(null); setShowAddToList(true); setAddLeadsStep('source'); setAddLeadsSource(null); setAddLeadsError('') }}
                title={addLeadsJobError}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-medium hover:bg-red-100 transition-colors max-w-xs"
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="truncate">{addLeadsJobError.length > 60 ? addLeadsJobError.slice(0, 57) + '…' : addLeadsJobError}</span>
              </button>
            ) : (
            <button
              onClick={() => { setAddLeadsJobError(null); setShowAddToList(true); setAddLeadsStep('source'); setAddLeadsSource(null); setAddLeadsError('') }}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Leads
            </button>
            )
          ) : (
            <>
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
              <button
                onClick={() => setShowManualAdd(true)}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
              >
                Add Lead
              </button>
            </>
          )}
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
          <option value="">All ICP fits</option>
          <option value="hot">★ Ideal Fit</option>
          <option value="warm">◆ Good Fit</option>
          <option value="cold">○ Weak Fit</option>
          <option value="disqualified">✗ Not a Fit</option>
        </select>
        <select
          value={sourceFilter}
          onChange={e => setSourceFilter(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All sources</option>
          <option value="excel_import">Excel / CSV</option>
          <option value="chrome_extension">Chrome Extension</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
          <span className="text-sm font-medium text-blue-800">{selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''} selected</span>
          <button
            onClick={() => qualifyAllMutation.mutate({ force: true, ids: [...selectedIds] })}
            disabled={qualifyAllMutation.isPending}
            className="px-3 py-1.5 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-60"
          >
            {qualifyAllMutation.isPending ? '⏳ Queuing…' : `✨ Score Selected (${selectedIds.size})`}
          </button>
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
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 transition-colors"
                  onClick={() => toggleSort('name')}
                >
                  <span className="inline-flex items-center">Name{sortArrow('name')}</span>
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 transition-colors"
                  onClick={() => toggleSort('title')}
                >
                  <span className="inline-flex items-center">Title{sortArrow('title')}</span>
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 transition-colors"
                  onClick={() => toggleSort('company')}
                >
                  <span className="inline-flex items-center">Company{sortArrow('company')}</span>
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 transition-colors"
                  onClick={() => toggleSort('icp_score')}
                >
                  <span className="inline-flex items-center">ICP Score{sortArrow('icp_score')}</span>
                </th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 transition-colors"
                  onClick={() => toggleSort('icp_flag')}
                >
                  <span className="inline-flex items-center">ICP Fit{sortArrow('icp_flag')}</span>
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Best Fit</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Labels</th>
                <th
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 transition-colors"
                  onClick={() => toggleSort('source')}
                >
                  <span className="inline-flex items-center">Source{sortArrow('source')}</span>
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center text-gray-400 text-sm">Loading…</td>
                </tr>
              ) : leads.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-16 text-center text-gray-500">
                    No leads yet. Import from a Sales Navigator Excel export to get started.
                  </td>
                </tr>
              ) : (
                sortedLeads.map(lead => {
                  const isQueued = requalifyMutation.isPending && requalifyMutation.variables === lead.id
                  const reasoning = lead.raw_data?.ai_reasoning
                  const openingLine = lead.raw_data?.opening_line
                  const isExpanded = expandedLeadId === lead.id
                  const hasEnrichedData = !!(lead.about || lead.experience_description || lead.skills?.length || lead.recent_posts?.length)
                  return (
                    <Fragment key={lead.id}>
                    <tr
                      onClick={() => setExpandedLeadId(isExpanded ? null : lead.id)}
                      className={`cursor-pointer transition-colors border-b border-gray-100 ${isExpanded ? 'bg-violet-50' : `${selectedIds.has(lead.id) ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-gray-50'}`}`}
                    >
                      <td className="px-4 py-3 w-8" onClick={e => e.stopPropagation()}>
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
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] text-gray-400 transition-transform duration-150 inline-block ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                          <span className="text-gray-900">
                            {lead.first_name} {lead.last_name}
                          </span>
                          {lead.linkedin_url && (
                            <a
                              href={lead.linkedin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              title="Open LinkedIn profile"
                              className="text-[#0A66C2] hover:text-[#004182] shrink-0"
                            >
                              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
                              </svg>
                            </a>
                          )}
                        </div>
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
                            {FLAG_LABELS[lead.icp_flag]}
                          </span>
                        ) : (
                          <span className="text-gray-400 text-xs italic">Unscored</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <BestFitCell lead={lead} products={products} />
                      </td>
                      <td className="px-4 py-3">
                        <LeadLabelCell leadId={lead.id} allLabels={labels} queryClient={queryClient} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 capitalize whitespace-nowrap">{lead.source.replace('_', ' ')}</td>
                      <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
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

                    {/* ── Expanded profile row ── */}
                    {isExpanded && (
                      <tr className="bg-violet-50 border-b border-gray-100">
                        <td colSpan={10} className="px-6 pb-5 pt-0 max-w-0 overflow-hidden">
                          {hasEnrichedData ? (
                            <div className="flex flex-wrap gap-x-8 gap-y-4 pt-2">

                              {lead.about && (
                                <div className="min-w-[200px] flex-1">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400 mb-1.5">About</p>
                                  <p className="text-xs text-gray-600 leading-relaxed line-clamp-4">{lead.about}</p>
                                </div>
                              )}

                              {lead.experience_description && (
                                <div className="min-w-[200px] flex-1">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400 mb-1.5">Current Role</p>
                                  <p className="text-xs text-gray-600 leading-relaxed line-clamp-3">{lead.experience_description}</p>
                                </div>
                              )}

                              {lead.skills && lead.skills.length > 0 && (
                                <div className="min-w-[160px]">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400 mb-1.5">Skills</p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {lead.skills.slice(0, 8).map((skill, i) => (
                                      <span key={i} className="px-2 py-0.5 bg-white border border-violet-200 text-violet-700 text-[10px] font-medium rounded-full">
                                        {skill}
                                      </span>
                                    ))}
                                    {lead.skills.length > 8 && (
                                      <span className="text-[10px] text-gray-400 self-center">+{lead.skills.length - 8} more</span>
                                    )}
                                  </div>
                                </div>
                              )}

                              {lead.recent_posts && lead.recent_posts.length > 0 && (
                                <div className="min-w-[260px] flex-[2]">
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-violet-400 mb-1.5">Recent Posts</p>
                                  <div className="space-y-1.5">
                                    {lead.recent_posts.slice(0, 3).map((post, i) => (
                                      <p key={i} className="text-xs text-gray-600 leading-relaxed line-clamp-2 pl-2 border-l-2 border-violet-200">
                                        {post}
                                      </p>
                                    ))}
                                  </div>
                                </div>
                              )}

                            </div>
                          ) : (
                            <p className="text-xs text-gray-400 italic pt-1">No profile data yet — click Enrich Profiles to scrape this lead's LinkedIn.</p>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
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

      {showManualAdd && (
        <ManualAddLeadModal
          listId={listId}
          onClose={() => setShowManualAdd(false)}
          onAdded={() => {
            setShowManualAdd(false)
            void queryClient.invalidateQueries({ queryKey: ['leads'] })
          }}
        />
      )}

      {/* ── Add Leads Wizard Modal ──────────────────────────────────────────── */}
      {showAddToList && listId && (() => {
        const activeAccts = accounts.filter((a: { status: string }) => a.status === 'active' || a.status === 'warming_up')

        type SourceDef = { id: AddLeadsSource; label: string; description: string; badge?: string; soon?: boolean; color: string; bgColor: string; borderColor: string; icon: React.ReactElement }
        const SOURCE_GROUPS: Array<{ heading: string; items: SourceDef[] }> = [
          {
            heading: 'People',
            items: [
              { id: 'sales_nav', label: 'Sales Navigator (Leads)', badge: 'Most popular', description: 'Paste a Sales Navigator people search URL to scrape up to 2,500 leads using your connected account.', color: 'text-blue-700', bgColor: 'bg-blue-50', borderColor: 'border-blue-200', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg> },
              { id: 'linkedin_search', label: 'LinkedIn Search Bar', description: 'Paste a LinkedIn people search URL (/search/results/people/…). Scraped server-side using your session.', color: 'text-violet-700', bgColor: 'bg-violet-50', borderColor: 'border-violet-200', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg> },
              { id: 'post_reactors', label: 'LinkedIn Post (Reactors)', description: 'Paste a LinkedIn post URL to import everyone who liked or commented on it.', color: 'text-pink-700', bgColor: 'bg-pink-50', borderColor: 'border-pink-200', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" /></svg> },
              { id: 'event_attendees', label: 'LinkedIn Event (Attendees)', soon: true, description: 'Paste a LinkedIn event URL to import attendees who are going or interested.', color: 'text-gray-500', bgColor: 'bg-gray-50', borderColor: 'border-gray-200', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg> },
              { id: 'csv', label: 'CSV / Excel', description: 'Upload a spreadsheet. Required columns: First Name, Last Name, LinkedIn URL.', color: 'text-emerald-700', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg> },
            ],
          },
          {
            heading: 'Companies',
            items: [
              { id: 'sales_nav_accounts', label: 'Sales Navigator (Accounts)', soon: true, description: 'Paste a Sales Navigator account search URL to import companies and then find decision-makers.', color: 'text-gray-500', bgColor: 'bg-gray-50', borderColor: 'border-gray-200', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg> },
              { id: 'linkedin_companies', label: 'LinkedIn Search Bar (Companies)', soon: true, description: 'Paste a LinkedIn company search URL to import companies from your search results.', color: 'text-gray-500', bgColor: 'bg-gray-50', borderColor: 'border-gray-200', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" /></svg> },
            ],
          },
        ]

        const allSources = SOURCE_GROUPS.flatMap(g => g.items)
        const selectedDef = allSources.find(s => s.id === addLeadsSource)

        async function handleAddLeadsSubmit() {
          if (!addLeadsSource || addLeadsImporting) return
          setAddLeadsError('')
          setAddLeadsImporting(true)
          try {
            if (addLeadsSource === 'csv') {
              if (!addLeadsCsvFile) return
              const result = await importExcelIntoList(listId!, addLeadsCsvFile)
              setShowAddToList(false)
              setAddLeadsCsvFile(null)
              void queryClient.invalidateQueries({ queryKey: ['leads'] })
              void queryClient.invalidateQueries({ queryKey: ['lead-list', listId] })
              // brief toast via console; UI will refresh
              console.log(`Imported: ${result.saved} saved, ${result.skipped} skipped`)
            } else {
              const { job_id } = await scrapeIntoList(listId!, { search_url: addLeadsUrl, account_id: addLeadsAccountId, max_leads: addLeadsMax, source_type: addLeadsSource! })
              setAddLeadsJobId(job_id)
              setAddLeadsProgress(0)
              setAddLeadsJobError(null)
              setShowAddToList(false)
              localStorage.setItem(lsScrapeKey, JSON.stringify({ jobId: job_id }))
              addLeadsPollRef.current = setInterval(async () => {
                try {
                  const s = await getListScrapeStatus(job_id)
                  setAddLeadsProgress(s.progress ?? 0)
                  if (s.state === 'completed' || s.state === 'failed') {
                    clearInterval(addLeadsPollRef.current!); addLeadsPollRef.current = null
                    localStorage.removeItem(lsScrapeKey)
                    setAddLeadsJobId(null); setAddLeadsProgress(0)
                    if (s.state === 'failed') {
                      setAddLeadsJobError(s.error ?? 'Scrape job failed. Check your account session.')
                    }
                    void queryClient.invalidateQueries({ queryKey: ['leads'] })
                    void queryClient.invalidateQueries({ queryKey: ['lead-list', listId] })
                  }
                } catch { /* keep polling */ }
              }, 3000)
            }
          } catch (e) {
            setAddLeadsError((e as Error).message)
          } finally {
            setAddLeadsImporting(false)
          }
        }

        const isUrlSource = addLeadsSource && addLeadsSource !== 'csv'
        const needsAccount = isUrlSource
        const needsMax = addLeadsSource === 'sales_nav' || addLeadsSource === 'linkedin_search'
        const canSubmit = addLeadsSource === 'csv'
          ? !!addLeadsCsvFile
          : !!addLeadsUrl.trim() && !!addLeadsAccountId

        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={e => { if (e.target === e.currentTarget) setShowAddToList(false) }}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">

              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  {addLeadsStep === 'form' && (
                    <button onClick={() => { setAddLeadsStep('source'); setAddLeadsSource(null); setAddLeadsError('') }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition-colors">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    </button>
                  )}
                  <h2 className="text-base font-semibold text-gray-900">
                    {addLeadsStep === 'source' ? 'Add Leads' : `Import from ${selectedDef?.label ?? ''}`}
                  </h2>
                </div>
                <button onClick={() => setShowAddToList(false)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              {/* Step 1 — Source selection */}
              {addLeadsStep === 'source' && (
                <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
                  <p className="text-sm text-gray-500">Choose how you want to add leads to this list.</p>

                  {/* Manual add option */}
                  <div>
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Manual</p>
                    <button
                      onClick={() => { setShowAddToList(false); setShowManualAdd(true) }}
                      className="w-full flex items-center gap-3 p-3.5 rounded-xl border text-left bg-gray-50 border-gray-200 hover:shadow-sm hover:scale-[1.01] transition-all"
                    >
                      <div className="flex-shrink-0 text-gray-600">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-gray-700">Add manually</span>
                        <p className="text-xs text-gray-400 mt-0.5">Enter a LinkedIn URL to add a single lead.</p>
                      </div>
                      <svg className="w-4 h-4 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </button>
                  </div>

                  {SOURCE_GROUPS.map(group => (
                    <div key={group.heading}>
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">{group.heading}</p>
                      <div className="space-y-2">
                        {group.items.map(src => (
                          <button
                            key={src.id}
                            onClick={() => { if (!src.soon) { setAddLeadsSource(src.id); setAddLeadsStep('form'); setAddLeadsUrl(''); setAddLeadsError('') } }}
                            disabled={!!src.soon}
                            className={`w-full flex items-center gap-3 p-3.5 rounded-xl border text-left transition-all ${src.soon ? 'opacity-50 cursor-not-allowed bg-gray-50 border-gray-200' : `${src.bgColor} ${src.borderColor} hover:shadow-sm hover:scale-[1.01]`}`}
                          >
                            <div className={`flex-shrink-0 ${src.soon ? 'text-gray-400' : src.color}`}>{src.icon}</div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`text-sm font-semibold ${src.soon ? 'text-gray-500' : src.color}`}>{src.label}</span>
                                {src.badge && !src.soon && <span className="text-xs font-medium px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-md">{src.badge}</span>}
                                {src.soon && <span className="text-xs font-medium px-1.5 py-0.5 bg-gray-200 text-gray-500 rounded-md">Soon</span>}
                              </div>
                              <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{src.description}</p>
                            </div>
                            {!src.soon && <svg className={`w-4 h-4 flex-shrink-0 ${src.color} opacity-50`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Step 2 — Form */}
              {addLeadsStep === 'form' && addLeadsSource && (
                <div className="p-6 space-y-4">
                  {/* URL input */}
                  {isUrlSource && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                        {addLeadsSource === 'sales_nav' && 'Sales Navigator Search URL'}
                        {addLeadsSource === 'linkedin_search' && 'LinkedIn People Search URL'}
                        {addLeadsSource === 'post_reactors' && 'LinkedIn Post URL'}
                        {addLeadsSource === 'event_attendees' && 'LinkedIn Event URL'}
                      </label>
                      <textarea
                        rows={2}
                        autoFocus
                        value={addLeadsUrl}
                        onChange={e => setAddLeadsUrl(e.target.value)}
                        placeholder={
                          addLeadsSource === 'sales_nav' ? 'https://www.linkedin.com/sales/search/people?savedSearchId=…'
                          : addLeadsSource === 'linkedin_search' ? 'https://www.linkedin.com/search/results/people/?keywords=…'
                          : addLeadsSource === 'post_reactors' ? 'https://www.linkedin.com/posts/johndoe_activity-12345678-abcd/'
                          : 'https://www.linkedin.com/events/1234567890/'
                        }
                        className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono"
                      />
                    </div>
                  )}

                  {/* Account selector */}
                  {needsAccount && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1.5">LinkedIn Account</label>
                      {activeAccts.length === 0 ? (
                        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-700">
                          No active LinkedIn accounts found.{' '}
                          <button onClick={() => navigate('/accounts')} className="underline font-medium">Add one in Accounts →</button>
                        </div>
                      ) : (
                        <select
                          value={addLeadsAccountId}
                          onChange={e => setAddLeadsAccountId(e.target.value)}
                          className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">Select account…</option>
                          {activeAccts.map((a: { id: string; sender_name?: string | null; linkedin_email: string }) => (
                            <option key={a.id} value={a.id}>{a.sender_name ? `${a.sender_name} (${a.linkedin_email})` : a.linkedin_email}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  {/* Max leads slider */}
                  {needsMax && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                        Max leads to import <span className="text-gray-400 font-normal">(up to 2,500)</span>
                      </label>
                      <div className="flex items-center gap-3">
                        <input type="range" min={25} max={2500} step={25} value={addLeadsMax} onChange={e => setAddLeadsMax(Number(e.target.value))} className="flex-1 accent-blue-600" />
                        <span className="text-sm font-semibold text-gray-800 w-12 text-right">{addLeadsMax.toLocaleString()}</span>
                      </div>
                    </div>
                  )}

                  {/* CSV file drop */}
                  {addLeadsSource === 'csv' && (
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1.5">Upload File</label>
                      <div
                        className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${addLeadsDragging ? 'border-blue-400 bg-blue-50' : addLeadsCsvFile ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'}`}
                        onClick={() => addLeadsCsvRef.current?.click()}
                        onDragOver={e => { e.preventDefault(); setAddLeadsDragging(true) }}
                        onDragLeave={() => setAddLeadsDragging(false)}
                        onDrop={e => { e.preventDefault(); setAddLeadsDragging(false); const f = e.dataTransfer.files[0]; if (f) setAddLeadsCsvFile(f) }}
                      >
                        <input ref={addLeadsCsvRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setAddLeadsCsvFile(f) }} />
                        {addLeadsCsvFile ? (
                          <>
                            <svg className="w-8 h-8 text-emerald-500 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            <p className="text-sm font-semibold text-emerald-700">{addLeadsCsvFile.name}</p>
                            <p className="text-xs text-emerald-600 mt-0.5">{(addLeadsCsvFile.size / 1024).toFixed(0)} KB — click to change</p>
                          </>
                        ) : (
                          <>
                            <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                            <p className="text-sm font-medium text-gray-600">Drop your CSV or Excel file here</p>
                            <p className="text-xs text-gray-400 mt-1">or click to browse — .csv, .xlsx, .xls</p>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-2">Required columns: <span className="font-medium text-gray-600">First Name, Last Name, LinkedIn URL</span></p>
                    </div>
                  )}

                  {addLeadsError && (
                    <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl">
                      <svg className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      <p className="text-xs text-red-700">{addLeadsError}</p>
                    </div>
                  )}

                  <div className="flex gap-3 pt-1">
                    <button onClick={() => setShowAddToList(false)} className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-xl hover:bg-gray-50 transition-colors">Cancel</button>
                    <button
                      onClick={() => void handleAddLeadsSubmit()}
                      disabled={addLeadsImporting || !canSubmit}
                      className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                    >
                      {addLeadsImporting ? (
                        <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Starting…</>
                      ) : addLeadsSource === 'csv' ? 'Import' : 'Start Scraping'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })()}

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

      {showEnrichModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Enrich Profiles</h2>
              <button onClick={() => { setShowEnrichModal(false); if (enrichPollRef.current) clearInterval(enrichPollRef.current) }} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            {enrichStatus === 'idle' && (
              <>
                <p className="text-sm text-gray-500">Visit each lead's LinkedIn profile and scrape their About, Experience, Skills, and recent posts.</p>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">LinkedIn Account</label>
                  <select
                    value={enrichAccountId}
                    onChange={e => setEnrichAccountId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                  >
                    <option value="">Select account…</option>
                    {accounts.filter(a => a.status === 'active' || a.status === 'warming_up').map(a => (
                      <option key={a.id} value={a.id}>{a.linkedin_email}</option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-gray-400">Will visit {leads.filter(l => l.linkedin_url?.includes('/in/')).length} profiles. Takes ~25–35s per profile.</p>
                <button
                  onClick={handleEnrichProfiles}
                  disabled={!enrichAccountId}
                  className="w-full py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-50"
                >
                  Start Enriching
                </button>
              </>
            )}

            {enrichStatus === 'running' && (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">Scraping {enrichCount} profiles…</p>
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-violet-500 rounded-full transition-all duration-500" style={{ width: `${enrichProgress}%` }} />
                </div>
                <p className="text-xs text-gray-400 text-center">{enrichProgress}% — profiles update live as they're scraped</p>
              </div>
            )}

            {enrichStatus === 'done' && (
              <div className="text-center space-y-3 py-2">
                <div className="text-3xl">✅</div>
                <p className="text-sm font-medium text-gray-800">Enrichment complete</p>
                <p className="text-xs text-gray-500">{enrichCount} profiles visited</p>
                <button onClick={() => setShowEnrichModal(false)} className="w-full py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors">Close</button>
              </div>
            )}

            {enrichStatus === 'error' && (
              <div className="text-center space-y-3 py-2">
                <div className="text-3xl">❌</div>
                <p className="text-sm text-gray-600">Enrichment failed</p>
                {enrichError && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2 text-left break-all">{enrichError}</p>}
                <button onClick={() => setShowEnrichModal(false)} className="w-full py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 transition-colors">Close</button>
              </div>
            )}
          </div>
        </div>
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

// ── Manual Add Lead Modal ────────────────────────────────────────────────────

function ManualAddLeadModal({ onClose, onAdded, listId, inline }: { onClose: () => void; onAdded: () => void; listId?: string; inline?: boolean }) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', linkedin_url: '',
    title: '', company: '', location: '',
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [added, setAdded] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.first_name.trim() || !form.last_name.trim() || !form.linkedin_url.trim()) {
      setError('First name, last name, and LinkedIn URL are required')
      return
    }
    setLoading(true)
    setError('')
    try {
      await createManualLead({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        linkedin_url: form.linkedin_url.trim(),
        title: form.title.trim() || undefined,
        company: form.company.trim() || undefined,
        location: form.location.trim() || undefined,
        list_id: listId,
      })
      if (inline) {
        setAdded(true)
        setForm({ first_name: '', last_name: '', linkedin_url: '', title: '', company: '', location: '' })
        onAdded()
      } else {
        onAdded()
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const formContent = (
    <form onSubmit={handleSubmit} className="space-y-3">
      {added && <p className="text-xs text-green-600 font-medium">Lead added! Fill in another or close.</p>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">First Name *</label>
              <input
                autoFocus
                type="text"
                value={form.first_name}
                onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Jane"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Last Name *</label>
              <input
                type="text"
                value={form.last_name}
                onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Smith"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">LinkedIn URL *</label>
            <input
              type="text"
              value={form.linkedin_url}
              onChange={e => setForm(f => ({ ...f, linkedin_url: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="https://linkedin.com/in/janesmith"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="CEO"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Company</label>
              <input
                type="text"
                value={form.company}
                onChange={e => setForm(f => ({ ...f, company: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Acme Corp"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Location</label>
            <input
              type="text"
              value={form.location}
              onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="London, UK"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {loading ? 'Adding…' : 'Add Lead'}
            </button>
          </div>
        </form>
  )

  if (inline) return formContent

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Lead Manually</h2>
        {formContent}
      </div>
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

/**
 * Normalises a URL to a standard linkedin.com/in/ profile URL.
 * Sales Navigator exports contain /sales/lead/ or /sales/people/ URLs which
 * cannot be scraped — we attempt to find a proper /in/ URL in the row first,
 * and skip the lead if none is available.
 */
function normalizeLinkedInUrl(raw: string): string | null {
  const url = raw.trim()
  // Already a valid profile URL
  if (url.includes('linkedin.com/in/')) return url.split('?')[0].replace(/\/$/, '')
  // Sales Navigator / Recruiter / Talent URLs — not scrapeable, reject
  if (
    url.includes('linkedin.com/sales/') ||
    url.includes('linkedin.com/talent/') ||
    url.includes('linkedin.com/recruiter/')
  ) return null
  // Any other linkedin.com URL we don't recognise — reject
  if (url.includes('linkedin.com/')) return null
  return null
}

function parseSheet(rows: Record<string, string>[]): ParsedLead[] {
  const leads: ParsedLead[] = []
  for (const row of rows) {
    // Try the proper LinkedIn profile URL columns first (Sales Navigator exports
    // include both a "LinkedIn Profile URL" (/in/) and a "Sales Navigator URL").
    const rawUrl = pickCol(row,
      'LinkedIn Profile URL', 'LinkedIn URL', 'Profile URL',
      'linkedin profile url', 'linkedin url', 'profile url',
      'LinkedinURL', 'ProfileURL', 'url', 'linkedin', 'profilelink'
    )
    if (!rawUrl) continue

    const linkedin_url = normalizeLinkedInUrl(rawUrl)
    if (!linkedin_url) continue   // skip Sales Nav / unrecognised URLs

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

  const activeAccounts = accounts.filter(a => a.status === 'active' || a.status === 'warming_up')

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

export function LeadDetailDrawer({
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
                      {FLAG_ICONS[lead.icp_flag]} {FLAG_LABELS[lead.icp_flag]}
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
