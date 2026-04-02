-- Campaign scheduling: time window + days of week
alter table campaigns
  add column if not exists schedule_start_hour integer not null default 9  check (schedule_start_hour between 0 and 23),
  add column if not exists schedule_end_hour   integer not null default 17 check (schedule_end_hour   between 0 and 23),
  add column if not exists schedule_days       integer[] not null default '{1,2,3,4,5}', -- 0=Sun, 1=Mon … 6=Sat
  add column if not exists schedule_timezone   text not null default 'UTC';

-- Activity log: per-account action feed
create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  account_id  uuid references linkedin_accounts(id) on delete set null,
  campaign_id uuid references campaigns(id) on delete set null,
  lead_id     uuid references leads(id) on delete set null,
  action      text not null,  -- e.g. 'connection_sent', 'message_sent', 'reply_received', 'qualified', 'error'
  detail      text,
  created_at  timestamptz not null default now()
);

alter table activity_log enable row level security;

create policy "Users view own activity"
  on activity_log for select
  using (auth.uid() = user_id);

create policy "Users insert own activity"
  on activity_log for insert
  with check (auth.uid() = user_id);

create index if not exists idx_activity_log_user_id    on activity_log(user_id);
create index if not exists idx_activity_log_account_id on activity_log(account_id);
create index if not exists idx_activity_log_created_at on activity_log(created_at desc);
