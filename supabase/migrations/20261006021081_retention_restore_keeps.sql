-- =============================================================================
-- RVW-57 (weekly review 27 October 2026): PRV-01 says "a restore counts as a keep", but only a lead the policy itself
-- had binned got a keep when restored (app.run_lead_retention step 1). A lead a person binned and restored was a
-- candidate again at once. The rule now also leaves out a lead with a 'restore' entry in the audit log
-- (app.audit_row: an update that clears deleted_at) since the cutoff, whoever restored it: in doubt the policy keeps
-- the lead. Read by (organization_id, entity_type, entity_id) = audit_log_entity_idx (plain columns; the function is a
-- definer, so RLS does not apply to the lookup either).
-- * Body copied from its only definition (021005) with only that condition added. Signature and grants unchanged.
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.lead_retention_candidates(p_org uuid, p_cutoff timestamptz, p_lead uuid default null)
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select l.id
    from public.leads l
   where l.organization_id = p_org
     and (p_lead is null or l.id = p_lead)
     and l.deleted_at is null
     and l.converted_at is null
     and l.created_at < p_cutoff
     and (l.last_contacted_at is null or l.last_contacted_at < p_cutoff)
     -- sample data (USR-04) is removed by its own button, never by the policy
     and not exists (select 1 from app.sample_records s where s.organization_id = p_org and s.lead_id = l.id)
     -- contact of any author (call, message, note, meeting; private notes too) and the customer's own inquiries
     and not exists (select 1 from public.activities a
                      where a.organization_id = p_org and a.lead_id = l.id
                        and (a.type = any (app.contact_types()) or a.type = 'inquiry')
                        and (a.occurred_at >= p_cutoff or a.created_at >= p_cutoff))
     and not exists (select 1 from public.tasks t
                      where t.organization_id = p_org and t.lead_id = l.id
                        and t.deleted_at is null and t.status = 'open')
     -- a planned meeting still ahead, or any meeting that was not cancelled within the window
     and not exists (select 1 from public.meetings m
                      where m.organization_id = p_org and m.lead_id = l.id
                        and ((m.status = 'planned' and m.ends_at > now())
                             or (m.status <> 'cancelled' and m.starts_at >= p_cutoff)))
     and not exists (select 1 from app.lead_retention_keeps k
                      where k.organization_id = p_org and k.lead_id = l.id and k.kept_at >= p_cutoff)
     -- RVW-57: a restore from the bin since the cutoff counts as a keep, whoever binned and restored it
     and not exists (select 1 from public.audit_log al
                      where al.organization_id = p_org and al.entity_type = 'leads' and al.entity_id = l.id
                        and al.action = 'restore' and al.created_at >= p_cutoff);
$$;
revoke all on function app.lead_retention_candidates(uuid, timestamptz, uuid) from public, anon, authenticated;
