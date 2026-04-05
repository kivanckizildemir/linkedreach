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
      ai_reasoning: result.reasoning,
      ai_qualified_at: new Date().toISOString(),
    }
    if (result.product_scores) {
      rawDataUpdate.product_scores = result.product_scores
      rawDataUpdate.best_product_id = result.best_product_id
    }

    await supabase
      .from('leads')
      .update({
        icp_score: result.score,
        icp_flag: result.flag,
        raw_data: rawDataUpdate,
      })
      .eq('id', lead_id)

    console.log(`[qualify] Lead ${lead_id}: score=${result.score} flag=${result.flag}`)
    return result
  },
  {
    connection,
    concurrency: 3,
  }
)

qualifyWorker.on('failed', (job, err) => {
  console.error(`[qualify] Job ${job?.id} failed:`, err.message)
})
