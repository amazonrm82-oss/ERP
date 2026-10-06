-- 20261006001100_reports: part 7 of 10. Run the parts in order.
-- ----------------------------------------------------------------------------
-- 9. Stuck deals: open deals idle too long, or with no next step (open task)
-- ----------------------------------------------------------------------------
create or replace function public.report_stuck_deals(
  p_org uuid, p_pipeline uuid default null, p_owner uuid default null, p_days integer default 14)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.idle_days desc, r.amount_agorot desc), '[]'::jsonb)
    from (
      select x.*, (x.idle_days >= x.limit_days) as idle,
             (x.next_task_at is null) as no_next_step
        from (
          select d.id, d.name, d.amount_agorot, d.owner_id, d.pipeline_id, s.name as stage_name,
                 coalesce(s.rot_days, greatest(coalesce(p_days, 14), 1)) as limit_days,
                 floor(extract(epoch from now() - d.stage_entered_at) / 86400)::int as days_in_stage,
                 la.last_at as last_activity_at,
                 floor(extract(epoch from now() - coalesce(la.last_at, d.created_at)) / 86400)::int as idle_days,
                 (select min(coalesce(t.due_at, t.created_at)) from public.tasks t
                   where t.organization_id = d.organization_id and t.deal_id = d.id
                     and t.status = 'open' and t.deleted_at is null) as next_task_at
            from public.deals d
            join public.stages s on s.organization_id = d.organization_id and s.id = d.stage_id
            left join lateral (
              select max(a.occurred_at) as last_at from public.activities a
               where a.organization_id = d.organization_id and a.deal_id = d.id and a.created_by is not null
            ) la on true
           where d.organization_id = p_org and d.deleted_at is null and d.status = 'open'
             and (p_pipeline is null or d.pipeline_id = p_pipeline)
             and (p_owner is null or d.owner_id = p_owner)
        ) x
       where x.idle_days >= x.limit_days or x.next_task_at is null
       order by x.idle_days desc
       limit 200
    ) r;
$$;
