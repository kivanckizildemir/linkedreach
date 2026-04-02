-- Blacklist: domains, emails or company names to exclude from outreach
create table if not exists blacklist (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  type        text not null check (type in ('domain', 'email', 'company')),
  value       text not null,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, type, value)
);

-- RLS
alter table blacklist enable row level security;

create policy "Users manage own blacklist"
  on blacklist for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index
create index if not exists idx_blacklist_user_id on blacklist(user_id);
