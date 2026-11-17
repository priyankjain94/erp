-- Partners management, quotations, payments and GST invoices, change orders, factory steps, warranty and service.

-- partners: contact details and status
alter table partners add column if not exists email text not null default '';
alter table partners add column if not exists city text not null default '';
alter table partners add column if not exists notes text not null default '';
alter table partners add column if not exists active boolean not null default true;
alter table partners add column if not exists created_at timestamptz not null default now();
create sequence if not exists partner_seq start 100;

-- quotation / BOQ, kept as revisions per lead (and carried to the project)
create table if not exists quotes (
  id serial primary key,
  lead_id text references leads(id) on delete cascade,
  project_id text references projects(id) on delete set null,
  rev int not null,
  lines jsonb not null default '[]'::jsonb,       -- [{room, item, desc, size, qty, rate}]
  discount numeric(12,2) not null default 0,
  gst_pct numeric(5,2) not null default 18,
  subtotal numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  notes text not null default '',
  status text not null default 'draft',            -- draft | sent | accepted | superseded
  by_id text references users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create index if not exists quotes_lead on quotes (lead_id, rev);

-- payments actually received (a milestone is received once its receipts cover its amount)
create table if not exists payment_receipts (
  id serial primary key,
  project_id text not null references projects(id) on delete cascade,
  milestone_id int references payment_milestones(id) on delete set null,
  receipt_no text not null unique,
  amount numeric(12,2) not null check (amount > 0),
  paid_on date not null,
  mode text not null,                              -- UPI | Bank transfer | Cheque | Cash | Card
  reference text not null default '',
  note text not null default '',
  by_id text references users(id),
  created_at timestamptz not null default now()
);
create sequence if not exists receipt_seq start 1;

-- GST tax invoices
create table if not exists invoices (
  id serial primary key,
  project_id text not null references projects(id) on delete cascade,
  invoice_no text not null unique,
  invoice_date date not null,
  description text not null,
  taxable numeric(12,2) not null,
  gst_pct numeric(5,2) not null default 18,
  gst numeric(12,2) not null,
  total numeric(12,2) not null,
  by_id text references users(id),
  created_at timestamptz not null default now()
);
create table if not exists invoice_seq (fy text primary key, n int not null default 0);

-- change orders after approval: price and scope changes the client approves
create table if not exists change_orders (
  id serial primary key,
  project_id text not null references projects(id) on delete cascade,
  item_id text references items(id) on delete set null,
  description text not null,
  amount numeric(12,2) not null default 0,          -- + adds to the order value, - reduces it
  days int not null default 0,                      -- delay added to the target date
  status text not null default 'pending',           -- pending | approved | rejected
  decided_via text,
  by_id text references users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- factory production steps per item
alter table items add column if not exists production_steps jsonb not null default '{}'::jsonb;

-- snag cost and who bears it
alter table snags add column if not exists cost numeric(12,2);
alter table snags add column if not exists payer text not null default '';

-- warranty and after-sales service
alter table items add column if not exists warranty_until date;
create table if not exists service_requests (
  id serial primary key,
  project_id text not null references projects(id) on delete cascade,
  item_id text references items(id) on delete set null,
  text text not null,
  photo text,
  status text not null default 'open',              -- open | scheduled | resolved
  visit_date date,
  assignee_id text references users(id),
  resolution text not null default '',
  under_warranty boolean,
  raised_by text not null default 'customer',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
