import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface PersonaliseInput {
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  industry: string | null
}

export interface PersonaliseResult {
  opening_line: string
}

export async function personaliseOpeningLine(
  lead: PersonaliseInput
): Promise<PersonaliseResult> {
  const prompt = `You are an expert B2B sales copywriter. Write a single personalised opening line for a LinkedIn outreach message to this prospect.

Prospect:
- Name: ${lead.first_name} ${lead.last_name}
- Title: ${lead.title ?? 'Unknown'}
- Company: ${lead.company ?? 'Unknown'}
- Industry: ${lead.industry ?? 'Unknown'}

Rules:
- One sentence only, max 20 words
- Sound natural and human, not salesy
- Reference their role or company specifically
- Do NOT start with "I" or "Hi"
- Do NOT include a call to action

Respond ONLY with valid JSON:
{"opening_line": "<your one-sentence opening>"}`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(json) as PersonaliseResult
}
