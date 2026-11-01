-- =============================================================================
-- RPT-02: a report may be exported as a PDF, counted in the monthly PDF quota
-- =============================================================================
-- Owner, 1 November 2026 (DECISIONS.md "מסמכי PDF שנשארו בגל 2", answer (4) א): a report's PDF is made on our own server for
-- every export, with the user's session, from the same shaped tables as its CSV and Excel files; it is never stored, and every
-- export counts one production in max_pdf_per_month.
-- public.log_export (021107, RPT-01) takes p_format 'pdf' for a report (never for the full export) and then takes one
-- production through app.pdf_take (QUO-06, 020955): over the month's quota it raises hint limit:max_pdf_per_month, over 30 a
-- minute hint rate:pdf, and at 80% it sends its one notice; the refusal rolls the audit entry back with it. Every other line,
-- every report key and every refusal is 021107's.
-- public.pdf_quota_check(org) (review, low) lets the route look at the quota and the rate before it renders (read only).
-- Every statement is safe to run twice. No object or row is removed.

create or replace function public.log_export(
  p_org uuid,
  p_kind text,
  p_report text,
  p_rows integer,
  p_format text default 'csv'
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role public.membership_role := app.role_in(p_org);
begin
  if p_kind = 'full' then
    if v_role is distinct from 'owner' then
      raise exception 'the full export is for the owner' using errcode = '42501';
    end if;
  elsif p_kind = 'report' then
    if not app.can_export(p_org) then
      raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
    end if;
    -- the report keys of src/features/reports/definitions.ts; keep the two in step
    if p_report is null or p_report not in ('sources', 'funnel', 'response', 'reps', 'activity', 'forecast', 'lost', 'cycle', 'stuck', 'revenue', 'meetings', 'referrals', 'products', 'categories', 'profit', 'quotes', 'source_revenue', 'debt_aging', 'collection', 'recurring') then
      raise exception 'invalid export' using errcode = '22023';
    end if;
    -- DLI-06: gross profit carries costs
    if p_report = 'profit' and not app.can_view_costs(p_org) then
      raise exception 'the gross profit report is for those who may see costs' using errcode = '42501';
    end if;
    -- QUO-17: the quotes report belongs to the quotes capability
    if p_report = 'quotes' and not app.org_has_feature(p_org, 'quotes') then
      raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
    end if;
    -- BAL-03: debt aging is for those who open a ledger (BAL-01's rule), with its three keys
    if p_report = 'debt_aging' then
      if not app.can_record_payments(p_org) then
        raise exception 'debt aging is for those who record payments' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'balances') then
        raise exception 'balances are not in this plan' using errcode = 'P0001', hint = 'feature:balances';
      end if;
      if not (app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments')) then
        raise exception 'documents and payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
      end if;
    end if;
    -- COL-06: the collection report is for those who open the collection screen (BAL-01's rule), with its three keys
    if p_report = 'collection' then
      if not app.can_record_payments(p_org) then
        raise exception 'the collection report is for those who record payments' using errcode = '42501';
      end if;
      if not app.org_has_feature(p_org, 'collection') then
        raise exception 'collection is not in this plan' using errcode = 'P0001', hint = 'feature:collection';
      end if;
      if not (app.org_has_feature(p_org, 'documents') and app.org_has_feature(p_org, 'payments')) then
        raise exception 'documents and payments are not in this plan' using errcode = 'P0001', hint = 'feature:payments';
      end if;
    end if;
  else
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if p_rows is null or p_rows < 0 or p_rows > 10000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02: the file formats of a report export; a PDF only for a report (the full export is a zip)
  if p_format is null or p_format not in ('csv', 'xlsx', 'pdf') or (p_format = 'pdf' and p_kind <> 'report') then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  -- RPT-02 (owner, 1 November 2026, answer (4) א): a report's PDF is made on our server for every export, never stored, and
  -- counts one production in max_pdf_per_month (app.pdf_take: limit:max_pdf_per_month, rate:pdf, the 80% notice). Taken in
  -- the same statement as the audit entry, so a refused export counts nothing and leaves no entry.
  if p_format = 'pdf' then
    perform app.pdf_take(p_org);
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export',
    case p_kind when 'full' then 'full_export' else 'reports' end,
    null,
    jsonb_build_object('kind', p_kind, 'rows', p_rows, 'format', case p_kind when 'full' then 'zip' else p_format end)
      || case when p_kind = 'report' then jsonb_build_object('report', p_report) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_export(uuid, text, text, integer, text) from public, anon;
grant execute on function public.log_export(uuid, text, text, integer, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Review (low): a cheap look at the month's PDF quota and the minute's rate before a report is rendered, so a refused export
-- does not render for nothing. Read only: it counts nothing and changes nothing (app.pdf_take still decides when the export is
-- logged). For those who may export (app.can_export); anyone else gets 42501 and learns nothing of the business's quota.
-- Answers null (room left), 'limit:max_pdf_per_month' or 'rate:pdf', the hints app.pdf_take would raise.
-- ----------------------------------------------------------------------------
create or replace function public.pdf_quota_check(p_org uuid) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_limit numeric;
  v_row   app.pdf_months;
begin
  if not app.can_export(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_limit := app.org_limit(p_org, 'max_pdf_per_month');
  select * into v_row from app.pdf_months m where m.organization_id = p_org and m.month = app.automation_run_month(p_org);
  if v_limit is not null and coalesce(v_row.produced, 0) >= v_limit then
    return 'limit:max_pdf_per_month';
  end if;
  if v_row.minute_start is not null and v_row.minute_start > now() - interval '1 minute' and v_row.minute_count >= 30 then
    return 'rate:pdf';
  end if;
  return null;
end;
$$;
revoke all on function public.pdf_quota_check(uuid) from public, anon;
grant execute on function public.pdf_quota_check(uuid) to authenticated;
