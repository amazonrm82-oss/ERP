-- =============================================================================
-- FLD-10 part three: a push in the business's own words
-- =============================================================================
-- Notifications keep being written in today's words; the app redraws them in the business's words from a closed list
-- of patterns (src/features/notifications/notification-text.ts): the bell and the notifications page read the terms
-- with the user's session. The push dispatcher has no session, so public.claim_push_notifications (service_role only)
-- now also returns the business's term keys from public.org_terms (null when the business has no row = today's
-- words). The body is the one of 20261006017300 with only that: one more key and one left join. Safe to run twice.

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
       -- 0163: a closed business pushes only the system notices to its owner (stored before the closing: none)
       and (not exists (select 1 from public.organizations o2
                         where o2.id = n.organization_id and app.org_status_closed(o2.status))
            or (n.type = 'system' and exists (
                  select 1 from public.memberships m
                   where m.organization_id = n.organization_id and m.user_id = n.user_id
                     and m.status = 'active' and m.role = 'owner')))
     order by n.created_at
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
     for update skip locked
  ), claimed as (
    update public.notifications n
       set pushed_at = now()
      from batch
     where n.id = batch.id
    returning n.id, n.organization_id, n.user_id, n.type, n.title, n.body, n.entity_type, n.entity_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'organization_id', c.organization_id, 'user_id', c.user_id,
           'title', c.title, 'body', c.body, 'entity_type', c.entity_type, 'entity_id', c.entity_id,
           'organization_name', o.name,
           'type', c.type,
           -- FLD-10 part three: the business's term keys, so the push says its own words (null = today's words)
           'terms', jsonb_build_object('contact_term', t.contact_term, 'lead_term', t.lead_term, 'deal_term', t.deal_term),
           'lead_actions', c.entity_type = 'lead' and c.entity_id is not null
             and c.type in ('lead_new', 'assigned')
             and exists (
               select 1 from public.leads l
                where l.organization_id = c.organization_id and l.id = c.entity_id
                  and l.deleted_at is null and l.converted_at is null
                  and (c.type = 'lead_new'
                       or (l.created_at > now() - interval '1 hour'
                           and exists (select 1 from public.form_submissions fs
                                        where fs.organization_id = c.organization_id and fs.lead_id = c.entity_id
                                          and fs.status = 'accepted'))))
         )), '[]'::jsonb)
    into v_result
    from claimed c
    join public.organizations o on o.id = c.organization_id
    left join public.org_terms t on t.organization_id = c.organization_id;
  return v_result;
end;
$$;
revoke all on function public.claim_push_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_push_notifications(integer) to service_role;
