-- v1.6: Google sign-in and self sign-up (access requests approved by an admin)
alter table users add column if not exists email text;
alter table users add column if not exists google_sub text;
create unique index if not exists users_email_uq on users (lower(email)) where email is not null and email <> '';
create unique index if not exists users_google_sub_uq on users (google_sub) where google_sub is not null;

create table if not exists access_requests (
  id serial primary key,
  name text not null,
  phone text not null,
  email text,
  google_sub text,
  role_wanted text not null default '',
  note text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  user_id text
);
create index if not exists access_requests_pending on access_requests (status, created_at);
