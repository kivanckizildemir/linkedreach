import Anthropic from '@anthropic-ai/sdk'
import { HUMAN_WRITING_RULES } from './humanRules'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export type MessageType = 'connection' | 'message' | 'follow_up' | 'inmail'
export type Approach =
  | 'direct'
  | 'trigger_based'
  | 'insight_challenger'
  | 'problem_solution'
  | 'social_proof'
  | 'question_hook'
  | 'before_after_bridge'
  | 'mutual_ground'
  | 'pattern_interrupt'
  | 'value_first'

interface Product {
  name: string
  description: string
  target_use_case: string
}

interface IcpConfig {
  target_titles?: string[]
  target_industries?: string[]
  products_services?: Product[]
  notes?: string
}

export interface SenderContext {
  name: string
  headline?: string | null
  about?: string | null
}

export interface GenerateMessageParams {
  type: MessageType
  approach: Approach
  icp_config: IcpConfig
  product_index?: number
  sender?: SenderContext | null
  tone?: string | null
}

export interface GenerateMessageResult {
  body: string
  subject?: string
  name_suggestion: string
}

// ── Approach instructions ──────────────────────────────────────────────────────

const APPROACH_INSTRUCTIONS: Record<Approach, { label: string; instruction: string }> = {
  direct: {
    label: 'Direct / No Fluff',
    instruction: `One clear sentence about who you help and the result they get. Zero warm-up. The recipient should understand the value proposition before the second line.`,
  },
  trigger_based: {
    label: 'Trigger-Based',
    instruction: `Open by referencing a specific recent signal or event — use {{opening_line}} as the personalised trigger. Make it feel timely, not like a pivot to a pitch. Never say "I came across your profile."`,
  },
  insight_challenger: {
    label: 'Insight / Challenger',
    instruction: `Open with a counter-intuitive or provocative insight about their industry or a problem they're sitting with. Connect that insight naturally to what you do. Peer with a perspective, not a vendor.`,
  },
  problem_solution: {
    label: 'Problem → Solution',
    instruction: `Name the exact pain the audience is most likely experiencing right now. Be specific — generic problems get ignored. Then present the solution crisply. Nothing between problem and solution.`,
  },
  social_proof: {
    label: 'Social Proof',
    instruction: `Lead with a specific, credible result for a similar company or role. Numbers and specifics make this work. Let the outcome sell, not the pitch.`,
  },
  question_hook: {
    label: 'Question Hook',
    instruction: `Open with a single sharp question relevant to their role or business. Easy to engage with. Creates just enough curiosity that the rest feels like a natural answer. One question only.`,
  },
  before_after_bridge: {
    label: 'Before / After / Bridge',
    instruction: `Paint the frustrating current state briefly. Contrast with where they could be. Then position yourself as the bridge. Create tension in the before, relief in the after.`,
  },
  mutual_ground: {
    label: 'Mutual Ground',
    instruction: `Reference something genuinely shared — a connection, community, event, or professional background. Use {{opening_line}} if useful. Warm peer-to-peer, earned not forced.`,
  },
  pattern_interrupt: {
    label: 'Pattern Interrupt',
    instruction: `Break the mould of typical LinkedIn cold messages. Self-aware, disarming, or surprising. Something that makes them stop mid-scroll. Memorable over conventional.`,
  },
  value_first: {
    label: 'Value-First',
    instruction: `Lead with something genuinely useful — a specific insight or observation they can act on. No hard sell. The ask is curiosity-driven. They should feel they got something even without replying.`,
  },
}

// ── Type constraints ───────────────────────────────────────────────────────────

const TYPE_CONSTRAINTS: Record<MessageType, string> = {
  connection: `CONNECTION REQUEST — strict 300 character limit. Ultra-concise. One or two short sentences max. Every word must earn its place. No CTA.`,
  message:    `DIRECT MESSAGE — 80–150 words. Conversational. Easy to read on mobile. Single clear question or CTA at the end.`,
  follow_up:  `FOLLOW-UP — 60–120 words. Add new value or a new angle rather than just repeating the pitch. One soft CTA.`,
  inmail:     `INMAIL — 150–250 words. Also generate a subject line: 5–8 words, specific and intriguing. Professional but human.`,
}

// ── Main function ──────────────────────────────────────────────────────────────

export async function generateMessage(params: GenerateMessageParams): Promise<GenerateMessageResult> {
  const { type, approach, icp_config, product_index, sender, tone } = params
  const approachInfo = APPROACH_INSTRUCTIONS[approach]

  // Build product context
  let productContext = 'Not specified.'
  const products = icp_config.products_services ?? []
  if (products.length > 0) {
    const product = product_index !== undefined ? products[product_index] : products[0]
    if (product) {
      const lines = [`Name: ${product.name}`]
      if (product.description) lines.push(`Description: ${product.description}`)
      if (product.target_use_case) lines.push(`Ideal customer: ${product.target_use_case}`)
      productContext = lines.join('\n')
    }
  }

  // Build audience context
  const audienceLines: string[] = []
  if (icp_config.target_titles?.length) audienceLines.push(`Target titles: ${icp_config.target_titles.join(', ')}`)
  if (icp_config.target_industries?.length) audienceLines.push(`Target industries: ${icp_config.target_industries.join(', ')}`)
  const audienceContext = audienceLines.length > 0 ? audienceLines.join('\n') : 'Not specified.'

  const needsSubject = type === 'inmail'

  const prompt = `${sender?.name ? `━━━ SENDER ━━━
You are writing AS: ${sender.name}${sender.headline ? ` (${sender.headline})` : ''}.
${sender.about ? `Their background: ${sender.about.slice(0, 400)}` : ''}
Write in first person as this person. Their voice and background should come through.

` : ''}━━━ MESSAGE TYPE ━━━
${TYPE_CONSTRAINTS[type]}

━━━ APPROACH: ${approachInfo.label} ━━━
${approachInfo.instruction}

${tone ? `━━━ TONE ━━━\nWrite in a ${tone} tone.\n\n` : ''}━━━ WHAT WE SELL ━━━
${productContext}

━━━ TARGET AUDIENCE ━━━
${audienceContext}
${icp_config.notes?.trim() ? `\nAdditional context: ${icp_config.notes.trim()}` : ''}

━━━ VARIABLES (use exactly — substituted per recipient at send time) ━━━
- {{first_name}} — recipient's first name (always include)
- {{company}} — recipient's company (include where natural)
- {{title}} — recipient's job title
- {{opening_line}} — personalised opener based on their profile (use as hook when approach calls for it)

${HUMAN_WRITING_RULES}

Respond ONLY with valid JSON, no markdown fences:
{
  "body": "...",${needsSubject ? '\n  "subject": "...",' : ''}
  "name_suggestion": "5–7 word template name"
}`

  const message = await getClient().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  return JSON.parse(json) as GenerateMessageResult
}
