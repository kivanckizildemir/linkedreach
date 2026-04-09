import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export interface SuggestResult {
  suggestions: string[]
}

interface ThreadMessage {
  direction: 'sent' | 'received'
  content: string
}

export async function suggestReplies(
  thread: ThreadMessage[],
  lead: { first_name: string; last_name: string; title?: string | null; company?: string | null }
): Promise<SuggestResult> {
  const transcript = thread
    .map(m => `${m.direction === 'sent' ? 'You' : lead.first_name}: ${m.content}`)
    .join('\n')

  const prompt = `You are an expert B2B sales assistant helping craft LinkedIn replies.

Lead: ${lead.first_name} ${lead.last_name}${lead.title ? `, ${lead.title}` : ''}${lead.company ? ` at ${lead.company}` : ''}

Conversation so far:
${transcript}

Generate exactly 3 short reply options (max 2 sentences each) to continue this conversation. Make them:
1. Direct and value-focused (ask a clarifying question or propose a call)
2. Softer follow-up (acknowledge their situation and stay top of mind)
3. Brief and punchy (one-liner that keeps the door open)

Respond ONLY with valid JSON in this exact format:
{
  "suggestions": [
    "<reply 1>",
    "<reply 2>",
    "<reply 3>"
  ]
}`

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(json) as SuggestResult
}
