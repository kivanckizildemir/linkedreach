import { Worker } from 'bullmq'
import { connection } from '../lib/queue'
import { supabase } from '../lib/supabase'
import { qualifyLead } from '../ai/qualify'

interface QualifyJob {
  lead_id: string
  user_id: string
}

export const qualifyWorker = new Worker<QualifyJob>(
  'qualify-leads',
  async (job) => {
    const { lead_id, user_id } = job.data

    // Fetch the lead + campaign ICP config for this user
    const { data: lead, error: leadErr } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .eq('user_id', user_id)
      .single()

    if (leadErr || !lead) {
      throw new Error(`Lead ${lead_id} not found`)
    }

    // Resolve list name or campaign name for logging
    let contextLabel = '(no list)'
    if (lead.list_id) {
      const { data: list } = await supabase
        .from('lead_lists')
        .select('name')
        .eq('id', lead.list_id)
        .single()
      contextLabel = list?.name ? `list="${list.name}"` : `list=${lead.list_id}`
    } else if (lead.campaign_id) {
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('name')
        .eq('id', lead.campaign_id)
        .single()
      contextLabel = campaign?.name ? `campaign="${campaign.name}"` : `campaign=${lead.campaign_id}`
    }

    const leadName = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || lead_id

    // Use user-level ICP config from settings, fallback to first active campaign's config
    const [settingsRes, campaignsRes] = await Promise.all([
      supabase.from('user_settings').select('icp_config').eq('user_id', user_id).maybeSingle(),
      supabase.from('campaigns').select('icp_config').eq('user_id', user_id).eq('status', 'active').limit(1),
    ])

    const icpConfig = settingsRes.data?.icp_config
      ?? campaignsRes.data?.[0]?.icp_config
      ?? {
        target_titles: ['CEO', 'CTO', 'VP', 'Director', 'Head of', 'Founder'],
        target_industries: [],
        target_locations: [],
        notes: 'Score based on seniority and decision-making authority.',
      }

    const result = await qualifyLead(
      {
        first_name: lead.first_name,
        last_name: lead.last_name,
        title: lead.title,
        company: lead.company,
        industry: lead.industry,
        location: lead.location,
        connection_degree: lead.connection_degree,
      },
      icpConfig as Record<string, unknown>
    )

    const rawDataUpdate: Record<string, unknown> = {
      ...(lead.raw_data as Record<string, unknown> ?? {}),
      ai_reasoning:    result.reasoning,
      ai_qualified_at: new Date().toISOString(),
      score_breakdown: result.score_breakdown,
    }
    if (result.product_scores) {
      rawDataUpdate.product_scores   = result.product_scores
      rawDataUpdate.best_product_id  = result.best_product_id
    }

    await supabase
      .from('leads')
      .update({
        icp_score: result.score,
        icp_flag:  result.flag,
        raw_data:  rawDataUpdate,
      })
      .eq('id', lead_id)

    const dims = result.score_breakdown.dimensions
    console.log(
      `[qualify] "${leadName}" [${contextLabel}]: score=${result.score} flag=${result.flag} ` +
      `(title=${dims.title_role.score}/${dims.title_role.max} ` +
      `industry=${dims.industry.score}/${dims.industry.max} ` +
      `location=${dims.location.score}/${dims.location.max} ` +
      `size=${dims.company_size.score}/${dims.company_size.max} ` +
      `criteria=${dims.custom_criteria.score}/${dims.custom_criteria.max})`
    )
    return result
  },
  {
    connection,
    // Keep concurrency low — Claude API allows 50 req/min; at ~2s per call,
    // concurrency 2 ≈ 60 req/min. The limiter below caps us safely at 40/min.
    concurrency: 2,
    limiter: {
      max: 40,
      duration: 60_000,
    },
  }
)

qualifyWorker.on('failed', (job, err) => {
  console.error(`[qualify] Job ${job?.id} failed:`, err.message)
})
