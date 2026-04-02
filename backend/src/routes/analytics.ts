import { Router } from 'express'
import type { Request, Response } from 'express'
import { supabase } from '../lib/supabase'
import { requireAuth } from '../middleware/auth'

export const analyticsRouter = Router()
analyticsRouter.use(requireAuth)

// GET /api/analytics — overview stats + per-campaign breakdown
analyticsRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.user.id

  const [
    campaignsRes,
    leadsRes,
    accountsRes,
    campaignLeadsRes,
  ] = await Promise.all([
    supabase.from('campaigns').select('id, name, status').eq('user_id', userId),
    supabase.from('leads').select('id, icp_flag', { count: 'exact' }).eq('user_id', userId),
    supabase.from('linkedin_accounts').select('id, linkedin_email, status, daily_connection_count, daily_message_count, warmup_day, last_active_at').eq('user_id', userId),
    supabase.from('campaign_leads').select(`
      id, status, reply_classification,
      campaign:campaigns!inner (id, name, user_id)
    `).eq('campaign.user_id', userId),
  ])

  const campaigns = campaignsRes.data ?? []
  const allCampaignLeads = ((campaignLeadsRes.data ?? []) as unknown) as Array<{
    id: string
    status: string
    reply_classification: string
    campaign: { id: string; name: string; user_id: string }
  }>

  // Per-campaign breakdown
  const campaignStats = campaigns.map(c => {
    const cls = allCampaignLeads.filter(cl => cl.campaign?.id === c.id)
    const total            = cls.length
    const connection_sent  = cls.filter(cl => ['connection_sent','connected','messaged','replied','converted'].includes(cl.status)).length
    const connected        = cls.filter(cl => ['connected','messaged','replied','converted'].includes(cl.status)).length
    const messaged         = cls.filter(cl => ['messaged','replied','converted'].includes(cl.status)).length
    const replied          = cls.filter(cl => ['replied','converted'].includes(cl.status)).length
    const converted        = cls.filter(cl => cl.status === 'converted').length
    const acceptance_rate  = connection_sent > 0 ? Math.round((connected / connection_sent) * 100) : 0
    const reply_rate       = messaged > 0 ? Math.round((replied / messaged) * 100) : 0

    const by_classification: Record<string, number> = {}
    for (const cl of cls.filter(cl => cl.reply_classification !== 'none')) {
      by_classification[cl.reply_classification] = (by_classification[cl.reply_classification] ?? 0) + 1
    }

    return {
      id: c.id,
      name: c.name,
      status: c.status,
      total,
      connection_sent,
      connected,
      messaged,
      replied,
      converted,
      acceptance_rate,
      reply_rate,
      by_classification,
    }
  })

  // Overall totals
  const totalLeads       = leadsRes.count ?? 0
  const totalConnections = allCampaignLeads.filter(cl => ['connection_sent','connected','messaged','replied','converted'].includes(cl.status)).length
  const totalReplies     = allCampaignLeads.filter(cl => ['replied','converted'].includes(cl.status)).length
  const totalConverted   = allCampaignLeads.filter(cl => cl.status === 'converted').length

  // Lead ICP breakdown
  const leads = (leadsRes.data ?? []) as Array<{ id: string; icp_flag: string | null }>
  const icp_breakdown = {
    hot:          leads.filter(l => l.icp_flag === 'hot').length,
    warm:         leads.filter(l => l.icp_flag === 'warm').length,
    cold:         leads.filter(l => l.icp_flag === 'cold').length,
    disqualified: leads.filter(l => l.icp_flag === 'disqualified').length,
    unscored:     leads.filter(l => !l.icp_flag).length,
  }

  res.json({
    overview: {
      active_campaigns: campaigns.filter(c => c.status === 'active').length,
      total_campaigns:  campaigns.length,
      total_leads:      totalLeads,
      total_connections: totalConnections,
      total_replies:    totalReplies,
      total_converted:  totalConverted,
    },
    icp_breakdown,
    accounts: accountsRes.data ?? [],
    campaigns: campaignStats,
  })
})
