-- Server-generated secrets for hosts where the operator can't set them as env vars (e.g. Hostinger web apps).
create table if not exists app_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
