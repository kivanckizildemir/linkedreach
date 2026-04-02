// Re-exported from /shared/types — single source of truth lives there.
// This local copy keeps the backend tsconfig self-contained.

export type AccountStatus = 'active' | 'paused' | 'banned' | 'warming_up'
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'
export type StepType = 'connect' | 'message' | 'wait' | 'inmail' | 'view_profile' | 'react_post' | 'fork' | 'follow' | 'end'
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
export type ReactionType = 'like' | 'celebrate' | 'love' | 'insightful' | 'curious'
