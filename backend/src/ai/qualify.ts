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

export interface QualifyResult {
  score: number      // 0-100
  flag: IcpFlag
  reasoning: string
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
  if (icp.products_services?.length) {
    lines.push('## Products & Services We Sell')
    lines.push('Use this to assess whether the lead is likely to have a need for what we offer.')
    for (const p of icp.products_services) {
      if (!p.name) continue
      lines.push(``)
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
  lines.push('Score this lead from 0 to 100 based on how well they match the ICP above.')
  lines.push('Assign a flag:')
  lines.push('- "hot" if score >= 75')
  lines.push('- "warm" if score >= 50')
  lines.push('- "cold" if score >= 25')
  lines.push('- "disqualified" if score < 25 OR any disqualifier applies')
  lines.push('')
  lines.push('Respond ONLY with valid JSON in this exact format (no markdown, no extra text):')
  lines.push('{')
  lines.push('  "score": <number 0-100>,')
  lines.push('  "flag": "<hot|warm|cold|disqualified>",')
  lines.push('  "reasoning": "<1-2 sentence explanation>"')
  lines.push('}')

  return lines.join('\n')
}

export async function qualifyLead(
  lead: LeadProfile,
  icpConfig: Record<string, unknown>
): Promise<QualifyResult> {
  const prompt = buildPrompt(lead, icpConfig as IcpConfig)

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  // Strip markdown fences if present
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const result = JSON.parse(json) as QualifyResult

  // Clamp score to valid range
  result.score = Math.max(0, Math.min(100, Math.round(result.score)))

  return result
}
