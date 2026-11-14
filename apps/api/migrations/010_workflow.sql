-- v1.14 workflow: material palette per project, drafts that can be resumed, batch documents (one PI / PO / truck for many items)
alter table projects add column if not exists palette jsonb not null default '{}'::jsonb;
create table if not exists drafts (
  user_id text not null references users(id) on delete cascade,
  key text not null, kind text not null default '', title text not null default '',
  project_id text references projects(id) on delete cascade, item_id text references items(id) on delete cascade,
  data jsonb, updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists drafts_project on drafts (project_id);
create table if not exists project_batches (
  id serial primary key, project_id text not null references projects(id) on delete cascade,
  kind text not null, ref_no text, amount numeric(12,2), doc text, vendor text, vehicle text, date date,
  items text[] not null default '{}', by_id text references users(id), created_at timestamptz not null default now()
);
create index if not exists project_batches_project on project_batches (project_id, kind);
alter table documents add column if not exists sent_at timestamptz;
