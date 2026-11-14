-- v1.12 scope of work: what was sold, per room, decided before the survey.
-- The surveyor only places scope items on walls; production items are created from scope lines.
create table if not exists project_scope (
  id serial primary key,
  project_id text not null references projects(id) on delete cascade,
  room_name text not null, room_code text not null,
  type text not null, descr text not null default '', size text not null default '',
  value numeric(12,2) not null default 0,
  source text not null default 'manual',
  status text not null default 'active' check (status in ('active','removed')),
  item_id text references items(id) on delete set null,
  sort int not null default 0,
  created_by text references users(id), created_at timestamptz not null default now(),
  removed_by text references users(id), removed_at timestamptz, remove_reason text
);
create index if not exists project_scope_project on project_scope (project_id, status);
alter table room_items add column if not exists scope_id int;
alter table items add column if not exists value numeric(12,2);
alter table items add column if not exists scope_id int;
