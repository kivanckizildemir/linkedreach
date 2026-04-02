-- Lead labels: user-defined colored tags
create table if not exists lead_labels (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  color      text not null default '#6366f1', -- hex color
  created_at timestamptz not null default now(),
  unique(user_id, name)
);

alter table lead_labels enable row level security;

create policy "Users manage own lead labels"
  on lead_labels for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Lead label assignments (many-to-many)
create table if not exists lead_label_assignments (
  lead_id  uuid not null references leads(id) on delete cascade,
  label_id uuid not null references lead_labels(id) on delete cascade,
  primary key (lead_id, label_id)
);

alter table lead_label_assignments enable row level security;

-- For RLS we check via the label's user_id
create policy "Users manage own lead label assignments"
  on lead_label_assignments for all
  using (
    exists (
      select 1 from lead_labels
      where id = label_id and user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from lead_labels
      where id = label_id and user_id = auth.uid()
    )
  );

create index if not exists idx_lead_label_assignments_lead  on lead_label_assignments(lead_id);
create index if not exists idx_lead_label_assignments_label on lead_label_assignments(label_id);
create index if not exists idx_lead_labels_user_id          on lead_labels(user_id);
