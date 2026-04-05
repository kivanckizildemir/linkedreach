import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/fetchJson'
import { fetchLeads, type Lead } from '../api/leads'

// ─── Types ────────────────────────────────────────────────────────────────────

interface MessageTemplate {
  id: string
  name: string
  type: 'connection' | 'message' | 'follow_up' | 'inmail'
  subject: string | null
  body: string
  variables: string[]
  created_at: string
  updated_at: string
}

type Approach =
  | 'direct'
  | 'trigger_based'
  | 'insight_challenger'
  | 'problem_solution'
  | 'social_proof'
  | 'question_hook'
  | 'before_after_bridge'
  | 'mutual_ground'
  | 'pattern_interrupt'
  | 'value_first'

interface ApproachMeta {
  label: string
  description: string
  icon: string
}

interface Product {
  id?: string
  name: string
  description: string
  target_use_case: string
}

interface IcpConfig {
  products_services?: Product[]
}

// ─── Static data ──────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  connection: '🤝 Connection Request',
  message:    '💬 Message',
  follow_up:  '🔄 Follow-up',
  inmail:     '📧 InMail',
}

const TYPE_COLORS: Record<string, string> = {
  connection: 'bg-blue-100 text-blue-700',
  message:    'bg-green-100 text-green-700',
  follow_up:  'bg-purple-100 text-purple-700',
  inmail:     'bg-orange-100 text-orange-700',
}

const VARIABLE_OPTIONS = [
  '{{first_name}}', '{{last_name}}', '{{full_name}}',
  '{{company}}', '{{title}}', '{{industry}}',
  '{{opening_line}}',
]

const APPROACHES: { value: Approach; meta: ApproachMeta }[] = [
  {
    value: 'direct',
    meta: {
      label: 'Direct / No Fluff',
      description: 'Straight to the value prop. No warm-up, no filler. Works great with busy executives.',
      icon: '⚡',
    },
  },
  {
    value: 'trigger_based',
    meta: {
      label: 'Trigger-Based',
      description: 'References a specific event — funding, role change, post they made. Highest reply rates.',
      icon: '🎯',
    },
  },
  {
    value: 'insight_challenger',
    meta: {
      label: 'Insight / Challenger',
      description: 'Opens with a counter-intuitive industry insight. Positions you as a peer, not a vendor.',
      icon: '💡',
    },
  },
  {
    value: 'problem_solution',
    meta: {
      label: 'Problem → Solution',
      description: 'Names the exact pain point they\'re likely sitting with, then connects it to your solution.',
      icon: '🔧',
    },
  },
  {
    value: 'social_proof',
    meta: {
      label: 'Social Proof',
      description: 'Leads with a specific result from a similar company. Let outcomes do the selling.',
      icon: '🏆',
    },
  },
  {
    value: 'question_hook',
    meta: {
      label: 'Question Hook',
      description: 'One sharp question they can\'t help but answer. Low friction, high curiosity.',
      icon: '❓',
    },
  },
  {
    value: 'before_after_bridge',
    meta: {
      label: 'Before / After / Bridge',
      description: 'Current state → desired state → you\'re the bridge. Creates tension and relief.',
      icon: '🌉',
    },
  },
  {
    value: 'mutual_ground',
    meta: {
      label: 'Mutual Ground',
      description: 'References something genuinely shared — mutual connection, community, background.',
      icon: '🤝',
    },
  },
  {
    value: 'pattern_interrupt',
    meta: {
      label: 'Pattern Interrupt',
      description: 'Breaks the mould of typical cold messages. Unexpected, disarming, memorable.',
      icon: '⚡',
    },
  },
  {
    value: 'value_first',
    meta: {
      label: 'Value-First',
      description: 'Leads with a genuinely useful insight. No hard sell — give before you ask.',
      icon: '🎁',
    },
  },
]

const SAMPLE_LEAD = {
  first_name: 'Sarah', last_name: 'Chen', full_name: 'Sarah Chen',
  company: 'TechCorp', title: 'Head of Growth', industry: 'SaaS',
  opening_line: 'Congrats on the recent Series B — impressive growth trajectory!',
}

type PreviewData = typeof SAMPLE_LEAD

function previewTemplate(body: string, data: PreviewData = SAMPLE_LEAD): string {
  let preview = body
  for (const [key, val] of Object.entries(data)) {
    preview = preview.replaceAll(`{{${key}}}`, val)
  }
  return preview
}

function leadToPreviewData(lead: Lead): PreviewData {
  return {
    first_name: lead.first_name,
    last_name: lead.last_name,
    full_name: `${lead.first_name} ${lead.last_name}`,
    company: lead.company ?? '',
    title: lead.title ?? '',
    industry: lead.industry ?? '',
    opening_line: SAMPLE_LEAD.opening_line,
  }
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function fetchTemplates(type?: string): Promise<MessageTemplate[]> {
  const params = type ? `?type=${type}` : ''
  const res = await apiFetch(`/api/message-templates${params}`)
  if (!res.ok) throw new Error('Failed to fetch templates')
  const { data } = await res.json() as { data: MessageTemplate[] }
  return data ?? []
}

async function createTemplate(input: Partial<MessageTemplate>): Promise<MessageTemplate> {
  const res = await apiFetch('/api/message-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'Failed to create template')
  }
  const { data } = await res.json() as { data: MessageTemplate }
  return data
}

async function updateTemplate(id: string, input: Partial<MessageTemplate>): Promise<MessageTemplate> {
  const res = await apiFetch(`/api/message-templates/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error('Failed to update template')
  const { data } = await res.json() as { data: MessageTemplate }
  return data
}

async function deleteTemplate(id: string): Promise<void> {
  await apiFetch(`/api/message-templates/${id}`, { method: 'DELETE' })
}

async function fetchSettings(): Promise<{ icp_config: IcpConfig }> {
  const res = await apiFetch('/api/settings')
  if (!res.ok) return { icp_config: {} }
  const { data } = await res.json() as { data: { icp_config: IcpConfig } }
  return data
}

async function generateMessage(params: {
  type: MessageTemplate['type']
  approach: Approach
  product_index?: number
}): Promise<{ body: string; subject?: string; name_suggestion: string }> {
  const res = await apiFetch('/api/message-templates/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'AI generation failed')
  }
  const { data } = await res.json() as { data: { body: string; subject?: string; name_suggestion: string } }
  return data
}

// ─── Form defaults ────────────────────────────────────────────────────────────

const EMPTY_FORM: { name: string; type: MessageTemplate['type']; subject: string; body: string } = {
  name: '', type: 'message', subject: '', body: '',
}

// ─── Main component ───────────────────────────────────────────────────────────

export function Templates() {
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [editing, setEditing]       = useState<MessageTemplate | null>(null)
  const [showForm, setShowForm]     = useState(false)
  const [form, setForm]             = useState(EMPTY_FORM)
  const [formError, setFormError]   = useState('')
  const [previewMode, setPreviewMode] = useState(false)
  const [previewLeadId, setPreviewLeadId] = useState<string>('')

  // AI generation state
  const [showAiPanel, setShowAiPanel]     = useState(true)
  const [aiApproach, setAiApproach]       = useState<Approach | null>(null)
  const [aiProductIdx, setAiProductIdx]   = useState<number | undefined>(undefined)
  const [aiError, setAiError]             = useState('')
  const [aiGenerating, setAiGenerating]   = useState(false)

  const queryClient = useQueryClient()

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })
  const products = settings?.icp_config?.products_services?.filter(p => p.name) ?? []

  const { data: leadsForPreview = [] } = useQuery({
    queryKey: ['leads-preview'],
    queryFn: () => fetchLeads(),
    enabled: previewMode,
    staleTime: 120_000,
  })

  const selectedPreviewLead = leadsForPreview.find(l => l.id === previewLeadId)
  const previewData = selectedPreviewLead ? leadToPreviewData(selectedPreviewLead) : SAMPLE_LEAD

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['message-templates', typeFilter],
    queryFn: () => fetchTemplates(typeFilter || undefined),
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editing) return updateTemplate(editing.id, form)
      return createTemplate(form)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['message-templates'] })
      setShowForm(false)
      setEditing(null)
      setForm(EMPTY_FORM)
      setFormError('')
      setAiApproach(null)
    },
    onError: (err: Error) => setFormError(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['message-templates'] }),
  })

  function openEdit(t: MessageTemplate) {
    setEditing(t)
    setForm({ name: t.name, type: t.type, subject: t.subject ?? '', body: t.body })
    setShowAiPanel(false)
    setAiApproach(null)
    setAiError('')
    setShowForm(true)
  }

  function openNew() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError('')
    setShowAiPanel(true)
    setAiApproach(null)
    setAiError('')
    setShowForm(true)
  }

  function insertVariable(v: string) {
    setForm(f => ({ ...f, body: f.body + v }))
  }

  async function handleGenerate() {
    if (!aiApproach) return
    setAiGenerating(true)
    setAiError('')
    try {
      const result = await generateMessage({
        type: form.type,
        approach: aiApproach,
        product_index: aiProductIdx,
      })
      setForm(f => ({
        ...f,
        body: result.body,
        subject: result.subject ?? f.subject,
        name: f.name.trim() ? f.name : result.name_suggestion,
      }))
    } catch (err: unknown) {
      setAiError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setAiGenerating(false)
    }
  }

  const charCount = form.body.length
  const overLimit = form.type === 'connection' && charCount > 300

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Message Templates</h1>
          <p className="mt-1 text-sm text-gray-500">AI-written messages with smart variable substitution</p>
        </div>
        <button
          onClick={openNew}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          + New Template
        </button>
      </div>

      {/* Type filter */}
      <div className="flex gap-2 flex-wrap">
        {([['', 'All'], ['connection', '🤝 Connection'], ['message', '💬 Message'], ['follow_up', '🔄 Follow-up'], ['inmail', '📧 InMail']] as const).map(([val, label]) => (
          <button
            key={val}
            onClick={() => setTypeFilter(val)}
            className={[
              'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              typeFilter === val ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Variables quick reference */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
        <p className="text-xs font-semibold text-blue-700 mb-2">Available Variables</p>
        <div className="flex flex-wrap gap-1.5">
          {VARIABLE_OPTIONS.map(v => (
            <code key={v} className="text-[11px] bg-white border border-blue-200 text-blue-700 px-2 py-0.5 rounded-md font-mono">{v}</code>
          ))}
        </div>
      </div>

      {/* Templates grid */}
      {isLoading ? (
        <div className="text-center py-10 text-sm text-gray-400">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 py-16 text-center">
          <p className="text-gray-900 font-medium">No templates yet</p>
          <p className="mt-1 text-sm text-gray-500">Create AI-written messages tailored to your ICP.</p>
          <button onClick={openNew} className="mt-4 text-sm text-blue-600 hover:underline">Create your first template →</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {templates.map(t => (
            <div key={t.id} className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{t.name}</p>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full mt-1 inline-block ${TYPE_COLORS[t.type]}`}>
                    {TYPE_LABELS[t.type]}
                  </span>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => openEdit(t)} className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                    </svg>
                  </button>
                  <button
                    onClick={() => { if (confirm('Delete this template?')) deleteMutation.mutate(t.id) }}
                    className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                    </svg>
                  </button>
                </div>
              </div>

              {t.subject && (
                <p className="text-xs text-gray-500 font-medium">Subject: {t.subject}</p>
              )}

              <p className="text-xs text-gray-600 line-clamp-3 leading-relaxed whitespace-pre-wrap">{t.body}</p>

              {t.variables.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1 border-t border-gray-50">
                  {t.variables.map(v => (
                    <code key={v} className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">{v}</code>
                  ))}
                </div>
              )}

              <p className="text-[10px] text-gray-300 mt-auto">
                {t.body.length} chars · Updated {new Date(t.updated_at).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Create / Edit Modal ── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[92vh]">

            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
              <h2 className="text-lg font-semibold text-gray-900">{editing ? 'Edit Template' : 'New Template'}</h2>
              <div className="flex items-center gap-3">
                {!showAiPanel && form.body && (
                  <button
                    onClick={() => setPreviewMode(p => !p)}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${previewMode ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                  >
                    {previewMode ? '✏️ Edit' : '👁 Preview'}
                  </button>
                )}
                <button onClick={() => { setShowForm(false); setEditing(null) }} className="text-gray-400 hover:text-gray-600">✕</button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

              {/* Name + Type */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Template Name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Q2 SaaS Founder Outreach"
                    className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Message Type</label>
                  <select
                    value={form.type}
                    onChange={e => setForm(f => ({ ...f, type: e.target.value as typeof form.type }))}
                    className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="connection">🤝 Connection Request</option>
                    <option value="message">💬 Message</option>
                    <option value="follow_up">🔄 Follow-up</option>
                    <option value="inmail">📧 InMail</option>
                  </select>
                </div>
              </div>

              {/* ── AI Generation Panel ── */}
              <div className="rounded-xl border border-violet-200 bg-violet-50 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAiPanel(p => !p)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-violet-100 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">✨</span>
                    <span className="text-sm font-semibold text-violet-800">Generate with AI</span>
                    <span className="text-xs text-violet-500">— pick an approach, we write the message</span>
                  </div>
                  <svg
                    className={`w-4 h-4 text-violet-500 transition-transform ${showAiPanel ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showAiPanel && (
                  <div className="px-4 pb-4 space-y-4">
                    {/* Approach grid */}
                    <div>
                      <p className="text-xs font-medium text-violet-700 mb-2.5">Select an approach</p>
                      <div className="grid grid-cols-2 gap-2">
                        {APPROACHES.map(({ value, meta }) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setAiApproach(value)}
                            className={[
                              'text-left px-3 py-2.5 rounded-lg border text-xs transition-all',
                              aiApproach === value
                                ? 'border-violet-500 bg-white ring-2 ring-violet-300'
                                : 'border-gray-200 bg-white hover:border-violet-300 hover:bg-violet-50',
                            ].join(' ')}
                          >
                            <div className="font-semibold text-gray-800 flex items-center gap-1.5 mb-0.5">
                              <span>{meta.icon}</span>
                              {meta.label}
                            </div>
                            <div className="text-gray-500 leading-snug">{meta.description}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Product selector — only if products defined in Settings */}
                    {products.length > 0 && (
                      <div>
                        <label className="block text-xs font-medium text-violet-700 mb-1.5">
                          Focus on product <span className="text-violet-400 font-normal">(optional)</span>
                        </label>
                        <select
                          value={aiProductIdx ?? ''}
                          onChange={e => setAiProductIdx(e.target.value !== '' ? parseInt(e.target.value) : undefined)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-400"
                        >
                          <option value="">First product (default)</option>
                          {products.map((p, i) => (
                            <option key={i} value={i}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Generate button */}
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void handleGenerate()}
                        disabled={!aiApproach || aiGenerating}
                        className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
                      >
                        {aiGenerating ? (
                          <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                            </svg>
                            Writing…
                          </>
                        ) : (
                          <>✨ Generate</>
                        )}
                      </button>
                      {form.body && !aiGenerating && (
                        <span className="text-xs text-violet-600">↓ Edit the result below</span>
                      )}
                      {aiError && <span className="text-xs text-red-600">{aiError}</span>}
                    </div>
                  </div>
                )}
              </div>

              {/* Subject line (InMail only) */}
              {form.type === 'inmail' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Subject</label>
                  <input
                    type="text"
                    value={form.subject}
                    onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                    placeholder="e.g. Quick question about {{company}}"
                    className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}

              {/* Message body */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-gray-700">Message Body</label>
                  <span className={`text-[11px] tabular-nums ${overLimit ? 'text-red-500 font-semibold' : 'text-gray-400'}`}>
                    {charCount}{form.type === 'connection' ? '/300' : ''} chars
                  </span>
                </div>

                {previewMode ? (
                  <>
                    <div className="mb-2 flex items-center gap-2">
                      <select
                        value={previewLeadId}
                        onChange={e => setPreviewLeadId(e.target.value)}
                        className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Sample lead (Sarah Chen)</option>
                        {leadsForPreview.map(l => (
                          <option key={l.id} value={l.id}>
                            {l.first_name} {l.last_name}{l.company ? ` · ${l.company}` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="w-full px-4 py-3 border border-blue-200 rounded-xl text-sm text-gray-800 bg-blue-50 min-h-[160px] whitespace-pre-wrap leading-relaxed">
                      {previewTemplate(form.body, previewData) || <span className="text-gray-400 italic">Preview will appear here…</span>}
                    </div>
                  </>
                ) : (
                  <textarea
                    value={form.body}
                    onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                    rows={7}
                    placeholder={
                      form.body ? '' : form.type === 'connection'
                        ? 'Generate with AI above, or write manually…'
                        : 'Generate with AI above, or write manually…'
                    }
                    className="w-full px-3.5 py-3 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono"
                  />
                )}

                {!previewMode && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <span className="text-[10px] text-gray-400 self-center">Insert:</span>
                    {VARIABLE_OPTIONS.map(v => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => insertVariable(v)}
                        className="text-[10px] bg-gray-100 hover:bg-blue-100 hover:text-blue-700 text-gray-600 px-2 py-1 rounded-md font-mono transition-colors"
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
                {overLimit && <p className="text-xs text-red-500 mt-1">Connection requests are limited to 300 characters on LinkedIn.</p>}
              </div>

              {formError && <p className="text-xs text-red-600">{formError}</p>}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex gap-3 shrink-0">
              <button
                onClick={() => { setShowForm(false); setEditing(null) }}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!form.name.trim() || !form.body.trim()) { setFormError('Name and body are required'); return }
                  saveMutation.mutate()
                }}
                disabled={saveMutation.isPending || overLimit}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {saveMutation.isPending ? 'Saving…' : editing ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
