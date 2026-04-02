import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { fetchCampaigns, createCampaign, updateCampaign, deleteCampaign } from '../api/campaigns'
import type { Campaign } from '../api/campaigns'
import { apiFetch } from '../lib/fetchJson'

interface CampaignStats {
  id: string
  total: number
  connection_sent: number
  connected: number
  replied: number
  acceptance_rate: number
  reply_rate: number
}

async function fetchCampaignStats(): Promise<CampaignStats[]> {
  const res = await apiFetch('/api/analytics')
  if (!res.ok) return []
  const { campaigns } = await res.json() as { campaigns: CampaignStats[] }
  return campaigns ?? []
}

const STATUS_COLORS: Record<Campaign['status'], string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-blue-100 text-blue-700',
}

type FilterStatus = 'all' | Campaign['status']

export function Campaigns() {
  const [filter, setFilter] = useState<FilterStatus>('all')
  const [showModal, setShowModal] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: fetchCampaigns,
  })

  const { data: stats = [] } = useQuery({
    queryKey: ['campaign-stats'],
    queryFn: fetchCampaignStats,
    staleTime: 60_000,
  })

  const statsById = Object.fromEntries(stats.map(s => [s.id, s]))

  const filtered = filter === 'all' ? campaigns : campaigns.filter(c => c.status === filter)

  const createMutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setShowModal(false)
    },
  })

  // Keep old alias for the modal
  const mutation = createMutation

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Campaign['status'] }) =>
      updateCampaign(id, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['analytics'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteCampaign,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['analytics'] })
    },
  })

  const duplicateMutation = useMutation({
    mutationFn: (c: Campaign) => createCampaign(c.name + ' (copy)'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
          <p className="mt-1 text-sm text-gray-500">Manage your outreach campaigns and sequences</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          New Campaign
        </button>
      </div>

      <div className="mt-6 bg-white rounded-xl border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex gap-2">
            {(['all', 'active', 'draft', 'paused'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={[
                  'px-3 py-1.5 text-sm rounded-lg transition-colors capitalize',
                  filter === f
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-100',
                ].join(' ')}
              >
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-gray-900 font-medium">No campaigns yet</p>
            <p className="mt-1 text-sm text-gray-500">Create your first campaign to start reaching out to leads.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {filtered.map(c => (
              <div
                key={c.id}
                className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors group"
              >
                {/* Clickable main area */}
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => navigate(`/campaigns/${c.id}`)}
                >
                  <div className="flex items-center gap-2.5">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${STATUS_COLORS[c.status]}`}>
                      {c.status}
                    </span>
                    <p className="text-sm font-semibold text-gray-900 truncate">{c.name}</p>
                  </div>
                  {statsById[c.id] && statsById[c.id].total > 0 ? (
                    <div className="flex items-center gap-4 mt-1.5 text-xs text-gray-500">
                      <span>{statsById[c.id].total} leads</span>
                      <span className="text-gray-200">·</span>
                      <span>{statsById[c.id].connection_sent} sent</span>
                      <span className="text-gray-200">·</span>
                      <span className={`font-medium ${statsById[c.id].acceptance_rate >= 30 ? 'text-green-600' : statsById[c.id].acceptance_rate >= 15 ? 'text-orange-500' : 'text-gray-500'}`}>
                        {statsById[c.id].acceptance_rate}% accept
                      </span>
                      <span className="text-gray-200">·</span>
                      <span className={`font-medium ${statsById[c.id].reply_rate >= 20 ? 'text-green-600' : statsById[c.id].reply_rate >= 10 ? 'text-orange-500' : 'text-gray-500'}`}>
                        {statsById[c.id].reply_rate}% reply
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Created {new Date(c.created_at).toLocaleDateString()}
                    </p>
                  )}
                </div>

                {/* Quick actions — visible on hover */}
                <div className="flex items-center gap-1.5 ml-4 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {c.status === 'active' && (
                    <button
                      onClick={e => { e.stopPropagation(); statusMutation.mutate({ id: c.id, status: 'paused' }) }}
                      disabled={statusMutation.isPending}
                      title="Pause campaign"
                      className="px-2.5 py-1.5 text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200 rounded-lg hover:bg-yellow-100 transition-colors"
                    >
                      ⏸ Pause
                    </button>
                  )}
                  {c.status === 'paused' && (
                    <button
                      onClick={e => { e.stopPropagation(); statusMutation.mutate({ id: c.id, status: 'active' }) }}
                      disabled={statusMutation.isPending}
                      title="Resume campaign"
                      className="px-2.5 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                    >
                      ▶ Resume
                    </button>
                  )}
                  {c.status === 'draft' && (
                    <button
                      onClick={e => { e.stopPropagation(); statusMutation.mutate({ id: c.id, status: 'active' }) }}
                      disabled={statusMutation.isPending}
                      title="Activate campaign"
                      className="px-2.5 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors"
                    >
                      ▶ Activate
                    </button>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); duplicateMutation.mutate(c) }}
                    disabled={duplicateMutation.isPending}
                    title="Duplicate campaign"
                    className="px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    ⧉ Copy
                  </button>
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      if (confirm(`Delete "${c.name}"? This cannot be undone.`)) {
                        deleteMutation.mutate(c.id)
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    title="Delete campaign"
                    className="px-2.5 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                  >
                    ✕ Delete
                  </button>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-300 ml-1 transition-colors">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-200 group-hover:opacity-0 shrink-0 ml-4 transition-opacity absolute right-6">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <NewCampaignModal
          onClose={() => setShowModal(false)}
          onSubmit={name => mutation.mutate(name)}
          isLoading={mutation.isPending}
          error={mutation.error?.message ?? null}
        />
      )}
    </div>
  )
}

function NewCampaignModal({
  onClose,
  onSubmit,
  isLoading,
  error,
}: {
  onClose: () => void
  onSubmit: (name: string) => void
  isLoading: boolean
  error: string | null
}) {
  const { register, handleSubmit, formState: { errors } } = useForm<{ name: string }>()

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900">New Campaign</h2>
        <form onSubmit={handleSubmit(d => onSubmit(d.name))} className="mt-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Campaign name</label>
            <input
              type="text"
              autoFocus
              className="w-full px-3.5 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g. Q2 SaaS Founders Outreach"
              {...register('name', { required: 'Name is required' })}
            />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {isLoading ? 'Creating…' : 'Create Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
