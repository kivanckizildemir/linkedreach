import Anthropic from '@anthropic-ai/sdk'

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Types ────────────────────────────────────────────────────────────────────

export type SequenceStepType = 'connect' | 'message' | 'inmail' | 'follow_up'

export interface ProductContext {
  name: string
  one_liner?: string
  description?: string
  target_use_case?: string
  usps?: string[]
  differentiators?: string[]
  tone_of_voice?: string
  website_url?: string
}

export interface LeadContext {
  first_name: string
  last_name: string
  title?: string | null
  company?: string | null
  industry?: string | null
  location?: string | null
  recent_posts?: string[]
  opening_line?: string | null
}

export interface PriorMessage {
  direction: 'sent' | 'received'
  content: string
  step_type?: string
}

export interface GenerateSequenceMessageInput {
  step_type: SequenceStepType
  position_in_sequence: number          // 1 = first outreach, 2 = follow-up 1, etc.
  product: ProductContext
  lead: LeadContext
  prior_messages: PriorMessage[]
  icp_notes?: string
  resolve_variables?: boolean            // true = substitute real values, false = keep {{placeholders}}
}

export interface GenerateSequenceMessageResult {
  body: string
  subject?: string                       // inmail only
  name_suggestion?: string
}

// ─── Step constraints ─────────────────────────────────────────────────────────

function stepConstraints(type: SequenceStepType, position: number): string {
  switch (type) {
    case 'connect':
      return `LinkedIn Connection Request note.
- HARD LIMIT: 300 characters total (including spaces). This is a LinkedIn platform constraint.
- Do NOT include a CTA ("let's chat", "would love to connect", etc.) — that comes after they accept.
- Goal: make them curious enough to accept. One personalised hook, then value teaser.
- No formal greetings like "Dear" or "To whom it may concern".`

    case 'message':
      if (position <= 2) {
        return `First direct message after connection accepted.
- Length: 80–140 words.
- Open by acknowledging the new connection naturally (don't mention "you accepted my request").
- Introduce the core value prop concisely — ONE pain point, ONE solution angle.
- End with a single low-friction CTA (a question, not "book a call").
- Conversational tone, no hard sell.`
      }
      return `Follow-up message (position ${position} in sequence).
- Length: 60–100 words.
- DO NOT repeat the hook, value prop, or CTA from previous messages.
- Try a completely new angle: a result, a story, a question, an insight.
- Acknowledge that you've reached out before — briefly, naturally.
- One soft CTA.`

    case 'follow_up':
      return `Follow-up message (position ${position} in sequence).
- Length: 60–100 words.
- DO NOT repeat the hook, value prop, or CTA from previous messages.
- New angle: result, case study snippet, insight, or honest "last try" framing.
- Keep it human — not corporate.
- One CTA max.`

    case 'inmail':
      return `LinkedIn InMail (cold outreach, no prior connection).
- Length: 150–250 words.
- Subject line: required, 6–10 words, specific and intriguing (not generic like "Quick question").
- Open strong — personalised to the lead's role or company context.
- Clear value prop in paragraph 2.
- Specific CTA in final paragraph.
- Feels like a peer reaching out, not a sales rep with a quota.`
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(input: GenerateSequenceMessageInput): string {
  const { step_type, position_in_sequence, product, lead, prior_messages, icp_notes, resolve_variables } = input

  const lines: string[] = []

  // ── Product block ──
  lines.push('━━━ PRODUCT / SERVICE ━━━')
  lines.push(`Name: ${product.name}`)
  if (product.one_liner) lines.push(`One-liner: ${product.one_liner}`)
  if (product.description) lines.push(`Description: ${product.description}`)
  if (product.target_use_case) lines.push(`Ideal customer: ${product.target_use_case}`)
  if (product.usps && product.usps.length > 0) {
    lines.push('Unique selling points:')
    product.usps.forEach(u => lines.push(`  • ${u}`))
  }
  if (product.differentiators && product.differentiators.length > 0) {
    lines.push('Points of differentiation vs. alternatives:')
    product.differentiators.forEach(d => lines.push(`  • ${d}`))
  }
  if (product.tone_of_voice) lines.push(`Tone of voice: ${product.tone_of_voice}`)
  lines.push('')

  // ── Lead block ──
  lines.push('━━━ LEAD PROFILE ━━━')
  lines.push(`Name: ${lead.first_name} ${lead.last_name}`)
  if (lead.title) lines.push(`Title: ${lead.title}`)
  if (lead.company) lines.push(`Company: ${lead.company}`)
  if (lead.industry) lines.push(`Industry: ${lead.industry}`)
  if (lead.location) lines.push(`Location: ${lead.location}`)
  if (lead.opening_line) lines.push(`Personalised hook available: ${lead.opening_line}`)
  if (lead.recent_posts && lead.recent_posts.length > 0) {
    lines.push('Recent LinkedIn activity / posts:')
    lead.recent_posts.slice(0, 3).forEach(p => lines.push(`  - ${p}`))
  }
  if (icp_notes) lines.push(`ICP notes: ${icp_notes}`)
  lines.push('')

  // ── Conversation history ──
  lines.push('━━━ CONVERSATION HISTORY ━━━')
  if (prior_messages.length === 0) {
    lines.push('This is the FIRST message in the sequence. No prior contact.')
  } else {
    lines.push('The following messages have already been sent/received in this sequence.')
    lines.push('Your new message MUST NOT repeat the same hook, value proposition, or CTA.')
    lines.push('Reference prior messages only if it adds genuine value or context.')
    lines.push('')
    prior_messages.forEach((m, i) => {
      const label = m.direction === 'sent'
        ? `You (${m.step_type ?? `Step ${i + 1}`})`
        : `${lead.first_name} (reply)`
      lines.push(`${label}: "${m.content}"`)
    })
  }
  lines.push('')

  // ── Step constraints ──
  lines.push('━━━ THIS STEP ━━━')
  lines.push(`Step type: ${step_type}`)
  lines.push(`Position in sequence: ${position_in_sequence}`)
  lines.push('')
  lines.push(stepConstraints(step_type, position_in_sequence))
  lines.push('')

  // ── Variable instructions ──
  lines.push('━━━ VARIABLES ━━━')
  if (resolve_variables) {
    lines.push('Use the actual lead data directly. Do NOT use {{placeholder}} syntax.')
    lines.push(`The lead's name is ${lead.first_name}, company is ${lead.company ?? 'unknown'}, title is ${lead.title ?? 'unknown'}.`)
    if (lead.opening_line) {
      lines.push(`The opening hook you can weave in: "${lead.opening_line}"`)
    }
  } else {
    lines.push('Use these placeholders where natural (they are substituted at send time):')
    lines.push('  {{first_name}} — lead\'s first name')
    lines.push('  {{last_name}} — lead\'s last name')
    lines.push('  {{full_name}} — lead\'s full name')
    lines.push('  {{company}} — lead\'s company name')
    lines.push('  {{title}} — lead\'s job title')
    lines.push('  {{industry}} — lead\'s industry')
    lines.push('  {{opening_line}} — AI-generated personalised opener (already crafted for this lead)')
  }
  lines.push('')

  // ── Output format ──
  lines.push('━━━ OUTPUT FORMAT ━━━')
  lines.push('Respond ONLY with valid JSON. No markdown fences. No explanation.')
  if (step_type === 'inmail') {
    lines.push('{ "body": "...", "subject": "..." }')
  } else {
    lines.push('{ "body": "..." }')
  }

  return lines.join('\n')
}

// ─── Main function ────────────────────────────────────────────────────────────

export async function generateSequenceMessage(
  input: GenerateSequenceMessageInput
): Promise<GenerateSequenceMessageResult> {
  const userPrompt = buildPrompt(input)

  const systemPrompt = `You are an expert B2B sales copywriter specialising in LinkedIn outreach sequences.
You write messages that sound like a real human — thoughtful, specific, and never salesy.
You study the lead's profile and the product context carefully before writing.
You never use clichés like "I hope this finds you well", "I came across your profile", "touching base", "circling back", "synergy", "low-hanging fruit", or "game-changer".
Every message you write is distinct from the others in the sequence — a new angle, not a repeat.`

  const response = await ai.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const raw = (response.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

  let parsed: { body: string; subject?: string }
  try {
    parsed = JSON.parse(json) as { body: string; subject?: string }
  } catch {
    // Fallback: extract body from raw text if JSON parse fails
    throw new Error(`AI returned unexpected format: ${raw.slice(0, 200)}`)
  }

  // Enforce connection note character limit
  if (input.step_type === 'connect' && parsed.body.length > 300) {
    parsed.body = parsed.body.slice(0, 297) + '...'
  }

  // Generate a name suggestion for the template
  const stepLabels: Record<SequenceStepType, string> = {
    connect: 'Connection Note',
    message: `Message ${input.position_in_sequence}`,
    follow_up: `Follow-up ${input.position_in_sequence - 1}`,
    inmail: 'InMail',
  }
  const nameSuggestion = `AI ${stepLabels[input.step_type]} — ${input.product.name}`

  return {
    body: parsed.body,
    subject: parsed.subject,
    name_suggestion: nameSuggestion,
  }
}

// ─── Helper: collect step chain ───────────────────────────────────────────────
// Exported so the route can use it

export interface StepNode {
  id: string
  type: string
  message_template: string | null
  parent_step_id: string | null
  branch: string | null
  step_order: number
  ai_generation_mode: boolean
}

/**
 * Returns the ordered chain of steps from the root to (but NOT including) the target step.
 * Used to build prior_messages context.
 */
export function buildPriorChain(
  targetStepId: string,
  allSteps: StepNode[]
): StepNode[] {
  // Build a map for fast lookup
  const byId = new Map(allSteps.map(s => [s.id, s]))

  // Walk from target step back to root, collecting ancestors
  const ancestors: StepNode[] = []
  let current = byId.get(targetStepId)
  while (current && current.parent_step_id) {
    const parent = byId.get(current.parent_step_id)
    if (parent) ancestors.unshift(parent)
    current = parent
  }
  return ancestors
}

/**
 * Returns the position of the target step in the message chain
 * (counting only 'connect', 'message', 'inmail', 'follow_up' steps in the ancestor chain + self).
 */
export function getMessagePosition(
  targetStepId: string,
  allSteps: StepNode[]
): number {
  const chain = buildPriorChain(targetStepId, allSteps)
  const byId = new Map(allSteps.map(s => [s.id, s]))
  const target = byId.get(targetStepId)
  if (!target) return 1

  const messageTypes = new Set(['connect', 'message', 'inmail', 'follow_up'])
  const priorMessageSteps = chain.filter(s => messageTypes.has(s.type))
  return priorMessageSteps.length + 1
}
