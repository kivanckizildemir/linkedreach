alter table campaigns
  add column if not exists message_approach text,
  add column if not exists message_tone text;
