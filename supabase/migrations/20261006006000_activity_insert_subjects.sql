-- =============================================================================
-- A new activity may link only records the user can see
-- =============================================================================
-- * Until now activities_insert asked app.can_read_activity_subject(), which is
--   true when the caller can see ANY of the records an entry links (right for
--   reading a timeline). So a member could write an entry on a lead they cannot
--   see by also linking a contact of their own, and it would then show up on that
--   lead's timeline for everyone who can see the lead.
-- * activities_insert now asks app.can_read_every_activity_subject(): every
--   record the entry links (lead, contact, company, deal) must be visible to the
--   caller. Everything else it checked stays (writable organization, a member).
-- * app.can_read_activity_subject() is unchanged: the select policy still uses its
--   "any of them" meaning.
-- * Server-side writers (conversion, merge, intake, status/stage logging) are
--   security definer and are not affected; the app's own forms link one record.
-- Every statement is safe to run twice.

create or replace function app.can_read_every_activity_subject(
  p_lead uuid, p_contact uuid, p_company uuid, p_deal uuid
) returns boolean
language sql stable
set search_path = ''
as $$
  -- SECURITY INVOKER on purpose, like app.can_read_activity_subject(): each sub-select is
  -- filtered by the caller's own select policies, so "can see" means exactly what it means
  -- on the record's page
  select num_nonnulls(p_lead, p_contact, p_company, p_deal) >= 1
     and (p_lead is null or exists (select 1 from public.leads l where l.id = p_lead))
     and (p_contact is null or exists (select 1 from public.contacts c where c.id = p_contact))
     and (p_company is null or exists (select 1 from public.companies co where co.id = p_company))
     and (p_deal is null or exists (select 1 from public.deals d where d.id = p_deal))
$$;
revoke all on function app.can_read_every_activity_subject(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app.can_read_every_activity_subject(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- alter, not drop and create: the policy exists since 0004 (rls.sql)
alter policy activities_insert on public.activities
  with check (app.can_write(organization_id)
              and app.can_read_every_activity_subject(lead_id, contact_id, company_id, deal_id));
