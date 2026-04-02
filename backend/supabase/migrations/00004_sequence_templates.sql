-- Sequence Templates
-- Stores user-saved sequence templates. Pre-defined templates are hardcoded in the frontend.

create table sequence_templates (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  steps_json jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create index idx_sequence_templates_user_id on sequence_templates(user_id);

alter table sequence_templates enable row level security;

create policy "Users can view own templates"
  on sequence_templates for select
  using (auth.uid() = user_id);

create policy "Users can insert own templates"
  on sequence_templates for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own templates"
  on sequence_templates for delete
  using (auth.uid() = user_id);
