-- User settings table: stores per-user ICP config + defaults
create table if not exists user_settings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade unique,
  icp_config  jsonb not null default '{
    "target_titles": ["CEO", "CTO", "VP", "Director", "Head of", "Founder"],
    "target_industries": [],
    "target_locations": [],
    "min_company_size": null,
    "max_company_size": null,
    "notes": "Score based on seniority and decision-making authority."
  }'::jsonb,
  timezone        text not null default 'Europe/London',
  daily_connection_limit  int not null default 20,
  daily_message_limit     int not null default 80,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table user_settings enable row level security;

create policy "Users manage own settings"
  on user_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-create settings row when user signs up
create or replace function create_user_settings()
returns trigger language plpgsql security definer as $$
begin
  insert into user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_settings on auth.users;
create trigger on_auth_user_created_settings
  after insert on auth.users
  for each row execute procedure create_user_settings();
