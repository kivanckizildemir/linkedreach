/**
 * Analyze a lead's reply to score warmth, detect intent, extract tone/length,
 * and detect meeting interest. Used exclusively by the Agent Mode reply worker.
 *
 * temperature: 0 for determinism — same reply always produces the same analysis.
 */

import Anthropic from '@anthropic-ai/sdk'

let _ai: Anthropic | null = null
function getAi(): Anthropic {
  if (!_ai) _ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _ai
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type WarmthFlag =
  | 'hot'            // Ready to buy / book / meet — strong positive signal
  | 'warm'           // Interested, engaged, asking questions
  | 'neutral'        // Polite but non-committal, no clear signal
  | 'cold'           // Disengaged, minimal, one-word replies
  | 'objection'      // Raises a specific concern or pushback (but hasn't said no)
  | 'not_interested' // Explicit rejection or "remove me"

export type ReplyTone =
  | 'enthusiastic'   // Excited, lots of energy, exclamation marks
  | 'professional'   // Formal, structured, business language
  | 'conversational' // Relaxed peer-to-peer tone
  | 'casual'         // Informal, contractions, friendly
  | 'curt'           // Very short, minimal, clipped

export type ReplyIntent =
  | 'interested'      // Positive engagement, wants to learn more
  | 'curious'         // Asking questions, exploring
  | 'objecting'       // Raising concerns or pushback
  | 'deflecting'      // Redirecting without saying no
  | 'scheduling'      // Proactively suggesting a call or meeting
  | 'asking_info'     // Requesting specific information or details
  | 'not_interested'  // Declining, opting out

export interface ReplyAnalysis {
  warmth_score:              number        // 0–100
  warmth_flag:               WarmthFlag
  reply_tone:                ReplyTone
  reply_length_words:        number
  reply_intent:              ReplyIntent
  meeting_interest_detected: boolean       // Did they hint at openness to a call/meeting?
  location_mentioned:        string | null // Any location they mentioned (for f2f matching)
  key_objection:             string | null // If objecting, what's the core concern?
  reasoning:                 string
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(
  replyText: string,
  conversationHistory: Array<{ direction: 'sent' | 'received'; content: string }>,
  leadName: string
): string {
  const lines: string[] = []

  lines.push('You are analyzing a LinkedIn reply to score lead warmth and extract signal for an AI sales agent.')
  lines.push('Be precise and conservative — do not over-score warmth based on politeness alone.')
  lines.push('')

  if (conversationHistory.length > 0) {
    lines.push('━━━ CONVERSATION HISTORY (most recent last) ━━━')
    conversationHistory.forEach((m, i) => {
      const label = m.direction === 'sent' ? 'YOU' : leadName.toUpperCase()
      lines.push(`[${label} — msg ${i + 1}]: "${m.content}"`)
    })
    lines.push('')
  }

  lines.push('━━━ REPLY TO ANALYZE ━━━')
  lines.push(`"${replyText}"`)
  lines.push('')

  lines.push('━━━ SCORING RULES ━━━')
  lines.push('')
  lines.push('warmth_score (0–100):')
  lines.push('  90–100: scheduling a call, asking for pricing, "let\'s do this"')
  lines.push('  70–89:  asking specific questions, wants to learn more, positive engagement')
  lines.push('  50–69:  open but non-committal, "sounds interesting", mild curiosity')
  lines.push('  30–49:  polite but vague, minimal engagement, hard to read')
  lines.push('  10–29:  curt, one-word, clearly not interested but not explicit')
  lines.push('  0–9:    explicit rejection, "not interested", "remove me", opt-out language')
  lines.push('')
  lines.push('warmth_flag: hot | warm | neutral | cold | objection | not_interested')
  lines.push('  hot           → score 80+')
  lines.push('  warm          → score 55–79')
  lines.push('  neutral       → score 30–54')
  lines.push('  cold          → score 10–29')
  lines.push('  objection     → any score, but reply raises a specific concern')
  lines.push('  not_interested → score 0–9 or explicit rejection')
  lines.push('')
  lines.push('reply_tone: enthusiastic | professional | conversational | casual | curt')
  lines.push('reply_intent: interested | curious | objecting | deflecting | scheduling | asking_info | not_interested')
  lines.push('')
  lines.push('meeting_interest_detected: true if they use words like "call", "chat", "meet",')
  lines.push('  "schedule", "book", "coffee", "zoom", "speak", "connect" in a positive context.')
  lines.push('')
  lines.push('location_mentioned: extract any location they reference (city, country, region).')
  lines.push('  null if none mentioned.')
  lines.push('')
  lines.push('key_objection: if intent is "objecting", summarise the core concern in ≤15 words.')
  lines.push('  null otherwise.')
  lines.push('')
  lines.push('━━━ OUTPUT FORMAT ━━━')
  lines.push('Respond ONLY with valid JSON. No markdown. No explanation.')
  lines.push(`{
  "warmth_score": number,
  "warmth_flag": string,
  "reply_tone": string,
  "reply_length_words": number,
  "reply_intent": string,
  "meeting_interest_detected": boolean,
  "location_mentioned": string | null,
  "key_objection": string | null,
  "reasoning": string
}`)

  return lines.join('\n')
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function analyzeReply(
  replyText: string,
  conversationHistory: Array<{ direction: 'sent' | 'received'; content: string }>,
  leadName: string
): Promise<ReplyAnalysis> {
  const prompt = buildPrompt(replyText, conversationHistory, leadName)

  const response = await getAi().messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 512,
    temperature: 0,
    system: 'You are a precise B2B sales signal analyzer. Output only valid JSON.',
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (response.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')

  let parsed: ReplyAnalysis
  try {
    parsed = JSON.parse(json) as ReplyAnalysis
  } catch {
    throw new Error(`analyzeReply: unexpected AI format: ${raw.slice(0, 200)}`)
  }

  // Ensure reply_length_words is set (count as fallback if AI missed it)
  if (!parsed.reply_length_words) {
    parsed.reply_length_words = replyText.trim().split(/\s+/).length
  }

  return parsed
}
