-- Part 1 of 4: resume migration 0010 (safe to run more than once)

-- Task reminders
alter table public.tasks add column if not exists reminded_at timestamptz;

create or replace function app.rearm_task_reminder() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.remind_at is distinct from old.remind_at then
    new.reminded_at := null;
  end if;
  return new;
end;
$$;

create or replace trigger tasks_rearm_reminder before update of remind_at on public.tasks
  for each row execute function app.rearm_task_reminder();

create or replace function app.send_task_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with due as (
    update public.tasks t
       set reminded_at = now()
     where t.reminded_at is null and t.status = 'open' and t.deleted_at is null
       and t.owner_id is not null
       and t.remind_at <= now() and t.remind_at > now() - interval '1 day'
       and app.org_writable(t.organization_id)
    returning t.organization_id, t.owner_id, t.id, t.title
  )
  insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
  select d.organization_id, d.owner_id, 'task_reminder', left('תזכורת: ' || d.title, 200), 'task', d.id
    from due d;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Push subscriptions
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  endpoint     text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh       text not null check (char_length(p256dh) <= 200),
  auth         text not null check (char_length(auth) <= 100),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 300),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;
grant select, delete on public.push_subscriptions to authenticated;
grant insert (endpoint, p256dh, auth, user_agent) on public.push_subscriptions to authenticated;
