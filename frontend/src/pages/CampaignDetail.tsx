import { useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import {
  fetchCampaign,
  fetchCampaignLeads,
  fetchCampaignActivity,
  updateCampaign,
  removeCampaignLead,
  addLeadsToCampaign,
  scoreEngagement,
  type Campaign,
  type CampaignLead,
  type CampaignActivityEntry,
} from '../api/campaigns'
import { fetchAccounts } from '../api/accounts'
import { fetchLeadLists, fetchListLeads } from '../api/leadLists'
import { apiFetch } from '../lib/fetchJson'
import { fetchSequences, createSequence, type SequenceStep } from '../api/sequences'
import { FlowCanvas } from './SequenceBuilder'
import { ChatSequenceBuilder } from '../components/ChatSequenceBuilder'

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

const ICP_BADGE: Record<string, string> = {
  hot:          'bg-red-100 text-red-700 border border-red-200',
  warm:         'bg-orange-100 text-orange-700 border border-orange-200',
  cold:         'bg-blue-100 text-blue-700 border border-blue-200',
  disqualified: 'bg-gray-100 text-gray-500 border border-gray-200',
}

const ICP_LABELS: Record<string, string> = {
  hot: '🔥 Hot', warm: '☀️ Warm', cold: '❄️ Cold', disqualified: '✗ Disqualified',
}

// ── Action labels & icons for the activity feed ──────────────────────────────
const ACTION_META: Record<string, { label: string; icon: string; color: string; bg?: string }> = {
  view_profile:       { label: 'Viewed profile',        icon: '👁',  color: 'text-gray-500' },
  connect:            { label: 'Connection sent',        icon: '🔗',  color: 'text-blue-600' },
  connection_sent:    { label: 'Connection sent',        icon: '🔗',  color: 'text-blue-600' },
  message:            { label: 'Message sent',           icon: '💬',  color: 'text-purple-600' },
  message_sent:       { label: 'Message sent',           icon: '💬',  color: 'text-purple-600' },
  follow:             { label: 'Followed',               icon: '➕',  color: 'text-indigo-500' },
  react_post:         { label: 'Reacted to post',        icon: '👍',  color: 'text-pink-500' },
  inmail:             { label: 'InMail sent',            icon: '✉️',  color: 'text-teal-600' },
  reply_received:     { label: 'Reply received',         icon: '📩',  color: 'text-green-600' },
  connected:          { label: 'Connected',              icon: '✅',  color: 'text-green-600' },
  // ── Failure / warning entries ──────────��──────────────────────────────────
  failed:             { label: 'Action failed',          icon: '❌',  color: 'text-red-600',    bg: 'bg-red-50' },
  session_expired:    { label: 'Session expired',        icon: '🔒',  color: 'text-orange-600', bg: 'bg-orange-50' },
  security_challenge: { label: 'Security challenge',     icon: '⚠️',  color: 'text-orange-600', bg: 'bg-orange-50' },
  limit_reached:      { label: 'Daily limit reached',    icon: '🚫',  color: 'text-yellow-700', bg: 'bg-yellow-50' },
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function ActivityFeed({ entries }: { entries: CampaignActivityEntry[] }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 mt-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">Activity Log</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-gray-400 italic text-center py-6">
          No activity yet — actions will appear here as the sequence runs.
        </p>
      ) : (
        <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
          {entries.map(e => {
            const meta = ACTION_META[e.action] ?? { label: e.action.replace(/_/g, ' '), icon: '·', color: 'text-gray-600' }
            const isError = !!meta.bg
            return (
              <div key={e.id} className={`flex items-start gap-3 py-2.5 px-2 rounded-lg ${isError ? `${meta.bg} -mx-2` : ''}`}>
                <span className="text-base w-5 text-center shrink-0 mt-0.5">{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
                  {e.detail && (
                    <p className={`text-xs mt-0.5 ${isError ? 'text-gray-500' : 'text-gray-400'} break-words`}>{e.detail}</p>
                  )}
                </div>
                <span className="text-[10px] text-gray-300 shrink-0 tabular-nums mt-0.5">{timeAgo(e.created_at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Next Action cell ─────────────────────────────────────────────────────────
const STEP_ICON: Record<string, string> = {
  connect:      '🔗',
  message:      '💬',
  view_profile: '👁',
  react_post:   '👍',
  wait:         '⏳',
  inmail:       '✉️',
  follow:       '➕',
  fork:         '🔀',
  end:          '✅',
}

function etaLabel(dueMs: number): string {
  const diff = dueMs - Date.now()
  if (diff <= 0) return 'overdue · running soon'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60)  return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `in ${hrs}h`
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  return remHrs > 0 ? `in ${days}d ${remHrs}h` : `in ${days}d`
}

function NextActionCell({ cl, steps }: { cl: CampaignLead; steps: SequenceStep[] }) {
  // Terminal states — nothing pending
  if (['stopped', 'converted'].includes(cl.status)) {
    return <span className="text-xs text-gray-300">—</span>
  }

  if (steps.length === 0) {
    return <span className="text-xs text-gray-300">no sequence</span>
  }

  // Find current step node
  let currentStep: SequenceStep | undefined
  if (cl.current_step === 0) {
    // Not started yet — show first step
    currentStep = steps.find(s => s.parent_step_id === null && s.branch === 'main')
    if (!currentStep) currentStep = steps[0]
    const icon = STEP_ICON[currentStep?.type ?? ''] ?? '·'
    const label = (currentStep?.type ?? 'start').replace(/_/g, ' ')
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-gray-700">{icon} {label}</span>
        <span className="text-[10px] text-blue-500">pending · starts soon</span>
      </div>
    )
  }

  currentStep = steps.find(s => s.step_order === cl.current_step)
  if (!currentStep) return <span className="text-xs text-gray-300">—</span>

  if (currentStep.type === 'wait') {
    // Compute when the wait ends
    const waitVal  = currentStep.wait_days ?? 1
    const waitUnit = (currentStep.condition?.wait_unit as string) ?? 'days'
    const waitMs   = waitUnit === 'minutes' ? waitVal * 60_000
      : waitUnit === 'hours' ? waitVal * 3_600_000
      : waitVal * 86_400_000

    const lastAt = cl.last_action_at ? new Date(cl.last_action_at).getTime() : null
    const dueMs  = lastAt ? lastAt + waitMs : null

    // Next action is the step after this wait
    const afterWait = steps.find(s =>
      s.step_order > currentStep!.step_order &&
      s.parent_step_id === currentStep!.parent_step_id &&
      s.branch === currentStep!.branch
    )
    const nextIcon  = afterWait ? (STEP_ICON[afterWait.type] ?? '·') : '✅'
    const nextLabel = afterWait ? afterWait.type.replace(/_/g, ' ') : 'done'

    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-gray-700">{nextIcon} {nextLabel}</span>
        <span className={`text-[10px] ${dueMs && dueMs > Date.now() ? 'text-gray-400' : 'text-orange-500'}`}>
          {dueMs ? etaLabel(dueMs) : 'scheduled'}
        </span>
      </div>
    )
  }

  // Current step is an action step — it's pending scheduler pickup
  const icon  = STEP_ICON[currentStep.type] ?? '·'
  const label = currentStep.type.replace(/_/g, ' ')
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-gray-700">{icon} {label}</span>
      <span className="text-[10px] text-blue-500">queued · running soon</span>
    </div>
  )
}

export function CampaignDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'dashboard' | 'leads' | 'settings' | 'sequence'>('dashboard')
  const [chatOpen, setChatOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [showAddLeads, setShowAddLeads] = useState(false)
  const [selectedListToAdd, setSelectedListToAdd] = useState('')
  const [sortCol, setSortCol] = useState<'name' | 'company' | 'icp' | 'engagement' | 'status' | 'reply'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [scoreEngStatus, setScoreEngStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [scoreEngProgress, setScoreEngProgress] = useState(0)
  const [, setScoreEngTotal] = useState(0)
  const scoreEngCancelRef = useRef(false)

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

  const { data: activityLog = [] } = useQuery({
    queryKey: ['campaign-activity', id],
    queryFn: () => fetchCampaignActivity(id!),
    enabled: !!id && tab === 'dashboard',
    refetchInterval: 15_000,
  })

  const { data: leadLists = [] } = useQuery({
    queryKey: ['lead-lists'],
    queryFn: fetchLeadLists,
    enabled: showAddLeads,
  })

  const { data: selectedListLeads = [], isFetching: listLeadsFetching } = useQuery({
    queryKey: ['list-leads-add', selectedListToAdd],
    queryFn: () => fetchListLeads(selectedListToAdd),
    enabled: showAddLeads && !!selectedListToAdd,
    select: (data) => data as Lead[],
  })

  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  })

  const { data: sequences = [] } = useQuery({
    queryKey: ['sequences', id],
    queryFn: () => fetchSequences(id!),
    enabled: !!id,
  })

  const createSeqMutation = useMutation({
    mutationFn: () => createSequence(id!, 'Main Sequence'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sequences', id] }),
  })

  const statusMutation = useMutation({
    mutationFn: (status: string) => updateCampaign(id!, { status: status as 'active' | 'paused' | 'completed' | 'draft' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['campaign', id] }),
  })

  const removeMutation = useMutation({
    mutationFn: (clIds: string[]) => Promise.all(clIds.map(clId => removeCampaignLead(id!, clId))),
    onSuccess: () => {
      setSelectedIds(new Set())
      void queryClient.invalidateQueries({ queryKey: ['campaign-leads', id] })
    },
  })

  const addMutation = useMutation({
    mutationFn: (leadIds: string[]) => addLeadsToCampaign(id!, leadIds, campaign?.account_id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaign-leads', id] })
      setShowAddLeads(false)
      setSelectedListToAdd('')
    },
  })

  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null)
  const scheduleMutation = useMutation({
    mutationFn: (updates: Parameters<typeof updateCampaign>[1]) => updateCampaign(id!, updates),
    onSuccess: () => {
      setSettingsSaveError(null)
      void queryClient.invalidateQueries({ queryKey: ['campaign', id] })
    },
    onError: (err: Error) => setSettingsSaveError(err.message),
  })

  async function handleScoreEngagement(clIds?: string[]) {
    const ids = clIds ?? campaignLeads.map(cl => cl.id)
    if (ids.length === 0) return
    scoreEngCancelRef.current = false
    setScoreEngStatus('running')
    setScoreEngProgress(0)
    setScoreEngTotal(ids.length)
    const BATCH = 10
    let done = 0
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        if (scoreEngCancelRef.current) break
        const batch = ids.slice(i, i + BATCH)
        await scoreEngagement(id!, batch)
        done += batch.length
        setScoreEngProgress(Math.round((done / ids.length) * 100))
      }
      void queryClient.invalidateQueries({ queryKey: ['campaign-leads', id] })
      setScoreEngStatus('done')
      setTimeout(() => setScoreEngStatus('idle'), 3000)
    } catch {
      setScoreEngStatus('error')
      setTimeout(() => setScoreEngStatus('idle'), 3000)
    }
  }


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

  const existingLeadIds = new Set(campaignLeads.map(cl => cl.lead.id))

  // Find the campaign's own product ID (first product with an id in icp_config)
  const campaignProductId = (() => {
    const products = (campaign.icp_config as { products_services?: Array<{ id?: string; name?: string }> }).products_services ?? []
    return products.find(p => p.id)?.id ?? null
  })()

  const sorted = [...filtered].sort((a, b) => {
    let av: string | number = ''
    let bv: string | number = ''
    if (sortCol === 'name') {
      av = `${a.lead.first_name} ${a.lead.last_name}`.toLowerCase()
      bv = `${b.lead.first_name} ${b.lead.last_name}`.toLowerCase()
    } else if (sortCol === 'company') {
      av = (a.lead.company ?? '').toLowerCase()
      bv = (b.lead.company ?? '').toLowerCase()
    } else if (sortCol === 'icp') {
      const aScore = campaignProductId ? a.lead.raw_data?.product_scores?.[campaignProductId]?.score : null
      const bScore = campaignProductId ? b.lead.raw_data?.product_scores?.[campaignProductId]?.score : null
      av = aScore ?? a.lead.icp_score ?? 0
      bv = bScore ?? b.lead.icp_score ?? 0
    } else if (sortCol === 'engagement') {
      av = a.engagement_score ?? -1
      bv = b.engagement_score ?? -1
    } else if (sortCol === 'status') {
      av = a.status
      bv = b.status
    } else if (sortCol === 'reply') {
      av = a.reply_classification ?? ''
      bv = b.reply_classification ?? ''
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const sortIndicator = (col: typeof sortCol) =>
    sortCol === col
      ? <span className="text-blue-400 text-[9px]">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
      : null

  const sequence = sequences[0]

  return (
    <div className="flex flex-col h-full">
    <div className="px-8 pt-8 shrink-0 space-y-6">
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
        </div>
      </div>

      {/* Stats row — hidden on sequence tab to give the canvas maximum space */}
      {(tab === 'dashboard' || tab === 'leads') && (
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
      )}
    </div>

    {/* Tab bar — always visible, outside the padded section so it can sit flush */}
    <div className="px-8 flex items-center gap-1 border-b border-gray-200 shrink-0">
      {(
        [
          { key: 'dashboard' as const, label: 'Dashboard' },
          { key: 'leads'     as const, label: `Leads (${total})` },
          { key: 'settings'  as const, label: 'Settings' },
          { key: 'sequence'  as const, label: 'Sequence' },
        ]
      ).map(t => (
        <button
          key={t.key}
          onClick={() => setTab(t.key)}
          className={[
            'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            tab === t.key
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700',
          ].join(' ')}
        >
          {t.label}
        </button>
      ))}

      {/* Build with AI button — only on Sequence tab */}
      {tab === 'sequence' && (
        <button
          onClick={() => setChatOpen(o => !o)}
          className={[
            'ml-auto mb-1 self-center flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-sm font-semibold transition-all border',
            chatOpen
              ? 'bg-blue-600 text-white border-blue-600 shadow-md'
              : 'bg-white text-blue-600 border-blue-200 hover:bg-blue-50',
          ].join(' ')}
        >
          <span>✨</span>
          <span>Build with AI</span>
        </button>
      )}
    </div>

    {/* Sequence tab — full-bleed canvas, no extra padding */}
    {tab === 'sequence' && (
      <div className="flex-1 relative min-h-0" style={{ background: '#F8FAFC' }}>
        {!sequence ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="text-center">
              <p className="text-gray-900 font-semibold text-base">No sequence yet</p>
              <p className="mt-1 text-sm text-gray-500">Create a sequence to start building your outreach flow.</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => createSeqMutation.mutate()}
                disabled={createSeqMutation.isPending}
                className="px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-60 transition-colors shadow-md"
              >
                {createSeqMutation.isPending ? 'Creating…' : 'Create Sequence'}
              </button>
              <button
                onClick={async () => { await createSeqMutation.mutateAsync(); setChatOpen(true) }}
                disabled={createSeqMutation.isPending}
                className="px-5 py-2.5 bg-white border border-blue-200 text-blue-600 text-sm font-semibold rounded-xl hover:bg-blue-50 disabled:opacity-60 transition-colors shadow-sm flex items-center gap-1.5"
              >
                ✨ Build with AI
              </button>
            </div>
          </div>
        ) : (
          <ReactFlowProvider>
            <FlowCanvas sequence={sequence} campaignId={id!} />
          </ReactFlowProvider>
        )}

        {/* AI Chat panel — slides in from the right over the canvas */}
        {chatOpen && (
          <ChatSequenceBuilder
            campaignId={id!}
            sequenceId={sequence?.id ?? null}
            onClose={() => setChatOpen(false)}
            onApplied={() => {
              void queryClient.invalidateQueries({ queryKey: ['sequences', id] })
            }}
          />
        )}
      </div>
    )}

    {/* Dashboard, Leads + Settings — padded scrollable area */}
    {(tab === 'dashboard' || tab === 'leads' || tab === 'settings') && (
    <div className="px-8 pb-8 pt-6 overflow-auto">

      {/* ── Dashboard tab ──────────────────────────────────────────────── */}
      {tab === 'dashboard' && <>
      {/* Funnel chart */}
      {total > 0 && (
        <FunnelChart total={total} sent={sent} connected={connected} messaged={messaged} replied={replied} converted={converted} />
      )}

      {/* ICP & Engagement distribution */}
      {(() => {
        const icpCounts = { hot: 0, warm: 0, cold: 0, disqualified: 0, unscored: 0 }
        const engBuckets = { veryWarm: 0, warm: 0, neutral: 0, cooling: 0, cold: 0, unscored: 0 }
        let engTotal = 0, engSum = 0
        for (const cl of campaignLeads) {
          const flag = campaignProductId
            ? cl.lead.raw_data?.product_scores?.[campaignProductId]?.flag ?? cl.lead.icp_flag
            : cl.lead.icp_flag
          if (flag && flag in icpCounts) (icpCounts as Record<string, number>)[flag]++
          else icpCounts.unscored++
          if (cl.engagement_score != null) {
            engSum += cl.engagement_score; engTotal++
            if (cl.engagement_score >= 80) engBuckets.veryWarm++
            else if (cl.engagement_score >= 60) engBuckets.warm++
            else if (cl.engagement_score >= 40) engBuckets.neutral++
            else if (cl.engagement_score >= 20) engBuckets.cooling++
            else engBuckets.cold++
          } else engBuckets.unscored++
        }
        const avgEng = engTotal > 0 ? Math.round(engSum / engTotal) : null

        const icpSegs = [
          { key: 'hot',          label: '🔥 Hot',         color: '#EF4444', count: icpCounts.hot },
          { key: 'warm',         label: '☀️ Warm',        color: '#F97316', count: icpCounts.warm },
          { key: 'cold',         label: '❄️ Cold',        color: '#60A5FA', count: icpCounts.cold },
          { key: 'disqualified', label: 'Disqualified',   color: '#9CA3AF', count: icpCounts.disqualified },
          { key: 'unscored',     label: 'Not scored',     color: '#E5E7EB', count: icpCounts.unscored },
        ]
        const icpTotal = total || 1

        const engArcAngle = avgEng != null ? Math.round(avgEng * 1.8) : 0
        const engArcColor = avgEng == null ? '#E5E7EB' : avgEng >= 80 ? '#22C55E' : avgEng >= 60 ? '#84CC16' : avgEng >= 40 ? '#EAB308' : avgEng >= 20 ? '#F97316' : '#EF4444'

        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* ── ICP Score Distribution ── */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">ICP Score Distribution</h3>
                  <p className="text-xs text-gray-400 mt-0.5">{total} leads total</p>
                </div>
                {icpCounts.hot > 0 && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-600 border border-red-100">
                    {Math.round(icpCounts.hot / icpTotal * 100)}% hot
                  </span>
                )}
              </div>

              {total === 0 ? (
                <div className="h-3 rounded-full bg-gray-100 mb-5" />
              ) : (
                <div className="flex h-3 rounded-full overflow-hidden gap-px mb-5">
                  {icpSegs.filter(s => s.count > 0).map(seg => (
                    <div
                      key={seg.key}
                      title={`${seg.label}: ${seg.count}`}
                      style={{ width: `${(seg.count / icpTotal) * 100}%`, background: seg.color }}
                    />
                  ))}
                </div>
              )}

              <div className="space-y-3">
                {icpSegs.map(seg => (
                  <div key={seg.key} className="flex items-center gap-3">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: seg.color }} />
                    <span className="text-xs text-gray-600 flex-1">{seg.label}</span>
                    <span className="text-sm font-bold text-gray-900 tabular-nums w-7 text-right">{seg.count}</span>
                    <span className="text-[11px] text-gray-400 tabular-nums w-9 text-right">
                      {total > 0 ? `${Math.round(seg.count / icpTotal * 100)}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Engagement Warmth ── */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
              <div className="flex items-start justify-between mb-5">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Engagement Warmth</h3>
                  <p className="text-xs text-gray-400 mt-0.5">{engTotal} scored · {engBuckets.unscored} pending</p>
                </div>
              </div>

              {engTotal === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 gap-2">
                  <div className="w-16 h-16 rounded-full bg-gray-50 border-4 border-gray-100 flex items-center justify-center">
                    <span className="text-2xl font-bold text-gray-300">—</span>
                  </div>
                  <p className="text-xs text-gray-400 text-center mt-1">Scores update automatically<br/>as leads reply and engage.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-6 mb-5">
                    <div className="relative flex-shrink-0" style={{ width: 96, height: 52 }}>
                      <svg width="96" height="52" viewBox="0 0 96 52" fill="none">
                        <path d="M8 48 A40 40 0 0 1 88 48" stroke="#F3F4F6" strokeWidth="10" strokeLinecap="round" />
                        <path
                          d="M8 48 A40 40 0 0 1 88 48"
                          stroke={engArcColor}
                          strokeWidth="10"
                          strokeLinecap="round"
                          strokeDasharray={`${(engArcAngle / 180) * 125.6} 125.6`}
                        />
                      </svg>
                      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
                        <span className="text-xl font-extrabold leading-none" style={{ color: engArcColor }}>{avgEng}</span>
                        <span className="text-[10px] text-gray-400 leading-none mt-0.5">avg warmth</span>
                      </div>
                    </div>

                    <div className="flex-1 space-y-1.5">
                      {[
                        { label: '🔥 Very warm', range: '80–100', count: engBuckets.veryWarm, color: '#22C55E' },
                        { label: 'Warm',          range: '60–79',  count: engBuckets.warm,     color: '#84CC16' },
                        { label: 'Neutral',       range: '40–59',  count: engBuckets.neutral,  color: '#EAB308' },
                        { label: 'Cooling',       range: '20–39',  count: engBuckets.cooling,  color: '#F97316' },
                        { label: '❄️ Cold',       range: '0–19',   count: engBuckets.cold,     color: '#EF4444' },
                      ].map(b => (
                        <div key={b.label} className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.color }} />
                          <span className="text-xs text-gray-500 flex-1">{b.label} <span className="text-gray-300">{b.range}</span></span>
                          <span className="text-xs font-semibold text-gray-800 tabular-nums">{b.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex h-2.5 rounded-full overflow-hidden gap-px">
                    {[
                      { count: engBuckets.veryWarm, color: '#22C55E' },
                      { count: engBuckets.warm,     color: '#84CC16' },
                      { count: engBuckets.neutral,  color: '#EAB308' },
                      { count: engBuckets.cooling,  color: '#F97316' },
                      { count: engBuckets.cold,     color: '#EF4444' },
                      { count: engBuckets.unscored, color: '#E5E7EB' },
                    ].filter(b => b.count > 0).map((b, i) => (
                      <div key={i} style={{ width: `${(b.count / total) * 100}%`, background: b.color }} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Activity Feed ── */}
      <ActivityFeed entries={activityLog} />
      </>}

      {/* ── Leads tab ──────────────────────────────────────────────────── */}
      {tab === 'leads' && <>
      {/* Leads table */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">Leads <span className="text-gray-400 font-normal">({total})</span></h2>
          <div className="flex items-center gap-2 flex-1 min-w-[180px] max-w-sm">
            <input
              type="text"
              placeholder="Search leads…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {campaignLeads.length > 0 && (
              <button
                onClick={() => {
                  if (scoreEngStatus === 'running') { scoreEngCancelRef.current = true }
                  else { void handleScoreEngagement() }
                }}
                disabled={scoreEngStatus === 'done' || scoreEngStatus === 'error'}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors shrink-0 ${
                  scoreEngStatus === 'running' ? 'border-violet-300 text-violet-700 bg-violet-100 hover:bg-violet-200' :
                  scoreEngStatus === 'done' ? 'border-green-200 text-green-700 bg-green-50' :
                  scoreEngStatus === 'error' ? 'border-red-200 text-red-700 bg-red-50' :
                  'border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100'
                }`}
              >
                {scoreEngStatus === 'running' ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z"/>
                    </svg>
                    {scoreEngProgress}% · click to stop
                  </span>
                ) : scoreEngStatus === 'done' ? '✓ Done' :
                  scoreEngStatus === 'error' ? '✕ Error' :
                  '⚡ Score Engagement'}
              </button>
            )}
            {campaignLeads.length > 0 && (
              <button
                onClick={() => {
                  const headers = ['First Name','Last Name','Title','Company','LinkedIn URL','ICP Flag','ICP Score','Engagement Score','Engagement Trend','Status','Reply']
                  const rows = campaignLeads.map(cl => [
                    cl.lead.first_name, cl.lead.last_name,
                    cl.lead.title ?? '', cl.lead.company ?? '',
                    cl.lead.linkedin_url ?? '', cl.lead.icp_flag ?? '',
                    cl.lead.icp_score ?? '', cl.engagement_score ?? '',
                    cl.engagement_trend ?? '',
                    cl.status,
                    cl.reply_classification !== 'none' ? cl.reply_classification : '',
                  ])
                  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
                  const blob = new Blob([csv], { type: 'text/csv' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url; a.download = `${campaign.name.replace(/[^a-z0-9]/gi,'-')}-leads.csv`
                  a.click(); URL.revokeObjectURL(url)
                }}
                className="px-3 py-1.5 border border-gray-200 text-gray-600 text-sm rounded-lg hover:bg-gray-50 flex items-center gap-1.5 transition-colors shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export CSV
              </button>
            )}
            <button
              onClick={() => setShowAddLeads(true)}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shrink-0"
            >
              + Add Leads
            </button>
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="mx-5 mb-3 flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
            <span className="text-sm font-medium text-blue-800">{selectedIds.size} lead{selectedIds.size !== 1 ? 's' : ''} selected</span>
            <button
              onClick={() => {
                if (confirm(`Remove ${selectedIds.size} lead${selectedIds.size !== 1 ? 's' : ''} from this campaign?`)) {
                  const clIds = campaignLeads.filter(cl => selectedIds.has(cl.id)).map(cl => cl.id)
                  removeMutation.mutate(clIds)
                }
              }}
              disabled={removeMutation.isPending}
              className="px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 text-sm font-medium rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50"
            >
              {removeMutation.isPending ? 'Removing…' : '✕ Remove'}
            </button>
            <button
              onClick={() => {
                if (scoreEngStatus === 'running') { scoreEngCancelRef.current = true }
                else { void handleScoreEngagement([...selectedIds]) }
              }}
              disabled={scoreEngStatus === 'done' || scoreEngStatus === 'error'}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                scoreEngStatus === 'running' ? 'border-violet-300 text-violet-700 bg-violet-100 hover:bg-violet-200' :
                scoreEngStatus === 'done' ? 'border-green-200 text-green-700 bg-green-50' :
                scoreEngStatus === 'error' ? 'border-red-200 text-red-700 bg-red-50' :
                'border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100'
              }`}
            >
              {scoreEngStatus === 'running' ? (
                <span className="flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z"/>
                  </svg>
                  {scoreEngProgress}% · click to stop
                </span>
              ) : scoreEngStatus === 'done' ? '✓ Done' :
                scoreEngStatus === 'error' ? '✕ Error' :
                `⚡ Score Engagement (${selectedIds.size})`}
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="ml-auto text-sm text-blue-500 hover:text-blue-700">
              Clear selection
            </button>
          </div>
        )}

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
                  <th className="px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={sorted.length > 0 && selectedIds.size === sorted.length}
                      onChange={e => setSelectedIds(e.target.checked ? new Set(sorted.map(cl => cl.id)) : new Set())}
                      className="rounded border-gray-300 text-blue-600"
                    />
                  </th>
                  <th className="px-3 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('name')}>Lead{sortIndicator('name')}</th>
                  <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('company')}>Company{sortIndicator('company')}</th>
                  <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('icp')}>ICP{sortIndicator('icp')}</th>
                  <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('engagement')}>Warmth{sortIndicator('engagement')}</th>
                  <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('status')}>Status{sortIndicator('status')}</th>
                  <th className="px-4 py-3 text-left font-medium cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('reply')}>Reply{sortIndicator('reply')}</th>
                  <th className="px-4 py-3 text-left font-medium">Next Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {sorted.map((cl: CampaignLead) => (
                  <tr key={cl.id} className={`hover:bg-gray-50 transition-colors ${selectedIds.has(cl.id) ? 'bg-blue-50' : ''}`}>
                    <td className="px-4 py-3.5 w-8">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(cl.id)}
                        onChange={e => {
                          const next = new Set(selectedIds)
                          if (e.target.checked) next.add(cl.id)
                          else next.delete(cl.id)
                          setSelectedIds(next)
                        }}
                        className="rounded border-gray-300 text-blue-600"
                      />
                    </td>
                    <td className="px-3 py-3.5">
                      <div>
                        <p className="font-medium text-gray-900">{cl.lead.first_name} {cl.lead.last_name}</p>
                        {cl.lead.title && <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[180px]">{cl.lead.title}</p>}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-gray-600 text-xs">{cl.lead.company ?? '—'}</td>
                    <td className="px-4 py-3.5">
                      {(() => {
                        const productScore = campaignProductId
                          ? cl.lead.raw_data?.product_scores?.[campaignProductId]
                          : null
                        const flag = productScore?.flag ?? cl.lead.icp_flag
                        const score = productScore?.score ?? cl.lead.icp_score
                        if (!flag) return <span className="text-xs text-gray-300">—</span>
                        return (
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${ICP_BADGE[flag] ?? 'bg-gray-100 text-gray-500'}`}>
                            {ICP_LABELS[flag] ?? flag}
                            {score != null && <span className="opacity-70">· {score}</span>}
                          </span>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1.5">
                        {cl.engagement_score != null ? (
                          <span
                            title={cl.engagement_reasoning ?? undefined}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold tabular-nums ${
                              cl.engagement_score >= 80 ? 'bg-green-100 text-green-700' :
                              cl.engagement_score >= 60 ? 'bg-lime-100 text-lime-700' :
                              cl.engagement_score >= 40 ? 'bg-yellow-100 text-yellow-700' :
                              cl.engagement_score >= 20 ? 'bg-orange-100 text-orange-700' :
                              'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {cl.engagement_trend === 'up' && <span className="text-green-600">↑</span>}
                            {cl.engagement_trend === 'down' && <span className="text-red-500">↓</span>}
                            {cl.engagement_score}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                        <button
                          onClick={() => {
                            if (scoreEngStatus === 'running') { scoreEngCancelRef.current = true }
                            else { void handleScoreEngagement([cl.id]) }
                          }}
                          disabled={scoreEngStatus === 'done' || scoreEngStatus === 'error'}
                          title={scoreEngStatus === 'running' ? 'Click to stop' : 'Re-score engagement'}
                          className={`transition-colors disabled:opacity-30 text-xs ${scoreEngStatus === 'running' ? 'text-violet-500 animate-pulse' : 'text-gray-300 hover:text-violet-500'}`}
                        >
                          ⚡
                        </button>
                      </div>
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
                    <td className="px-4 py-3.5">
                      <NextActionCell cl={cl} steps={sequences[0]?.sequence_steps ?? []} />
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
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
              <h2 className="text-lg font-semibold text-gray-900">Add Leads to Campaign</h2>
              <button onClick={() => { setShowAddLeads(false); setSelectedListToAdd('') }} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              <p className="text-sm text-gray-500 mb-3">Select a lead list to add all its leads to this campaign at once.</p>
              <div className="space-y-2">
                {leadLists.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-4">No lead lists found. Create one first.</p>
                ) : (
                  leadLists.map(list => (
                    <label
                      key={list.id}
                      className={`flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-colors ${selectedListToAdd === list.id ? 'border-blue-500 bg-blue-50' : 'border-gray-100 hover:border-gray-200'}`}
                    >
                      <input
                        type="radio"
                        name="lead-list"
                        value={list.id}
                        checked={selectedListToAdd === list.id}
                        onChange={() => setSelectedListToAdd(list.id)}
                        className="text-blue-600"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-900">{list.name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{list.lead_count ?? 0} leads</p>
                      </div>
                      {selectedListToAdd === list.id && selectedListLeads.length > 0 && (
                        <span className="text-xs text-blue-600 font-medium">
                          {selectedListLeads.filter(l => !existingLeadIds.has(l.id)).length} new leads
                        </span>
                      )}
                    </label>
                  ))
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 shrink-0">
              <button
                onClick={() => { setShowAddLeads(false); setSelectedListToAdd('') }}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                disabled={!selectedListToAdd || listLeadsFetching || addMutation.isPending}
                onClick={() => {
                  const newLeadIds = selectedListLeads.filter(l => !existingLeadIds.has(l.id)).map(l => l.id)
                  if (newLeadIds.length > 0) addMutation.mutate(newLeadIds)
                }}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60"
              >
                {listLeadsFetching ? 'Loading…' : addMutation.isPending ? 'Adding…' : selectedListToAdd && selectedListLeads.length > 0
                  ? `Add ${selectedListLeads.filter(l => !existingLeadIds.has(l.id)).length} Leads`
                  : 'Add Leads'}
              </button>
            </div>
          </div>
        </div>
      )}
      </>}

      {tab === 'settings' && (
        <CampaignSettings
          campaign={campaign}
          accounts={accounts}
          onSave={updates => { setSettingsSaveError(null); scheduleMutation.mutate(updates) }}
          saving={scheduleMutation.isPending}
          saveError={settingsSaveError}
        />
      )}
    </div>
    )}
    </div>
  )
}

// ── Campaign Settings helpers ─────────────────────────────────────────────────

const SUGGESTED_LOCATIONS = [
  // ── Regions ──
  'EMEA', 'APAC', 'AMER', 'LATAM', 'DACH',
  'North America', 'Latin America', 'Western Europe', 'Northern Europe',
  'Southern Europe', 'Eastern Europe', 'Asia Pacific', 'Southeast Asia',
  'Middle East', 'North Africa', 'Sub-Saharan Africa', 'Nordics',
  // ── Countries ──
  'Afghanistan', 'Albania', 'Algeria', 'Angola', 'Argentina', 'Armenia',
  'Australia', 'Austria', 'Azerbaijan', 'Bahrain', 'Bangladesh', 'Belarus',
  'Belgium', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil',
  'Bulgaria', 'Cambodia', 'Cameroon', 'Canada', 'Chile', 'China', 'Colombia',
  'Costa Rica', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark',
  'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Estonia',
  'Ethiopia', 'Finland', 'France', 'Georgia', 'Germany', 'Ghana', 'Greece',
  'Guatemala', 'Honduras', 'Hong Kong', 'Hungary', 'Iceland', 'India',
  'Indonesia', 'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Japan',
  'Jordan', 'Kazakhstan', 'Kenya', 'Kuwait', 'Latvia', 'Lebanon', 'Lithuania',
  'Luxembourg', 'Malaysia', 'Malta', 'Mexico', 'Moldova', 'Morocco',
  'Mozambique', 'Myanmar', 'Netherlands', 'New Zealand', 'Nigeria', 'Norway',
  'Oman', 'Pakistan', 'Panama', 'Paraguay', 'Peru', 'Philippines', 'Poland',
  'Portugal', 'Qatar', 'Romania', 'Russia', 'Saudi Arabia', 'Senegal',
  'Serbia', 'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'South Korea',
  'Spain', 'Sri Lanka', 'Sweden', 'Switzerland', 'Taiwan', 'Tanzania',
  'Thailand', 'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Venezuela',
  'Vietnam', 'Zambia', 'Zimbabwe',
]

function TagInput({
  label, values, suggestions, onChange, placeholder,
}: {
  label: string
  values: string[]
  suggestions: string[]
  onChange: (vals: string[]) => void
  placeholder: string
}) {
  const [input, setInput] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)

  const filtered = suggestions
    .filter(s => !values.includes(s) && s.toLowerCase().includes(input.toLowerCase()))
    .slice(0, 8)

  function add(val: string) {
    const trimmed = val.trim()
    if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed])
    setInput('')
    setShowSuggestions(false)
  }

  function remove(val: string) {
    onChange(values.filter(v => v !== val))
  }

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      <div className="min-h-[44px] flex flex-wrap gap-1.5 px-3 py-2 border border-gray-300 rounded-xl bg-white focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500">
        {values.map(v => (
          <span key={v} className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 bg-blue-100 text-blue-800 rounded-full">
            {v}
            <button type="button" onClick={() => remove(v)} className="text-blue-500 hover:text-blue-800 leading-none">×</button>
          </span>
        ))}
        <div className="relative flex-1 min-w-[120px]">
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setShowSuggestions(true) }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            onKeyDown={e => {
              if (e.key === 'Enter' && input.trim()) { e.preventDefault(); add(input) }
              if (e.key === 'Backspace' && !input && values.length > 0) remove(values[values.length - 1])
            }}
            placeholder={values.length === 0 ? placeholder : ''}
            className="w-full text-sm text-gray-700 outline-none bg-transparent py-0.5"
          />
          {showSuggestions && filtered.length > 0 && (
            <div className="absolute left-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 min-w-[200px]">
              {filtered.map(s => (
                <button
                  key={s}
                  type="button"
                  onMouseDown={() => add(s)}
                  className="block w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-gray-400">Type and press Enter, or pick from suggestions</p>
    </div>
  )
}

// ── Message Approach & Tone data ──────────────────────────────────────────────

type Approach =
  | 'direct' | 'trigger_based' | 'insight_challenger' | 'problem_solution'
  | 'social_proof' | 'question_hook' | 'before_after_bridge' | 'mutual_ground'
  | 'pattern_interrupt' | 'value_first'

const APPROACHES: { value: Approach; label: string; description: string; icon: string }[] = [
  { value: 'direct',             label: 'Direct / No Fluff',       icon: '⚡', description: 'Straight to the value prop. Works great with busy executives.' },
  { value: 'trigger_based',      label: 'Trigger-Based',           icon: '🎯', description: 'References a specific event — funding, role change, post they made.' },
  { value: 'insight_challenger', label: 'Insight / Challenger',    icon: '💡', description: 'Opens with a counter-intuitive industry insight. Positions you as a peer.' },
  { value: 'problem_solution',   label: 'Problem → Solution',      icon: '🔧', description: 'Names the exact pain point, then connects it to your solution.' },
  { value: 'social_proof',       label: 'Social Proof',            icon: '🏆', description: 'Leads with a specific result from a similar company.' },
  { value: 'question_hook',      label: 'Question Hook',           icon: '❓', description: 'One sharp question they can\'t help but answer.' },
  { value: 'before_after_bridge',label: 'Before / After / Bridge', icon: '🌉', description: 'Current state → desired state → you\'re the bridge.' },
  { value: 'mutual_ground',      label: 'Mutual Ground',           icon: '🤝', description: 'References something genuinely shared — mutual connection, community.' },
  { value: 'pattern_interrupt',  label: 'Pattern Interrupt',       icon: '🔀', description: 'Breaks the mould of typical cold messages. Unexpected and memorable.' },
  { value: 'value_first',        label: 'Value-First',             icon: '🎁', description: 'Leads with a genuinely useful insight. Give before you ask.' },
]

const TONE_OPTIONS = [
  { value: 'professional', label: 'Professional', description: 'Formal, polished, business-appropriate tone' },
  { value: 'conversational', label: 'Conversational', description: 'Natural, peer-to-peer, like a warm intro' },
  { value: 'casual', label: 'Casual / Friendly', description: 'Light, approachable, low-pressure feel' },
  { value: 'bold', label: 'Bold / Confident', description: 'Assertive, direct, high-conviction language' },
]

// ── Custom Criteria helpers ───────────────────────────────────────────────────

interface CustomCriterion {
  id: string
  label: string
  description: string
  weight: 'must_have' | 'nice_to_have' | 'disqualifier'
}

const WEIGHT_OPTIONS: { value: CustomCriterion['weight']; label: string; color: string }[] = [
  { value: 'must_have',    label: 'Must Have',    color: 'bg-green-100 text-green-800 border-green-200' },
  { value: 'nice_to_have', label: 'Nice to Have', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'disqualifier', label: 'Disqualifier', color: 'bg-red-100 text-red-800 border-red-200' },
]


export function CriterionRow({
  criterion,
  onChange,
  onRemove,
}: {
  criterion: CustomCriterion
  onChange: (c: CustomCriterion) => void
  onRemove: () => void
}) {
  const weightInfo = WEIGHT_OPTIONS.find(w => w.value === criterion.weight)!

  return (
    <div className="rounded-xl border border-amber-200 bg-white p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <input
            type="text"
            value={criterion.label}
            onChange={e => onChange({ ...criterion, label: e.target.value })}
            placeholder="Criterion name (e.g. Uses Salesforce, Has raised Series A+)"
            className="w-full text-sm font-semibold text-gray-900 bg-transparent border-b border-gray-300 focus:border-blue-500 outline-none pb-0.5 placeholder:font-normal placeholder:text-gray-400"
          />
          <textarea
            rows={2}
            value={criterion.description}
            onChange={e => onChange({ ...criterion, description: e.target.value })}
            placeholder="Explain what to look for — the AI will use this to evaluate the lead"
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-gray-400 hover:text-red-500 transition-colors mt-0.5 shrink-0"
          title="Remove"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 mr-1">Weight:</span>
        {WEIGHT_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange({ ...criterion, weight: opt.value })}
            className={`px-3 py-1 text-xs font-medium rounded-full border transition-all ${
              criterion.weight === opt.value
                ? opt.color + ' ring-2 ring-offset-1 ' + (
                    opt.value === 'must_have' ? 'ring-green-400' :
                    opt.value === 'nice_to_have' ? 'ring-blue-400' : 'ring-red-400'
                  )
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <span className={`ml-auto text-xs px-2 py-0.5 rounded-full border font-medium ${weightInfo.color}`}>
          {weightInfo.label}
        </span>
      </div>
    </div>
  )
}

// ── Collapsible section wrapper ───────────────────────────────────────────────

function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = false,
  accentColor = 'border-l-gray-300',
  children,
  headerExtra,
}: {
  title: string
  subtitle?: string
  defaultOpen?: boolean
  accentColor?: string
  children: React.ReactNode
  headerExtra?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`bg-white rounded-xl border border-gray-100 border-l-4 ${accentColor} overflow-hidden shadow-sm`}>
      <button
        type="button"
        className="w-full px-5 py-4 flex items-center justify-between gap-3 text-sm font-semibold text-gray-900 hover:bg-gray-50 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex-1 min-w-0">
          <span>{title}</span>
          {subtitle && <span className="block text-xs font-normal text-gray-400 mt-0.5">{subtitle}</span>}
        </div>
        {headerExtra && (
          <div onClick={e => e.stopPropagation()} className="shrink-0">
            {headerExtra}
          </div>
        )}
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="px-5 pb-6 pt-1 border-t border-gray-100 space-y-5">
          {children}
        </div>
      )}
    </div>
  )
}

// ── Campaign Settings ─────────────────────────────────────────────────────────

interface GlobalProduct {
  id: string
  name: string
  description: string
  target_use_case: string
  target_titles: string[]
  target_industries: string[]
  target_locations: string[]
  min_company_size: number | null
  max_company_size: number | null
  custom_criteria: Array<{ id: string; label: string; description: string; weight: 'must_have' | 'nice_to_have' | 'disqualifier' }>
}

function CampaignSettings({
  campaign,
  accounts,
  onSave,
  saving,
  saveError,
}: {
  campaign: Campaign
  accounts: import('../api/accounts').LinkedInAccount[]
  onSave: (updates: Partial<Campaign>) => void
  saving: boolean
  saveError?: string | null
}) {
  const icp = (campaign.icp_config ?? {}) as {
    selected_product_ids?: string[]
    title_override?: string[]
    industry_override?: string[]
    location_override?: string[]
    min_size_override?: number | null
    max_size_override?: number | null
    notes?: string
    message_approach?: Approach | null
    message_tone?: string | null
  }

  const [accountId, setAccountId] = useState(campaign.account_id ?? '')
  // Decode the stored lead_priority into two independent boolean toggles
  const storedPriority = (campaign as unknown as Record<string, unknown>).lead_priority as string | null ?? null
  const [priorityHighIcp,  setPriorityHighIcp]  = useState(storedPriority === 'high_icp' || storedPriority === 'high_icp+warm')
  const [priorityWarmLeads, setPriorityWarmLeads] = useState(storedPriority === 'warm'    || storedPriority === 'high_icp+warm')
  /** Encode the two toggles back to a stored value */
  function encodePriority(highIcp: boolean, warm: boolean): string | null {
    if (highIcp && warm) return 'high_icp+warm'
    if (highIcp) return 'high_icp'
    if (warm)    return 'warm'
    return null
  }
  const [connLimit, setConnLimit] = useState(campaign.daily_connection_limit)
  const [msgLimit, setMsgLimit] = useState(campaign.daily_message_limit)
  const [scheduleDays, setScheduleDays] = useState<number[]>(campaign.schedule_days ?? [1,2,3,4,5])
  const [scheduleStart, setScheduleStart] = useState(campaign.schedule_start_hour ?? 9)
  const [scheduleEnd, setScheduleEnd] = useState(campaign.schedule_end_hour ?? 17)
  const [scheduleTz, setScheduleTz] = useState(campaign.schedule_timezone ?? 'UTC')
  const toArr = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    if (typeof v === 'string' && v.trim()) return v.split(',').map(s => s.trim()).filter(Boolean)
    return []
  }
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(icp.selected_product_ids ?? [])
  const [titleOverride, setTitleOverride] = useState<string[]>(toArr(icp.title_override))
  const [industryOverride, setIndustryOverride] = useState<string[]>(toArr(icp.industry_override))
  const [locationOverride, setLocationOverride] = useState<string[]>(toArr(icp.location_override))
  const [minSizeOverride, setMinSizeOverride] = useState<string>(icp.min_size_override != null ? String(icp.min_size_override) : '')
  const [maxSizeOverride, setMaxSizeOverride] = useState<string>(icp.max_size_override != null ? String(icp.max_size_override) : '')
  const [notes, setNotes] = useState(icp.notes ?? '')
  const [messageApproach, setMessageApproach] = useState<Approach | null>(icp.message_approach ?? null)
  const [messageTone, setMessageTone] = useState<string | null>(icp.message_tone ?? null)

  const { data: globalSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings')
      const { data } = await res.json() as { data: { icp_config?: { products_services?: GlobalProduct[] } } }
      return data
    },
  })
  const globalProducts: GlobalProduct[] = (globalSettings?.icp_config?.products_services ?? []) as GlobalProduct[]

  function toggleProduct(id: string) {
    setSelectedProductIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const isDirty =
    accountId !== (campaign.account_id ?? '') ||
    encodePriority(priorityHighIcp, priorityWarmLeads) !== (storedPriority ?? null) ||
    connLimit !== campaign.daily_connection_limit ||
    msgLimit !== campaign.daily_message_limit ||
    JSON.stringify(selectedProductIds) !== JSON.stringify(icp.selected_product_ids ?? []) ||
    JSON.stringify(titleOverride) !== JSON.stringify(toArr(icp.title_override)) ||
    JSON.stringify(industryOverride) !== JSON.stringify(toArr(icp.industry_override)) ||
    JSON.stringify(locationOverride) !== JSON.stringify(toArr(icp.location_override)) ||
    minSizeOverride !== (icp.min_size_override != null ? String(icp.min_size_override) : '') ||
    maxSizeOverride !== (icp.max_size_override != null ? String(icp.max_size_override) : '') ||
    notes !== (icp.notes ?? '') ||
    messageApproach !== (icp.message_approach ?? null) ||
    messageTone !== (icp.message_tone ?? null) ||
    JSON.stringify(scheduleDays) !== JSON.stringify(campaign.schedule_days ?? [1,2,3,4,5]) ||
    scheduleStart !== (campaign.schedule_start_hour ?? 9) ||
    scheduleEnd !== (campaign.schedule_end_hour ?? 17) ||
    scheduleTz !== (campaign.schedule_timezone ?? 'UTC')

  function handleSave() {
    onSave({
      account_id: accountId || null,
      lead_priority: encodePriority(priorityHighIcp, priorityWarmLeads) as Campaign['lead_priority'],
      daily_connection_limit: connLimit,
      daily_message_limit: msgLimit,
      schedule_days: scheduleDays,
      schedule_start_hour: scheduleStart,
      schedule_end_hour: scheduleEnd,
      schedule_timezone: scheduleTz,
      icp_config: {
        ...(campaign.icp_config ?? {}),
        selected_product_ids: selectedProductIds,
        title_override: titleOverride,
        industry_override: industryOverride,
        location_override: locationOverride,
        min_size_override: minSizeOverride !== '' ? Number(minSizeOverride) : null,
        max_size_override: maxSizeOverride !== '' ? Number(maxSizeOverride) : null,
        notes,
        message_approach: messageApproach,
        message_tone: messageTone,
      },
    })
  }

  // ── Header summaries (shown collapsed) ──────────────────────────────────────
  const configSummary = (() => {
    const accountLabel = accountId
      ? (accounts.find(a => a.id === accountId)?.linkedin_email ?? 'Selected account')
      : 'Auto-select'
    const limits = `${connLimit} conn · ${msgLimit} msg/day`
    return [accountLabel, limits].filter(Boolean).join(' · ')
  })()

  const productsSummary = (() => {
    if (selectedProductIds.length === 0) return 'None selected'
    const names = globalProducts
      .filter(p => selectedProductIds.includes(p.id))
      .map(p => p.name || 'Unnamed')
    return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`
  })()

  const audienceOverrideSummary = (() => {
    const parts: string[] = []
    if (titleOverride.length > 0) parts.push(`${titleOverride.length} title${titleOverride.length > 1 ? 's' : ''}`)
    if (industryOverride.length > 0) parts.push(`${industryOverride.length} industr${industryOverride.length > 1 ? 'ies' : 'y'}`)
    if (locationOverride.length > 0) parts.push(`${locationOverride.length} location${locationOverride.length > 1 ? 's' : ''}`)
    if (minSizeOverride || maxSizeOverride) parts.push('company size')
    return parts.length > 0 ? `Overriding: ${parts.join(', ')}` : 'Inherited from product (no overrides)'
  })()

  const approachSummary = (() => {
    const a = messageApproach ? APPROACHES.find(x => x.value === messageApproach) : null
    const t = messageTone ? TONE_OPTIONS.find(x => x.value === messageTone) : null
    const parts = [
      a ? `${a.icon} ${a.label}` : null,
      t ? t.label : null,
    ].filter(Boolean)
    return parts.length > 0 ? parts.join(' · ') : 'Not configured'
  })()

  const notesSummary = notes.trim()
    ? (notes.length > 70 ? notes.slice(0, 70).trimEnd() + '…' : notes)
    : 'No notes added'

  const scheduleSummary = [
    DAY_NAMES.filter((_, i) => scheduleDays.includes(i)).join(', ') || 'No days selected',
    `${formatHour(scheduleStart)}–${formatHour(scheduleEnd)}`,
    scheduleTz,
  ].join(' · ')

  return (
    <div className="space-y-3">

      {/* ── Panel 1: Products & Services ── */}
      <CollapsibleSection
        title="Products & Services"
        subtitle={productsSummary}
        accentColor="border-l-purple-400"
      >
        {globalProducts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-purple-200 py-8 text-center">
            <p className="text-sm text-gray-400">No products defined yet</p>
            <p className="text-xs text-gray-400 mt-0.5">Go to <span className="font-medium">Settings → Products & Services</span> to add your products first</p>
          </div>
        ) : (
          <div className="space-y-2">
            {globalProducts.map(p => (
              <label
                key={p.id}
                className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                  selectedProductIds.includes(p.id)
                    ? 'border-purple-400 bg-purple-50'
                    : 'border-gray-100 hover:border-purple-200'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedProductIds.includes(p.id)}
                  onChange={() => toggleProduct(p.id)}
                  className="mt-0.5 rounded border-gray-300 text-purple-600"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{p.name || 'Unnamed product'}</p>
                  {p.target_use_case && <p className="text-xs text-gray-500 mt-0.5 truncate">{p.target_use_case}</p>}
                  {p.target_titles?.length > 0 && (
                    <p className="text-xs text-purple-500 mt-0.5 truncate">
                      → {p.target_titles.slice(0, 3).join(', ')}{p.target_titles.length > 3 ? ` +${p.target_titles.length - 3}` : ''}
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* ── Panel 2: Target Audience Override ── */}
      <CollapsibleSection
        title="Target Audience Override"
        subtitle={audienceOverrideSummary}
        accentColor="border-l-blue-400"
      >
        <p className="text-xs text-gray-500 mb-4">
          By default, leads are qualified using each product's own audience settings. Use these fields to narrow or adjust the targeting for this campaign specifically. Leave blank to inherit from the product.
        </p>
        <div className="space-y-4">
          <TagInput
            label="Job Titles (optional)"
            values={titleOverride}
            suggestions={['CEO', 'Founder', 'CTO', 'VP of Sales', 'Head of Marketing', 'Director of Operations', 'CMO', 'COO', 'Sales Manager', 'Marketing Manager']}
            onChange={setTitleOverride}
            placeholder="e.g. CEO, VP of Sales…"
          />
          <TagInput
            label="Industries (optional)"
            values={industryOverride}
            suggestions={['SaaS', 'FinTech', 'HealthTech', 'E-commerce', 'Consulting', 'Manufacturing', 'Real Estate', 'EdTech', 'Legal', 'Recruitment']}
            onChange={setIndustryOverride}
            placeholder="e.g. SaaS, FinTech…"
          />
          <TagInput
            label="Locations (optional)"
            values={locationOverride}
            suggestions={SUGGESTED_LOCATIONS}
            onChange={setLocationOverride}
            placeholder="e.g. EMEA, United Kingdom, Germany…"
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Min Company Size <span className="text-gray-400">(optional)</span></label>
              <input
                type="number"
                min={1}
                value={minSizeOverride}
                onChange={e => setMinSizeOverride(e.target.value)}
                placeholder="e.g. 10"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Max Company Size <span className="text-gray-400">(optional)</span></label>
              <input
                type="number"
                min={1}
                value={maxSizeOverride}
                onChange={e => setMaxSizeOverride(e.target.value)}
                placeholder="e.g. 500"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Panel 3: Message Approach & Tone ── */}
      <CollapsibleSection
        title="Message Approach & Tone"
        subtitle={approachSummary}
        accentColor="border-l-indigo-400"
      >
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2.5">Approach <span className="text-gray-400 font-normal">(optional)</span></label>
          <div className="grid grid-cols-2 gap-2">
            {APPROACHES.map(a => (
              <button
                key={a.value}
                type="button"
                onClick={() => setMessageApproach(messageApproach === a.value ? null : a.value)}
                className={[
                  'text-left px-3 py-2.5 rounded-lg border text-xs transition-all',
                  messageApproach === a.value
                    ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200'
                    : 'border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50',
                ].join(' ')}
              >
                <div className="font-semibold text-gray-800 flex items-center gap-1.5 mb-0.5">
                  <span>{a.icon}</span>
                  {a.label}
                </div>
                <div className="text-gray-500 leading-snug">{a.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Tone <span className="text-gray-400 font-normal">(optional)</span></label>
          <div className="grid grid-cols-2 gap-2">
            {TONE_OPTIONS.map(t => (
              <button
                key={t.value}
                type="button"
                onClick={() => setMessageTone(messageTone === t.value ? null : t.value)}
                className={[
                  'text-left px-3 py-2.5 rounded-lg border text-xs transition-all',
                  messageTone === t.value
                    ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200'
                    : 'border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50',
                ].join(' ')}
              >
                <div className="font-semibold text-gray-800 mb-0.5">{t.label}</div>
                <div className="text-gray-500 leading-snug">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Panel 4: Additional AI Notes ── */}
      <CollapsibleSection
        title="Additional Notes for AI"
        subtitle={notesSummary}
        accentColor="border-l-green-400"
      >
        <textarea
          rows={4}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="e.g. Prioritise bootstrapped companies over VC-funded ones. Deprioritise anyone in an agency role."
          className="w-full px-3.5 py-2.5 border border-green-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
        />
      </CollapsibleSection>

      {/* ── Panel 5: Campaign Configuration ── */}
      <CollapsibleSection
        title="Campaign Configuration"
        subtitle={configSummary}
        accentColor="border-l-rose-400"
      >
        {/* LinkedIn Account */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">LinkedIn Account</label>
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

        {/* Sequence Priority */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Sequence Priority</label>
          <p className="text-xs text-gray-400 mb-2">Determines the order leads are worked through the sequence. Toggles can be combined.</p>
          <div className="flex flex-col gap-3 max-w-sm">
            {([
              {
                key:   'highIcp' as const,
                label: 'Prioritise high ICP score',
                desc:  'Best-fit leads (highest qualification score) go first',
                value:  priorityHighIcp,
                toggle: (v: boolean) => setPriorityHighIcp(v),
              },
              {
                key:   'warm' as const,
                label: 'Prioritise warm leads',
                desc:  'Hot / warm-flagged leads go before cold ones',
                value:  priorityWarmLeads,
                toggle: (v: boolean) => setPriorityWarmLeads(v),
              },
            ]).map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => opt.toggle(!opt.value)}
                className={[
                  'flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-sm text-left transition-all',
                  opt.value
                    ? 'border-rose-400 bg-rose-50'
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
                ].join(' ')}
              >
                {/* Toggle pill */}
                <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${opt.value ? 'bg-rose-500' : 'bg-gray-200'}`}>
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${opt.value ? 'translate-x-4' : 'translate-x-1'}`} />
                </span>
                <div>
                  <p className="font-semibold text-gray-800">{opt.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>


        {/* Daily limits */}
        <div className="grid grid-cols-2 gap-6 max-w-sm">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Connection Limit</label>
            <p className="text-xs text-gray-400 mb-2">Per day, per account</p>
            <input type="number" min={1} max={25} value={connLimit} onChange={e => setConnLimit(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <p className="text-[10px] text-gray-400 mt-1">Max 25/day (LinkedIn limit)</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message Limit</label>
            <p className="text-xs text-gray-400 mb-2">Per day, per account</p>
            <input type="number" min={1} max={100} value={msgLimit} onChange={e => setMsgLimit(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <p className="text-[10px] text-gray-400 mt-1">Max 100/day (LinkedIn limit)</p>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Panel 6: Schedule ── */}
      <CollapsibleSection
        title="Schedule"
        subtitle={scheduleSummary}
        accentColor="border-l-teal-400"
      >
        <ScheduleEditor
          days={scheduleDays}
          startHour={scheduleStart}
          endHour={scheduleEnd}
          timezone={scheduleTz}
          onDaysChange={setScheduleDays}
          onStartHourChange={setScheduleStart}
          onEndHourChange={setScheduleEnd}
          onTimezoneChange={setScheduleTz}
        />
      </CollapsibleSection>

      {/* ── Save ── */}
      <div className="flex flex-col items-end gap-2 pt-1">
        {saveError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 max-w-sm text-right">
            Save failed: {saveError}
          </p>
        )}
        <button
          onClick={handleSave}
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
  days, startHour, endHour, timezone,
  onDaysChange, onStartHourChange, onEndHourChange, onTimezoneChange,
}: {
  days: number[]
  startHour: number
  endHour: number
  timezone: string
  onDaysChange: (days: number[]) => void
  onStartHourChange: (h: number) => void
  onEndHourChange: (h: number) => void
  onTimezoneChange: (tz: string) => void
}) {
  return (
    <div className="space-y-5">
      {/* Days of week */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-2">Active Days</label>
        <div className="flex gap-2">
          {DAY_NAMES.map((name, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onDaysChange(days.includes(i) ? days.filter(x => x !== i) : [...days, i].sort())}
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
            onChange={e => onStartHourChange(Number(e.target.value))}
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
            onChange={e => onEndHourChange(Number(e.target.value))}
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
          onChange={e => onTimezoneChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {TIMEZONES.map(tz => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
