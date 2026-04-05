import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

export interface GenerateMessageParams {
  type: MessageType
  approach: Approach
  icp_config: IcpConfig
  product_index?: number   // which product to focus on (index into products_services)
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
    instruction: `Get straight to the point. One clear sentence about who you help and the result they get. Zero corporate jargon, zero warm-up. Punchy and confident. The recipient should understand the entire value proposition before the second line. Busy senior people appreciate not having their time wasted.`,
  },
  trigger_based: {
    label: 'Trigger-Based',
    instruction: `Open by referencing a specific recent signal or event about the recipient — use {{opening_line}} as the personalised trigger at the start. Make it feel timely, as if you spotted something specific. The pitch should feel like a natural follow-on from that observation, not a pivot. Never say "I came across your profile."`,
  },
  insight_challenger: {
    label: 'Insight / Challenger',
    instruction: `Open with a counter-intuitive or provocative insight about their industry, role, or a problem they're likely sitting with. Something that reframes how they think. Then connect that insight naturally to what you do. Position yourself as a peer with genuine perspective — not a vendor. Make them think "hm, that's actually true."`,
  },
  problem_solution: {
    label: 'Problem → Solution',
    instruction: `Open by naming the exact pain point your target audience is most likely experiencing right now. Be specific — generic problems get ignored. Make them feel understood in the first sentence. Then present the solution crisply. No fluff between problem and solution.`,
  },
  social_proof: {
    label: 'Social Proof',
    instruction: `Lead immediately with a specific, credible result achieved for a similar company or role. Numbers and specifics make this work — vague claims get ignored. Then briefly explain what you do and invite them to explore relevance. Let the outcome sell, not the pitch.`,
  },
  question_hook: {
    label: 'Question Hook',
    instruction: `Open with a single sharp, thought-provoking question directly relevant to their role or business. It should be easy to engage with — a yes/no or a quick thought. The question should create just enough curiosity that the rest of the message feels like a natural answer. One question only.`,
  },
  before_after_bridge: {
    label: 'Before / After / Bridge',
    instruction: `Paint a vivid but concise picture of where they likely are now (the frustrating current state). Then contrast with where they could be (the desired outcome). Then position yourself as the bridge. Create tension in the "before," relief in the "after," and make yourself the obvious bridge. Avoid clichés.`,
  },
  mutual_ground: {
    label: 'Mutual Ground',
    instruction: `Open by referencing something genuinely shared — a mutual connection, community, industry group, conference, or shared professional background. Use {{opening_line}} if it contains useful context. Make it feel like a warm peer-to-peer introduction. The shared ground should feel earned, not forced or flattering.`,
  },
  pattern_interrupt: {
    label: 'Pattern Interrupt',
    instruction: `Break the mould of typical LinkedIn cold messages. Be unexpectedly self-aware, disarming, or open with a surprising angle — something that makes them stop mid-scroll. You might acknowledge the outreach dynamic in a way that's refreshing rather than apologetic. Slightly dry humour works if it fits. Memorable over conventional. Never start with "I know you get a lot of these."`,
  },
  value_first: {
    label: 'Value-First',
    instruction: `Lead with something genuinely useful — a specific insight, benchmark, or observation they can act on regardless of whether they reply. No hard sell. The ask should be curiosity-driven: offer to share more if useful. Position yourself as a generous peer. The recipient should feel they got something from this message even if they don't respond.`,
  },
}

// ── Type constraints ───────────────────────────────────────────────────────────

const TYPE_CONSTRAINTS: Record<MessageType, string> = {
  connection: `CONNECTION REQUEST — strict 300 character limit (including spaces). Be ultra-concise. One or two short sentences maximum. No lengthy pitches. Every word must earn its place.`,
  message:    `DIRECT MESSAGE — aim for 80–150 words. Conversational tone, not formal. Easy to read on mobile. Clear single call to action at the end.`,
  follow_up:  `FOLLOW-UP MESSAGE — 60–120 words. Acknowledge this is a follow-up without being pushy or apologetic. Add new value or a new angle rather than just "checking in." One soft CTA.`,
  inmail:     `INMAIL — 150–250 words. You have slightly more space — use it to make a compelling case. Also generate a subject line (5–8 words, curiosity-driven, no clickbait). Professional but still human.`,
}

// ── Main function ──────────────────────────────────────────────────────────────

export async function generateMessage(params: GenerateMessageParams): Promise<GenerateMessageResult> {
  const { type, approach, icp_config, product_index } = params
  const approachInfo = APPROACH_INSTRUCTIONS[approach]

  // Build product context
  let productContext = 'Not specified.'
  const products = icp_config.products_services ?? []
  if (products.length > 0) {
    const product = product_index !== undefined ? products[product_index] : products[0]
    if (product) {
      const lines = [`Product/Service: ${product.name}`]
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

  const prompt = `You are an expert B2B sales copywriter specialising in LinkedIn outreach that actually gets replies.

Write a LinkedIn ${type.replace('_', ' ')} using the "${approachInfo.label}" approach.

━━━ MESSAGE TYPE ━━━
${TYPE_CONSTRAINTS[type]}

━━━ APPROACH: ${approachInfo.label} ━━━
${approachInfo.instruction}

━━━ WHAT WE SELL ━━━
${productContext}

━━━ TARGET AUDIENCE ━━━
${audienceContext}
${icp_config.notes?.trim() ? `\nAdditional context: ${icp_config.notes.trim()}` : ''}

━━━ VARIABLES (use these exactly — they get replaced per recipient) ━━━
- {{first_name}} — recipient's first name (always include this)
- {{company}} — recipient's company (include where natural)
- {{title}} — recipient's job title
- {{opening_line}} — AI-personalised opener based on their profile (use this as the personalised hook when the approach calls for it)

━━━ WRITING RULES ━━━
- Write in first person as the sender
- Never start with "I hope this message finds you well" or any filler opener
- Never use "I wanted to reach out" as an opener
- Avoid excessive exclamation marks
- No corporate buzzwords (synergy, leverage, circle back, touch base)
- Sound like a smart human, not a marketing email
- Use paragraph breaks (\\n\\n) for readability
- The CTA should be low-friction — a question, not a demand
${type === 'connection' ? '- For connection requests: no CTA needed, just make them want to accept' : ''}

Respond ONLY with valid JSON, no markdown fences, no extra text:
{
  "body": "...",${needsSubject ? '\n  "subject": "...",' : ''}
  "name_suggestion": "5–7 word template name"
}`

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (message.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const result = JSON.parse(json) as GenerateMessageResult
  return result
}
