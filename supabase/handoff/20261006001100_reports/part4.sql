-- 20261006001100_reports: part 4 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- 5. Activity: what each person logged, tasks completed, and a daily series
-- ----------------------------------------------------------------------------
create or replace function public.report_activity(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with tz as (
    select coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem') as name
  ), acts as (
    select a.created_by as user_id, a.type, (a.occurred_at at time zone (select name from tz))::date as day
      from public.activities a
     where a.organization_id = p_org and a.created_by is not null and a.type = any (app.contact_types())
       and a.occurred_at >= p_from and a.occurred_at < p_to
       and (p_owner is null or a.created_by = p_owner)
  ), done as (
    select t.owner_id as user_id, (t.completed_at at time zone (select name from tz))::date as day
      from public.tasks t
     where t.organization_id = p_org and t.deleted_at is null and t.status = 'done'
       and t.completed_at >= p_from and t.completed_at < p_to
       and (p_owner is null or t.owner_id = p_owner)
  ), users as (
    select user_id from acts union select user_id from done
  ), days as (
    select day from acts union select day from done
  )
  select jsonb_build_object(
    'by_user', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', u.user_id,
               'note', (select count(*) from acts a where a.user_id = u.user_id and a.type = 'note'),
               'call', (select count(*) from acts a where a.user_id = u.user_id and a.type = 'call'),
               'meeting', (select count(*) from acts a where a.user_id = u.user_id and a.type = 'meeting'),
               'messages', (select count(*) from acts a where a.user_id = u.user_id and a.type in ('email', 'whatsapp', 'sms')),
               'tasks_done', (select count(*) from done t where t.user_id = u.user_id)))
        from users u where u.user_id is not null), '[]'::jsonb),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', d.day,
               'activities', (select count(*) from acts a where a.day = d.day),
               'tasks_done', (select count(*) from done t where t.day = d.day))
             order by d.day)
        from days d), '[]'::jsonb));
$$;
