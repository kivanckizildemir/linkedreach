import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

async function fetchDashboardStats() {
  const [campaigns, leads, connectionsSent, replies] = await Promise.all([
    supabase.from('campaigns').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('leads').select('*', { count: 'exact', head: true }),
    supabase.from('campaign_leads').select('*', { count: 'exact', head: true })
      .in('status', ['connection_sent', 'connected', 'messaged', 'replied', 'converted']),
    supabase.from('campaign_leads').select('*', { count: 'exact', head: true })
      .in('status', ['replied', 'converted']),
  ])
  return {
    activeCampaigns: campaigns.count ?? 0,
    totalLeads: leads.count ?? 0,
    connectionsSent: connectionsSent.count ?? 0,
    replies: replies.count ?? 0,
  }
}

export function Dashboard() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: fetchDashboardStats,
  })

  const statCards = [
    { label: 'Active Campaigns', value: stats?.activeCampaigns },
    { label: 'Total Leads',      value: stats?.totalLeads },
    { label: 'Connections Sent', value: stats?.connectionsSent },
    { label: 'Replies',          value: stats?.replies },
  ]

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-1 text-sm text-gray-500">Overview of your outreach activity</p>

      <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map(({ label, value }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 p-6">
            <p className="text-sm font-medium text-gray-500">{label}</p>
            <p className="mt-2 text-3xl font-bold text-gray-900">
              {isLoading ? (
                <span className="inline-block w-8 h-7 bg-gray-200 rounded animate-pulse" />
              ) : (
                value
              )}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8 bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-base font-semibold text-gray-900">Getting Started</h2>
        <ol className="mt-4 space-y-3 text-sm text-gray-600 list-decimal list-inside">
          <li>Add a LinkedIn account under <strong>Accounts</strong></li>
          <li>Import leads from a Sales Navigator export under <strong>Leads</strong></li>
          <li>Create a campaign and build your outreach sequence under <strong>Campaigns</strong></li>
          <li>Monitor replies in the <strong>Inbox</strong></li>
        </ol>
      </div>
    </div>
  )
}
