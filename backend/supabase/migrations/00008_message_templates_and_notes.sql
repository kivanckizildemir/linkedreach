-- Message templates: reusable message texts with variable support
create table if not exists message_templates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  type        text not null default 'message' check (type in ('connection', 'message', 'follow_up', 'inmail')),
  subject     text,          -- for InMail
  body        text not null,
  variables   text[] default '{}',  -- e.g. ['{{first_name}}', '{{company}}']
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table message_templates enable row level security;

create policy "Users manage own message templates"
  on message_templates for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_message_templates_user_id on message_templates(user_id);

-- Lead notes: CRM-style notes per lead
create table if not exists lead_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  lead_id     uuid not null references leads(id) on delete cascade,
  content     text not null,
  created_at  timestamptz not null default now()
);

alter table lead_notes enable row level security;

create policy "Users manage own lead notes"
  on lead_notes for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists idx_lead_notes_lead_id on lead_notes(lead_id);
create index if not exists idx_lead_notes_user_id on lead_notes(user_id);
