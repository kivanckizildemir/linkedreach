import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { fetchCampaigns, createCampaign } from '../api/campaigns'
import type { Campaign } from '../api/campaigns'

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

  const filtered = filter === 'all' ? campaigns : campaigns.filter(c => c.status === filter)

  const mutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] })
      setShowModal(false)
    },
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
                onClick={() => navigate(`/campaigns/${c.id}`)}
                className="px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors cursor-pointer"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{c.name}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Created {new Date(c.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_COLORS[c.status]}`}>
                    {c.status}
                  </span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-300">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
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
