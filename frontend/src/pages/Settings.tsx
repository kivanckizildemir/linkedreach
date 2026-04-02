import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/fetchJson'

interface IcpConfig {
  target_titles: string[]
  target_industries: string[]
  target_locations: string[]
  min_company_size: number | null
  max_company_size: null | number
  notes: string
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

async function fetchSettings(): Promise<UserSettings> {
  const res = await apiFetch('/api/settings')
  if (!res.ok) throw new Error('Failed to fetch settings')
  const { data } = await res.json() as { data: UserSettings }
  return data
}

async function updateSettings(updates: Partial<Omit<UserSettings, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<UserSettings> {
  const res = await apiFetch('/api/settings', {
    method: 'PATCH',
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

  const filtered = suggestions.filter(
    s => !values.includes(s) && s.toLowerCase().includes(input.toLowerCase())
  ).slice(0, 8)

  function add(val: string) {
    const trimmed = val.trim()
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed])
    }
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
            <button
              type="button"
              onClick={() => remove(v)}
              className="text-blue-500 hover:text-blue-800 leading-none"
            >
              ×
            </button>
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
              if (e.key === 'Backspace' && !input && values.length > 0) {
                remove(values[values.length - 1])
              }
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

export function Settings() {
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  })

  // Local form state
  const [icp, setIcp] = useState<IcpConfig>({
    target_titles: [],
    target_industries: [],
    target_locations: [],
    min_company_size: null,
    max_company_size: null,
    notes: '',
  })
  const [timezone, setTimezone] = useState('Europe/London')
  const [connectionLimit, setConnectionLimit] = useState(20)
  const [messageLimit, setMessageLimit] = useState(80)

  // Populate form when data loads
  useEffect(() => {
    if (settings) {
      setIcp(settings.icp_config)
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
      setTimeout(() => setSaved(false), 2000)
    },
  })

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

      {/* ICP Configuration */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Ideal Customer Profile (ICP)</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              These criteria are used by AI to score and qualify your leads. The more specific you are, the better the scores.
            </p>
          </div>
        </div>

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
              Min Company Size <span className="text-gray-400 font-normal">(employees, optional)</span>
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
              Max Company Size <span className="text-gray-400 font-normal">(employees, optional)</span>
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

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Additional Notes for AI <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            rows={3}
            value={icp.notes}
            onChange={e => setIcp(c => ({ ...c, notes: e.target.value }))}
            placeholder="e.g. Prioritise people at bootstrapped companies, deprioritise agencies…"
            className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>
      </section>

      {/* Sending defaults */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-purple-50 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Sending Defaults</h2>
            <p className="text-sm text-gray-500 mt-0.5">Default daily limits applied to new LinkedIn accounts. LinkedIn safety rules are enforced independently.</p>
          </div>
        </div>

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

      {/* Save button */}
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

      {/* Info banner */}
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
