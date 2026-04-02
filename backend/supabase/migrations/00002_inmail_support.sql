-- Migration: InMail support for LinkedIn Premium accounts
-- Adds inmail step type, subject line for steps, and premium fields on accounts

-- 1. Drop existing type check on sequence_steps and re-add with 'inmail'
alter table sequence_steps
  drop constraint sequence_steps_type_check;

alter table sequence_steps
  add constraint sequence_steps_type_check
  check (type in ('connect', 'message', 'wait', 'inmail'));

-- 2. Add subject column for InMail subject lines
alter table sequence_steps
  add column subject text;

-- 3. Add LinkedIn Premium fields to linkedin_accounts
alter table linkedin_accounts
  add column has_premium boolean not null default false;

alter table linkedin_accounts
  add column inmail_credits integer not null default 0;
