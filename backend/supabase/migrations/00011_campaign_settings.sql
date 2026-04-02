-- Assign a LinkedIn account to each campaign and add ICP score threshold
alter table campaigns
  add column if not exists account_id      uuid references linkedin_accounts(id) on delete set null,
  add column if not exists min_icp_score   integer not null default 0  check (min_icp_score between 0 and 100),
  add column if not exists connection_note text;  -- default personalised connection note template
