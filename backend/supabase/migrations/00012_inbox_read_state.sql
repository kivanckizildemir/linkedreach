-- Track read/unread state on received messages
alter table messages
  add column if not exists is_read boolean not null default false;

-- Index for fast unread count queries
create index if not exists idx_messages_unread
  on messages(campaign_lead_id, is_read)
  where direction = 'received' and is_read = false;
