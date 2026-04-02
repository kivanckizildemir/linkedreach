-- LinkedReach Initial Schema
-- All tables include id (uuid), created_at, updated_at
-- RLS enabled on all tables — users only see their own data

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "uuid-ossp";

-- ============================================================
-- Helper: auto-update updated_at
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- Table: linkedin_accounts_proxies
-- ============================================================
create table linkedin_accounts_proxies (
  id uuid primary key default uuid_generate_v4(),
  proxy_url text not null,
  assigned_account_id uuid,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_linkedin_accounts_proxies_updated_at
  before update on linkedin_accounts_proxies
  for each row execute function update_updated_at();

-- ============================================================
-- Table: linkedin_accounts
-- ============================================================
create table linkedin_accounts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  linkedin_email text not null,
  cookies text not null default '',
  proxy_id uuid references linkedin_accounts_proxies(id) on delete set null,
  status text not null default 'warming_up'
    check (status in ('active', 'paused', 'banned', 'warming_up')),
  daily_connection_count integer not null default 0,
  daily_message_count integer not null default 0,
  last_active_at timestamptz,
  warmup_day integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_linkedin_accounts_user_id on linkedin_accounts(user_id);

create trigger trg_linkedin_accounts_updated_at
  before update on linkedin_accounts
  for each row execute function update_updated_at();

-- Add back-reference from proxies to accounts
alter table linkedin_accounts_proxies
  add constraint fk_proxy_assigned_account
  foreign key (assigned_account_id) references linkedin_accounts(id)
  on delete set null;

-- ============================================================
-- Table: campaigns
-- ============================================================
create table campaigns (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'completed')),
  icp_config jsonb not null default '{}',
  daily_connection_limit integer not null default 25,
  daily_message_limit integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_campaigns_user_id on campaigns(user_id);

create trigger trg_campaigns_updated_at
  before update on campaigns
  for each row execute function update_updated_at();

-- ============================================================
-- Table: sequences
-- ============================================================
create table sequences (
  id uuid primary key default uuid_generate_v4(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_sequences_campaign_id on sequences(campaign_id);

create trigger trg_sequences_updated_at
  before update on sequences
  for each row execute function update_updated_at();

-- ============================================================
-- Table: sequence_steps
-- ============================================================
create table sequence_steps (
  id uuid primary key default uuid_generate_v4(),
  sequence_id uuid not null references sequences(id) on delete cascade,
  step_order integer not null,
  type text not null check (type in ('connect', 'message', 'wait')),
  message_template text,
  wait_days integer,
  condition jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_sequence_steps_sequence_id on sequence_steps(sequence_id);

create trigger trg_sequence_steps_updated_at
  before update on sequence_steps
  for each row execute function update_updated_at();

-- ============================================================
-- Table: leads
-- ============================================================
create table leads (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  linkedin_url text not null,
  first_name text not null,
  last_name text not null,
  title text,
  company text,
  industry text,
  location text,
  connection_degree integer,
  icp_score integer check (icp_score >= 0 and icp_score <= 100),
  icp_flag text check (icp_flag in ('hot', 'warm', 'cold', 'disqualified')),
  source text not null default 'manual'
    check (source in ('excel_import', 'chrome_extension', 'manual')),
  raw_data jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_leads_user_id on leads(user_id);
create index idx_leads_linkedin_url on leads(linkedin_url);

create trigger trg_leads_updated_at
  before update on leads
  for each row execute function update_updated_at();

-- ============================================================
-- Table: campaign_leads
-- ============================================================
create table campaign_leads (
  id uuid primary key default uuid_generate_v4(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  account_id uuid references linkedin_accounts(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'connection_sent', 'connected', 'messaged', 'replied', 'converted', 'stopped')),
  current_step integer not null default 0,
  last_action_at timestamptz,
  reply_classification text not null default 'none'
    check (reply_classification in ('interested', 'not_now', 'wrong_person', 'referral', 'negative', 'none')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_campaign_leads_campaign_id on campaign_leads(campaign_id);
create index idx_campaign_leads_lead_id on campaign_leads(lead_id);
create index idx_campaign_leads_account_id on campaign_leads(account_id);

create trigger trg_campaign_leads_updated_at
  before update on campaign_leads
  for each row execute function update_updated_at();

-- ============================================================
-- Table: messages
-- ============================================================
create table messages (
  id uuid primary key default uuid_generate_v4(),
  campaign_lead_id uuid not null references campaign_leads(id) on delete cascade,
  direction text not null check (direction in ('sent', 'received')),
  content text not null,
  sent_at timestamptz not null default now(),
  linkedin_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_messages_campaign_lead_id on messages(campaign_lead_id);

create trigger trg_messages_updated_at
  before update on messages
  for each row execute function update_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================

-- linkedin_accounts: users see only their own
alter table linkedin_accounts enable row level security;

create policy "Users can view own accounts"
  on linkedin_accounts for select
  using (auth.uid() = user_id);

create policy "Users can insert own accounts"
  on linkedin_accounts for insert
  with check (auth.uid() = user_id);

create policy "Users can update own accounts"
  on linkedin_accounts for update
  using (auth.uid() = user_id);

create policy "Users can delete own accounts"
  on linkedin_accounts for delete
  using (auth.uid() = user_id);

-- campaigns: users see only their own
alter table campaigns enable row level security;

create policy "Users can view own campaigns"
  on campaigns for select
  using (auth.uid() = user_id);

create policy "Users can insert own campaigns"
  on campaigns for insert
  with check (auth.uid() = user_id);

create policy "Users can update own campaigns"
  on campaigns for update
  using (auth.uid() = user_id);

create policy "Users can delete own campaigns"
  on campaigns for delete
  using (auth.uid() = user_id);

-- sequences: users see sequences of their own campaigns
alter table sequences enable row level security;

create policy "Users can view own sequences"
  on sequences for select
  using (
    exists (
      select 1 from campaigns
      where campaigns.id = sequences.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can insert own sequences"
  on sequences for insert
  with check (
    exists (
      select 1 from campaigns
      where campaigns.id = sequences.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can update own sequences"
  on sequences for update
  using (
    exists (
      select 1 from campaigns
      where campaigns.id = sequences.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can delete own sequences"
  on sequences for delete
  using (
    exists (
      select 1 from campaigns
      where campaigns.id = sequences.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

-- sequence_steps: users see steps of their own sequences
alter table sequence_steps enable row level security;

create policy "Users can view own sequence steps"
  on sequence_steps for select
  using (
    exists (
      select 1 from sequences
      join campaigns on campaigns.id = sequences.campaign_id
      where sequences.id = sequence_steps.sequence_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can insert own sequence steps"
  on sequence_steps for insert
  with check (
    exists (
      select 1 from sequences
      join campaigns on campaigns.id = sequences.campaign_id
      where sequences.id = sequence_steps.sequence_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can update own sequence steps"
  on sequence_steps for update
  using (
    exists (
      select 1 from sequences
      join campaigns on campaigns.id = sequences.campaign_id
      where sequences.id = sequence_steps.sequence_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can delete own sequence steps"
  on sequence_steps for delete
  using (
    exists (
      select 1 from sequences
      join campaigns on campaigns.id = sequences.campaign_id
      where sequences.id = sequence_steps.sequence_id
        and campaigns.user_id = auth.uid()
    )
  );

-- leads: users see only their own
alter table leads enable row level security;

create policy "Users can view own leads"
  on leads for select
  using (auth.uid() = user_id);

create policy "Users can insert own leads"
  on leads for insert
  with check (auth.uid() = user_id);

create policy "Users can update own leads"
  on leads for update
  using (auth.uid() = user_id);

create policy "Users can delete own leads"
  on leads for delete
  using (auth.uid() = user_id);

-- campaign_leads: users see campaign_leads of their own campaigns
alter table campaign_leads enable row level security;

create policy "Users can view own campaign leads"
  on campaign_leads for select
  using (
    exists (
      select 1 from campaigns
      where campaigns.id = campaign_leads.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can insert own campaign leads"
  on campaign_leads for insert
  with check (
    exists (
      select 1 from campaigns
      where campaigns.id = campaign_leads.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can update own campaign leads"
  on campaign_leads for update
  using (
    exists (
      select 1 from campaigns
      where campaigns.id = campaign_leads.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can delete own campaign leads"
  on campaign_leads for delete
  using (
    exists (
      select 1 from campaigns
      where campaigns.id = campaign_leads.campaign_id
        and campaigns.user_id = auth.uid()
    )
  );

-- messages: users see messages of their own campaign_leads
alter table messages enable row level security;

create policy "Users can view own messages"
  on messages for select
  using (
    exists (
      select 1 from campaign_leads
      join campaigns on campaigns.id = campaign_leads.campaign_id
      where campaign_leads.id = messages.campaign_lead_id
        and campaigns.user_id = auth.uid()
    )
  );

create policy "Users can insert own messages"
  on messages for insert
  with check (
    exists (
      select 1 from campaign_leads
      join campaigns on campaigns.id = campaign_leads.campaign_id
      where campaign_leads.id = messages.campaign_lead_id
        and campaigns.user_id = auth.uid()
    )
  );

-- linkedin_accounts_proxies: no RLS (managed by service role only)
alter table linkedin_accounts_proxies enable row level security;

create policy "Service role manages proxies"
  on linkedin_accounts_proxies for all
  using (true)
  with check (true);
