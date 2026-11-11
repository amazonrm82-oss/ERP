-- RVW-77 (weekly review 2026-11-11, medium): SGN-02's server fill read a hidden contact's or company's values.
--
-- app.document_record_values (021212) is security definer and judged whether the caller reads a deal's contact, a deal's
-- company or a contact's company with app.can_read_activity_subject, a security INVOKER helper whose sub-selects rely on the
-- caller's RLS. Called from a definer body it runs as the function owner, the policies do not apply, and it answered yes for
-- any existing id. So a rep allowed to edit a deal whose contact belongs to someone hidden from them (visibility own or team)
-- got that contact's name, phone and email (and a hidden company's name and billing address) filled into the draft of
-- public.signature_document_draft, and public.signature_document_send / SGN-03's send stored them. The app's fill
-- (src/features/document-templates/record-values-server.ts) reads the linked rows with the user's session and leaves them out.
--
-- Fix: app.document_caller_reads(org, type, id) (definer, no grants) judges a linked contact or company for the person, by the
-- rule of its select policy (018700): app.can_read_record(org, owner_id, team_id) on the row read as the server, or the row
-- is in app.deputy_readable(type) (HEB-08). Both helpers are security definer and read auth.uid() and app.membership_role()
-- themselves (aal2, closed business, support session), so they give the same answer inside a definer body as the policy does
-- for the caller. Keep it in step with contacts_select / companies_select. No bin filter, as the policies (and the app's read)
-- have none. app.document_record_values is redefined with the three checks replaced and nothing else changed (same signature,
-- definer, search_path '', grants revoked as before), so the server's fill equals the app's again.
--
-- Checked with it (every security definer body, at its latest definition, that calls an invoker helper reading public tables):
-- only app.document_record_values called app.can_read_activity_subject (or can_read_every_activity_subject /
-- can_read_task_links) from a definer body; app.signature_record_row only reads owner/team/bin for the caller's own
-- can_edit_record check (definer helpers), which is correct. The other definer bodies call invoker helpers that read
-- business configuration scoped by the organization (rest days, VAT rates, record addresses for consent, response target),
-- where no per-person visibility is meant.
--
-- No destructive statements and no escaped code points; safe to run twice.

create or replace function app.document_caller_reads(p_org uuid, p_type text, p_id uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_team uuid;
begin
  if p_org is null or p_id is null or auth.uid() is null then
    return false;
  end if;
  if p_type = 'contact' then
    select c.owner_id, c.team_id into v_owner, v_team from public.contacts c where c.organization_id = p_org and c.id = p_id;
  elsif p_type = 'company' then
    select c.owner_id, c.team_id into v_owner, v_team from public.companies c where c.organization_id = p_org and c.id = p_id;
  else
    return false;
  end if;
  if not found then
    return false;
  end if;
  return coalesce(app.can_read_record(p_org, v_owner, v_team), false)
      or exists (select 1 from app.deputy_readable(p_type) r where r.organization_id = p_org and r.id = p_id);
end;
$$;
revoke all on function app.document_caller_reads(uuid, text, uuid) from public, anon, authenticated, service_role;

-- the merge values of a record and of the business (= readRecordDocumentValues + businessDocumentValues), read as the
-- server; a linked contact or company counts only when the caller reads it by its select policy
-- (app.document_caller_reads, RVW-77), as the app read them with the user's session
create or replace function app.document_record_values(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org public.organizations;
  v_set public.org_document_settings;
  v_user text;
  v_values jsonb;
  v_gender text;
  v_lead public.leads;
  v_contact public.contacts;
  v_company public.companies;
  v_deal public.deals;
  v_person public.contacts;
  v_firm public.companies;
  v_money numeric;
begin
  select * into v_org from public.organizations o where o.id = p_org;
  select * into v_set from public.org_document_settings s where s.organization_id = p_org;
  select nullif(btrim(p.full_name), '') into v_user from public.profiles p where p.id = auth.uid();
  v_values := jsonb_build_object(
    'שם העסק', nullif(btrim(v_org.name), ''),
    'השם הרשום של העסק', coalesce(nullif(btrim(v_set.legal_name), ''), nullif(btrim(v_org.name), '')),
    'מספר העוסק', nullif(btrim(v_set.tax_id), ''),
    'כתובת העסק', nullif(concat_ws(', ', nullif(btrim(v_set.address_line), ''), nullif(btrim(v_set.city), '')), ''),
    'טלפון העסק', coalesce(nullif(btrim(v_set.phone), ''), nullif(btrim(v_org.phone), '')),
    'אימייל העסק', nullif(btrim(v_set.email), ''),
    'שם הנציג', coalesce(v_user, (select nullif(btrim(u.email), '') from auth.users u where u.id = auth.uid()), 'משתמש'),
    'תאריך היום', to_char((now() at time zone app.intake_zone(v_org.timezone))::date, 'DD.MM.YYYY'));

  if p_type = 'lead' then
    select * into v_lead from public.leads l where l.organization_id = p_org and l.id = p_id;
    v_values := v_values || jsonb_build_object(
      'שם מלא', nullif(btrim(v_lead.full_name), ''),
      'שם פרטי', nullif(split_part(btrim(regexp_replace(coalesce(v_lead.full_name, ''), '\s+', ' ', 'g')), ' ', 1), ''),
      'טלפון', nullif(btrim(v_lead.phone), ''),
      'אימייל', nullif(btrim(v_lead.email), ''),
      'שם החברה', nullif(btrim(v_lead.company_name), ''),
      'תפקיד', nullif(btrim(v_lead.job_title), ''));
    v_gender := v_lead.gender;
  elsif p_type = 'contact' then
    select * into v_contact from public.contacts c where c.organization_id = p_org and c.id = p_id;
    if v_contact.company_id is not null and app.document_caller_reads(p_org, 'company', v_contact.company_id) then
      select * into v_firm from public.companies c where c.organization_id = p_org and c.id = v_contact.company_id;
    end if;
    v_values := v_values || jsonb_build_object(
      'שם מלא', nullif(btrim(v_contact.full_name), ''),
      'שם פרטי', coalesce(nullif(btrim(v_contact.first_name), ''),
                          nullif(split_part(btrim(regexp_replace(coalesce(v_contact.full_name, ''), '\s+', ' ', 'g')), ' ', 1), '')),
      'שם משפחה', nullif(btrim(v_contact.last_name), ''),
      'טלפון', nullif(btrim(v_contact.phone), ''),
      'אימייל', nullif(btrim(v_contact.email), ''),
      'תפקיד', nullif(btrim(v_contact.job_title), ''),
      'כתובת', nullif(concat_ws(', ', nullif(btrim(v_contact.address_line), ''), nullif(btrim(v_contact.city), '')), ''),
      'תעודת זהות', nullif(btrim(v_contact.billing_tax_id), ''),
      'כתובת לחיוב', coalesce(nullif(btrim(v_contact.billing_address), ''), nullif(btrim(v_firm.billing_address), '')),
      'שם החברה', nullif(btrim(v_firm.name), ''),
      'תאריך לידה', to_char(v_contact.birth_date, 'DD.MM.YYYY'));
    v_gender := v_contact.gender;
  elsif p_type = 'company' then
    select * into v_company from public.companies c where c.organization_id = p_org and c.id = p_id;
    v_values := v_values || jsonb_build_object(
      'שם החברה', nullif(btrim(v_company.name), ''),
      'מספר החברה', nullif(btrim(v_company.tax_id), ''),
      'כתובת', nullif(concat_ws(', ', nullif(btrim(v_company.address_line), ''), nullif(btrim(v_company.city), '')), ''),
      'טלפון', nullif(btrim(v_company.phone), ''),
      'אימייל', nullif(btrim(v_company.email), ''),
      'שם לחיוב', coalesce(nullif(btrim(v_company.billing_name), ''), nullif(btrim(v_company.name), '')),
      'כתובת לחיוב', nullif(btrim(v_company.billing_address), ''));
  elsif p_type = 'deal' then
    select * into v_deal from public.deals d where d.organization_id = p_org and d.id = p_id;
    if v_deal.contact_id is not null and app.document_caller_reads(p_org, 'contact', v_deal.contact_id) then
      select * into v_person from public.contacts c where c.organization_id = p_org and c.id = v_deal.contact_id;
    end if;
    if v_deal.company_id is not null and app.document_caller_reads(p_org, 'company', v_deal.company_id) then
      select * into v_firm from public.companies c where c.organization_id = p_org and c.id = v_deal.company_id;
    end if;
    v_money := v_deal.amount_agorot / 100.0;
    v_values := v_values || jsonb_build_object(
      'שם העסקה', nullif(btrim(v_deal.name), ''),
      'סכום העסקה', case when v_deal.amount_agorot is null then null
                         when v_deal.amount_agorot % 100 = 0 then to_char(v_money, 'FM999,999,999,999,990') || ' ₪'
                         else to_char(v_money, 'FM999,999,999,999,990.00') || ' ₪' end,
      'תאריך סגירה צפוי', to_char(v_deal.expected_close_date, 'DD.MM.YYYY'),
      'שם מלא', nullif(btrim(v_person.full_name), ''),
      'שם פרטי', coalesce(nullif(btrim(v_person.first_name), ''),
                          nullif(split_part(btrim(regexp_replace(coalesce(v_person.full_name, ''), '\s+', ' ', 'g')), ' ', 1), '')),
      'טלפון', nullif(btrim(v_person.phone), ''),
      'אימייל', nullif(btrim(v_person.email), ''),
      'שם החברה', nullif(btrim(v_firm.name), ''));
    v_gender := v_person.gender;
  end if;
  return jsonb_build_object('values', jsonb_strip_nulls(v_values), 'gender', v_gender);
end;
$$;
revoke all on function app.document_record_values(uuid, text, uuid) from public, anon, authenticated, service_role;
