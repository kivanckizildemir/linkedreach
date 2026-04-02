-- Migration: Add 'follow' and 'end' step types

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
    'fork',
    'follow',
    'end'
  ));
