/**
 * ICP Qualification — Structured Scoring
 *
 * Instead of asking Claude for a single opaque 0–100 score, we decompose
 * qualification into five independent dimensions. Claude evaluates each
 * dimension (and each custom criterion) separately; the backend computes
 * the final score deterministically from those evaluations.
 *
 * This eliminates score drift caused by temperature and holistic judgment:
 *   • temperature: 0         → same input always produces same output
 *   • dimension scoring      → AI cannot compensate one weakness with another
 *   • backend aggregation    → arithmetic, not AI opinion, sets the final number
 *   • explicit rubrics       → Claude has anchored scale for every dimension
 *
 * Dimension weights (sum to 100):
 *   title_role      30 pts  — most important: are they a buyer / champion?
 *   industry        20 pts  — does their sector need this product?
 *   location        10 pts  — geo fit
 *   company_size    10 pts  — headcount / ARR fit
 *   custom_criteria 30 pts  — must-haves 20 pts, nice-to-haves 10 pts
 *
 * If a dimension has no criteria configured: neutral (half max) is applied
 * by the backend without involving the AI.
 *
 * Hard disqualifier rule: if any disqualifier criterion is triggered by
 * the AI, the lead is immediately flagged "disqualified" regardless of totals.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { IcpFlag } from '../types'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface LeadProfile {
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  industry: string | null
  location: string | null
  connection_degree: number | null
}

/** One scored dimension returned in the final result */
export interface ScoringDimension {
  score:      number   // actual points awarded
  max:        number   // max possible for this dimension
  reasoning:  string   // why this score was given
  configured: boolean  // false = neutral applied, no criteria existed
}

/** Per-criterion evaluation for custom_criteria dimension */
export interface CriterionEval {
  label:      string
  met?:       boolean    // used by must_haves and nice_to_haves
  triggered?: boolean    // used by disqualifiers
  reasoning:  string
}

/** Full breakdown stored in raw_data.score_breakdown */
export interface ScoringBreakdown {
  dimensions: {
    title_role:      ScoringDimension
    industry:        ScoringDimension
    location:        ScoringDimension
    company_size:    ScoringDimension
    custom_criteria: ScoringDimension
  }
  criteria_detail: {
    must_haves:   CriterionEval[]
    nice_to_haves: CriterionEval[]
    disqualifiers: CriterionEval[]
  }
  disqualified:        boolean
  disqualifier_reason: string | null
}

export interface ProductScore {
  score:         number
  flag:          IcpFlag
  reasoning:     string
  breakdown?:    ScoringBreakdown
}

export interface QualifyResult {
  score:           number        // 0-100, backend-computed
  flag:            IcpFlag
  reasoning:       string        // 1-sentence summary
  score_breakdown: ScoringBreakdown
  product_scores?:  Record<string, ProductScore>   // keyed by product.id
  best_product_id?: string
}

// ── Internal types ────────────────────────────────────────────────────────────

interface CustomCriterion {
  id?:         string
  label:       string
  description: string
  weight:      'must_have' | 'nice_to_have' | 'disqualifier'
}

interface Product {
  id?:                string
  name:               string
  description:        string
  target_use_case:    string
  target_titles?:     string[]
  target_industries?: string[]
  target_locations?:  string[]
  min_company_size?:  number | null
  max_company_size?:  number | null
  custom_criteria?:   CustomCriterion[]
}

interface IcpConfig {
  notes?:              string
  products_services?:  Product[]
  // Legacy global fields
  target_titles?:      string[]
  target_industries?:  string[]
  target_locations?:   string[]
  min_company_size?:   number | null
  max_company_size?:   number | null
  custom_criteria?:    CustomCriterion[]
}

/** Resolved, normalised criteria for a single scoring pass */
interface ScoringCriteria {
  titles:      string[]
  industries:  string[]
  locations:   string[]
  minSize:     number | null
  maxSize:     number | null
  must_haves:  CustomCriterion[]
  nice_to_haves: CustomCriterion[]
  disqualifiers: CustomCriterion[]
  notes:       string
}

// Dimension max points — must sum to 100
const DIM = {
  title_role:      30,
  industry:        20,
  location:        10,
  company_size:    10,
  custom_criteria: 30,   // 20 must-haves + 10 nice-to-haves
} as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function toArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim()) return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

/** Returns the array only if it has items, otherwise null — safe for ?? fallback */
function nonEmpty(v: unknown): string[] | null {
  const arr = toArr(v)
  return arr.length > 0 ? arr : null
}

function neutralDimension(max: number): ScoringDimension {
  return {
    score:      Math.round(max / 2),
    max,
    reasoning:  'No criteria configured — neutral score applied',
    configured: false,
  }
}

function resolveFlag(score: number, disqualified: boolean): IcpFlag {
  if (disqualified || score < 25) return 'disqualified'
  if (score >= 75) return 'hot'
  if (score >= 50) return 'warm'
  return 'cold'
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(lead: LeadProfile, criteria: ScoringCriteria): string {
  const lines: string[] = []

  lines.push('You are a B2B sales qualification specialist. Score this lead against the ICP criteria below.')
  lines.push('Use the EXACT rubrics given for each dimension — do not deviate.')
  lines.push('')

  // Lead profile
  lines.push('## Lead Profile')
  lines.push(`- Name: ${lead.first_name} ${lead.last_name}`)
  lines.push(`- Title: ${lead.title ?? 'Unknown'}`)
  lines.push(`- Company: ${lead.company ?? 'Unknown'}`)
  lines.push(`- Industry: ${lead.industry ?? 'Unknown'}`)
  lines.push(`- Location: ${lead.location ?? 'Unknown'}`)
  if (lead.connection_degree != null) {
    lines.push(`- Connection degree: ${lead.connection_degree}°`)
  }
  lines.push('')

  if (criteria.notes.trim()) {
    lines.push('## Additional Context')
    lines.push(criteria.notes.trim())
    lines.push('')
  }

  // ── Dimension 1: Title / Role ──────────────────────────────────────────────
  if (criteria.titles.length > 0) {
    lines.push('## Dimension 1 — Title / Role Match (max 30 pts)')
    lines.push(`Target titles: ${criteria.titles.join(', ')}`)
    lines.push('Rubric:')
    lines.push('  26-30: Exact or equivalent match; lead clearly holds the authority implied by target titles')
    lines.push('  18-25: Strong match; similar seniority or function; likely champion or decision-maker')
    lines.push('  8-17 : Partial match; related function but not ideal seniority or scope')
    lines.push('  1-7  : Weak match; peripheral role; unlikely to drive a purchase')
    lines.push('  0    : No relevance; completely different function')
    lines.push('')
  }

  // ── Dimension 2: Industry ──────────────────────────────────────────────────
  if (criteria.industries.length > 0) {
    lines.push('## Dimension 2 — Industry Match (max 20 pts)')
    lines.push(`Target industries: ${criteria.industries.join(', ')}`)
    lines.push('Rubric:')
    lines.push('  17-20: Lead\'s industry exactly matches one of the target industries')
    lines.push('  11-16: Adjacent or closely related industry; strong likelihood of fit')
    lines.push('  4-10 : Loosely related; product could apply but not primary market')
    lines.push('  0-3  : Unrelated industry; unlikely to need this product')
    lines.push('')
  }

  // ── Dimension 3: Location ──────────────────────────────────────────────────
  if (criteria.locations.length > 0) {
    lines.push('## Dimension 3 — Location Match (max 10 pts)')
    lines.push(`Target locations: ${criteria.locations.join(', ')}`)
    lines.push('Rubric:')
    lines.push('  9-10: Exact location or country match')
    lines.push('  6-8 : Same region (e.g., EMEA, APAC)')
    lines.push('  3-5 : Nearby or adjacent region')
    lines.push('  0-2 : Different region; no geographic fit')
    lines.push('')
  }

  // ── Dimension 4: Company Size ──────────────────────────────────────────────
  if (criteria.minSize != null || criteria.maxSize != null) {
    const min = criteria.minSize ?? 1
    const max = criteria.maxSize ?? '∞'
    lines.push('## Dimension 4 — Company Size Match (max 10 pts)')
    lines.push(`Target headcount: ${min}–${max} employees`)
    lines.push('Rubric:')
    lines.push('  9-10: Company size falls within the target range')
    lines.push('  5-8 : Close to range (within ~30% of boundary)')
    lines.push('  0-4 : Outside range — too small or too large')
    lines.push('Note: If company size is unknown, score 5.')
    lines.push('')
  }

  // ── Dimension 5: Custom Criteria ───────────────────────────────────────────
  const hasCriteria =
    criteria.must_haves.length > 0 ||
    criteria.nice_to_haves.length > 0 ||
    criteria.disqualifiers.length > 0

  if (hasCriteria) {
    lines.push('## Dimension 5 — Custom Criteria')
    lines.push('For each criterion below, determine whether it applies to this lead.')
    lines.push('Output a boolean `met` (true/false) and a one-sentence `reasoning`.')
    lines.push('')

    if (criteria.disqualifiers.length > 0) {
      lines.push('### Disqualifiers — if ANY is triggered, the lead is disqualified regardless of other scores')
      criteria.disqualifiers.forEach(c => {
        lines.push(`- "${c.label}": ${c.description}`)
      })
      lines.push('')
    }
    if (criteria.must_haves.length > 0) {
      lines.push('### Must-haves — together worth up to 20 pts; each miss reduces the score proportionally')
      criteria.must_haves.forEach(c => {
        lines.push(`- "${c.label}": ${c.description}`)
      })
      lines.push('')
    }
    if (criteria.nice_to_haves.length > 0) {
      lines.push('### Nice-to-haves — together worth up to 10 pts; each hit adds proportional points')
      criteria.nice_to_haves.forEach(c => {
        lines.push(`- "${c.label}": ${c.description}`)
      })
      lines.push('')
    }
  }

  // ── Output format ──────────────────────────────────────────────────────────
  lines.push('## Output Format')
  lines.push('Respond ONLY with valid JSON — no markdown fences, no extra text.')
  lines.push('{')

  const dimFields: string[] = []
  if (criteria.titles.length > 0) {
    dimFields.push('    "title_role":    { "score": <0-30>, "reasoning": "<one sentence>" }')
  }
  if (criteria.industries.length > 0) {
    dimFields.push('    "industry":      { "score": <0-20>, "reasoning": "<one sentence>" }')
  }
  if (criteria.locations.length > 0) {
    dimFields.push('    "location":      { "score": <0-10>, "reasoning": "<one sentence>" }')
  }
  if (criteria.minSize != null || criteria.maxSize != null) {
    dimFields.push('    "company_size":  { "score": <0-10>, "reasoning": "<one sentence>" }')
  }

  if (dimFields.length > 0) {
    lines.push('  "dimensions": {')
    lines.push(dimFields.join(',\n'))
    lines.push('  },')
  } else {
    lines.push('  "dimensions": {},')
  }

  if (hasCriteria) {
    lines.push('  "custom_criteria": {')
    if (criteria.disqualifiers.length > 0) {
      lines.push('    "disqualifiers": [')
      lines.push(criteria.disqualifiers.map(c =>
        `      { "label": ${JSON.stringify(c.label)}, "triggered": <true|false>, "reasoning": "<one sentence>" }`
      ).join(',\n'))
      lines.push('    ],')
    } else {
      lines.push('    "disqualifiers": [],')
    }
    if (criteria.must_haves.length > 0) {
      lines.push('    "must_haves": [')
      lines.push(criteria.must_haves.map(c =>
        `      { "label": ${JSON.stringify(c.label)}, "met": <true|false>, "reasoning": "<one sentence>" }`
      ).join(',\n'))
      lines.push('    ],')
    } else {
      lines.push('    "must_haves": [],')
    }
    if (criteria.nice_to_haves.length > 0) {
      lines.push('    "nice_to_haves": [')
      lines.push(criteria.nice_to_haves.map(c =>
        `      { "label": ${JSON.stringify(c.label)}, "met": <true|false>, "reasoning": "<one sentence>" }`
      ).join(',\n'))
      lines.push('    ]')
    } else {
      lines.push('    "nice_to_haves": []')
    }
    lines.push('  },')
  } else {
    lines.push('  "custom_criteria": { "disqualifiers": [], "must_haves": [], "nice_to_haves": [] },')
  }

  lines.push('  "overall_reasoning": "<1-2 sentences summarising fit>"')
  lines.push('}')

  return lines.join('\n')
}

// ── Score aggregator ──────────────────────────────────────────────────────────

interface ClaudeResponse {
  dimensions: {
    title_role?:   { score: number; reasoning: string }
    industry?:     { score: number; reasoning: string }
    location?:     { score: number; reasoning: string }
    company_size?: { score: number; reasoning: string }
  }
  custom_criteria: {
    disqualifiers:  Array<{ label: string; triggered: boolean; reasoning: string }>
    must_haves:     Array<{ label: string; met: boolean; reasoning: string }>
    nice_to_haves:  Array<{ label: string; met: boolean; reasoning: string }>
  }
  overall_reasoning: string
}

function aggregateScore(
  resp: ClaudeResponse,
  criteria: ScoringCriteria
): ScoringBreakdown & { total: number; reasoning: string } {
  const d = resp.dimensions

  // ── 1. Title / Role ───────────────────────────────────────────────────────
  const titleDim: ScoringDimension = criteria.titles.length > 0 && d.title_role
    ? {
        score:      Math.max(0, Math.min(DIM.title_role, Math.round(d.title_role.score))),
        max:        DIM.title_role,
        reasoning:  d.title_role.reasoning,
        configured: true,
      }
    : neutralDimension(DIM.title_role)

  // ── 2. Industry ───────────────────────────────────────────────────────────
  const industryDim: ScoringDimension = criteria.industries.length > 0 && d.industry
    ? {
        score:      Math.max(0, Math.min(DIM.industry, Math.round(d.industry.score))),
        max:        DIM.industry,
        reasoning:  d.industry.reasoning,
        configured: true,
      }
    : neutralDimension(DIM.industry)

  // ── 3. Location ───────────────────────────────────────────────────────────
  const locationDim: ScoringDimension = criteria.locations.length > 0 && d.location
    ? {
        score:      Math.max(0, Math.min(DIM.location, Math.round(d.location.score))),
        max:        DIM.location,
        reasoning:  d.location.reasoning,
        configured: true,
      }
    : neutralDimension(DIM.location)

  // ── 4. Company Size ───────────────────────────────────────────────────────
  const sizeDim: ScoringDimension =
    (criteria.minSize != null || criteria.maxSize != null) && d.company_size
      ? {
          score:      Math.max(0, Math.min(DIM.company_size, Math.round(d.company_size.score))),
          max:        DIM.company_size,
          reasoning:  d.company_size.reasoning,
          configured: true,
        }
      : neutralDimension(DIM.company_size)

  // ── 5. Custom Criteria ────────────────────────────────────────────────────
  const cc = resp.custom_criteria

  // Disqualifiers — any triggered → disqualified
  const triggeredDisqualifier = cc.disqualifiers.find(c => c.triggered)

  // Must-haves — each worth (20 / total_must_haves) points
  let mustScore = DIM.custom_criteria - 10   // start at 20; nice-to-haves get remaining 10
  if (criteria.must_haves.length > 0) {
    const perMust = 20 / criteria.must_haves.length
    const metCount = cc.must_haves.filter(c => c.met).length
    mustScore = Math.round(perMust * metCount)
  }

  // Nice-to-haves — each worth (10 / total_nice_to_haves) points
  let niceScore = 0
  if (criteria.nice_to_haves.length > 0) {
    const perNice = 10 / criteria.nice_to_haves.length
    const metCount = cc.nice_to_haves.filter(c => c.met).length
    niceScore = Math.round(perNice * metCount)
  } else if (criteria.must_haves.length === 0 && criteria.disqualifiers.length === 0) {
    // No criteria at all — neutral
    niceScore = 0
  } else {
    // Nice-to-haves not configured but others are — give full nice-to-have points
    niceScore = 10
  }

  const criteriaDim: ScoringDimension = {
    score: triggeredDisqualifier
      ? 0
      : criteria.must_haves.length === 0 && criteria.nice_to_haves.length === 0 && criteria.disqualifiers.length === 0
        ? neutralDimension(DIM.custom_criteria).score
        : Math.min(DIM.custom_criteria, mustScore + niceScore),
    max:        DIM.custom_criteria,
    reasoning:  triggeredDisqualifier
      ? `Disqualified: ${triggeredDisqualifier.reasoning}`
      : `Must-haves: ${cc.must_haves.filter(c => c.met).length}/${criteria.must_haves.length} met · Nice-to-haves: ${cc.nice_to_haves.filter(c => c.met).length}/${criteria.nice_to_haves.length} met`,
    configured: criteria.must_haves.length > 0 || criteria.nice_to_haves.length > 0 || criteria.disqualifiers.length > 0,
  }

  // ── Final score ───────────────────────────────────────────────────────────
  const total = titleDim.score + industryDim.score + locationDim.score + sizeDim.score + criteriaDim.score
  const disqualified = !!triggeredDisqualifier

  return {
    dimensions: {
      title_role:      titleDim,
      industry:        industryDim,
      location:        locationDim,
      company_size:    sizeDim,
      custom_criteria: criteriaDim,
    },
    criteria_detail: {
      must_haves:   cc.must_haves,
      nice_to_haves: cc.nice_to_haves,
      disqualifiers: cc.disqualifiers,
    },
    disqualified,
    disqualifier_reason: triggeredDisqualifier
      ? `${triggeredDisqualifier.label}: ${triggeredDisqualifier.reasoning}`
      : null,
    total,
    reasoning: resp.overall_reasoning,
  }
}

// ── Core scoring function ─────────────────────────────────────────────────────

function resolveCriteria(product: Product, globalIcp: IcpConfig): ScoringCriteria {
  // Use nonEmpty() + ?? so an empty product array correctly falls back to global ICP.
  // Previously used || which treated [] as truthy, causing all products to score identically.
  const titles     = nonEmpty(product.target_titles)     ?? toArr(globalIcp.target_titles)
  const industries = nonEmpty(product.target_industries) ?? toArr(globalIcp.target_industries)
  const locations  = nonEmpty(product.target_locations)  ?? toArr(globalIcp.target_locations)
  const minSize    = product.min_company_size ?? globalIcp.min_company_size ?? null
  const maxSize    = product.max_company_size ?? globalIcp.max_company_size ?? null
  const rawCriteria = product.custom_criteria?.length
    ? product.custom_criteria
    : (globalIcp.custom_criteria ?? [])

  return {
    titles,
    industries,
    locations,
    minSize,
    maxSize,
    must_haves:   rawCriteria.filter(c => c.weight === 'must_have'),
    nice_to_haves: rawCriteria.filter(c => c.weight === 'nice_to_have'),
    disqualifiers: rawCriteria.filter(c => c.weight === 'disqualifier'),
    notes: globalIcp.notes ?? '',
  }
}

async function scoreOnce(
  lead: LeadProfile,
  criteria: ScoringCriteria
): Promise<ScoringBreakdown & { total: number; reasoning: string }> {
  const prompt = buildPrompt(lead, criteria)

  const message = await getClient().messages.create({
    model:       'claude-haiku-4-5-20251001',
    max_tokens:  1024,
    temperature: 0,   // deterministic — same input always produces same scores
    messages: [{ role: 'user', content: prompt }],
  })

  const rawText = (message.content[0] as { type: string; text: string }).text.trim()
  const json = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const parsed = JSON.parse(json) as ClaudeResponse

  return aggregateScore(parsed, criteria)
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function qualifyLead(
  lead: LeadProfile,
  icpConfig: Record<string, unknown>
): Promise<QualifyResult> {
  const raw = icpConfig as IcpConfig
  const globalIcp: IcpConfig = {
    ...raw,
    target_titles:     toArr(raw.target_titles),
    target_industries: toArr(raw.target_industries),
    target_locations:  toArr(raw.target_locations),
    products_services: (raw.products_services ?? []).map(p => ({
      ...p,
      target_titles:     toArr(p.target_titles),
      target_industries: toArr(p.target_industries),
      target_locations:  toArr(p.target_locations),
    })),
  }

  const productsWithIds = (globalIcp.products_services ?? []).filter(p => p.name && p.id)

  if (productsWithIds.length > 0) {
    // Score each product independently, pick best
    const productScores: Record<string, ProductScore> = {}

    await Promise.all(
      productsWithIds.map(async product => {
        const criteria = resolveCriteria(product, globalIcp)
        const result   = await scoreOnce(lead, criteria)
        const score    = Math.min(result.total, 100)
        const flag     = resolveFlag(score, result.disqualified)

        productScores[product.id!] = {
          score,
          flag,
          reasoning: result.reasoning,
          breakdown: {
            dimensions:      result.dimensions,
            criteria_detail: result.criteria_detail,
            disqualified:    result.disqualified,
            disqualifier_reason: result.disqualifier_reason,
          },
        }
      })
    )

    // Best = highest score (hot > warm > cold > disqualified)
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
      score:           best.score,
      flag:            best.flag,
      reasoning:       best.reasoning,
      score_breakdown: best.breakdown!,
      product_scores:  productScores,
      best_product_id: bestProductId,
    }
  }

  // No products — global criteria pass
  const criteria = resolveCriteria(
    {
      name: '', description: '', target_use_case: '',
      target_titles:     globalIcp.target_titles,
      target_industries: globalIcp.target_industries,
      target_locations:  globalIcp.target_locations,
      min_company_size:  globalIcp.min_company_size,
      max_company_size:  globalIcp.max_company_size,
      custom_criteria:   globalIcp.custom_criteria,
    },
    globalIcp
  )

  const result  = await scoreOnce(lead, criteria)
  const score   = Math.min(result.total, 100)
  const flag    = resolveFlag(score, result.disqualified)

  return {
    score,
    flag,
    reasoning:       result.reasoning,
    score_breakdown: {
      dimensions:      result.dimensions,
      criteria_detail: result.criteria_detail,
      disqualified:    result.disqualified,
      disqualifier_reason: result.disqualifier_reason,
    },
  }
}
