import Anthropic from '@anthropic-ai/sdk'
import { HUMAN_WRITING_RULES } from './humanRules'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export interface PersonaliseInput {
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  industry: string | null
  about?: string | null
  experience_description?: string | null
  skills?: string[]
  recent_posts?: string[]
}

export interface PersonaliseResult {
  opening_line: string
}

export async function personaliseOpeningLine(
  lead: PersonaliseInput
): Promise<PersonaliseResult> {
  const contextLines: string[] = [
    `- Name: ${lead.first_name} ${lead.last_name}`,
    `- Title: ${lead.title ?? 'Unknown'}`,
    `- Company: ${lead.company ?? 'Unknown'}`,
    `- Industry: ${lead.industry ?? 'Unknown'}`,
  ]
  if (lead.about) contextLines.push(`- About: ${lead.about.slice(0, 400)}`)
  if (lead.experience_description) contextLines.push(`- Current role description: ${lead.experience_description.slice(0, 300)}`)
  if (lead.skills?.length) contextLines.push(`- Top skills: ${lead.skills.slice(0, 5).join(', ')}`)
  if (lead.recent_posts?.length) {
    contextLines.push('- Recent posts:')
    lead.recent_posts.slice(0, 3).forEach(p => contextLines.push(`    "${p.slice(0, 200)}"`))
  }

  const prompt = `Write a single personalised opening line for a LinkedIn outreach message to this prospect.

Prospect:
${contextLines.join('\n')}

Rules:
- One sentence only, max 25 words
- Reference something specific from their profile — their actual role, something they wrote, a project they've worked on, their company's situation
- Sound like a real person noticed something about them, not like software generated a compliment
- Do NOT start with "I" or "Hi"
- Do NOT start with "Your" as a flattering opener ("Your impressive work..." etc.)
- Do NOT include a call to action
- Do NOT use: "impressive", "exciting", "fascinating", "amazing", "incredible", "passionate"

${HUMAN_WRITING_RULES}

Respond ONLY with valid JSON:
{"opening_line": "<one sentence>"}`

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(json) as PersonaliseResult
}
