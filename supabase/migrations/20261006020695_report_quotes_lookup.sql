-- =============================================================================
-- The quotes report finds the "accepted" timeline entry through the quote's deal or contact (QUO-17 follow-up)
-- =============================================================================
-- public.report_quotes (020425) takes the time to acceptance from quote_decisions, which only owners and admins read;
-- for everyone else it looks for the quote's "accepted" timeline entry (QUO-16). That lookup filtered the business's
-- activities by metadata ->> 'quote_id'. The report is security invoker, and under RLS PostgreSQL may use a condition in
-- an index only when its operator is leakproof; ->> (jsonb_object_field_text) is not, so every lookup read and checked
-- all of the business's activities. Measured locally (5,000 quotes, 2,000 accepted, 50,000 activities): about 1.1 s per
-- accepted quote, and a member's report did not finish within 900 s. An index on metadata ->> 'quote_id' does not help
-- (tested: used by a superuser, ignored under RLS).
-- Now the entry is looked up on the quote's deal (activities_deal_idx), else on its contact (activities_contact_idx):
-- uuid equality is leakproof, so the index is used. Same data: 3.4 s for a member, 2.2 s for an owner (unchanged).
-- The QUO-16 entry is written on the quote's deal and contact, so it is found the same way. One difference: a quote with
-- neither a deal nor a contact (both purged; their entries went with them) gets no fallback time for a caller who does
-- not read quote_decisions.
-- The body of 020425, otherwise unchanged. Safe to run twice. No drops, no row changes.

create or replace function public.report_quotes(p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with live as (
    -- the newest sent version of each chain (and every quote that has no sent newer version)
    select q.id, q.owner_id, q.status, q.sent_at, q.total_agorot, q.valid_until, q.deal_id, q.contact_id
      from public.quotes q
     where q.organization_id = p_org
       and q.status <> 'draft'
       and q.sent_at is not null
       and (p_owner is null or q.owner_id = p_owner)
       and not exists (select 1 from public.quotes n
                        where n.organization_id = q.organization_id and n.previous_id = q.id and n.sent_at is not null)
  ), today as (
    select (now() at time zone coalesce(nullif(o.timezone, ''), 'Asia/Jerusalem'))::date as d
      from public.organizations o where o.id = p_org
  ), period as (
    select l.* from live l where l.sent_at >= p_from and l.sent_at < p_to
  ), accepted_at as (
    select p.id, p.owner_id,
           coalesce(
             (select d.decided_at from public.quote_decisions d
               where d.organization_id = p_org and d.quote_id = p.id and d.decision = 'accepted'),
             -- the entry sits on the quote's deal (and contact): found through their indexes, because under RLS a
             -- condition on metadata cannot use an index (->> is not leakproof)
             case when p.deal_id is not null then
               (select min(a.created_at) from public.activities a
                 where a.organization_id = p_org and a.deal_id = p.deal_id and a.type = 'system'
                   and a.metadata ->> 'kind' = 'quote_accepted' and a.metadata ->> 'quote_id' = p.id::text)
             else
               (select min(a.created_at) from public.activities a
                 where a.organization_id = p_org and a.contact_id = p.contact_id and a.type = 'system'
                   and a.metadata ->> 'kind' = 'quote_accepted' and a.metadata ->> 'quote_id' = p.id::text)
             end
           ) - p.sent_at as took
      from period p
     where p.status = 'accepted'
  ), open_now as (
    select l.* from live l
     where l.status in ('sent', 'viewed')
       and (l.valid_until is null or l.valid_until >= (select d from today))
  ), owners as (
    select owner_id from period union select owner_id from open_now
  ), per as (
    select o.owner_id,
           (select count(*) from period p where p.owner_id is not distinct from o.owner_id) as sent,
           (select count(*) from period p where p.owner_id is not distinct from o.owner_id and p.status = 'accepted') as accepted,
           (select count(*) from period p where p.owner_id is not distinct from o.owner_id and p.status = 'rejected') as rejected,
           (select coalesce(sum(p.total_agorot), 0) from period p
             where p.owner_id is not distinct from o.owner_id and p.status = 'accepted') as accepted_amount,
           (select round(extract(epoch from avg(a.took)) / 3600.0, 1) from accepted_at a
             where a.owner_id is not distinct from o.owner_id and a.took is not null) as avg_hours_to_accept,
           (select count(*) from open_now n where n.owner_id is not distinct from o.owner_id) as open_count,
           (select coalesce(sum(n.total_agorot), 0) from open_now n where n.owner_id is not distinct from o.owner_id) as open_amount
      from owners o
  )
  select jsonb_build_object(
    'rate_min', 5,
    'totals', jsonb_build_object(
      'sent', (select count(*) from period),
      'viewed', (select count(*) from period where status = 'viewed'),
      'waiting', (select count(*) from period where status = 'sent'),
      'accepted', (select count(*) from period where status = 'accepted'),
      'rejected', (select count(*) from period where status = 'rejected'),
      'expired', (select count(*) from period where status = 'expired'),
      'cancelled', (select count(*) from period where status = 'cancelled'),
      'acceptance_rate', (select case when count(*) filter (where status in ('accepted', 'rejected')) >= 5
                                      then round(100.0 * count(*) filter (where status = 'accepted')
                                                 / count(*) filter (where status in ('accepted', 'rejected')), 1) end
                            from period),
      'accepted_amount', (select coalesce(sum(total_agorot), 0) from period where status = 'accepted'),
      'avg_hours_to_accept', (select round(extract(epoch from avg(took)) / 3600.0, 1) from accepted_at where took is not null),
      'accepted_measured', (select count(*) from accepted_at where took is not null),
      'open_count', (select count(*) from open_now),
      'open_amount', (select coalesce(sum(total_agorot), 0) from open_now)
    ),
    'by_owner', coalesce((
      select jsonb_agg(jsonb_build_object(
               'owner_id', r.owner_id,
               'sent', r.sent,
               'accepted', r.accepted,
               'rejected', r.rejected,
               'acceptance_rate', case when r.accepted + r.rejected >= 5
                                       then round(100.0 * r.accepted / (r.accepted + r.rejected), 1) end,
               'accepted_amount', r.accepted_amount,
               'avg_hours_to_accept', r.avg_hours_to_accept,
               'open_count', r.open_count,
               'open_amount', r.open_amount)
             order by r.sent desc, r.open_amount desc, r.owner_id)
        from per r), '[]'::jsonb)
  );
$$;
revoke all on function public.report_quotes(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.report_quotes(uuid, timestamptz, timestamptz, uuid) to authenticated;
