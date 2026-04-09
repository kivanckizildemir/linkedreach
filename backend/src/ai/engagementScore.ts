/**
 * Engagement Score — behavioural warmth scoring
 *
 * Calls Claude with the full conversation thread + engagement event log
 * and returns a 0-100 warmth score based on how the lead is reacting
 * to outreach. Separate from the static ICP score.
 *
 * Hard rules enforced in the prompt (Claude must follow):
 *   - No reply at all          → max 30
 *   - Connection accepted only → max 35
 *   - Any positive reply       → min 40
 *   - Most recent msg negative → max 45
 *   - Most recent msg positive → min 50
 *   - Blocked / removed        → 0, locked
 *   - Clear "not interested"   → 0-15, locked
 *
 * Trend: delta vs previous_engagement_score
 *   > 3  → "up"
 *   < -3 → "down"
 *   else → "stable"
 */

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export type EngagementTrend = 'up' | 'down' | 'stable'

export interface EngagementEvent {
  type:
    | 'connection_accepted'
    | 'connection_rejected'
    | 'message_replied'
    | 'profile_viewed_back'
    | 'post_liked'
    | 'post_commented'
    | 'removed_connection'
    | 'marked_spam'
  at: string   // ISO timestamp
  note?: string
}

export interface EngagementResult {
  score: number
  trend: EngagementTrend
  reasoning: string
}

function buildPrompt(
  messages: Array<{ direction: 'sent' | 'received'; content: string; sent_at: string }>,
  events: EngagementEvent[],
): string {
  const lines: string[] = []

  lines.push('You are a B2B sales expert measuring how warm a lead is based on their behaviour.')
  lines.push('Score their engagement warmth from 0 to 100.')
  lines.push('')

  // ── Conversation thread ──
  if (messages.length > 0) {
    lines.push('## Conversation Thread (chronological, oldest first)')
    for (const m of messages) {
      const dir = m.direction === 'sent' ? 'SENDER' : 'LEAD'
      const date = new Date(m.sent_at).toISOString().slice(0, 10)
      lines.push(`[${date}] ${dir}: ${m.content}`)
    }
    lines.push('')
  } else {
    lines.push('## Conversation Thread')
    lines.push('No messages exchanged yet.')
    lines.push('')
  }

  // ── Engagement events ──
  if (events.length > 0) {
    lines.push('## Engagement Events')
    for (const e of events) {
      const date = new Date(e.at).toISOString().slice(0, 10)
      lines.push(`[${date}] ${e.type.replace(/_/g, ' ')}${e.note ? ' — ' + e.note : ''}`)
    }
    lines.push('')
  } else {
    lines.push('## Engagement Events')
    lines.push('None recorded.')
    lines.push('')
  }

  // ── Scoring rules ──
  lines.push('## Scoring Rules (you MUST follow these exactly)')
  lines.push('')
  lines.push('Hard ceilings/floors:')
  lines.push('- No messages received from lead AND no positive events → max score: 30')
  lines.push('- Connection accepted but no reply → max score: 35')
  lines.push('- Lead has sent at least one positive reply → min score: 40')
  lines.push('- Most recent lead message is negative/dismissive → max score: 45')
  lines.push('- Most recent lead message is positive/curious → min score: 50')
  lines.push('- Lead removed connection or marked as spam → score: 0 (hard lock)')
  lines.push('- Lead clearly said "not interested", "stop", "unsubscribe" → score: 0–15 (hard lock)')
  lines.push('')
  lines.push('Recency rule:')
  lines.push('- The most recent message carries 70% of the sentiment weight.')
  lines.push('- All previous messages combined carry 30%.')
  lines.push('- A positive reply after a negative one should result in net positive score.')
  lines.push('')
  lines.push('Signal quality:')
  lines.push('- A genuine reply (any length) >> liked a post >> viewed profile')
  lines.push('- A reply with a question shows active interest — treat it as strong positive')
  lines.push('- Short dismissive replies count as negative even if polite')
  lines.push('')
  lines.push('## Score Bands')
  lines.push('80–100: Very warm — lead is clearly engaged and interested')
  lines.push('60–79:  Warm — positive signals, conversation going well')
  lines.push('40–59:  Neutral — some engagement but unclear direction')
  lines.push('20–39:  Cooling — interest fading or mixed signals')
  lines.push('0–19:   Cold / disengaged — no meaningful engagement')
  lines.push('')
  lines.push('Respond ONLY with valid JSON (no markdown, no extra text):')
  lines.push('{"score": <0-100>, "reasoning": "<1 concise sentence explaining the score>"}')

  return lines.join('\n')
}

/**
 * Recalculates the engagement score for a campaign_lead.
 * Reads the message thread + engagement_events from the DB,
 * calls Claude, then writes the result back.
 */
export async function scoreEngagement(campaignLeadId: string): Promise<EngagementResult | null> {
  // Fetch current engagement score + events
  const { data: cl, error: clErr } = await supabase
    .from('campaign_leads')
    .select('engagement_score, engagement_events')
    .eq('id', campaignLeadId)
    .single()

  if (clErr || !cl) {
    console.error('[engagementScore] campaign_lead not found:', campaignLeadId)
    return null
  }

  const previousScore: number | null = (cl as { engagement_score?: number | null }).engagement_score ?? null
  const events: EngagementEvent[] = ((cl as { engagement_events?: EngagementEvent[] }).engagement_events ?? [])

  // Fetch message thread
  const { data: messages, error: msgErr } = await supabase
    .from('messages')
    .select('direction, content, sent_at')
    .eq('campaign_lead_id', campaignLeadId)
    .order('sent_at', { ascending: true })

  if (msgErr) {
    console.error('[engagementScore] failed to fetch messages:', msgErr.message)
    return null
  }

  const thread = (messages ?? []) as Array<{ direction: 'sent' | 'received'; content: string; sent_at: string }>

  // Call Claude
  const prompt = buildPrompt(thread, events)

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (response.content[0] as { type: string; text: string }).text.trim()
  const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const parsed = JSON.parse(json) as { score: number; reasoning: string }

  const newScore = Math.max(0, Math.min(100, Math.round(parsed.score)))

  // Calculate trend
  let trend: EngagementTrend = 'stable'
  if (previousScore != null) {
    const delta = newScore - previousScore
    if (delta > 3) trend = 'up'
    else if (delta < -3) trend = 'down'
  }

  // Write back to DB
  await supabase
    .from('campaign_leads')
    .update({
      previous_engagement_score: previousScore,
      engagement_score: newScore,
      engagement_trend: trend,
      engagement_reasoning: parsed.reasoning,
      engagement_updated_at: new Date().toISOString(),
    })
    .eq('id', campaignLeadId)

  return { score: newScore, trend, reasoning: parsed.reasoning }
}

/**
 * Appends an engagement event to the campaign_lead's event log
 * and immediately recalculates the score.
 */
export async function recordEngagementEvent(
  campaignLeadId: string,
  event: Omit<EngagementEvent, 'at'>,
): Promise<EngagementResult | null> {
  const newEvent: EngagementEvent = { ...event, at: new Date().toISOString() }

  // Read current events, append, write back
  const { data: cl } = await supabase
    .from('campaign_leads')
    .select('engagement_events')
    .eq('id', campaignLeadId)
    .single()

  const existing: EngagementEvent[] = ((cl as { engagement_events?: EngagementEvent[] } | null)?.engagement_events ?? [])
  const updated = [...existing, newEvent]

  await supabase
    .from('campaign_leads')
    .update({ engagement_events: updated })
    .eq('id', campaignLeadId)

  // Recalculate score
  return scoreEngagement(campaignLeadId)
}
