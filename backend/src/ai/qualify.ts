import Anthropic from '@anthropic-ai/sdk'
import type { IcpFlag } from '../types'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

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

interface CustomCriterion {
  id?: string
  label: string
  description: string
  weight: 'must_have' | 'nice_to_have' | 'disqualifier'
}

interface Product {
  id?: string
  name: string
  description: string
  target_use_case: string
  // Target audience now lives per-product
  target_titles?: string[]
  target_industries?: string[]
  target_locations?: string[]
  min_company_size?: number | null
  max_company_size?: number | null
  custom_criteria?: CustomCriterion[]
}

interface IcpConfig {
  notes?: string
  products_services?: Product[]
  // Legacy fields — still accepted but products take precedence
  target_titles?: string[]
  target_industries?: string[]
  target_locations?: string[]
  min_company_size?: number | null
  max_company_size?: number | null
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

  // ── Products & services ──
  // Each product now carries its own target audience. Score the lead separately per product.
  // Fall back to legacy global criteria if products have none.
  const productsWithIds = (icp.products_services ?? []).filter(p => p.name && p.id)
  const productsNoId    = (icp.products_services ?? []).filter(p => p.name && !p.id)

  function productAudienceLines(p: Product): string[] {
    const out: string[] = []
    // Prefer product-level audience; fall back to global icp fields for legacy data
    const titles     = toArr(p.target_titles)     || toArr(icp.target_titles)
    const industries = toArr(p.target_industries) || toArr(icp.target_industries)
    const locations  = toArr(p.target_locations)  || toArr(icp.target_locations)
    const minSize    = p.min_company_size ?? icp.min_company_size ?? null
    const maxSize    = p.max_company_size ?? icp.max_company_size ?? null
    const criteria   = p.custom_criteria?.length ? p.custom_criteria : (icp.custom_criteria ?? [])

    if (titles.length)     out.push(`  Target titles: ${titles.join(', ')}`)
    if (industries.length) out.push(`  Target industries: ${industries.join(', ')}`)
    if (locations.length)  out.push(`  Target locations: ${locations.join(', ')}`)
    if (minSize != null || maxSize != null) {
      out.push(`  Company size: ${minSize ?? 1}–${maxSize ?? '∞'} employees`)
    }

    const disq    = criteria.filter(c => c.weight === 'disqualifier' && c.label)
    const must    = criteria.filter(c => c.weight === 'must_have' && c.label)
    const nice    = criteria.filter(c => c.weight === 'nice_to_have' && c.label)
    if (disq.length) out.push(`  Disqualifiers: ${disq.map(c => c.label).join('; ')}`)
    if (must.length) out.push(`  Must have: ${must.map(c => c.label).join('; ')}`)
    if (nice.length) out.push(`  Nice to have: ${nice.map(c => c.label).join('; ')}`)

    return out
  }

  if (productsWithIds.length > 0) {
    lines.push('## Products & Services We Sell')
    lines.push('Score this lead SEPARATELY for each product using that product\'s own audience criteria.')
    lines.push('Each product has a unique [PRODUCT_ID] tag.')
    for (const p of productsWithIds) {
      lines.push('')
      lines.push(`### ${p.name} [PRODUCT_ID: ${p.id!}]`)
      if (p.description) lines.push(`  Description: ${p.description}`)
      if (p.target_use_case) lines.push(`  Ideal customer: ${p.target_use_case}`)
      const audience = productAudienceLines(p)
      if (audience.length) {
        lines.push('  Target audience for this product:')
        audience.forEach(l => lines.push(l))
      }
    }
    lines.push('')
  } else if (productsNoId.length > 0) {
    lines.push('## Products & Services We Sell')
    for (const p of productsNoId) {
      lines.push('')
      lines.push(`### ${p.name}`)
      if (p.description) lines.push(`  Description: ${p.description}`)
      if (p.target_use_case) lines.push(`  Ideal customer: ${p.target_use_case}`)
      const audience = productAudienceLines(p)
      audience.forEach(l => lines.push(l))
    }
    lines.push('')
  } else {
    // No products defined — fall back to global audience criteria
    const titles     = toArr(icp.target_titles)
    const industries = toArr(icp.target_industries)
    const locations  = toArr(icp.target_locations)
    if (titles.length || industries.length || locations.length || icp.min_company_size != null || icp.max_company_size != null) {
      lines.push('## Target Audience Criteria')
      if (titles.length)     lines.push(`- Target titles: ${titles.join(', ')}`)
      if (industries.length) lines.push(`- Target industries: ${industries.join(', ')}`)
      if (locations.length)  lines.push(`- Target locations: ${locations.join(', ')}`)
      if (icp.min_company_size != null || icp.max_company_size != null) {
        lines.push(`- Company size: ${icp.min_company_size ?? 1}–${icp.max_company_size ?? '∞'} employees`)
      }
      lines.push('')
    }
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

function toArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim()) return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

export async function qualifyLead(
  lead: LeadProfile,
  icpConfig: Record<string, unknown>
): Promise<QualifyResult> {
  const raw = icpConfig as IcpConfig
  const icp: IcpConfig = {
    ...raw,
    // Normalise legacy top-level arrays (may be stored as comma-separated strings)
    target_titles:     toArr(raw.target_titles),
    target_industries: toArr(raw.target_industries),
    target_locations:  toArr(raw.target_locations),
    // Normalise per-product audience arrays too
    products_services: (raw.products_services ?? []).map(p => ({
      ...p,
      target_titles:     toArr(p.target_titles),
      target_industries: toArr(p.target_industries),
      target_locations:  toArr(p.target_locations),
    })),
  }
  const hasPerProductScoring = (icp.products_services ?? []).some(p => p.name && p.id)

  const prompt = buildPrompt(lead, icp)

  const message = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: hasPerProductScoring ? 1024 : 256,
    messages: [{ role: 'user', content: prompt }],
  })

  const rawText = (message.content[0] as { type: string; text: string }).text.trim()
  const json = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

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
