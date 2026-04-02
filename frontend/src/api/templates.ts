import type { StepType, Branch } from './sequences'
import { apiFetch } from '../lib/fetchJson'

// ── Template step shape ────────────────────────────────────────────────────────
// parent_index refers to another step's position in the steps array (for fork children).

export interface TemplateStep {
  type: StepType
  step_order: number
  branch: Branch
  parent_index: number | null
  message_template?: string | null
  subject?: string | null
  wait_days?: number | null
  condition?: Record<string, unknown> | null
}

export interface Template {
  id: string
  name: string
  description: string
  steps: TemplateStep[]
  is_preset?: boolean  // true = built-in, false = user-saved
}

export interface SavedTemplate {
  id: string
  user_id: string
  name: string
  description: string | null
  steps_json: TemplateStep[]
  created_at: string
}

// ── Pre-defined templates ─────────────────────────────────────────────────────

export const PRESET_TEMPLATES: Template[] = [
  {
    // Most commonly used LinkedIn outreach flow. ~30–40% acceptance rate.
    // View profile signals genuine interest before the connect request.
    // One follow-up message after connecting, then end cleanly.
    id: 'preset_connect_one_touch',
    name: 'Connect + One Follow-up',
    description: 'View → Connect with note → Wait 4 days → Message → End',
    is_preset: true,
    steps: [
      // index 0
      { type: 'view_profile', step_order: 0, branch: 'main', parent_index: null },
      // index 1
      { type: 'connect', step_order: 1, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, I came across your profile and thought it'd be great to connect — I work in a similar space and think there could be some value in staying in touch." },
      // index 2
      { type: 'wait', step_order: 2, branch: 'main', parent_index: null,
        wait_days: 4, condition: { wait_unit: 'days' } },
      // index 3
      { type: 'message', step_order: 3, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, thanks for connecting! I noticed you're leading things at {{company}} — curious whether [specific challenge] is something on your radar right now? Happy to share what we've seen work for similar teams." },
      // index 4
      { type: 'end', step_order: 4, branch: 'main', parent_index: null },
    ],
  },
  {
    // Follow first to appear in their notifications feed before connecting.
    // Increases name recognition → higher connection acceptance.
    // Only 2 touches after connecting — keeps it lightweight.
    id: 'preset_follow_first',
    name: 'Follow → Connect → Message',
    description: 'Follow → Wait 2 days → Connect → Wait 5 days → Message → End',
    is_preset: true,
    steps: [
      // index 0
      { type: 'view_profile', step_order: 0, branch: 'main', parent_index: null },
      // index 1
      { type: 'follow', step_order: 1, branch: 'main', parent_index: null },
      // index 2
      { type: 'wait', step_order: 2, branch: 'main', parent_index: null,
        wait_days: 2, condition: { wait_unit: 'days' } },
      // index 3
      { type: 'connect', step_order: 3, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, I've been following your work — your perspective on this space is really sharp. Would love to connect." },
      // index 4
      { type: 'wait', step_order: 4, branch: 'main', parent_index: null,
        wait_days: 5, condition: { wait_unit: 'days' } },
      // index 5
      { type: 'message', step_order: 5, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, great to be connected! Quick question — how is {{company}} currently handling [specific problem]? I've been working with a few similar teams on this and have some thoughts that might be useful." },
      // index 6
      { type: 'end', step_order: 6, branch: 'main', parent_index: null },
    ],
  },
  {
    // React to a post first — they get a notification, creates warm familiarity.
    // Connection note references their content which boosts acceptance.
    // Proven to outperform cold connect in acceptance rate.
    id: 'preset_engage_first',
    name: 'React to Post → Connect → Message',
    description: 'React → Wait 2 days → Connect → Wait 4 days → Message → End',
    is_preset: true,
    steps: [
      // index 0
      { type: 'view_profile', step_order: 0, branch: 'main', parent_index: null },
      // index 1
      { type: 'react_post', step_order: 1, branch: 'main', parent_index: null,
        condition: { reaction: 'like' } },
      // index 2
      { type: 'wait', step_order: 2, branch: 'main', parent_index: null,
        wait_days: 2, condition: { wait_unit: 'days' } },
      // index 3
      { type: 'connect', step_order: 3, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, I came across your recent post and it really resonated. Would love to connect with someone thinking about this space the way you are." },
      // index 4
      { type: 'wait', step_order: 4, branch: 'main', parent_index: null,
        wait_days: 4, condition: { wait_unit: 'days' } },
      // index 5
      { type: 'message', step_order: 5, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, thanks for connecting! Your post got me thinking about how {{company}} approaches [topic]. We've been helping teams tackle exactly this — would a quick 15-min call be worth it?" },
      // index 6
      { type: 'end', step_order: 6, branch: 'main', parent_index: null },
    ],
  },
  {
    // Handles the reality that ~40–60% of connection requests go unanswered.
    // Fork after waiting: message those who accepted, InMail those who didn't.
    // Maximises reach from a single campaign.
    id: 'preset_connect_fork',
    name: 'Connect → Fork on Acceptance',
    description: 'Connect → Wait 5 days → Fork: message if accepted, InMail if not → End',
    is_preset: true,
    steps: [
      // index 0
      { type: 'view_profile', step_order: 0, branch: 'main', parent_index: null },
      // index 1
      { type: 'connect', step_order: 1, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, I work with {{title}}s at companies like {{company}} on [specific problem]. Would love to connect and share some thoughts." },
      // index 2
      { type: 'wait', step_order: 2, branch: 'main', parent_index: null,
        wait_days: 5, condition: { wait_unit: 'days' } },
      // index 3
      { type: 'fork', step_order: 3, branch: 'main', parent_index: null,
        condition: { type: 'connected' } },
      // index 4 — YES: direct message (they accepted)
      { type: 'message', step_order: 0, branch: 'if_yes', parent_index: 3,
        message_template: "Hi {{first_name}}, thanks for connecting! I work with teams at companies like {{company}} to [specific outcome]. Would it be worth a quick 15-min call to see if there's a fit?" },
      // index 5 — YES: end
      { type: 'end', step_order: 1, branch: 'if_yes', parent_index: 3 },
      // index 6 — NO: InMail (didn't accept)
      { type: 'inmail', step_order: 0, branch: 'if_no', parent_index: 3,
        subject: '{{first_name}} — quick question',
        message_template: "Hi {{first_name}}, I reached out to connect but wanted to follow up directly. I've been working with {{title}}s at similar companies on [specific problem] and thought it might be relevant to you. Worth a 15-min call?" },
      // index 7 — NO: end
      { type: 'end', step_order: 1, branch: 'if_no', parent_index: 3 },
    ],
  },
  {
    // Two-touch sequence with reply check after the first message.
    // If they reply, end the automation — handle the conversation manually.
    // If no reply after 5 days, send one more short bump then stop.
    id: 'preset_two_touch_reply',
    name: 'Connect → Message → Reply Check → Bump',
    description: 'Connect → Message → Wait → Fork: end if replied, one bump if not → End',
    is_preset: true,
    steps: [
      // index 0
      { type: 'view_profile', step_order: 0, branch: 'main', parent_index: null },
      // index 1
      { type: 'connect', step_order: 1, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, would love to connect — I work in a related space and think it's worth staying in touch." },
      // index 2
      { type: 'wait', step_order: 2, branch: 'main', parent_index: null,
        wait_days: 3, condition: { wait_unit: 'days' } },
      // index 3
      { type: 'message', step_order: 3, branch: 'main', parent_index: null,
        message_template: "Hi {{first_name}}, thanks for connecting! We help {{title}}s at companies like {{company}} with [specific outcome]. Is this something you're currently thinking about?" },
      // index 4
      { type: 'wait', step_order: 4, branch: 'main', parent_index: null,
        wait_days: 5, condition: { wait_unit: 'days' } },
      // index 5
      { type: 'fork', step_order: 5, branch: 'main', parent_index: null,
        condition: { type: 'replied' } },
      // index 6 — YES: they replied, take it offline
      { type: 'end', step_order: 0, branch: 'if_yes', parent_index: 5 },
      // index 7 — NO: one short bump
      { type: 'message', step_order: 0, branch: 'if_no', parent_index: 5,
        message_template: "Hi {{first_name}}, just bumping this up in case it got buried. No worries if the timing isn't right — happy to reconnect down the road." },
      // index 8 — NO: end
      { type: 'end', step_order: 1, branch: 'if_no', parent_index: 5 },
    ],
  },
  {
    // InMail-only for premium accounts targeting senior or hard-to-reach profiles.
    // Single high-quality touch — no connect request needed.
    // Reply fork: if they respond, send calendar link. If not, stop cleanly.
    id: 'preset_inmail_senior',
    name: 'InMail → Reply Fork (Premium)',
    description: 'InMail → Wait 7 days → Fork: calendar if replied, end if not',
    is_preset: true,
    steps: [
      // index 0
      { type: 'view_profile', step_order: 0, branch: 'main', parent_index: null },
      // index 1
      { type: 'inmail', step_order: 1, branch: 'main', parent_index: null,
        subject: '{{first_name}} — quick question about {{company}}',
        message_template: "Hi {{first_name}},\n\nI noticed you're leading [function] at {{company}} — we've been helping similar teams [specific outcome] and I thought it might be worth a quick conversation.\n\nWould a 15-min call this week make sense?" },
      // index 2
      { type: 'wait', step_order: 2, branch: 'main', parent_index: null,
        wait_days: 7, condition: { wait_unit: 'days' } },
      // index 3
      { type: 'fork', step_order: 3, branch: 'main', parent_index: null,
        condition: { type: 'replied' } },
      // index 4 — YES: they replied, send calendar
      { type: 'message', step_order: 0, branch: 'if_yes', parent_index: 3,
        message_template: "Hi {{first_name}}, great to hear from you! Here's a link to book a time that works: [calendar link]. Looking forward to it." },
      // index 5 — YES: end
      { type: 'end', step_order: 1, branch: 'if_yes', parent_index: 3 },
      // index 6 — NO: end cleanly (don't spam senior profiles)
      { type: 'end', step_order: 0, branch: 'if_no', parent_index: 3 },
    ],
  },
]

// ── API calls for user-saved templates ────────────────────────────────────────

export async function fetchUserTemplates(): Promise<SavedTemplate[]> {
  const res = await apiFetch('/api/templates')
  if (!res.ok) throw new Error('Failed to fetch templates')
  const { data } = await res.json() as { data: SavedTemplate[] }
  return data ?? []
}

export async function saveTemplate(
  name: string,
  description: string,
  steps: TemplateStep[]
): Promise<SavedTemplate> {
  const res = await apiFetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, steps_json: steps }),
  })
  if (!res.ok) throw new Error('Failed to save template')
  const { data } = await res.json() as { data: SavedTemplate }
  return data
}

export async function deleteUserTemplate(id: string): Promise<void> {
  const res = await apiFetch(`/api/templates/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete template')
}
