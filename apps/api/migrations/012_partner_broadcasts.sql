-- v1.16.4: monthly product-launch PDF / video sent to partners on WhatsApp
create table if not exists partner_broadcasts (
  id serial primary key,
  kind text not null,                 -- document | video
  file_ref text not null,
  filename text not null default '',
  note text not null,
  template text not null,
  recipients int not null default 0,
  partner_types text[] not null default '{}',
  by_user text references users(id),
  created_at timestamptz not null default now()
);
