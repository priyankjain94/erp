-- Make My Space CRM + Operations — initial schema (PostgreSQL 16)
-- Money is stored in whole rupees (integer). Dates the business plans with (targets, deadlines) are DATE;
-- events are TIMESTAMPTZ (UTC). Text IDs keep the human codes the team already uses (P101, I12, T40, L07).

create table settings (key text primary key, value jsonb not null);

-- ---------- people, access ----------
create table users (
  id text primary key,
  name text not null,
  phone text not null unique,               -- E.164, e.g. +919826110001
  role text not null,
  title text not null default '',
  members text[] not null default '{}',     -- installation team helpers (role = installer)
  skills text[] not null default '{}',      -- item type codes the team installs (empty = all)
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table role_permissions (
  role text not null, perm text not null, allowed boolean not null,
  primary key (role, perm)
);
create table customers (
  id serial primary key,
  name text not null,
  phone text not null unique,
  created_at timestamptz not null default now()
);
create table otp_requests (
  id serial primary key,
  phone text not null,
  audience text not null check (audience in ('staff','customer','signoff')),
  ref text,                                 -- item id for installation sign-off OTPs
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);
create index on otp_requests (phone, created_at);
create table sessions (
  id text primary key,
  subject_type text not null check (subject_type in ('user','customer')),
  subject_id text not null,
  refresh_hash text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index on sessions (subject_type, subject_id);
create table audit_log (
  id bigserial primary key,
  actor_type text not null, actor_id text,
  action text not null, entity text, entity_id text,
  text text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index on audit_log (created_at desc);

-- ---------- CRM ----------
create table partners (
  id text primary key, name text not null, firm text not null default '', type text not null,
  tier text not null default 'Silver', rate double precision not null default 0, owner_id text references users(id), phone text
);
create table leads (
  id text primary key,
  name text not null, phone text not null,
  source text not null, sub text not null default '',
  ref_partner_id text references partners(id), ref_lead_id text references leads(id),
  showroom text not null default '',
  stage text not null default 'new',
  owner_id text references users(id),
  value integer not null default 0,
  interest text not null default '', area text not null default '',
  follow_up date,
  last_inbound_at timestamptz,
  lost_reason text not null default '',
  dup_flag boolean not null default false,
  meta_leadgen_id text unique, meta_form_id text, meta_ad_name text, meta_campaign_name text,
  created_at timestamptz not null default now(),
  stage_changed_at timestamptz not null default now()
);
create index on leads (phone);
create table lead_messages (
  id bigserial primary key,
  lead_id text not null references leads(id) on delete cascade,
  from_kind text not null check (from_kind in ('them','us','auto')),
  text text not null, tpl text, wamid text,
  status text not null default 'sent',
  created_at timestamptz not null default now()
);
create index on lead_messages (lead_id, created_at);
create table lead_timeline (
  id bigserial primary key,
  lead_id text not null references leads(id) on delete cascade,
  text text not null, auto boolean not null default false,
  created_at timestamptz not null default now()
);
create index on lead_timeline (lead_id, created_at);
create table automations (
  id text primary key, fam text not null, name text not null, when_text text not null, then_text text not null,
  enabled boolean not null default true, runs integer not null default 0
);
create table commissions (
  id serial primary key, lead_id text references leads(id), partner_id text references partners(id),
  amount integer not null, status text not null default 'pending', created_at timestamptz not null default now()
);

-- ---------- projects ----------
create sequence project_seq start 101;
create table projects (
  id text primary key, code text not null unique,
  lead_id text references leads(id), customer_id int not null references customers(id),
  pm_id text references users(id),
  address text not null default '', value integer not null default 0,
  target date not null, site_ready boolean not null default false, notes text not null default '',
  feedback_rating int, feedback_comment text, feedback_at timestamptz,
  created_at timestamptz not null default now()
);
create table payment_milestones (
  id serial primary key, project_id text not null references projects(id) on delete cascade,
  label text not null, pct int not null, amount integer not null, gate text not null default '',
  received_at timestamptz, received_by text, sort int not null default 0
);
create table project_activity (
  id bigserial primary key, project_id text not null references projects(id) on delete cascade,
  text text not null, created_at timestamptz not null default now()
);
create index on project_activity (project_id, created_at);

-- ---------- site survey ----------
create table surveys (
  project_id text primary key references projects(id) on delete cascade,
  status text not null default 'scheduled' check (status in ('scheduled','in-progress','submitted')),
  assignee_id text references users(id),
  scheduled_at timestamptz, check_in_at timestamptz, check_in_lat double precision, check_in_lng double precision,
  submitted_at timestamptz, minutes int, signed boolean not null default false, signature_url text,
  version int not null default 1
);
create table rooms (
  id text primary key, project_id text not null references projects(id) on delete cascade,
  name text not null, code text not null, ceiling int not null default 2900, floor text not null default '',
  shape text not null default 'rect', sort int not null default 0
);
create table walls (
  id serial primary key, room_id text not null references rooms(id) on delete cascade,
  label text not null, w int, h int, photo text, notes text not null default '',
  unique (room_id, label)
);
create table wall_obstructions (
  id serial primary key, wall_id int not null references walls(id) on delete cascade,
  type text not null, left_mm int not null default 0, floor_mm int not null default 0, w int not null, h int not null
);
create table room_items (
  id serial primary key, room_id text not null references rooms(id) on delete cascade,
  type text not null, wall text not null, descr text not null default ''
);

-- ---------- items (unit of work) ----------
create sequence item_seq start 1;
create table items (
  id text primary key, code text not null,
  project_id text not null references projects(id) on delete cascade,
  room_code text not null, room_name text not null, type text not null, wall text not null, descr text not null default '',
  stage text not null,
  owner_id text references users(id), designer_id text references users(id), installer_id text references users(id),
  target date not null,
  hw_pi boolean not null default false, prod_pi boolean not null default false, po text not null default '',
  dispatch_vehicle text, dispatch_boxes int, dispatch_date date,
  delivered boolean not null default false, install_done boolean not null default false, signed_off boolean not null default false,
  after_photo text, installed_at timestamptz,
  checklist jsonb not null default '{}',
  flags text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index on items (project_id); create index on items (stage); create index on items (installer_id);
create table item_stage_log (
  id bigserial primary key, item_id text not null references items(id) on delete cascade,
  stage text not null, in_at timestamptz not null, out_at timestamptz, by_id text references users(id),
  override text, note text
);
create index on item_stage_log (item_id, in_at);
create table documents (
  id serial primary key, item_id text not null references items(id) on delete cascade,
  kind text not null default 'drawing', rev text not null, url text, by_id text references users(id),
  created_at timestamptz not null default now(), approved_at timestamptz, approved_via text
);
create table item_boxes (
  id serial primary key, item_id text not null references items(id) on delete cascade,
  n int not null, label text not null, got boolean, unique (item_id, n)
);
create table work_sessions (
  id serial primary key, item_id text not null references items(id) on delete cascade,
  start_at timestamptz not null, end_at timestamptz, reason text not null default '', by_id text references users(id),
  start_lat double precision, start_lng double precision
);
create table snags (
  id text primary key, item_id text not null references items(id) on delete cascade,
  part text not null, type text not null, note text not null default '', photo text, vendor text,
  status text not null default 'open' check (status in ('open','reordered','dispatched','fixed')),
  raised_by text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- ---------- tasks ----------
create sequence task_seq start 1;
create table tasks (
  id text primary key, title text not null,
  project_id text references projects(id) on delete cascade, item_id text references items(id) on delete cascade,
  assignee_id text not null references users(id), assigner_id text not null references users(id),
  deadline date not null, priority text not null default 'normal' check (priority in ('normal','urgent')),
  status text not null default 'todo' check (status in ('todo','progress','blocked','done')),
  blocked_reason text not null default '', auto boolean not null default false,
  proof text not null default '', proof_note text, repeat text not null default '',
  reminders int not null default 0,
  created_at timestamptz not null default now(), done_at timestamptz
);
create index on tasks (assignee_id, status); create index on tasks (deadline);
create table task_events (
  id bigserial primary key, task_id text not null references tasks(id) on delete cascade,
  e text not null, by_id text, to_id text, note text, created_at timestamptz not null default now()
);
create index on task_events (task_id, created_at);
create table reminder_log (key text primary key, created_at timestamptz not null default now());

-- ---------- WhatsApp + Meta ----------
create table wa_contacts (phone text primary key, name text, last_inbound_at timestamptz, opted_out_at timestamptz);
create table wa_messages (
  id bigserial primary key, direction text not null check (direction in ('in','out')),
  wamid text unique, phone text not null, kind text not null, template text, body text, payload jsonb,
  status text not null default 'queued', error text, pricing jsonb,
  related_type text, related_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on wa_messages (phone, created_at);
create table webhook_events (
  id bigserial primary key, source text not null, external_id text not null,
  payload jsonb not null, received_at timestamptz not null default now(), processed_at timestamptz, error text,
  unique (source, external_id)
);
create table meta_leads_raw (
  leadgen_id text primary key, form_id text, page_id text, payload jsonb, lead_id text references leads(id),
  created_at timestamptz not null default now()
);

-- ---------- background jobs (Postgres queue, no Redis needed) ----------
create table jobs (
  id bigserial primary key, kind text not null, payload jsonb not null default '{}',
  run_at timestamptz not null default now(), attempts int not null default 0, max_attempts int not null default 6,
  locked_at timestamptz, done_at timestamptz, last_error text, created_at timestamptz not null default now()
);
create index jobs_ready on jobs (run_at) where done_at is null;

-- ---------- uploads (local storage driver) ----------
create table uploads (
  id text primary key, owner_type text not null, owner_id text not null, content_type text not null,
  size int not null, path text not null, created_at timestamptz not null default now()
);
