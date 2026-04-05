-- Add product_id to campaigns (references a product object id stored in user_settings.icp_config.products_services[])
-- Stored as text since products live in JSONB, not a normalised table
alter table campaigns
  add column if not exists product_id text;

-- Add ai_generation_mode to sequence_steps
-- When true: message content was AI-generated at authoring time (may also regenerate at send time)
-- When false: message_template is a static literal template (legacy behaviour)
alter table sequence_steps
  add column if not exists ai_generation_mode boolean not null default false;

-- Add step_id to messages so we know which sequence step produced each sent message
-- Null for legacy messages sent before this migration
alter table messages
  add column if not exists step_id uuid references sequence_steps(id) on delete set null;

create index if not exists idx_messages_step_id on messages(step_id);
