-- v1.8: customer support tickets (complaint numbers, assignment, happy-code closure, timeline)
create sequence if not exists ticket_seq start 1;
alter table service_requests add column if not exists ticket_no text;
alter table service_requests add column if not exists category text not null default 'service';
alter table service_requests add column if not exists priority text not null default 'normal';
alter table service_requests add column if not exists happy_code text;
alter table service_requests add column if not exists due_at timestamptz;
alter table service_requests add column if not exists closed_at timestamptz;
alter table service_requests add column if not exists closed_by text;
alter table service_requests add column if not exists closed_via text;
alter table service_requests add column if not exists close_note text not null default '';
alter table service_requests add column if not exists rating int;
alter table service_requests add column if not exists contact_phone text;
-- number existing requests
update service_requests set ticket_no = 'SR-' || to_char(created_at, 'YYMM') || '-' || lpad(nextval('ticket_seq')::text, 4, '0') where ticket_no is null;
update service_requests set due_at = created_at + interval '48 hours' where due_at is null;
update service_requests set status = 'closed', closed_at = coalesce(resolved_at, now()), closed_via = 'legacy' where status = 'resolved';
create unique index if not exists service_requests_ticket_no on service_requests (ticket_no);
create index if not exists service_requests_status on service_requests (status, due_at);

create table if not exists service_events (
  id serial primary key,
  ticket_id int not null references service_requests(id) on delete cascade,
  status text,
  text text not null,
  by_name text not null default '',
  customer_visible boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists service_events_ticket on service_events (ticket_id, created_at);
