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
  website_url: string
  // Target audience owned by each product:
  target_titles: string[]
  target_industries: string[]
  target_locations: string[]
  min_company_size: number | null
  max_company_size: number | null
  custom_criteria: CustomCriterion[]
}

interface CustomCriterion {
  id: string
  label: string
  description: string
  weight: 'must_have' | 'nice_to_have' | 'disqualifier'
}

interface IcpConfig {
  notes: string
  products_services: Product[]
  default_ai_mode?: boolean
  default_message_length?: string
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

// ─── Message length presets ───────────────────────────────────────────────────

const MESSAGE_LENGTH_PRESETS = [
  { key: 'micro',     label: 'Micro',     words: 50,  range: '30–60 words',   desc: 'Highest reply rates · single hook, single ask' },
  { key: 'concise',   label: 'Concise',   words: 80,  range: '60–100 words',  desc: 'LinkedIn best practice for cold outreach' },
  { key: 'standard',  label: 'Standard',  words: 130, range: '100–160 words', desc: 'Balanced professional message' },
  { key: 'detailed',  label: 'Detailed',  words: 180, range: '150–200 words', desc: 'Warm leads & nurture sequences' },
  { key: 'long_form', label: 'Long-form', words: 250, range: '200–300 words', desc: 'InMail & relationship building' },
] as const

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

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

// ─── ProductCard ──────────────────────────────────────────────────────────────

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

/** Inline tag-list editor — supports optional typeahead suggestions */
function TagListInput({
  items,
  onChange,
  placeholder,
  suggestions,
}: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder: string
  suggestions?: string[]
}) {
  const [draft, setDraft] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)

  const filtered = suggestions
    ? suggestions.filter(s => !items.includes(s) && s.toLowerCase().includes(draft.toLowerCase())).slice(0, 8)
    : []

  function add(val: string) {
    const trimmed = val.trim()
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed])
    }
    setDraft('')
    setShowSuggestions(false)
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
      <div className="relative flex gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={e => { setDraft(e.target.value); setShowSuggestions(true) }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(draft) } }}
          placeholder={placeholder}
          className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="button"
          onClick={() => add(draft)}
          disabled={!draft.trim()}
          className="px-2.5 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          + Add
        </button>
        {showSuggestions && filtered.length > 0 && (
          <div className="absolute left-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 min-w-[200px]">
            {filtered.map(s => (
              <button
                key={s}
                type="button"
                onMouseDown={() => add(s)}
                className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700"
              >
                {s}
              </button>
            ))}
          </div>
        )}
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
    website_url: product.website_url ?? '',
    target_titles: product.target_titles ?? [],
    target_industries: product.target_industries ?? [],
    target_locations: product.target_locations ?? [],
    min_company_size: product.min_company_size ?? null,
    max_company_size: product.max_company_size ?? null,
    custom_criteria: product.custom_criteria ?? [],
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

          {/* Target Titles */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Target Job Titles</label>
            <TagListInput
              items={p.target_titles}
              onChange={target_titles => onChange({ ...p, target_titles })}
              placeholder="e.g. CEO, VP Sales, Head of Growth…"
            />
          </div>

          {/* Target Industries */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Target Industries</label>
            <TagListInput
              items={p.target_industries}
              onChange={target_industries => onChange({ ...p, target_industries })}
              placeholder="e.g. SaaS, FinTech, E-commerce…"
            />
          </div>

          {/* Target Locations */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Target Locations <span className="text-gray-400 font-normal">(optional)</span></label>
            <TagListInput
              items={p.target_locations}
              onChange={target_locations => onChange({ ...p, target_locations })}
              placeholder="e.g. EMEA, United Kingdom, United States…"
              suggestions={SUGGESTED_LOCATIONS}
            />
          </div>

          {/* Company size */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Min Company Size <span className="text-gray-400 font-normal">(employees)</span></label>
              <input
                type="number" min={1}
                value={p.min_company_size ?? ''}
                onChange={e => onChange({ ...p, min_company_size: e.target.value ? parseInt(e.target.value) : null })}
                placeholder="e.g. 10"
                className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Max Company Size <span className="text-gray-400 font-normal">(employees)</span></label>
              <input
                type="number" min={1}
                value={p.max_company_size ?? ''}
                onChange={e => onChange({ ...p, max_company_size: e.target.value ? parseInt(e.target.value) : null })}
                placeholder="e.g. 500"
                className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Custom Criteria */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Qualification Criteria <span className="text-gray-400 font-normal">(optional)</span></label>
            <div className="space-y-2">
              {(p.custom_criteria ?? []).map(cr => (
                <div key={cr.id} className="flex items-center gap-2">
                  <select
                    value={cr.weight}
                    onChange={e => onChange({ ...p, custom_criteria: p.custom_criteria.map(c => c.id === cr.id ? { ...c, weight: e.target.value as CustomCriterion['weight'] } : c) })}
                    className="text-xs px-2 py-1 border border-gray-300 rounded-lg bg-white focus:outline-none"
                  >
                    <option value="must_have">Must have</option>
                    <option value="nice_to_have">Nice to have</option>
                    <option value="disqualifier">Disqualifier</option>
                  </select>
                  <input
                    type="text"
                    value={cr.label}
                    onChange={e => onChange({ ...p, custom_criteria: p.custom_criteria.map(c => c.id === cr.id ? { ...c, label: e.target.value } : c) })}
                    placeholder="e.g. Uses Salesforce"
                    className="flex-1 px-2.5 py-1 text-xs border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => onChange({ ...p, custom_criteria: p.custom_criteria.filter(c => c.id !== cr.id) })}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                  >×</button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => onChange({ ...p, custom_criteria: [...(p.custom_criteria ?? []), { id: Math.random().toString(36).slice(2,10), label: '', description: '', weight: 'nice_to_have' }] })}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >+ Add criterion</button>
            </div>
          </div>

          {/* USPs */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Value Propositions <span className="text-gray-400 font-normal">(key benefits you deliver to the customer)</span></label>
            <TagListInput
              items={p.usps}
              onChange={usps => onChange({ ...p, usps })}
              placeholder="e.g. saves 10 hrs/week, increases reply rates by 3×…"
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

        </div>
      )}
    </div>
  )
}

// ─── Main Settings page ───────────────────────────────────────────────────────

const DEFAULT_ICP: IcpConfig = {
  notes: '',
  products_services: [],
  default_ai_mode: false,
  default_message_length: 'concise',
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
        {
          id: uid(), name: '', one_liner: '', description: '',
          target_use_case: '', usps: [], differentiators: [],
          website_url: '',
          target_titles: [], target_industries: [], target_locations: [],
          min_company_size: null, max_company_size: null, custom_criteria: [],
        },
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
        <p className="mt-1 text-sm text-gray-500">Configure your products, sending limits, and preferences</p>
      </div>

      {/* ── Preferences ── */}
      <section className="bg-violet-50 rounded-xl border border-violet-100 p-6 space-y-5">
        <SectionHeader
          icon={
            <svg className="w-5 h-5 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          }
          iconBg="bg-violet-50"
          title="Preferences"
          subtitle="Default behaviours applied when creating new steps and sequences."
        />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-800">Default message type</p>
            <p className="text-xs text-gray-500 mt-0.5">New message steps will default to this mode when added to a sequence.</p>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm font-medium shrink-0 ml-4">
            <button
              type="button"
              onClick={() => {
                setIcp(c => ({ ...c, default_ai_mode: true }))
                void updateSettings({ icp_config: { ...icp, default_ai_mode: true } })
              }}
              className={[
                'px-4 py-2 transition-colors',
                icp.default_ai_mode === true
                  ? 'bg-violet-600 text-white'
                  : 'text-gray-600 hover:bg-gray-50',
              ].join(' ')}
            >
              ✨ AI Automated
            </button>
            <button
              type="button"
              onClick={() => {
                setIcp(c => ({ ...c, default_ai_mode: false }))
                void updateSettings({ icp_config: { ...icp, default_ai_mode: false } })
              }}
              className={[
                'px-4 py-2 border-l border-gray-200 transition-colors',
                icp.default_ai_mode !== true
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-600 hover:bg-gray-50',
              ].join(' ')}
            >
              ✍️ Manual
            </button>
          </div>
        </div>

        {/* Message length default */}
        <div className="pt-2 border-t border-gray-100">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-sm font-medium text-gray-800">Default message length</p>
              <p className="text-xs text-gray-500 mt-0.5">AI-generated messages will target this length by default. Override per step in the sequence builder.</p>
            </div>
            {(() => {
              const active = MESSAGE_LENGTH_PRESETS.find(p => p.key === (icp.default_message_length ?? 'concise'))
              return active ? (
                <span className="text-xs font-semibold text-violet-600 bg-violet-50 border border-violet-100 rounded-full px-2.5 py-1 shrink-0 ml-4">
                  {active.range}
                </span>
              ) : null
            })()}
          </div>
          <input
            type="range"
            min={0}
            max={4}
            step={1}
            value={MESSAGE_LENGTH_PRESETS.findIndex(p => p.key === (icp.default_message_length ?? 'concise'))}
            onChange={e => {
              const preset = MESSAGE_LENGTH_PRESETS[Number(e.target.value)]
              setIcp(c => ({ ...c, default_message_length: preset.key }))
              void updateSettings({ icp_config: { ...icp, default_message_length: preset.key } })
            }}
            className="w-full h-2 appearance-none bg-gray-200 rounded-full accent-violet-600 cursor-pointer"
          />
          <div className="flex justify-between mt-2 px-0.5">
            {MESSAGE_LENGTH_PRESETS.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setIcp(c => ({ ...c, default_message_length: p.key }))
                  void updateSettings({ icp_config: { ...icp, default_message_length: p.key } })
                }}
                className={[
                  'text-xs font-medium transition-colors',
                  (icp.default_message_length ?? 'concise') === p.key
                    ? 'text-violet-600'
                    : 'text-gray-400 hover:text-gray-600',
                ].join(' ')}
              >
                {p.label}
              </button>
            ))}
          </div>
          {(() => {
            const active = MESSAGE_LENGTH_PRESETS.find(p => p.key === (icp.default_message_length ?? 'concise'))
            return active ? (
              <div className="mt-3 px-3 py-2 bg-violet-50 border border-violet-100 rounded-lg">
                <p className="text-xs font-semibold text-violet-700">{active.label} · {active.range} · ~{active.words} words</p>
                <p className="text-xs text-violet-600 mt-0.5">{active.desc}</p>
              </div>
            ) : null
          })()}
        </div>
      </section>

      {/* ── Products & Services ── */}
      <section className="bg-emerald-50 rounded-xl border border-emerald-100 p-6 space-y-5">
        <SectionHeader
          icon={
            <svg className="w-5 h-5 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          }
          iconBg="bg-violet-50"
          title="Products & Services"
          subtitle="Define what you sell and who you sell it to. Each product owns its own target audience."
        />

        <div className="space-y-3">
          {icp.products_services.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-8 text-center">
              <svg className="w-8 h-8 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
              <p className="text-sm text-gray-400">No products added yet</p>
              <p className="text-xs text-gray-400 mt-0.5">Add what you sell so the AI can assess product-market fit per campaign</p>
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

      {/* ── Sending Defaults ── */}
      <section className="bg-purple-50 rounded-xl border border-purple-100 p-6 space-y-5">
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
