-- Migration 00014: Rename linkedin_accounts_proxies → proxies
-- Adds user_id for per-user RLS, label for friendly naming.
-- Fixes RLS from catch-all to per-user isolation.

-- ── Rename table ──────────────────────────────────────────────────────────────
alter table linkedin_accounts_proxies rename to proxies;

-- ── Add new columns ───────────────────────────────────────────────────────────
alter table proxies
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists label   text;

create index if not exists idx_proxies_user_id on proxies(user_id);

-- ── Fix RLS: replace catch-all with per-user policies ─────────────────────────
drop policy if exists "Service role manages proxies" on proxies;

create policy "Users can view own proxies"
  on proxies for select
  using (auth.uid() = user_id);

create policy "Users can insert own proxies"
  on proxies for insert
  with check (auth.uid() = user_id);

create policy "Users can update own proxies"
  on proxies for update
  using (auth.uid() = user_id);

create policy "Users can delete own proxies"
  on proxies for delete
  using (auth.uid() = user_id);
