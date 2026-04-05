import Anthropic from '@anthropic-ai/sdk'
import type { IcpFlag } from '../types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface LeadProfile {
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  industry: string | null
  location: string | null
  connection_degree: number | null
}

export interface ProductScore {
  score: number
  flag: IcpFlag
  reasoning: string
}

export interface QualifyResult {
  score: number      // 0-100 (best product score, or overall if no products)
  flag: IcpFlag
  reasoning: string
  product_scores?: Record<string, ProductScore>   // keyed by product.id
  best_product_id?: string
}

interface Product {
  id?: string
  name: string
  description: string
  target_use_case: string
}

interface CustomCriterion {
  id?: string
  label: string
  description: string
  weight: 'must_have' | 'nice_to_have' | 'disqualifier'
}

interface IcpConfig {
  target_titles?: string[]
  target_industries?: string[]
  target_locations?: string[]
  min_company_size?: number | null
  max_company_size?: number | null
  notes?: string
  products_services?: Product[]
  custom_criteria?: CustomCriterion[]
}

function buildPrompt(lead: LeadProfile, icp: IcpConfig): string {
  const lines: string[] = []

  lines.push('You are an expert B2B sales qualification assistant.')
  lines.push('Evaluate the following lead against the ICP (Ideal Customer Profile) criteria and return a qualification score.')
  lines.push('')

  // ── Lead profile ──
  lines.push('## Lead Profile')
  lines.push(`- Name: ${lead.first_name} ${lead.last_name}`)
  lines.push(`- Title: ${lead.title ?? 'Unknown'}`)
  lines.push(`- Company: ${lead.company ?? 'Unknown'}`)
  lines.push(`- Industry: ${lead.industry ?? 'Unknown'}`)
  lines.push(`- Location: ${lead.location ?? 'Unknown'}`)
  lines.push(`- Connection Degree: ${lead.connection_degree ?? 'Unknown'}`)
  lines.push('')

  // ── Target audience ──
  lines.push('## Target Audience Criteria')
  if (icp.target_titles?.length) {
    lines.push(`- Target titles: ${icp.target_titles.join(', ')}`)
  }
  if (icp.target_industries?.length) {
    lines.push(`- Target industries: ${icp.target_industries.join(', ')}`)
  }
  if (icp.target_locations?.length) {
    lines.push(`- Target locations: ${icp.target_locations.join(', ')}`)
  }
  if (icp.min_company_size != null || icp.max_company_size != null) {
    const min = icp.min_company_size ?? 1
    const max = icp.max_company_size ?? '∞'
    lines.push(`- Company size: ${min}–${max} employees`)
  }
  lines.push('')

  // ── Products & services ──
  // Products with IDs use per-product scoring; those without fall back to single-score mode.
  const productsWithIds = (icp.products_services ?? []).filter(p => p.name && p.id)
  const productsNoId    = (icp.products_services ?? []).filter(p => p.name && !p.id)

  if (productsWithIds.length > 0) {
    lines.push('## Products & Services We Sell')
    lines.push('You will score this lead SEPARATELY for each product. Each product has a unique [PRODUCT_ID] tag.')
    for (const p of productsWithIds) {
      lines.push('')
      lines.push(`### ${p.name} [PRODUCT_ID: ${p.id!}]`)
      if (p.description) lines.push(`Description: ${p.description}`)
      if (p.target_use_case) lines.push(`Ideal customer: ${p.target_use_case}`)
    }
    lines.push('')
  } else if (productsNoId.length > 0) {
    lines.push('## Products & Services We Sell')
    lines.push('Use this to assess whether the lead is likely to have a need for what we offer.')
    for (const p of productsNoId) {
      lines.push('')
      lines.push(`### ${p.name}`)
      if (p.description) lines.push(`Description: ${p.description}`)
      if (p.target_use_case) lines.push(`Ideal customer: ${p.target_use_case}`)
    }
    lines.push('')
  }

  // ── Custom criteria ──
  if (icp.custom_criteria?.length) {
    const mustHave    = icp.custom_criteria.filter(c => c.weight === 'must_have' && c.label)
    const niceToHave  = icp.custom_criteria.filter(c => c.weight === 'nice_to_have' && c.label)
    const disqualify  = icp.custom_criteria.filter(c => c.weight === 'disqualifier' && c.label)

    lines.push('## Custom Qualification Criteria')

    if (disqualify.length) {
      lines.push('')
      lines.push('### Disqualifiers (if any apply, score must be < 25 and flag must be "disqualified"):')
      for (const c of disqualify) {
        lines.push(`- ${c.label}${c.description ? ': ' + c.description : ''}`)
      }
    }

    if (mustHave.length) {
      lines.push('')
      lines.push('### Must Have (heavily penalise if missing — reduce score significantly):')
      for (const c of mustHave) {
        lines.push(`- ${c.label}${c.description ? ': ' + c.description : ''}`)
      }
    }

    if (niceToHave.length) {
      lines.push('')
      lines.push('### Nice to Have (boost score if present, small penalty if absent):')
      for (const c of niceToHave) {
        lines.push(`- ${c.label}${c.description ? ': ' + c.description : ''}`)
      }
    }

    lines.push('')
  }

  // ── Additional notes ──
  if (icp.notes?.trim()) {
    lines.push('## Additional Notes')
    lines.push(icp.notes.trim())
    lines.push('')
  }

  // ── Scoring instructions ──
  lines.push('## Scoring Instructions')
  lines.push('Flag rules: "hot" ≥ 75 · "warm" ≥ 50 · "cold" ≥ 25 · "disqualified" < 25 or if any disqualifier applies')
  lines.push('')

  if (productsWithIds.length > 0) {
    // Per-product output format
    lines.push('Score this lead separately for EACH product using the ICP criteria above.')
    lines.push('Use the exact product IDs shown in the [PRODUCT_ID: ...] tags.')
    lines.push('')
    lines.push('Respond ONLY with valid JSON (no markdown fences, no extra text):')
    lines.push('{')
    lines.push('  "product_scores": {')
    productsWithIds.forEach((p, i) => {
      const comma = i < productsWithIds.length - 1 ? ',' : ''
      lines.push(`    "${p.id!}": { "score": <0-100>, "flag": "<hot|warm|cold|disqualified>", "reasoning": "<1 sentence>" }${comma}`)
    })
    lines.push('  }')
    lines.push('}')
  } else {
    // Single overall score
    lines.push('Score this lead from 0 to 100 based on overall ICP fit.')
    lines.push('')
    lines.push('Respond ONLY with valid JSON (no markdown, no extra text):')
    lines.push('{')
    lines.push('  "score": <number 0-100>,')
    lines.push('  "flag": "<hot|warm|cold|disqualified>",')
    lines.push('  "reasoning": "<1-2 sentence explanation>"')
    lines.push('}')
  }

  return lines.join('\n')
}

export async function qualifyLead(
  lead: LeadProfile,
  icpConfig: Record<string, unknown>
): Promise<QualifyResult> {
  const icp = icpConfig as IcpConfig
  const hasPerProductScoring = (icp.products_services ?? []).some(p => p.name && p.id)

  const prompt = buildPrompt(lead, icp)

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: hasPerProductScoring ? 1024 : 256,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

  if (hasPerProductScoring) {
    // Per-product response: { product_scores: { [id]: { score, flag, reasoning } } }
    const parsed = JSON.parse(json) as { product_scores: Record<string, ProductScore> }
    const productScores = parsed.product_scores

    // Clamp scores
    for (const id of Object.keys(productScores)) {
      productScores[id].score = Math.max(0, Math.min(100, Math.round(productScores[id].score)))
    }

    // Find best product (highest score)
    let bestProductId = ''
    let bestScore = -1
    for (const [id, ps] of Object.entries(productScores)) {
      if (ps.score > bestScore) {
        bestScore = ps.score
        bestProductId = id
      }
    }

    const best = productScores[bestProductId]
    return {
      score: best.score,
      flag: best.flag,
      reasoning: best.reasoning,
      product_scores: productScores,
      best_product_id: bestProductId,
    }
  }

  // Single-score fallback
  const result = JSON.parse(json) as QualifyResult
  result.score = Math.max(0, Math.min(100, Math.round(result.score)))
  return result
}
