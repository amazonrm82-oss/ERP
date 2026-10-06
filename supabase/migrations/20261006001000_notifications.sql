-- =============================================================================
-- 0010 Notifications: live bell, task reminders, push to phones
-- =============================================================================
-- * notifications join the Supabase Realtime publication (RLS still applies:
--   each user receives only their own rows).
-- * tasks.reminded_at + app.send_task_reminders(): a task with remind_at in
--   the past (within a day) notifies its owner once. Changing remind_at arms it again.
-- * push_subscriptions: a browser's Web Push endpoint, per user.
--   notifications.pushed_at: set by the app's push dispatcher.
-- * app.dispatch_push(): when there are notifications to push, it pings the
--   app's dispatch route through pg_net. The route URL and its secret live in
--   app.settings, which the owner fills in by hand (never in a migration).
--   The route claims its batch with public.claim_push_notifications() (service role only).

-- ----------------------------------------------------------------------------
-- Task reminders
-- ----------------------------------------------------------------------------
alter table public.tasks add column reminded_at timestamptz;

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

create trigger tasks_rearm_reminder before update of remind_at on public.tasks
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

-- ----------------------------------------------------------------------------
-- Push subscriptions (per user, across organizations)
-- ----------------------------------------------------------------------------
create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  endpoint     text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh       text not null check (char_length(p256dh) <= 200),
  auth         text not null check (char_length(auth) <= 100),
  user_agent   text check (user_agent is null or char_length(user_agent) <= 300),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;
grant select, delete on public.push_subscriptions to authenticated;
grant insert (endpoint, p256dh, auth, user_agent) on public.push_subscriptions to authenticated;

-- user_id comes from the session, never from the client
create or replace function app.own_push_subscription() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

create trigger push_subscriptions_owner before insert on public.push_subscriptions
  for each row execute function app.own_push_subscription();

create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

alter table public.notifications add column pushed_at timestamptz;
create index notifications_unpushed_idx on public.notifications (created_at) where pushed_at is null;

-- ----------------------------------------------------------------------------
-- Settings only the database itself reads (schema app is not exposed)
-- ----------------------------------------------------------------------------
create table app.settings (
  key   text primary key,
  value text not null
);
revoke all on app.settings from public, anon, authenticated;

-- Wakes the app's push dispatcher when there is something to push.
create or replace function app.dispatch_push() returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url text := (select s.value from app.settings s where s.key = 'push_dispatch_url');
  v_secret text := (select s.value from app.settings s where s.key = 'push_dispatch_secret');
begin
  if v_url is null or v_secret is null
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (
       select 1 from public.notifications n
        where n.pushed_at is null and n.created_at > now() - interval '1 hour'
          and n.read_at is null
          and exists (select 1 from public.push_subscriptions p where p.user_id = n.user_id)) then
    return false;
  end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2)'
    using v_url, jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret);
  return true;
end;
$$;

-- The push dispatcher (service role) claims a batch of notifications to send:
-- marks them pushed and returns them with their subscriptions' owners.
-- skip locked: two dispatchers running at once never send the same row twice.
create or replace function public.claim_push_notifications(p_limit integer default 200)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  with batch as (
    select n.id
      from public.notifications n
     where n.pushed_at is null and n.read_at is null and n.created_at > now() - interval '1 hour'
       and exists (select 1 from public.push_subscriptions p where p.user_id = n.user_id)
     order by n.created_at
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
     for update skip locked
  ), claimed as (
    update public.notifications n
       set pushed_at = now()
      from batch
     where n.id = batch.id
    returning n.id, n.organization_id, n.user_id, n.title, n.body, n.entity_type, n.entity_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'organization_id', c.organization_id, 'user_id', c.user_id,
           'title', c.title, 'body', c.body, 'entity_type', c.entity_type, 'entity_id', c.entity_id,
           'organization_name', o.name)), '[]'::jsonb)
    into v_result
    from claimed c
    join public.organizations o on o.id = c.organization_id;
  return v_result;
end;
$$;

revoke all on function public.claim_push_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_push_notifications(integer) to service_role;

revoke all on function app.rearm_task_reminder() from public, anon;
grant execute on function app.rearm_task_reminder() to authenticated, service_role;
revoke all on function app.own_push_subscription() from public, anon;
grant execute on function app.own_push_subscription() to authenticated, service_role;
revoke all on function app.send_task_reminders() from public, anon, authenticated;
revoke all on function app.dispatch_push() from public, anon, authenticated;
grant execute on function app.send_task_reminders() to service_role;
grant execute on function app.dispatch_push() to service_role;

-- ----------------------------------------------------------------------------
-- Realtime and schedule (only where Supabase provides them)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                     and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-notifications', '* * * * *', 'select app.send_task_reminders(); select app.dispatch_push();');
  end if;
end;
$$;
