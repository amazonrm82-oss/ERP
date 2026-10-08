-- 20261006003800_lead_conversion_columns: part 1 of 1. Run the parts in order.
-- =============================================================================
-- 0038 Only the conversion marks a lead as converted (FXS-04)
-- =============================================================================
-- leads had a table-wide insert and update grant, so a user could set
-- converted_at / converted_contact_id / converted_company_id / converted_deal_id
-- on a lead of theirs, pointing at another contact or deal of the organization,
-- and the after-update trigger would copy custom fields there without checking
-- who may edit it. Those four columns are now written only by convert_lead()
-- and merge_records() (security definer). Every other column keeps its grant.
-- Every statement is safe to run twice (a table-wide revoke also clears column grants).

revoke insert, update on public.leads from authenticated;

grant insert (
  id, organization_id, full_name, email, phone, phone_e164, company_name, job_title, status_id, source_id,
  campaign, utm, score, budget_agorot, message, disqualify_reason, owner_id, team_id, tag_ids, custom_fields,
  first_contacted_at, last_contacted_at, created_by, updated_by, created_at, updated_at, deleted_at, import_job_id
) on public.leads to authenticated;

grant update (
  id, organization_id, full_name, email, phone, phone_e164, company_name, job_title, status_id, source_id,
  campaign, utm, score, budget_agorot, message, disqualify_reason, owner_id, team_id, tag_ids, custom_fields,
  first_contacted_at, last_contacted_at, created_by, updated_by, created_at, updated_at, deleted_at, import_job_id
) on public.leads to authenticated;
