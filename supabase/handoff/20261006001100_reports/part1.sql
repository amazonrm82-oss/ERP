-- 20261006001100_reports: part 1 of 10. Run the parts in order.
-- =============================================================================
-- 0011 Reports: the ten built-in reports and the manager dashboard summary
-- =============================================================================
-- Every function here is SECURITY INVOKER: it runs as the signed-in user, so
-- Row Level Security decides which leads, deals and activities are counted.
-- A member whose organization shows only "own" records sees a report of their
-- own records; a non-member gets empty results.
-- Each function returns jsonb; the app formats it. Amounts are agorot.
-- "Contact with the customer" = an activity a person logged (created_by set)
-- of type note, call, meeting, email, whatsapp or sms.

-- uuid from text, or null when the text is not a uuid (metadata is client-writable)
create or replace function app.safe_uuid(p_text text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then p_text::uuid end;
$$;

create or replace function app.contact_types() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['note', 'call', 'meeting', 'email', 'whatsapp', 'sms'];
$$;

-- the pipeline a report looks at: the one asked for, or the organization's default
create or replace function app.report_pipeline(p_org uuid, p_pipeline uuid) returns uuid
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select p.id from public.pipelines p
      where p.organization_id = p_org and p.id = p_pipeline and p.deleted_at is null),
    (select p.id from public.pipelines p
      where p.organization_id = p_org and p.is_default and p.deleted_at is null limit 1));
$$;

-- ----------------------------------------------------------------------------
-- 1. Leads by source (and campaign): count, converted, won deals, revenue
-- ----------------------------------------------------------------------------
create or replace function public.report_leads_by_source(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(r order by r.leads desc), '[]'::jsonb)
    from (
      select l.source_id, s.name as source_name, nullif(btrim(l.campaign), '') as campaign,
             count(*) as leads,
             count(l.converted_at) as converted,
             count(d.id) filter (where d.status = 'won') as won,
             coalesce(sum(d.amount_agorot) filter (where d.status = 'won'), 0) as revenue
        from public.leads l
        left join public.lead_sources s on s.organization_id = l.organization_id and s.id = l.source_id
        left join public.deals d on d.organization_id = l.organization_id and d.id = l.converted_deal_id
                                and d.deleted_at is null
       where l.organization_id = p_org and l.deleted_at is null
         and l.created_at >= p_from and l.created_at < p_to
         and (p_owner is null or l.owner_id = p_owner)
       group by l.source_id, s.name, nullif(btrim(l.campaign), '')
    ) r;
$$;
