/**
 * Extract Target Audience from Products
 *
 * Given a list of product definitions, uses AI to suggest target audience
 * fields (titles, industries, company size) for a LinkedIn campaign.
 */

import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export interface AudienceSuggestion {
  target_titles: string[]
  target_industries: string[]
  target_locations: string[]
  min_company_size: number | null
  max_company_size: number | null
}

export interface ProductInput {
  name: string
  one_liner?: string
  description?: string
  target_use_case?: string
}

export async function extractAudienceFromProducts(
  products: ProductInput[],
): Promise<AudienceSuggestion> {
  const lines: string[] = []

  lines.push('You are a B2B sales expert. Based on the following product(s), extract the ideal target audience for a LinkedIn outreach campaign.')
  lines.push('')
  lines.push('## Products')
  for (const p of products) {
    lines.push(`### ${p.name}`)
    if (p.one_liner) lines.push(`One-liner: ${p.one_liner}`)
    if (p.description) lines.push(`Description: ${p.description}`)
    if (p.target_use_case) lines.push(`Ideal customer: ${p.target_use_case}`)
  }
  lines.push('')
  lines.push('## Instructions')
  lines.push('Only populate fields where the product descriptions provide clear evidence. Leave arrays empty and sizes null if not clearly implied.')
  lines.push('- target_titles: 3–8 specific job titles who would buy or champion this product')
  lines.push('- target_industries: 1–5 industries most relevant to this product')
  lines.push('- target_locations: leave empty unless the product is explicitly geography-specific')
  lines.push('- min_company_size / max_company_size: employee count range, or null if not implied')
  lines.push('')
  lines.push('Respond ONLY with valid JSON (no markdown):')
  lines.push('{"target_titles":[],"target_industries":[],"target_locations":[],"min_company_size":null,"max_company_size":null}')

  const message = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: lines.join('\n') }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(json) as AudienceSuggestion
}
