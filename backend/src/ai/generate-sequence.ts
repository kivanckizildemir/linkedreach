/**
 * AI-powered sequence generation via chat.
 *
 * The user describes the sequence they want in natural language.
 * Claude responds conversationally AND optionally includes a
 * structured step array that the frontend can apply directly.
 *
 * Steps are returned inside a ```sequence-json fenced block so the
 * rest of the text stays readable in the chat UI.
 */

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are an expert LinkedIn outreach strategist embedded inside LinkedReach, a B2B automation platform. Your job is to help users build high-converting outreach sequences by chatting with them.

## Available step types
| type | description |
|------|-------------|
| view_profile | View the lead's LinkedIn profile (always do this first — feels human) |
| follow | Follow the lead on LinkedIn |
| connect | Send a connection request (max 1 per sequence; personalized note ≤ 300 chars) |
| message | Send a LinkedIn DM (requires connection) |
| inmail | Send LinkedIn InMail (no connection needed; premium feature) |
| react_post | React to a recent post (like/celebrate/love/insightful/curious) |
| wait | Pause N days/hours before the next action |
| fork | Conditional branch — splits on: replied / not_replied / connected / not_connected |
| end | Terminates a branch (every branch MUST end with this) |

## Personalization tokens
Use these in message_template: {{firstName}}, {{lastName}}, {{company}}, {{jobTitle}}, {{industry}}, {{location}}

## Sequence rules
- view_profile should almost always be the first step
- connect must come before message
- Every branch (main, if_yes, if_no) must terminate with an end step
- wait_days accepts decimals for hours (e.g. 0.5 = 12 hours)
- For now, keep sequences linear (no fork steps) unless the user explicitly asks for branching

## LinkedIn best practices you must follow
- Connection note: short, personal, no pitch — just a reason to connect (<300 chars)
- First message: warm, leads with curiosity/value — NOT a product pitch
- Follow-up: acknowledge no-reply with empathy, add a different angle
- Space steps out: 2–3 days minimum between messages
- Keep messages concise: 50–120 words is the sweet spot
- Typical winning sequence: view_profile → connect(note) → wait(2d) → message → wait(3d) → message → end

## Response format
Respond conversationally, then — when you want to propose a full sequence — include exactly one \`\`\`sequence-json block containing a JSON array of steps.

The JSON schema for each step:
{
  "type": "<step type>",
  "branch": "main",
  "step_order": <integer starting at 0>,
  "message_template": "<string with tokens, or null>",
  "subject": "<InMail subject or null>",
  "wait_days": <number or null>,
  "ai_generation_mode": false,
  "condition": <object or null>,
  "parent_step_id": null
}

For react_post steps, condition must be: { "reaction": "like" } (or celebrate/love/insightful/curious)
For wait steps, condition can include: { "wait_unit": "days" }

Only emit the \`\`\`sequence-json block when proposing a complete buildable sequence. For clarifying questions, feedback, or partial edits, just reply in plain text.

Keep replies concise and friendly — you're a knowledgeable colleague, not a formal assistant.`

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GeneratedStep {
  type: string
  branch: string
  step_order: number
  message_template: string | null
  subject: string | null
  wait_days: number | null
  ai_generation_mode: boolean
  condition: Record<string, unknown> | null
  parent_step_id: string | null
}

export interface SequenceChatResult {
  reply: string
  steps: GeneratedStep[] | null
}

export async function chatGenerateSequence(
  messages: ChatMessage[],
  campaignContext: {
    name: string
    targetAudience: string | null
    existingSteps: string
  }
): Promise<SequenceChatResult> {
  // Inject campaign context as the first exchange so Claude has full awareness
  const contextBlock =
    `Campaign: "${campaignContext.name}"\n` +
    `Target audience: ${campaignContext.targetAudience ?? 'Not specified'}\n` +
    `Current sequence: ${campaignContext.existingSteps || 'Empty — no steps yet'}`

  const apiMessages: Anthropic.Messages.MessageParam[] = [
    { role: 'user',      content: `Here is the campaign context:\n\n${contextBlock}` },
    { role: 'assistant', content: "Got it! I can see your campaign. What kind of outreach sequence would you like to build? Tell me about your goals and I'll craft the perfect flow." },
    ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system:     SYSTEM_PROMPT,
    messages:   apiMessages,
  })

  const raw = response.content[0].type === 'text' ? response.content[0].text : ''

  // Extract the fenced sequence-json block if present
  const jsonMatch = raw.match(/```sequence-json\n([\s\S]*?)\n```/)
  let steps: GeneratedStep[] | null = null
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as unknown
      if (Array.isArray(parsed)) steps = parsed as GeneratedStep[]
    } catch { /* malformed JSON — return null */ }
  }

  // Strip the code block from the conversational reply
  const reply = raw.replace(/```sequence-json\n[\s\S]*?\n```/g, '').replace(/\n{3,}/g, '\n\n').trim()

  return { reply, steps }
}
