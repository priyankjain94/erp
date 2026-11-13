-- Real drawings and documents, material specifications, factory PI and hardware procurement.

-- per-item material specification filled by the designer (carcass, shutter, finish, edge band, hardware...)
alter table items add column if not exists spec jsonb not null default '{}'::jsonb;
-- production PI raised with the factory
alter table items add column if not exists prod_pi_no text not null default '';
alter table items add column if not exists prod_pi_amount numeric(12,2);
alter table items add column if not exists prod_pi_doc text;
-- hardware procurement
alter table items add column if not exists hw_vendor text not null default '';
alter table items add column if not exists hw_po_doc text;
alter table items add column if not exists hw_received boolean not null default false;
-- factory finished making the item
alter table items add column if not exists production_done boolean not null default false;

-- drawings now carry the file, a note, and the material spec they were issued with
alter table documents add column if not exists notes text not null default '';
alter table documents add column if not exists spec jsonb;

-- project-level files: final floor plan, furniture drawings, final production drawings, PI/PO copies, handover docs
create table if not exists project_docs (
  id serial primary key,
  project_id text not null references projects(id) on delete cascade,
  item_id text references items(id) on delete set null,
  category text not null,
  title text not null,
  file text not null,
  notes text not null default '',
  rev text not null default '',
  shared boolean not null default false,
  by_id text references users(id),
  created_at timestamptz not null default now()
);
create index if not exists project_docs_project on project_docs (project_id, category);

-- file bytes for STORAGE_DRIVER=db (hosts whose disk is wiped on restart)
create table if not exists upload_blobs (id text primary key references uploads(id) on delete cascade, data bytea not null);
