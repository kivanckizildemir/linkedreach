-- Migration: Advanced step types and conditional branching

-- 1. Drop existing type check and re-add with new step types
alter table sequence_steps
  drop constraint sequence_steps_type_check;

alter table sequence_steps
  add constraint sequence_steps_type_check
  check (type in (
    'connect',
    'message',
    'wait',
    'inmail',
    'view_profile',
    'react_post',
    'fork'
  ));

-- 2. Add branching support columns
alter table sequence_steps
  add column parent_step_id uuid references sequence_steps(id) on delete cascade;

alter table sequence_steps
  add column branch text not null default 'main';

alter table sequence_steps
  add constraint sequence_steps_branch_check
  check (branch in ('main', 'if_yes', 'if_no'));
