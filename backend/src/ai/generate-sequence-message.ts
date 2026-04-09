import Anthropic from '@anthropic-ai/sdk'
import { HUMAN_WRITING_RULES } from './humanRules'

let _ai: Anthropic | null = null
function getAi(): Anthropic {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _ai
}

// ─── Approach & Tone guidance maps ───────────────────────────────────────────

const APPROACH_GUIDANCE: Record<string, string> = {
  direct:              'No warm-up. State clearly who you are, what you offer, and what you want. Brevity signals confidence — respect their time and they will read it.',
  trigger_based:       'Reference a specific recent signal — a job change, funding round, product launch, hiring spike, or post they published. "I noticed you just..." creates genuine relevance that generic messages cannot fake.',
  insight_challenger:  'Open with a counterintuitive industry insight or a data point that challenges the status quo. You are not a vendor pitching features — you are a thinker worth engaging. The insight must be sharp and specific, never generic.',
  problem_solution:    'Open by naming a specific operational pain or frustration the lead likely faces. Make them feel deeply understood before introducing any solution. Empathy earns attention; the solution earns the reply.',
  social_proof:        'Reference a named company type, role, or measurable result early. "We helped a Series B SaaS CFO cut X by Y%" beats "companies like yours". Specificity overcomes scepticism — generic claims are ignored.',
  question_hook:       'Open with a single provocative or genuinely curious question that makes them want to answer. No preamble. The question IS the hook. It should feel like you already know something about their world.',
  before_after_bridge: 'Paint a vivid before state (current friction or limitation), then a clear after state (the transformed outcome), then bridge to how you make that shift happen. Story structure triggers imagination.',
  mutual_ground:       'Find common ground before any pitch — a shared background, mutual connection, shared perspective on an industry shift, or a post they wrote that you genuinely found valuable. Rapport earns the right to pitch.',
  pattern_interrupt:   'Break every convention. Open with something unexpected, self-aware, or structurally different from every other message in their inbox. Surprise creates read-through. Be original, not gimmicky.',
  value_first:         'Lead immediately with the concrete outcome or benefit. What changes for them? Say it in sentence one. No intro fluff, no setup — the value statement IS the opener.',
}

const TONE_GUIDANCE: Record<string, string> = {
  professional:   'Clear, precise, authoritative business language. No jargon for its own sake. Reads like a sharp executive, not a salesperson with a script.',
  conversational: 'Write like you are talking to a trusted peer. Short sentences, contractions, relaxed rhythm. Reads like a thoughtful Slack message from a smart colleague.',
  casual:         'Loose, warm, low-pressure. The tone of a coffee chat. Informal without being unprofessional. Light humour is welcome if it fits naturally — never forced.',
  bold:           'Direct, punchy, unapologetic. Strong active verbs, zero hedging, no padding. Confident people do not say "just" or "maybe" — neither should this message.',
}

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

export interface SenderContext {
  name: string
  headline?: string | null
  about?: string | null
  experience?: string | null
  skills?: string[]
  recent_posts?: string[]
}

export interface LeadContext {
  first_name: string
  last_name: string
  title?: string | null
  company?: string | null
  industry?: string | null
  location?: string | null
  about?: string | null
  experience_description?: string | null
  skills?: string[]
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
  position_in_sequence: number
  product: ProductContext
  sender?: SenderContext | null
  lead: LeadContext
  prior_messages: PriorMessage[]
  icp_notes?: string
  resolve_variables?: boolean
  approach?: string | null
  tone?: string | null
  max_words?: number | null
  /** Which lead profile data sources to include. Omit = include all available. */
  profile_sources?: string[]
  /**
   * Strategic guidance injected by the AI Sequence Architect (AI automated mode).
   * When present, the message generator follows the architect's brief precisely.
   */
  ai_guidance?: {
    ai_role?: string             // e.g. "first_touch" | "follow_up" | "breakup"
    ai_arc?: string              // e.g. "M1 of 3"
    ai_instruction?: string      // specific writing instruction from the architect
    ai_context?: string          // lead state at this step, e.g. "Accepted connection 3 days ago, no reply"
    ai_sequence_strategy?: string // overall sequence strategy name
  } | null
}

export interface GenerateSequenceMessageResult {
  body: string
  subject?: string
  name_suggestion?: string
}

// ─── Message length presets ───────────────────────────────────────────────────

export const MESSAGE_LENGTH_WORDS: Record<string, number> = {
  micro:     50,
  concise:   80,
  standard:  130,
  detailed:  180,
  long_form: 250,
}

// ─── Step constraints ─────────────────────────────────────────────────────────

function stepConstraints(type: SequenceStepType, position: number): string {
  switch (type) {
    case 'connect':
      return `LinkedIn Connection Request note.
- HARD LIMIT: 300 characters total (including spaces). LinkedIn platform constraint.
- No CTA ("let's chat", "would love to connect") — that comes after they accept.
- Goal: make them curious enough to accept. One personalised hook, brief value signal.
- No formal greetings like "Dear" or "To whom it may concern".`

    case 'message':
      if (position <= 2) {
        return `First direct message after connection accepted.
- Length: 80–140 words.
- Open naturally — don't say "you accepted my request".
- ONE pain point, ONE solution angle. No lists.
- End with a single low-friction question, not a demand.`
      }
      return `Follow-up message (position ${position} in sequence).
- Length: 60–100 words.
- Do NOT repeat the hook, value prop, or CTA from previous messages.
- A completely new angle: a result, a story, a question, an insight.
- Acknowledge briefly and naturally that you've reached out before.
- One soft CTA.`

    case 'follow_up':
      return `Follow-up message (position ${position} in sequence).
- Length: 60–100 words.
- Do NOT repeat the hook, value prop, or CTA from previous messages.
- New angle: result, case study snippet, insight, or honest "final try" framing.
- Keep it human. One CTA max.`

    case 'inmail':
      return `LinkedIn InMail (cold outreach, no prior connection).
- Length: 150–250 words.
- Subject line required: 6–10 words, specific and intriguing (never "Quick question" or generic "Following up").
- Strong personalised opener in paragraph 1.
- Clear value prop in paragraph 2.
- Specific low-friction CTA in final paragraph.
- Reads like a peer reaching out, not a sales rep with quota pressure.`
  }
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(input: GenerateSequenceMessageInput): string {
  const { step_type, position_in_sequence, product, sender, lead, prior_messages, icp_notes, resolve_variables, approach, tone, max_words, profile_sources, ai_guidance } = input

  // Determine which lead data sources are active (default: all)
  const src = profile_sources ?? ['basic', 'summary', 'experience', 'posts']
  const use = (key: string) => src.includes(key)

  const lines: string[] = []

  // ── Sender block ──
  if (sender?.name) {
    lines.push('━━━ SENDER (who is writing this message) ━━━')
    lines.push(`Name: ${sender.name}`)
    if (sender.headline) lines.push(`Headline: ${sender.headline}`)
    if (sender.about) lines.push(`About: ${sender.about.slice(0, 400)}`)
    if (sender.experience) lines.push(`Experience: ${sender.experience.slice(0, 300)}`)
    if (sender.skills && sender.skills.length > 0) lines.push(`Skills: ${sender.skills.join(', ')}`)
    if (sender.recent_posts && sender.recent_posts.length > 0) {
      lines.push(`Recent posts (use to reflect their voice and interests):`)
      sender.recent_posts.slice(0, 2).forEach((p, i) => lines.push(`  Post ${i + 1}: ${p.slice(0, 200)}`))
    }
    lines.push('Write in first person AS this sender. The message voice, expertise, and background should reflect who they are.')
    lines.push('')
  } else {
    // No sender identity configured — explicitly forbid the AI from inventing a name
    lines.push('━━━ SENDER ━━━')
    lines.push('Sender name is not set. NEVER introduce the sender by any personal name (no "I\'m Sam", "My name is...", etc.).')
    lines.push('Write in first person but omit personal name introductions. Reference the company or product instead.')
    lines.push('')
  }

  // ── Product block ──
  lines.push('━━━ PRODUCT / SERVICE ━━━')
  lines.push(`Name: ${product.name}`)
  if (product.one_liner) lines.push(`One-liner: ${product.one_liner}`)
  if (product.description) lines.push(`Description: ${product.description}`)
  if (product.target_use_case) lines.push(`Ideal customer: ${product.target_use_case}`)
  if (product.usps?.length) {
    lines.push('Unique selling points:')
    product.usps.forEach(u => lines.push(`  • ${u}`))
  }
  if (product.differentiators?.length) {
    lines.push('Differentiators vs. alternatives:')
    product.differentiators.forEach(d => lines.push(`  • ${d}`))
  }
  if (product.tone_of_voice) lines.push(`Brand tone of voice: ${product.tone_of_voice}`)
  lines.push('')

  // ── Approach block ──
  if (approach) {
    lines.push('━━━ OUTREACH APPROACH ━━━')
    lines.push(`Strategic angle: ${approach}`)
    if (APPROACH_GUIDANCE[approach]) lines.push(APPROACH_GUIDANCE[approach])
    lines.push('')
  }

  // ── Tone block ──
  if (tone) {
    lines.push('━━━ TONE ━━━')
    lines.push(`Write in a ${tone} tone.${TONE_GUIDANCE[tone] ? ' ' + TONE_GUIDANCE[tone] : ''}`)
    lines.push('')
  }

  // ── AI Sequence Architect guidance block ──
  if (ai_guidance && Object.keys(ai_guidance).length > 0) {
    lines.push('━━━ SEQUENCE ARCHITECT BRIEF ━━━')
    lines.push('This message was designed by the AI Sequence Architect as part of a deliberate outreach arc. Follow the brief precisely.')
    if (ai_guidance.ai_sequence_strategy) lines.push(`Overall sequence strategy: ${ai_guidance.ai_sequence_strategy}`)
    if (ai_guidance.ai_role)              lines.push(`Role of this message in the sequence: ${ai_guidance.ai_role}`)
    if (ai_guidance.ai_arc)               lines.push(`Arc position: ${ai_guidance.ai_arc}`)
    if (ai_guidance.ai_context)           lines.push(`Lead state at this step: ${ai_guidance.ai_context}`)
    if (ai_guidance.ai_instruction)       lines.push(`Writing instruction: ${ai_guidance.ai_instruction}`)
    lines.push('This guidance supersedes generic writing instincts. Execute the instruction above.')
    lines.push('')
  }

  // ── Lead block ──
  lines.push('━━━ LEAD PROFILE ━━━')
  // basic — always include name; title/company/industry/location gated
  lines.push(`Name: ${lead.first_name} ${lead.last_name}`)
  if (use('basic')) {
    if (lead.title) lines.push(`Title: ${lead.title}`)
    if (lead.company) lines.push(`Company: ${lead.company}`)
    if (lead.industry) lines.push(`Industry: ${lead.industry}`)
    if (lead.location) lines.push(`Location: ${lead.location}`)
    if (lead.skills?.length) lines.push(`Top skills: ${lead.skills.slice(0, 5).join(', ')}`)
  }
  if (use('summary') && lead.about) {
    lines.push(`LinkedIn About: ${lead.about.slice(0, 600)}`)
  }
  if (use('experience') && lead.experience_description) {
    lines.push(`Current role description: ${lead.experience_description.slice(0, 400)}`)
  }
  if (lead.opening_line) lines.push(`Personalised hook: ${lead.opening_line}`)
  if (use('posts') && lead.recent_posts?.length) {
    lines.push('Recent posts / LinkedIn activity:')
    lead.recent_posts.slice(0, 3).forEach(p => lines.push(`  — "${p.slice(0, 250)}"`))
    lines.push('Use their posts to find the one specific angle that would resonate with this person right now.')
  }
  if (icp_notes) lines.push(`ICP notes: ${icp_notes}`)
  lines.push('')

  // ── Conversation history ──
  lines.push('━━━ CONVERSATION HISTORY ━━━')
  if (prior_messages.length === 0) {
    lines.push('First message in the sequence. No prior contact.')
  } else {
    lines.push('Messages already sent/received. Your new message MUST NOT repeat the same hook, value prop, or CTA.')
    lines.push('')
    prior_messages.forEach((m, i) => {
      const label = m.direction === 'sent'
        ? `Sent (${m.step_type ?? `Step ${i + 1}`})`
        : `${lead.first_name} replied`
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

  // ── Length override ──
  if (max_words && step_type !== 'connect') {
    lines.push('━━━ LENGTH CONSTRAINT ━━━')
    lines.push(`Hard limit: under ${max_words} words. This overrides step defaults.`)
    lines.push('')
  }

  // ── Variable instructions ──
  lines.push('━━━ VARIABLES ━━━')
  if (resolve_variables) {
    lines.push('Use the actual lead data directly. Do NOT use {{placeholder}} syntax.')
    lines.push(`Lead name: ${lead.first_name}, company: ${lead.company ?? 'unknown'}, title: ${lead.title ?? 'unknown'}.`)
    if (lead.opening_line) lines.push(`Opening hook: "${lead.opening_line}"`)
  } else {
    lines.push('Use placeholders (substituted at send time):')
    lines.push('  {{first_name}}, {{last_name}}, {{full_name}}, {{company}}, {{title}}, {{industry}}')
    lines.push('  {{opening_line}} — AI-personalised opener crafted for this specific lead')
  }
  lines.push('')

  // ── Output format ──
  lines.push('━━━ OUTPUT FORMAT ━━━')
  lines.push('Respond ONLY with valid JSON. No markdown. No explanation.')
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

  const systemPrompt = `You are a B2B sales copywriter who writes LinkedIn outreach that gets replies because it reads like a real human wrote it.

You study the lead's profile — their about section, current role, skills, recent posts — and find the one specific angle that would make this particular person pause and read.

${HUMAN_WRITING_RULES}

Every message you write is distinct from the others in the sequence — a new angle, not a repetition.`

  const response = await getAi().messages.create({
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
    throw new Error(`AI returned unexpected format: ${raw.slice(0, 200)}`)
  }

  // Enforce connection note character limit
  if (input.step_type === 'connect' && parsed.body.length > 300) {
    parsed.body = parsed.body.slice(0, 297) + '...'
  }

  const stepLabels: Record<SequenceStepType, string> = {
    connect:  'Connection Note',
    message:  `Message ${input.position_in_sequence}`,
    follow_up: `Follow-up ${input.position_in_sequence - 1}`,
    inmail:   'InMail',
  }
  const nameSuggestion = `${stepLabels[input.step_type]} — ${input.product.name}`

  return {
    body: parsed.body,
    subject: parsed.subject,
    name_suggestion: nameSuggestion,
  }
}

// ─── Helper: collect step chain ───────────────────────────────────────────────

export interface StepNode {
  id: string
  type: string
  message_template: string | null
  parent_step_id: string | null
  branch: string | null
  step_order: number
  ai_generation_mode: boolean
}

export function buildPriorChain(targetStepId: string, allSteps: StepNode[]): StepNode[] {
  const byId = new Map(allSteps.map(s => [s.id, s]))
  const ancestors: StepNode[] = []
  let current = byId.get(targetStepId)
  while (current && current.parent_step_id) {
    const parent = byId.get(current.parent_step_id)
    if (parent) ancestors.unshift(parent)
    current = parent
  }
  return ancestors
}

export function getMessagePosition(targetStepId: string, allSteps: StepNode[]): number {
  const chain = buildPriorChain(targetStepId, allSteps)
  const byId = new Map(allSteps.map(s => [s.id, s]))
  const target = byId.get(targetStepId)
  if (!target) return 1
  const messageTypes = new Set(['connect', 'message', 'inmail', 'follow_up'])
  return chain.filter(s => messageTypes.has(s.type)).length + 1
}
