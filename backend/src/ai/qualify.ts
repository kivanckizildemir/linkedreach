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

export async function qualifyLead(
  lead: LeadProfile,
  icpConfig: Record<string, unknown>
): Promise<QualifyResult> {
  const prompt = `You are an expert B2B sales qualification assistant. Evaluate the following lead against the ICP (Ideal Customer Profile) criteria and return a qualification score.

ICP Configuration:
${JSON.stringify(icpConfig, null, 2)}

Lead Profile:
- Name: ${lead.first_name} ${lead.last_name}
- Title: ${lead.title ?? 'Unknown'}
- Company: ${lead.company ?? 'Unknown'}
- Industry: ${lead.industry ?? 'Unknown'}
- Location: ${lead.location ?? 'Unknown'}
- Connection Degree: ${lead.connection_degree ?? 'Unknown'}

Score this lead from 0 to 100 based on how well they match the ICP.
Assign a flag:
- "hot" if score >= 75
- "warm" if score >= 50
- "cold" if score >= 25
- "disqualified" if score < 25

Respond ONLY with valid JSON in this exact format:
{
  "score": <number 0-100>,
  "flag": "<hot|warm|cold|disqualified>",
  "reasoning": "<1-2 sentence explanation>"
}`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
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
