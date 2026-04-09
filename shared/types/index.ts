export type AccountStatus = 'active' | 'paused' | 'banned' | 'warming_up'

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'

export type StepType = 'connect' | 'message' | 'wait' | 'inmail' | 'view_profile' | 'react_post' | 'fork'

export type IcpFlag = 'hot' | 'warm' | 'cold' | 'disqualified'

export type LeadSource = 'excel_import' | 'chrome_extension' | 'manual'

export type CampaignLeadStatus =
  | 'pending'
  | 'connection_sent'
  | 'connected'
  | 'messaged'
  | 'replied'
  | 'converted'
  | 'stopped'

export type ReplyClassification =
  | 'interested'
  | 'not_now'
  | 'wrong_person'
  | 'referral'
  | 'negative'
  | 'none'

export type MessageDirection = 'sent' | 'received'

export interface LinkedInAccount {
  id: string
  user_id: string
  linkedin_email: string
  cookies: string
  proxy_id: string | null
  status: AccountStatus
  daily_connection_count: number
  daily_message_count: number
  last_active_at: string | null
  warmup_day: number
  has_premium: boolean
  inmail_credits: number
  created_at: string
  updated_at: string
}

export interface Campaign {
  id: string
  user_id: string
  name: string
  status: CampaignStatus
  icp_config: Record<string, unknown>
  daily_connection_limit: number
  daily_message_limit: number
  created_at: string
  updated_at: string
}

export interface Sequence {
  id: string
  campaign_id: string
  name: string
  created_at: string
  updated_at: string
}

export interface SequenceStep {
  id: string
  sequence_id: string
  step_order: number
  type: StepType
  message_template: string | null
  subject: string | null
  wait_days: number | null
  condition: Record<string, unknown> | null
  parent_step_id: string | null
  branch: 'main' | 'if_yes' | 'if_no'
  created_at: string
  updated_at: string
}

export interface Lead {
  id: string
  user_id: string
  linkedin_url: string
  first_name: string
  last_name: string
  title: string | null
  company: string | null
  industry: string | null
  location: string | null
  connection_degree: number | null
  icp_score: number | null
  icp_flag: IcpFlag | null
  source: LeadSource
  raw_data: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type EngagementTrend = 'up' | 'down' | 'stable'

export interface CampaignLead {
  id: string
  campaign_id: string
  lead_id: string
  account_id: string | null
  status: CampaignLeadStatus
  current_step: number
  last_action_at: string | null
  reply_classification: ReplyClassification
  engagement_score: number | null
  previous_engagement_score: number | null
  engagement_trend: EngagementTrend | null
  engagement_reasoning: string | null
  engagement_updated_at: string | null
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  campaign_lead_id: string
  direction: MessageDirection
  content: string
  sent_at: string
  linkedin_message_id: string | null
  created_at: string
  updated_at: string
}

export interface Proxy {
  id: string
  proxy_url: string
  assigned_account_id: string | null
  is_available: boolean
  created_at: string
  updated_at: string
}
