-- v1.11 tasks you can trust: original deadline, approval for more time, blocked owner + follow-up,
-- real proof, check / reopen, read receipts; items can wait on the client (clock paused)
alter table tasks drop constraint if exists tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('todo','progress','blocked','done','missed'));
alter table tasks add column if not exists original_deadline date;
update tasks set original_deadline = deadline where original_deadline is null;
alter table tasks add column if not exists verify boolean not null default false;
alter table tasks add column if not exists verified_at timestamptz;
alter table tasks add column if not exists blocked_on text;
alter table tasks add column if not exists follow_up date;
alter table tasks add column if not exists blocked_at timestamptz;
alter table tasks add column if not exists blocked_days numeric not null default 0;
alter table tasks add column if not exists proof_ref text;
alter table tasks add column if not exists ext_request jsonb;
alter table tasks add column if not exists seen_at timestamptz;
alter table tasks add column if not exists started_at timestamptz;
alter table tasks add column if not exists template text;
update tasks t set seen_at = e.created_at from (select task_id, min(created_at) created_at from task_events where e = 'seen' group by task_id) e where e.task_id = t.id and t.seen_at is null;
alter table items add column if not exists waiting text not null default '';
alter table items add column if not exists waiting_since timestamptz;
alter table items add column if not exists waiting_ms bigint not null default 0;
create index if not exists wa_messages_related on wa_messages (related_type, related_id);
