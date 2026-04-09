/**
 * Campaign Fit Scoring
 *
 * Scores how well a lead matches a specific campaign's target audience and
 * selected products. Separate from the global ICP score.
 */

import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export interface CampaignFitResult {
  score: number       // 0–100
  reasoning: string  // 1-sentence explanation
}

export interface LeadSummary {
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  industry: string | null
  location: string | null
}

export interface CustomCriterion {
  id: string
  label: string
  description: string
  weight: 'must_have' | 'nice_to_have' | 'disqualifier'
}

export interface CampaignTargetParams {
  target_titles?: string[]
  target_industries?: string[]
  target_locations?: string[]
  min_company_size?: number | null
  max_company_size?: number | null
  selected_products?: Array<{ name: string; description?: string; target_use_case?: string }>
  custom_criteria?: CustomCriterion[]
  notes?: string
}

/** Safely coerce a value to string[] — handles stored-as-string edge cases */
function toArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim()) return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

export async function scoreCampaignFit(
  lead: LeadSummary,
  params: CampaignTargetParams,
): Promise<CampaignFitResult> {
  // Normalize array fields that may arrive as comma-separated strings
  params = {
    ...params,
    target_titles:     toArr(params.target_titles),
    target_industries: toArr(params.target_industries),
    target_locations:  toArr(params.target_locations),
  }

  const lines: string[] = []

  lines.push('You are a B2B sales expert scoring how well a lead matches a campaign\'s target criteria.')
  lines.push('')

  lines.push('## Lead')
  lines.push(`- Name: ${lead.first_name} ${lead.last_name}`)
  lines.push(`- Title: ${lead.title ?? 'Unknown'}`)
  lines.push(`- Company: ${lead.company ?? 'Unknown'}`)
  lines.push(`- Industry: ${lead.industry ?? 'Unknown'}`)
  lines.push(`- Location: ${lead.location ?? 'Unknown'}`)
  lines.push('')

  lines.push('## Campaign Target Criteria')

  if (params.target_titles?.length) {
    lines.push(`- Target titles: ${params.target_titles.join(', ')}`)
  }
  if (params.target_industries?.length) {
    lines.push(`- Target industries: ${params.target_industries.join(', ')}`)
  }
  if (params.target_locations?.length) {
    lines.push(`- Target locations: ${params.target_locations.join(', ')}`)
  }
  if (params.min_company_size != null || params.max_company_size != null) {
    const min = params.min_company_size ?? 1
    const max = params.max_company_size ?? '∞'
    lines.push(`- Company size: ${min}–${max} employees`)
  }

  if (params.selected_products?.length) {
    lines.push('')
    lines.push('## Products Being Promoted')
    for (const p of params.selected_products) {
      lines.push(`### ${p.name}`)
      if (p.target_use_case) lines.push(`  Ideal customer: ${p.target_use_case}`)
      if (p.description) lines.push(`  Description: ${p.description}`)
    }
  }

  if (params.custom_criteria?.length) {
    lines.push('')
    lines.push('## Custom Qualification Rules')
    for (const c of params.custom_criteria) {
      const weightLabel = c.weight === 'must_have' ? 'MUST HAVE' : c.weight === 'disqualifier' ? 'DISQUALIFIER' : 'Nice to Have'
      lines.push(`- [${weightLabel}] ${c.label}${c.description ? `: ${c.description}` : ''}`)
    }
  }

  if (params.notes?.trim()) {
    lines.push('')
    lines.push('## Additional Notes')
    lines.push(params.notes.trim())
  }

  lines.push('')
  lines.push('## Scoring')
  lines.push('Score 0–100 based on how well this lead fits the campaign criteria and would benefit from the promoted products.')
  lines.push('- 90–100: Perfect match')
  lines.push('- 70–89: Strong match')
  lines.push('- 50–69: Partial match')
  lines.push('- 25–49: Weak match')
  lines.push('- 0–24: Poor match')
  lines.push('')
  lines.push('Respond ONLY with valid JSON (no markdown):')
  lines.push('{"score": <0-100>, "reasoning": "<1 concise sentence>"}')

  const message = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{ role: 'user', content: lines.join('\n') }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const result = JSON.parse(json) as CampaignFitResult
  result.score = Math.max(0, Math.min(100, Math.round(result.score)))
  return result
}
