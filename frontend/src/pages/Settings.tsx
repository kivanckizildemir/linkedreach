import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/fetchJson'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Product {
  id: string
  name: string
  one_liner: string
  description: string
  target_use_case: string
  usps: string[]
  differentiators: string[]
  tone_of_voice: string
  website_url: string
}

interface CustomCriterion {
  id: string
  label: string
  description: string
  weight: 'must_have' | 'nice_to_have' | 'disqualifier'
}

interface IcpConfig {
  target_titles: string[]
  target_industries: string[]
  target_locations: string[]
  min_company_size: number | null
  max_company_size: number | null
  notes: string
  products_services: Product[]
  custom_criteria: CustomCriterion[]
}

interface UserSettings {
  id: string
  user_id: string
  icp_config: IcpConfig
  timezone: string
  daily_connection_limit: number
  daily_message_limit: number
  created_at: string
  updated_at: string
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchSettings(): Promise<UserSettings> {
  const res = await apiFetch('/api/settings')
  if (!res.ok) throw new Error('Failed to fetch settings')
  const { data } = await res.json() as { data: UserSettings }
  return data
}

async function updateSettings(
  updates: Partial<Omit<UserSettings, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
): Promise<UserSettings> {
  const res = await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'Failed to save settings')
  }
  const { data } = await res.json() as { data: UserSettings }
  return data
}

// ─── Static data ──────────────────────────────────────────────────────────────

const TIMEZONES = [
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Amsterdam',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Vancouver',
  'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Australia/Melbourne',
  'Pacific/Auckland',
]

const SUGGESTED_TITLES = [
  'CEO', 'CTO', 'CMO', 'CFO', 'COO', 'CPO', 'CRO', 'CISO',
  'VP Sales', 'VP Marketing', 'VP Engineering', 'VP Product',
  'Director of Sales', 'Director of Marketing', 'Director of Engineering',
  'Head of Sales', 'Head of Growth', 'Head of Product',
  'Founder', 'Co-Founder', 'Managing Director', 'General Manager',
  'Partner', 'Principal', 'President',
]

const SUGGESTED_INDUSTRIES = [
  'SaaS', 'FinTech', 'HealthTech', 'EdTech', 'E-commerce', 'Retail',
  'Financial Services', 'Banking', 'Insurance', 'Healthcare', 'Pharmaceuticals',
  'Manufacturing', 'Logistics', 'Real Estate', 'Construction', 'Energy',
  'Telecommunications', 'Media', 'Marketing & Advertising', 'Consulting',
  'Legal', 'Education', 'Non-profit', 'Government',
]

const WEIGHT_OPTIONS: { value: CustomCriterion['weight']; label: string; color: string }[] = [
  { value: 'must_have',    label: 'Must Have',    color: 'bg-green-100 text-green-800 border-green-200' },
  { value: 'nice_to_have', label: 'Nice to Have', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'disqualifier', label: 'Disqualifier', color: 'bg-red-100 text-red-800 border-red-200' },
]

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

// ─── TagInput ─────────────────────────────────────────────────────────────────

function TagInput({
  label,
  values,
  suggestions,
  onChange,
  placeholder,
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
          <span
            key={v}
            className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 bg-blue-100 text-blue-800 rounded-full"
          >
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

// ─── ProductCard ──────────────────────────────────────────────────────────────

const TONE_OPTIONS = [
  { value: 'professional', label: '🎩 Professional' },
  { value: 'conversational', label: '💬 Conversational' },
  { value: 'bold', label: '⚡ Bold' },
  { value: 'empathetic', label: '🤝 Empathetic' },
]

async function extractProductFromUrl(url: string): Promise<{ name: string; description: string; target_use_case: string }> {
  const res = await apiFetch('/api/settings/extract-product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  const body = await res.json() as { data?: { name: string; description: string; target_use_case: string }; error?: string }
  if (!res.ok) throw new Error(body.error ?? 'Extraction failed')
  return body.data!
}

/** Inline tag-list editor for USPs and differentiators */
function TagListInput({
  items,
  onChange,
  placeholder,
}: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder: string
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const trimmed = draft.trim()
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed])
    }
    setDraft('')
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-full text-xs font-medium">
            {item}
            <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-blue-400 hover:text-blue-700 leading-none">×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder={placeholder}
          className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          + Add
        </button>
      </div>
    </div>
  )
}

function ProductCard({
  product,
  onChange,
  onRemove,
}: {
  product: Product
  onChange: (p: Product) => void
  onRemove: () => void
}) {
  const [urlDraft, setUrlDraft] = useState(product.website_url ?? '')
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState('')
  const [expanded, setExpanded] = useState(!product.name)

  // Safely coerce legacy products that may be missing new fields
  const p: Product = {
    ...product,
    one_liner: product.one_liner ?? '',
    usps: product.usps ?? [],
    differentiators: product.differentiators ?? [],
    tone_of_voice: product.tone_of_voice ?? 'professional',
    website_url: product.website_url ?? '',
  }

  async function handleExtract() {
    const url = urlDraft.trim()
    if (!url) return
    setExtracting(true)
    setExtractError('')
    try {
      const result = await extractProductFromUrl(url)
      onChange({ ...p, ...result, website_url: url })
    } catch (err: unknown) {
      setExtractError(err instanceof Error ? err.message : 'Failed to extract')
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
      {/* Header row — always visible */}
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 18l6-6-6-6" />
          </svg>
        </button>
        <input
          type="text"
          value={p.name}
          onChange={e => onChange({ ...p, name: e.target.value })}
          placeholder="Product / service name"
          className="flex-1 text-sm font-semibold text-gray-900 bg-transparent outline-none placeholder:font-normal placeholder:text-gray-400"
        />
        {p.tone_of_voice && (
          <span className="text-xs text-gray-400 hidden sm:block capitalize">{p.tone_of_voice}</span>
        )}
        <button type="button" onClick={onRemove} className="text-gray-400 hover:text-red-500 transition-colors shrink-0" title="Remove">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-200 pt-3">

          {/* Website extractor */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Auto-fill from website</label>
            <div className="flex gap-2">
              <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg focus-within:ring-2 focus-within:ring-violet-400 transition-all">
                <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                </svg>
                <input
                  type="url"
                  value={urlDraft}
                  onChange={e => { setUrlDraft(e.target.value); setExtractError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleExtract() } }}
                  onBlur={() => onChange({ ...p, website_url: urlDraft.trim() })}
                  placeholder="https://yourwebsite.com"
                  className="flex-1 text-sm text-gray-700 bg-transparent outline-none placeholder:text-gray-400"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleExtract()}
                disabled={!urlDraft.trim() || extracting}
                className="flex items-center gap-1.5 px-3 py-2 bg-violet-600 text-white text-xs font-semibold rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {extracting ? (
                  <><svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Reading…</>
                ) : <>✨ Extract</>}
              </button>
            </div>
            {extractError && <p className="text-xs text-red-500 mt-1">{extractError}</p>}
          </div>

          {/* One-liner */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">One-liner pitch <span className="text-gray-400 font-normal">(≤15 words)</span></label>
            <input
              type="text"
              value={p.one_liner}
              onChange={e => onChange({ ...p, one_liner: e.target.value })}
              placeholder="e.g. The fastest way to turn cold leads into booked demos"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
            <textarea
              rows={2}
              value={p.description}
              onChange={e => onChange({ ...p, description: e.target.value })}
              placeholder="What does it do? What problem does it solve?"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* Target use case */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Ideal Customer / Use Case</label>
            <textarea
              rows={2}
              value={p.target_use_case}
              onChange={e => onChange({ ...p, target_use_case: e.target.value })}
              placeholder="Who benefits most? e.g. B2B SaaS companies with 50–500 employees scaling their sales team"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* USPs */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Unique Selling Points <span className="text-gray-400 font-normal">(what makes you the obvious choice)</span></label>
            <TagListInput
              items={p.usps}
              onChange={usps => onChange({ ...p, usps })}
              placeholder="e.g. 5-minute setup, no credit card required…"
            />
          </div>

          {/* Differentiators */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Points of Differentiation <span className="text-gray-400 font-normal">(vs. competitors or doing nothing)</span></label>
            <TagListInput
              items={p.differentiators}
              onChange={differentiators => onChange({ ...p, differentiators })}
              placeholder="e.g. 3× faster than Salesforce, no per-seat pricing…"
            />
          </div>

          {/* Tone of voice */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Tone of Voice</label>
            <div className="flex flex-wrap gap-2">
              {TONE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ ...p, tone_of_voice: opt.value })}
                  className={[
                    'px-3 py-1.5 text-xs font-medium rounded-lg border transition-all',
                    p.tone_of_voice === opt.value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300',
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

// ─── CriterionRow ─────────────────────────────────────────────────────────────

function CriterionRow({
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
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3">
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

      {/* Weight selector */}
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

// ─── Main Settings page ───────────────────────────────────────────────────────

const DEFAULT_ICP: IcpConfig = {
  target_titles: [],
  target_industries: [],
  target_locations: [],
  min_company_size: null,
  max_company_size: null,
  notes: '',
  products_services: [],
  custom_criteria: [],
}

export function Settings() {
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })

  const [icp, setIcp] = useState<IcpConfig>(DEFAULT_ICP)
  const [timezone, setTimezone] = useState('Europe/London')
  const [connectionLimit, setConnectionLimit] = useState(20)
  const [messageLimit, setMessageLimit] = useState(80)

  useEffect(() => {
    if (settings) {
      setIcp({
        ...DEFAULT_ICP,
        ...settings.icp_config,
        products_services: settings.icp_config.products_services ?? [],
        custom_criteria: settings.icp_config.custom_criteria ?? [],
      })
      setTimezone(settings.timezone)
      setConnectionLimit(settings.daily_connection_limit)
      setMessageLimit(settings.daily_message_limit)
    }
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: () => updateSettings({
      icp_config: icp,
      timezone,
      daily_connection_limit: connectionLimit,
      daily_message_limit: messageLimit,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  // Products helpers
  function addProduct() {
    setIcp(c => ({
      ...c,
      products_services: [
        ...c.products_services,
        { id: uid(), name: '', one_liner: '', description: '', target_use_case: '', usps: [], differentiators: [], tone_of_voice: 'professional', website_url: '' },
      ],
    }))
  }

  function updateProduct(id: string, updated: Product) {
    setIcp(c => ({
      ...c,
      products_services: c.products_services.map(p => p.id === id ? updated : p),
    }))
  }

  function removeProduct(id: string) {
    setIcp(c => ({
      ...c,
      products_services: c.products_services.filter(p => p.id !== id),
    }))
  }

  // Criteria helpers
  function addCriterion() {
    setIcp(c => ({
      ...c,
      custom_criteria: [
        ...c.custom_criteria,
        { id: uid(), label: '', description: '', weight: 'nice_to_have' },
      ],
    }))
  }

  function updateCriterion(id: string, updated: CustomCriterion) {
    setIcp(c => ({
      ...c,
      custom_criteria: c.custom_criteria.map(cr => cr.id === id ? updated : cr),
    }))
  }

  function removeCriterion(id: string) {
    setIcp(c => ({
      ...c,
      custom_criteria: c.custom_criteria.filter(cr => cr.id !== id),
    }))
  }

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="text-sm text-gray-400">Loading settings…</div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Configure your ICP criteria, sending limits, and preferences</p>
      </div>

      {/* ── ICP: Target Audience ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <SectionHeader
          icon={
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          }
          iconBg="bg-blue-50"
          title="Target Audience"
          subtitle="Define who your ideal lead looks like — titles, industries, locations, and company size."
        />

        <TagInput
          label="Target Job Titles"
          values={icp.target_titles}
          suggestions={SUGGESTED_TITLES}
          onChange={vals => setIcp(c => ({ ...c, target_titles: vals }))}
          placeholder="e.g. CEO, VP Sales, Founder…"
        />

        <TagInput
          label="Target Industries"
          values={icp.target_industries}
          suggestions={SUGGESTED_INDUSTRIES}
          onChange={vals => setIcp(c => ({ ...c, target_industries: vals }))}
          placeholder="e.g. SaaS, FinTech, Healthcare…"
        />

        <TagInput
          label="Target Locations (optional)"
          values={icp.target_locations}
          suggestions={['United Kingdom', 'United States', 'Canada', 'Australia', 'Germany', 'France', 'Netherlands', 'Sweden', 'Denmark', 'Norway']}
          onChange={vals => setIcp(c => ({ ...c, target_locations: vals }))}
          placeholder="e.g. United Kingdom, United States…"
        />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Min Company Size <span className="text-gray-400 font-normal">(employees)</span>
            </label>
            <input
              type="number"
              min={1}
              value={icp.min_company_size ?? ''}
              onChange={e => setIcp(c => ({ ...c, min_company_size: e.target.value ? parseInt(e.target.value) : null }))}
              placeholder="e.g. 10"
              className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Max Company Size <span className="text-gray-400 font-normal">(employees)</span>
            </label>
            <input
              type="number"
              min={1}
              value={icp.max_company_size ?? ''}
              onChange={e => setIcp(c => ({ ...c, max_company_size: e.target.value ? parseInt(e.target.value) : null }))}
              placeholder="e.g. 500"
              className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </section>

      {/* ── Products & Services ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <SectionHeader
          icon={
            <svg className="w-5 h-5 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          }
          iconBg="bg-violet-50"
          title="Products & Services"
          subtitle="Tell the AI what you sell. It uses this to assess whether each lead has a likely need for your offering."
        />

        <div className="space-y-3">
          {icp.products_services.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-8 text-center">
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <p className="text-sm text-gray-400">No products added yet</p>
              <p className="text-xs text-gray-400 mt-0.5">Add what you sell so the AI can assess product-market fit</p>
            </div>
          )}

          {icp.products_services.map(p => (
            <ProductCard
              key={p.id}
              product={p}
              onChange={updated => updateProduct(p.id, updated)}
              onRemove={() => removeProduct(p.id)}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={addProduct}
          className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add product or service
        </button>
      </section>

      {/* ── Custom Qualification Criteria ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <SectionHeader
          icon={
            <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          }
          iconBg="bg-amber-50"
          title="Custom Qualification Criteria"
          subtitle="Add specific rules the AI must apply when scoring. Mark each as Must Have, Nice to Have, or a Disqualifier."
        />

        {/* Legend */}
        <div className="flex items-center gap-3 flex-wrap">
          {WEIGHT_OPTIONS.map(opt => (
            <span key={opt.value} className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border font-medium ${opt.color}`}>
              {opt.value === 'must_have' && (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              )}
              {opt.value === 'disqualifier' && (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
              )}
              {opt.label}
            </span>
          ))}
          <span className="text-xs text-gray-400 ml-1">— set importance for each rule</span>
        </div>

        <div className="space-y-3">
          {icp.custom_criteria.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-8 text-center">
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-sm text-gray-400">No custom criteria yet</p>
              <p className="text-xs text-gray-400 mt-0.5">e.g. "Uses Salesforce", "Has raised Series A+", "Not an agency"</p>
            </div>
          )}

          {icp.custom_criteria.map(cr => (
            <CriterionRow
              key={cr.id}
              criterion={cr}
              onChange={updated => updateCriterion(cr.id, updated)}
              onRemove={() => removeCriterion(cr.id)}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={addCriterion}
          className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add qualification criterion
        </button>
      </section>

      {/* ── Additional Notes ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <SectionHeader
          icon={
            <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          }
          iconBg="bg-gray-100"
          title="Additional Notes for AI"
          subtitle="Free-text guidance for the AI — use this for anything that doesn't fit into structured criteria."
        />
        <textarea
          rows={3}
          value={icp.notes}
          onChange={e => setIcp(c => ({ ...c, notes: e.target.value }))}
          placeholder="e.g. Prioritise bootstrapped companies over VC-funded ones. Deprioritise anyone in an agency role."
          className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
      </section>

      {/* ── Sending Defaults ── */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <SectionHeader
          icon={
            <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
          iconBg="bg-purple-50"
          title="Sending Defaults"
          subtitle="Default daily limits applied to new LinkedIn accounts. LinkedIn safety rules are enforced independently."
        />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Daily Connection Limit
              <span className="ml-1.5 text-xs text-gray-400 font-normal">(max 25)</span>
            </label>
            <input
              type="number"
              min={1}
              max={25}
              value={connectionLimit}
              onChange={e => setConnectionLimit(Math.min(25, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Daily Message Limit
              <span className="ml-1.5 text-xs text-gray-400 font-normal">(max 100)</span>
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={messageLimit}
              onChange={e => setMessageLimit(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Default Timezone</label>
          <select
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
            className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {TIMEZONES.map(tz => (
              <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-400">Used for scheduling — no actions sent outside 7am–11pm in this timezone</p>
        </div>
      </section>

      {/* ── Save ── */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="px-6 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && (
          <span className="text-sm text-green-600 font-medium flex items-center gap-1.5">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Saved
          </span>
        )}
        {saveMutation.isError && (
          <span className="text-sm text-red-600">{(saveMutation.error as Error).message}</span>
        )}
      </div>

      {/* ── Info banner ── */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 flex gap-3">
        <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p className="text-sm font-medium text-amber-800">Changes apply to new qualification runs</p>
          <p className="text-xs text-amber-700 mt-1">
            Existing ICP scores are not updated automatically. Use &ldquo;AI Score All&rdquo; on the Leads page to re-score all leads with the new criteria.
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Shared section header component ─────────────────────────────────────────

function SectionHeader({
  icon,
  iconBg,
  title,
  subtitle,
}: {
  icon: React.ReactNode
  iconBg: string
  title: string
  subtitle: string
}) {
  return (
    <div className="flex items-start gap-3">
      <div className={`w-9 h-9 rounded-xl ${iconBg} flex items-center justify-center shrink-0`}>
        {icon}
      </div>
      <div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
      </div>
    </div>
  )
}
