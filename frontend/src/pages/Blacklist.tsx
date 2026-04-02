import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/fetchJson'

interface BlacklistEntry {
  id: string
  type: 'domain' | 'email' | 'company'
  value: string
  note: string | null
  created_at: string
}

async function fetchBlacklist(type?: string): Promise<BlacklistEntry[]> {
  const params = type ? `?type=${type}` : ''
  const res = await apiFetch(`/api/blacklist${params}`)
  if (!res.ok) throw new Error('Failed to fetch blacklist')
  const { data } = await res.json() as { data: BlacklistEntry[] }
  return data ?? []
}

async function addToBlacklist(entry: { type: string; value: string; note?: string }): Promise<BlacklistEntry> {
  const res = await apiFetch('/api/blacklist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'Failed to add entry')
  }
  const { data } = await res.json() as { data: BlacklistEntry }
  return data
}

async function removeFromBlacklist(id: string): Promise<void> {
  const res = await apiFetch(`/api/blacklist/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to remove entry')
}

const TYPE_COLORS: Record<string, string> = {
  domain:  'bg-blue-100 text-blue-700',
  email:   'bg-purple-100 text-purple-700',
  company: 'bg-orange-100 text-orange-700',
}

const TYPE_ICONS: Record<string, string> = {
  domain:  '🌐',
  email:   '✉️',
  company: '🏢',
}

export function Blacklist() {
  const [filter, setFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ type: 'domain', value: '', note: '' })
  const [formError, setFormError] = useState('')
  const queryClient = useQueryClient()

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['blacklist', filter],
    queryFn: () => fetchBlacklist(filter || undefined),
  })

  const addMutation = useMutation({
    mutationFn: addToBlacklist,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['blacklist'] })
      setShowAdd(false)
      setForm({ type: 'domain', value: '', note: '' })
      setFormError('')
    },
    onError: (err: Error) => setFormError(err.message),
  })

  const removeMutation = useMutation({
    mutationFn: removeFromBlacklist,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['blacklist'] }),
  })

  const filtered = entries.filter(e =>
    !search || e.value.toLowerCase().includes(search.toLowerCase()) || (e.note ?? '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Blacklist</h1>
          <p className="mt-1 text-sm text-gray-500">Domains, emails, and companies excluded from outreach</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          + Add Entry
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3 flex-wrap">
          <div className="flex gap-1.5">
            {(['', 'domain', 'email', 'company'] as const).map(t => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={[
                  'px-3 py-1.5 text-xs rounded-lg font-medium transition-colors capitalize',
                  filter === t
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100',
                ].join(' ')}
              >
                {t === '' ? 'All' : `${TYPE_ICONS[t]} ${t}s`}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="ml-auto px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-48"
          />
        </div>

        {isLoading ? (
          <div className="py-10 text-center text-sm text-gray-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-500">No blacklist entries yet.</p>
            <p className="mt-1 text-xs text-gray-400">Add domains, emails, or companies to prevent contacting them.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(entry => (
              <div key={entry.id} className="px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${TYPE_COLORS[entry.type]}`}>
                    {TYPE_ICONS[entry.type]} {entry.type}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{entry.value}</p>
                    {entry.note && <p className="text-xs text-gray-400 truncate">{entry.note}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-400">{new Date(entry.created_at).toLocaleDateString()}</span>
                  <button
                    onClick={() => removeMutation.mutate(entry.id)}
                    disabled={removeMutation.isPending}
                    className="text-xs text-red-400 hover:text-red-600 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Add to Blacklist</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Type</label>
                <div className="flex gap-2">
                  {(['domain', 'email', 'company'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setForm(f => ({ ...f, type: t }))}
                      className={[
                        'flex-1 py-2 text-sm font-medium rounded-lg border transition-colors capitalize',
                        form.type === t
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'border-gray-200 text-gray-600 hover:bg-gray-50',
                      ].join(' ')}
                    >
                      {TYPE_ICONS[t]} {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  {form.type === 'domain' ? 'Domain (e.g. competitor.com)' :
                   form.type === 'email'  ? 'Email address' :
                   'Company name'}
                </label>
                <input
                  type="text"
                  autoFocus
                  value={form.value}
                  onChange={e => setForm(f => ({ ...f, value: e.target.value }))}
                  placeholder={
                    form.type === 'domain'  ? 'competitor.com' :
                    form.type === 'email'   ? 'john@example.com' :
                    'Acme Corp'
                  }
                  className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Note <span className="text-gray-400 font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={form.note}
                  onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="e.g. Competitor, existing customer…"
                  className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {formError && <p className="text-xs text-red-600">{formError}</p>}
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setShowAdd(false); setFormError(''); setForm({ type: 'domain', value: '', note: '' }) }}
                className="flex-1 py-2.5 border border-gray-200 text-sm font-medium rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (!form.value.trim()) { setFormError('Value is required'); return }
                  addMutation.mutate({ type: form.type, value: form.value.trim(), note: form.note || undefined })
                }}
                disabled={addMutation.isPending}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {addMutation.isPending ? 'Adding…' : 'Add to Blacklist'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
