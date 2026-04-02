import Anthropic from '@anthropic-ai/sdk'
import type { ReplyClassification } from '../types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ClassifyResult {
  classification: ReplyClassification
  reasoning: string
}

export async function classifyReply(replyText: string): Promise<ClassifyResult> {
  const prompt = `You are an expert B2B sales assistant. Classify the intent of this LinkedIn reply from a prospect.

Reply:
"${replyText}"

Choose one classification:
- "interested" — they want to learn more, asked a question, or suggested a call/meeting
- "not_now" — they're open but not right now (busy, wrong timing, on leave)
- "wrong_person" — they're not the decision maker or not relevant
- "referral" — they referred you to someone else
- "negative" — they're not interested, asked to stop, or were dismissive
- "none" — auto-reply, out of office, or no clear intent

Respond ONLY with valid JSON in this exact format:
{
  "classification": "<one of the values above>",
  "reasoning": "<1 sentence explanation>"
}`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(json) as ClassifyResult
}
