-- Part 4 of 4: resume migration 0010 (safe to run more than once)

revoke all on function app.rearm_task_reminder() from public, anon;
grant execute on function app.rearm_task_reminder() to authenticated, service_role;
revoke all on function app.own_push_subscription() from public, anon;
grant execute on function app.own_push_subscription() to authenticated, service_role;
revoke all on function app.send_task_reminders() from public, anon, authenticated;
revoke all on function app.dispatch_push() from public, anon, authenticated;
grant execute on function app.send_task_reminders() to service_role;
grant execute on function app.dispatch_push() to service_role;

-- Realtime and schedule
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

-- What it should show: every column true
select
  to_regclass('app.settings') is not null as settings_table,
  to_regclass('public.push_subscriptions') is not null as push_table,
  (select count(*) from pg_policies where tablename = 'push_subscriptions') = 3 as push_policies,
  exists (select 1 from pg_extension where extname = 'pg_net') as pg_net,
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications') as realtime,
  exists (select 1 from cron.job where jobname = 'crm-notifications') as cron_job;
