-- =============================================================================
-- CAP-08 follow-ups (owner's answers of 14 October 2026, DECISIONS.md "חלוקת לידים")
-- =============================================================================
-- 1. Language. leads.preferred_locale: null or he | ar | en | ru | am | fr | es, the codes
--    and check of contacts.preferred_locale (CONTACT_LOCALES in
--    src/features/contacts/preferences.ts); column grants like every leads column. Shown on
--    the lead form and details card (card-layout key, app.card_layout_builtin_keys redefined
--    from the body of card_layouts 0190 with the one key added).
--    forms.locale_choice (default off; owners/admins through the forms policies and a column
--    grant): the hosted form asks the person's language; intake_form() returns
--    `locale_choice` (body of preferred_channel_form 018810 plus that line); intake_submit()
--    reads `preferred_locale` from the payload only when the form asks and ignores a value
--    outside the list. A new lead gets it; a repeat inquiry fills the matched lead and the
--    contact (it became) only where theirs is empty.
--    Conversion: trigger leads_convert_preferred_locale (after converted_at is first set)
--    copies the lead's language to the new contact only when the contact has none.
-- 2. Rules gain two conditions: `locale` (one of the codes) and a custom lead field of type
--    select with one of its options (`field_key`, `field_value`; the stand-in for "area"
--    until branches, BRN-02). Checked by app.lead_routing_rules_check: the field must be an
--    active lead field of type select and the value one of its options (hint
--    lead_routing_rules:field), the language one of the codes (check constraint). A rule
--    needs at least one condition (source, product, language or field).
-- 3. A rule points at a team or at one person (`user_id`, exactly one of the two; composite
--    FK to the membership, cascade). The person must be an active member who is not a
--    viewer when the rule is written (hint lead_routing_rules:user_inactive); a rule whose
--    person is no longer such a member is skipped when matching. A person rule goes through
--    HEB-08: app.auto_lead_owner (present: them; away: their deputy; away with no usable
--    deputy: no owner, the SPD-01 notices, app.absence_waiting_leads). Working hours are not
--    asked, as for a form's fixed owner. Automatic distribution only.
--    app.lead_rule_match(org, lead) returns the first active matching rule's team or person;
--    app.lead_distribution_route(org, team, at, lead, excluded) is what intake and the
--    automation round robin call now: a person rule decides there, otherwise it asks
--    app.lead_distribution_pick (unchanged) for the rule's team or the caller's.
--    app.lead_rule_team (pick's own rule look-up, used only with a lead context) follows
--    app.lead_rule_match: the first matching rule's team, null when that rule is a person.
-- 4. Open load = the waiting-leads rule (src/features/leads/waiting.ts and the "unhandled"
--    rule of report_money_waiting): open status, not converted, not imported, not in the
--    bin, and no contact entry (app.contact_types()) that a person logged and that is not
--    private. app.member_open_load redefined (from lead_distribution 019100).
-- Redefined, each from the body named: public.intake_submit and app.run_automation_actions
-- (lead_distribution 019100), public.intake_form (preferred_channel_form 018810),
-- app.card_layout_builtin_keys (card_layouts 0190), app.lead_rule_team and
-- app.member_open_load (lead_distribution 019100), app.lead_routing_rules_check
-- (lead_distribution 019100).
-- New functions: app.lead_rule_match, app.lead_distribution_route, app.lead_routing_context,
-- app.convert_preferred_locale.
-- Nullable columns: app.sample_row() needs nothing (0121). Merge picks unchanged
-- (shared-ground follow-up, like preferred_channel).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Language on leads and forms
-- ----------------------------------------------------------------------------
alter table public.leads add column if not exists preferred_locale text;
alter table public.forms add column if not exists locale_choice boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_preferred_locale_check' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_preferred_locale_check
      check (preferred_locale in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es'));
  end if;
end;
$$;

comment on column public.leads.preferred_locale is
  'CAP-08: null or he | ar | en | ru | am | fr | es (CONTACT_LOCALES in src/features/contacts/preferences.ts); copied to the contact on conversion when its own is empty';
comment on column public.forms.locale_choice is
  'CAP-08: the hosted form asks the person''s preferred language (the contacts'' codes)';

grant insert (preferred_locale), update (preferred_locale) on public.leads to authenticated;
grant insert (locale_choice), update (locale_choice) on public.forms to authenticated;

-- Conversion carries the lead's language to the new contact when the contact has none.
create or replace function app.convert_preferred_locale() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.preferred_locale is null or new.converted_contact_id is null then
    return null;
  end if;
  update public.contacts c
     set preferred_locale = new.preferred_locale
   where c.organization_id = new.organization_id
     and c.id = new.converted_contact_id
     and c.preferred_locale is null;
  return null;
end;
$$;
revoke all on function app.convert_preferred_locale() from public, anon, authenticated;

create or replace trigger leads_convert_preferred_locale after update of converted_at on public.leads
  for each row
  when (old.converted_at is null and new.converted_at is not null)
  execute function app.convert_preferred_locale();

-- ----------------------------------------------------------------------------
-- Rules: language, a select field, a person
-- ----------------------------------------------------------------------------
alter table public.lead_routing_rules add column if not exists locale text;
alter table public.lead_routing_rules add column if not exists field_key text;
alter table public.lead_routing_rules add column if not exists field_value text;
alter table public.lead_routing_rules add column if not exists user_id uuid;
alter table public.lead_routing_rules alter column team_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lead_routing_rules_locale_check' and conrelid = 'public.lead_routing_rules'::regclass) then
    alter table public.lead_routing_rules add constraint lead_routing_rules_locale_check
      check (locale in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lead_routing_rules_field_shape' and conrelid = 'public.lead_routing_rules'::regclass) then
    alter table public.lead_routing_rules add constraint lead_routing_rules_field_shape
      check ((field_key is null) = (field_value is null)
             and (field_key is null or field_key ~ '^[a-z][a-z0-9_]{0,39}$')
             and (field_value is null or char_length(field_value) between 1 and 200));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lead_routing_rules_target' and conrelid = 'public.lead_routing_rules'::regclass) then
    alter table public.lead_routing_rules add constraint lead_routing_rules_target
      check ((team_id is null) <> (user_id is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lead_routing_rules_user_fkey' and conrelid = 'public.lead_routing_rules'::regclass) then
    alter table public.lead_routing_rules add constraint lead_routing_rules_user_fkey
      foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade;
  end if;
end;
$$;

-- at least one condition, now of four
alter table public.lead_routing_rules
  drop constraint if exists lead_routing_rules_condition,
  add constraint lead_routing_rules_condition
    check (source_id is not null or product_id is not null or locale is not null or field_key is not null);

create index if not exists lead_routing_rules_user_idx on public.lead_routing_rules (organization_id, user_id) where user_id is not null;

grant insert (locale, field_key, field_value, user_id), update (locale, field_key, field_value, user_id) on public.lead_routing_rules to authenticated;

comment on column public.lead_routing_rules.user_id is
  'CAP-08: the one person the rule sends a lead to (instead of a team; exactly one of the two); HEB-08 rules apply';
comment on column public.lead_routing_rules.field_key is
  'CAP-08: a custom lead field of type select (the stand-in for area until BRN-02); field_value is one of its options';

-- The body of lead_distribution (019100), plus the new conditions and the person target.
create or replace function app.lead_routing_rules_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- RLS refuses this writer right after; answer nothing about the plan (the quota triggers' guard)
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if new.is_active and (
       tg_op = 'INSERT' or not old.is_active
       or new.source_id is distinct from old.source_id or new.product_id is distinct from old.product_id
       or new.team_id is distinct from old.team_id or new.user_id is distinct from old.user_id
       or new.locale is distinct from old.locale or new.field_key is distinct from old.field_key
       or new.field_value is distinct from old.field_value)
     and not app.org_has_feature(new.organization_id, 'lead_distribution') then
    raise exception 'distribution rules are not in the plan' using errcode = 'P0001', hint = 'feature:lead_distribution';
  end if;
  -- a select field of leads that is in use, and one of its options
  if new.field_key is not null
     and (tg_op = 'INSERT' or new.field_key is distinct from old.field_key or new.field_value is distinct from old.field_value)
     and not exists (
       select 1 from public.field_definitions d
        where d.organization_id = new.organization_id and d.object_type = 'lead' and d.key = new.field_key
          and d.is_active and d.field_type = 'select'
          and coalesce(d.options, '[]'::jsonb) @> jsonb_build_array(new.field_value)) then
    raise exception 'the field is not a list field of leads, or the value is not one of its options'
      using errcode = 'P0001', hint = 'lead_routing_rules:field';
  end if;
  -- the person: an active member who is not a viewer
  if new.user_id is not null
     and (tg_op = 'INSERT' or new.user_id is distinct from old.user_id)
     and not exists (
       select 1 from public.memberships m
        where m.organization_id = new.organization_id and m.user_id = new.user_id
          and m.status = 'active' and m.role <> 'viewer') then
    raise exception 'the person is not an active member' using errcode = 'P0001', hint = 'lead_routing_rules:user_inactive';
  end if;
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('lead_routing_rules:' || new.organization_id::text, 0));
    if (select count(*) from public.lead_routing_rules r where r.organization_id = new.organization_id) >= 50 then
      raise exception 'too many distribution rules' using errcode = 'P0001', hint = 'lead_routing_rules:max';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.lead_routing_rules_check() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Matching
-- ----------------------------------------------------------------------------

-- The first active rule (by position) that matches the lead ({source_id, product_id,
-- locale, custom_fields}): its team, or its person. A person who is no longer an active
-- member who is not a viewer makes the rule skipped.
create or replace function app.lead_rule_match(p_org uuid, p_lead jsonb, out team_id uuid, out user_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_team uuid;
  v_user uuid;
begin
  if p_org is null or p_lead is null then
    return;
  end if;
  select r.team_id, r.user_id into v_team, v_user
    from public.lead_routing_rules r
    left join public.memberships m on m.organization_id = r.organization_id and m.user_id = r.user_id
   where r.organization_id = p_org and r.is_active
     and (r.source_id is null or r.source_id = app.distribution_uuid(p_lead ->> 'source_id'))
     and (r.product_id is null or r.product_id = app.distribution_uuid(p_lead ->> 'product_id'))
     and (r.locale is null or r.locale = p_lead ->> 'locale')
     and (r.field_key is null or (case when jsonb_typeof(p_lead -> 'custom_fields') = 'object'
                                       then p_lead -> 'custom_fields' ->> r.field_key end) = r.field_value)
     and (r.user_id is null or (m.status = 'active' and m.role <> 'viewer'))
   order by r.position, r.created_at, r.id
   limit 1;
  team_id := v_team;
  user_id := v_user;
end;
$$;
revoke all on function app.lead_rule_match(uuid, jsonb) from public, anon, authenticated;

-- The pick's own look-up (lead_distribution 019100): the first matching rule's team, null
-- when there is none or the first matching rule names a person.
create or replace function app.lead_rule_team(p_org uuid, p_lead jsonb) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.team_id from app.lead_rule_match(p_org, p_lead) m
$$;
revoke all on function app.lead_rule_team(uuid, jsonb) from public, anon, authenticated;

-- What a rule looks at on an existing lead (the automation round robin): its source, requested
-- product, language and custom values. Read only; null when the lead is not there.
create or replace function app.lead_routing_context(p_org uuid, p_lead uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('source_id', l.source_id, 'product_id', l.requested_product_id,
                            'locale', l.preferred_locale, 'custom_fields', l.custom_fields)
    from public.leads l
   where l.organization_id = p_org and l.id = p_lead
$$;
revoke all on function app.lead_routing_context(uuid, uuid) from public, anon, authenticated;

-- What intake and the automation round robin ask. A person rule: that person through HEB-08
-- (owner_id = the person or their deputy; absent_user = the person when away with no usable
-- deputy). Otherwise the pick in the rule's team, or the caller's. method is 'person' for a
-- person rule.
create or replace function app.lead_distribution_route(
  p_org uuid, p_team uuid, p_at timestamptz, p_lead jsonb default null, p_excluded uuid[] default '{}',
  out turn_user uuid, out owner_id uuid, out turn_was timestamptz, out team_id uuid, out method text,
  out rule_user uuid, out absent_user uuid
)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_team uuid := p_team;
  v_rule_team uuid;
  v_rule_user uuid;
  v_owner uuid;
  v_absent uuid;
begin
  if p_org is not null and p_lead is not null and app.org_has_feature(p_org, 'lead_distribution') then
    select m.team_id, m.user_id into v_rule_team, v_rule_user from app.lead_rule_match(p_org, p_lead) m;
    if v_rule_user is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent from app.auto_lead_owner(p_org, v_rule_user, coalesce(p_at, now())) a;
      owner_id := v_owner;
      absent_user := v_absent;
      rule_user := v_rule_user;
      team_id := p_team;
      method := 'person';
      return;
    end if;
    v_team := coalesce(v_rule_team, p_team);
  end if;
  select p.turn_user, p.owner_id, p.turn_was, p.team_id, p.method
    into turn_user, owner_id, turn_was, team_id, method
    from app.lead_distribution_pick(p_org, v_team, p_at, null, coalesce(p_excluded, '{}'::uuid[])) p;
end;
$$;
revoke all on function app.lead_distribution_route(uuid, uuid, timestamptz, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function app.lead_distribution_route(uuid, uuid, timestamptz, jsonb, uuid[]) to service_role;

-- ----------------------------------------------------------------------------
-- Open load = the waiting-leads rule (lead_distribution 019100 counted every open lead)
-- ----------------------------------------------------------------------------
create or replace function app.member_open_load(p_org uuid, p_user uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.leads l
    join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
   where l.organization_id = p_org and l.owner_id = p_user
     and l.deleted_at is null and l.converted_at is null and l.import_job_id is null and s.kind = 'open'
     and not exists (
       select 1 from public.activities a
        where a.organization_id = l.organization_id and a.lead_id = l.id
          and a.created_by is not null and a.type = any (app.contact_types()) and not a.is_private)
$$;
revoke all on function app.member_open_load(uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- app.card_layout_builtin_keys: the body of card_layouts (0190), plus the lead's
-- preferred_locale (mirrored by CARD_LAYOUT_BUILT_IN, test 99)
-- ----------------------------------------------------------------------------
create or replace function app.card_layout_builtin_keys(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['full_name', 'phone', 'email', 'company_name', 'source_id', 'requested_product_id',
                           'preferred_channel', 'preferred_locale', 'owner_id', 'budget', 'last_contacted_at', 'created_at', 'disqualify_reason']
    when 'contact' then array['full_name', 'phone', 'email', 'job_title', 'company_id', 'type', 'birth_date',
                              'preferred_locale', 'preferred_channel', 'source_id', 'owner_id', 'created_at']
    when 'company' then array['type', 'parent_company_id', 'country', 'tax_id', 'industry', 'phone', 'email',
                              'website', 'city', 'address_line', 'owner_id', 'created_at']
    when 'deal' then array['amount', 'contact_id', 'company_id', 'expected_close_date', 'recurring_kind',
                           'recurring_amount', 'recurring_start', 'renewal_date', 'closed_at', 'lost_reason',
                           'competitor', 'owner_id', 'created_at']
    else array[]::text[]
  end
$$;
revoke all on function app.card_layout_builtin_keys(text) from public, anon;
grant execute on function app.card_layout_builtin_keys(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- public.intake_form: the body of preferred_channel_form (018810), plus locale_choice
-- ----------------------------------------------------------------------------
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
  v_whatsapp text;
  -- SPD-05
  v_callback jsonb;
  -- FLD-04: the "נבנה ב-Mexuz" line
  v_built_with boolean;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
  end if;
  -- 0163: a business whose public pages are closed (cancelled, deleted): a marker and nothing else
  if not app.org_public_pages_open(v_form.organization_id) then
    return jsonb_build_object('inactive', true);
  end if;

  select coalesce(jsonb_agg(x.field order by x.ord), '[]'::jsonb) into v_fields
    from (
      select a.ord,
             jsonb_build_object(
               'key', a.item ->> 'key',
               'required', coalesce(a.item -> 'required' = 'true'::jsonb, false),
               'help', coalesce(nullif(btrim(a.item ->> 'help'), ''), d.help_text),
               'show_if', case when jsonb_typeof(a.item -> 'show_if') = 'object' then a.item -> 'show_if' end,
               'label', d.label,
               'type', d.field_type,
               'options', d.options) as field
        from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end)
               with ordinality as a(item, ord)
        left join public.field_definitions d
          on (a.item ->> 'key') like 'cf:%'
         and d.organization_id = v_form.organization_id
         and d.object_type = 'lead'
         and d.key = substr(a.item ->> 'key', 4)
         and d.is_active
         and d.field_type <> 'user'
       where (a.item ->> 'key') in ('full_name', 'phone', 'email', 'company_name', 'message')
          or d.id is not null
    ) x;

  -- FLD-04: only the logo's object name and the colour; nothing else of the organization
  select jsonb_build_object('logo', o.logo_path, 'color', o.brand_color) into v_brand
    from public.organizations o
   where o.id = v_form.organization_id;

  -- CAP-05: the WhatsApp number of the thank-you page, only when the form turns it on:
  -- the form's own number, else the business phone; only a valid E.164 number leaves
  if v_form.whatsapp_button then
    select app.normalize_phone(coalesce(nullif(btrim(v_form.whatsapp_phone), ''), o.phone)) into v_whatsapp
      from public.organizations o
     where o.id = v_form.organization_id;
    if v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
      v_whatsapp := null;
    end if;
  end if;

  -- SPD-05: the call-back choice: the business's time zone, whether "now" is
  -- offered, and the slots still open today and on the next working day
  if v_form.callback_choice then
    select jsonb_build_object('time_zone', app.intake_zone(o.timezone))
           || app.intake_callback_offer(v_form.organization_id, v_form.callback_slots_off, now())
      into v_callback
      from public.organizations o
     where o.id = v_form.organization_id;
  end if;

  -- FLD-04: shown unless the plan or the override turns remove_built_with on; a bad
  -- plan value never fails the form (the line then shows)
  begin
    v_built_with := coalesce(app.show_built_with(v_form.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'built_with', v_built_with,
    'callback', v_callback,
    -- CON-10: ask how the person likes to be contacted (the four channels)
    'channel_choice', v_form.channel_choice,
    -- CAP-08: ask the person's preferred language (the contacts' codes)
    'locale_choice', v_form.locale_choice,
    'title', coalesce(nullif(btrim(v_form.title), ''), v_form.name),
    'intro', v_form.intro,
    'submit_label', v_form.submit_label,
    'fields', v_fields,
    'brand', coalesce(v_brand, jsonb_build_object('logo', null, 'color', null)),
    'thanks', jsonb_build_object(
      'whatsapp', v_whatsapp,
      'whatsapp_text', case when v_whatsapp is not null then nullif(btrim(v_form.whatsapp_text), '') end));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;
grant execute on function public.intake_form(text) to service_role;

-- ----------------------------------------------------------------------------
-- public.intake_submit: the body of lead_distribution (019100), plus the language (a new
-- lead gets it; a repeat inquiry fills an empty one) and the routing through
-- app.lead_distribution_route (a rule's person, through HEB-08, never falls back to the
-- form's owner). app.org_takes_leads and the v_rotation_closed lines are kept.
-- ----------------------------------------------------------------------------
create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_phone_e164 text;
  -- matched lead (and the contact it became) or matched contact
  v_lead_match uuid;
  v_lead_owner uuid;
  v_lead_contact uuid;
  v_contact_match uuid;
  v_contact_owner uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
  -- CAP-02 / ADS-01: where the visit came from (cleaned, known keys only)
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  -- CAP-01: custom values as sent, and what is kept of them
  v_custom_in jsonb := case when jsonb_typeof(p_payload -> 'custom') = 'object' then p_payload -> 'custom' else '{}'::jsonb end;
  v_custom jsonb := '{}'::jsonb;
  -- values of the shown fields by form key, for the conditions of later fields
  v_values jsonb := '{}'::jsonb;
  v_shown text[] := '{}';
  v_value jsonb;
  v_cond jsonb;
  v_type text;
  v_options jsonb;
  -- SPD-05: when the person asked to be called back ('now' or a slot 'YYYY-MM-DD-HH', its business date and start hour)
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_phrase text;
  v_callback_note text;
  v_task_owner uuid;
  v_task uuid;
  -- CAP-09: the rotation has members, but none is in working hours (or all are on leave)
  v_rotation_closed boolean := false;
  -- CAP-08: the team the new lead belongs to and is distributed in (the form's, or a matching rule's)
  v_team uuid;
  -- HEB-08: the form's owner was away with no usable deputy
  v_absent uuid;
  -- CON-10: how the person likes to be contacted, when the form asks (one of the four, else none)
  v_channel text := case when p_payload ->> 'preferred_channel' in ('phone', 'whatsapp', 'email', 'sms')
                         then p_payload ->> 'preferred_channel' end;
  -- CAP-08: the person's language, when the form asks (one of the contacts' codes, else none)
  v_locale text := case when p_payload ->> 'preferred_locale' in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es')
                        then p_payload ->> 'preferred_locale' end;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  -- read-only and suspended businesses keep taking leads (owner, 8 and 13 October 2026)
  if not app.org_takes_leads(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam', coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  -- CAP-01: the form's fields in order. A hidden field loses its value and is
  -- never required; a shown custom field must hold a valid value.
  if v_form.kind = 'form' then
    for v_field in
      select a.value from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end) a
    loop
      continue when jsonb_typeof(v_field) <> 'object';
      v_key := v_field ->> 'key';
      continue when v_key is null or v_key = any (v_shown);
      v_type := null;
      v_options := null;
      if v_key like 'cf:%' then
        select d.field_type, d.options into v_type, v_options
          from public.field_definitions d
         where d.organization_id = v_form.organization_id and d.object_type = 'lead'
           and d.key = substr(v_key, 4) and d.is_active;
        -- a field that is gone, switched off or picks a team member is not on the form
        continue when v_type is null or v_type = 'user';
        v_value := v_custom_in -> substr(v_key, 4);
      elsif v_key = 'full_name' then v_value := to_jsonb(v_full_name);
      elsif v_key = 'phone' then v_value := to_jsonb(v_phone);
      elsif v_key = 'email' then v_value := to_jsonb(v_email);
      elsif v_key = 'company_name' then v_value := to_jsonb(v_company);
      elsif v_key = 'message' then v_value := to_jsonb(v_message);
      else
        continue;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;

      v_cond := v_field -> 'show_if';
      if jsonb_typeof(v_cond) = 'object'
         and not coalesce((v_cond ->> 'field') = any (v_shown)
                          and app.intake_condition_met(v_values -> (v_cond ->> 'field'), v_cond ->> 'value'), false) then
        -- hidden: whatever was sent for it is dropped
        if v_key = 'full_name' then v_full_name := null;
        elsif v_key = 'phone' then v_phone := null;
        elsif v_key = 'email' then v_email := null;
        elsif v_key = 'company_name' then v_company := null;
        elsif v_key = 'message' then v_message := null;
        end if;
        continue;
      end if;

      v_shown := v_shown || v_key;
      if v_type is not null and app.intake_has_value(v_value) then
        if not app.custom_value_ok(v_type, v_options, v_value) then
          raise exception 'invalid custom field: %', substr(v_key, 4) using errcode = '22023';
        end if;
        v_custom := v_custom || jsonb_build_object(substr(v_key, 4), v_value);
      end if;
      if app.intake_has_value(v_value) then
        v_values := v_values || jsonb_build_object(v_key, v_value);
      end if;
      if v_field -> 'required' = 'true'::jsonb and not app.intake_has_value(v_value) then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;

  -- CON-10: a channel counts only when the form asks
  if v_form.kind <> 'form' or not v_form.channel_choice then
    v_channel := null;
  end if;
  -- CAP-08: a language counts only when the form asks
  if v_form.kind <> 'form' or not v_form.locale_choice then
    v_locale := null;
  end if;

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  -- (SPD-05 follow-ups: the slots this form offers now, app.intake_callback_pick())
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select p.at, p.phrase into v_callback_at, v_callback_phrase
      from app.intake_callback_pick(v_form.organization_id, v_form.callback_slots_off, v_callback, now()) p;
    v_callback_note := 'ביקשו שנחזור אליהם ' || v_callback_phrase;
  else
    v_callback := null;
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
    from public.leads l
   where l.organization_id = v_form.organization_id and l.deleted_at is null
     and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
          or (v_email is not null and lower(l.email) = v_email))
   order by l.created_at desc
   limit 1;
  if v_lead_match is null then
    -- CON-01: the contact's primary phone or email, or any of its other ones
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and c2.phone_e164 = v_phone_e164)
                 or (v_email is not null and lower(c2.email) = v_email))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and ch.value_e164 = v_phone_e164)
                 or (v_email is not null and ch.kind = 'email' and ch.value = v_email)))
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead_match is not null or v_contact_match is not null then
    -- first touch wins: the lead keeps its attribution and custom fields;
    -- this visit's are kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end);
    -- CAP-08: the form's language fills an empty one only
    if v_locale is not null then
      if v_lead_match is not null then
        update public.leads l set preferred_locale = v_locale
         where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.preferred_locale is null;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c set preferred_locale = v_locale
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and c.preferred_locale is null;
      end if;
    end if;
    -- CON-10 (owner, 14 October 2026): the form's channel fills an empty one, or replaces one
    -- that came from a form; a channel a person set (or one older than its source) stays
    if v_channel is not null then
      if v_lead_match is not null then
        update public.leads l
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where l.organization_id = v_form.organization_id and l.id = v_lead_match
           and (l.preferred_channel is null or l.preferred_channel_source = 'form')
           and l.preferred_channel is distinct from v_channel;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and (c.preferred_channel is null or c.preferred_channel_source = 'form')
           and c.preferred_channel is distinct from v_channel;
      end if;
    end if;
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      -- SPD-05: the requested call-back time, when there is one, in the body
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים', v_callback_note,
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    -- SPD-05: a call task for the record's owner, else the form's owner
    if v_callback_at is not null then
      -- the record's owner while an active member who is not a viewer, else the form's owner, same check
      select m.user_id into v_task_owner from public.memberships m
       where m.organization_id = v_form.organization_id and m.user_id = v_owner
         and m.status = 'active' and m.role <> 'viewer';
      if v_task_owner is null then
        select m.user_id into v_task_owner from public.memberships m
         where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
           and m.status = 'active' and m.role <> 'viewer';
      end if;
      v_task := app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                     coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- SPD-01: the lead's call task follows "לקחתי"
      if v_lead_match is not null then
        insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
        values (v_task, v_form.organization_id, v_lead_match) on conflict do nothing;
      end if;
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  select s.id into v_status from public.lead_statuses s
   where s.organization_id = v_form.organization_id and s.kind = 'open'
   order by s.is_default desc, s.position
   limit 1;
  if v_status is null then
    raise exception 'the organization has no open lead status' using errcode = 'P0001';
  end if;

  v_team := v_form.team_id;
  if v_form.assign_mode = 'round_robin' then
    -- CAP-08: the rules (source, language, list field; a team or one person), then the pick
    select p.owner_id, p.team_id, p.rule_user, p.absent_user into v_owner, v_team, v_rule_user, v_absent
      from app.lead_distribution_route(v_form.organization_id, v_form.team_id, now(),
                                       jsonb_build_object('source_id', v_form.source_id, 'locale', v_locale,
                                                          'custom_fields', v_custom), '{}'::uuid[]) p;
    -- CAP-09 (owner, 13 October 2026): nobody of the rotation in hours: the lead waits
    -- with no owner for a "לקחתי"; nobody available at all keeps the form owner's fallback
    v_rotation_closed := v_owner is null and v_rule_user is null and app.rotation_has_members(v_form.organization_id, v_team);
  end if;
  -- CAP-08: a rule's person (HEB-08 already applied) never falls back to the form's owner
  if v_owner is null and not v_rotation_closed and v_rule_user is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
    -- HEB-08: an absent form owner's new lead goes to their deputy; with no usable
    -- deputy it has no owner and takes the SPD-01 route (no chain)
    -- (app.auto_lead_owner: the rule every automatic assigner of a fixed person uses)
    if v_owner is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent
        from app.auto_lead_owner(v_form.organization_id, v_owner, now()) a;
    end if;
  end if;

  -- SPD-01: the owner is told as 'lead_new' (app.notify_assignment())
  perform set_config('app.intake', 'on', true);
  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields, preferred_channel, preferred_channel_source, preferred_locale)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_team,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content',
            -- CAP-02: the extra parameters of the closed list, in one place
            'extra', v_attr -> 'extra')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid',
          v_custom, v_channel, case when v_channel is not null then 'form' end, v_locale)
  returning id into v_lead;
  perform set_config('app.intake', '', true);

  -- CAP-09: if nobody takes it, the rotation gives it to the first member back in hours
  if v_rotation_closed then
    insert into app.rotation_waiting_leads (lead_id, organization_id, team_id)
    values (v_lead, v_form.organization_id, v_team) on conflict do nothing;
  end if;

  -- HEB-08: back from the absence, the form's owner gets it if nobody took it (app.return_absence_leads())
  if v_owner is null and v_absent is not null then
    perform app.lead_waits_for_absent(v_form.organization_id, v_lead, v_form.id, v_absent);
  end if;

  -- SPD-01: nobody owns it: whoever may take it is told, and the first "לקחתי" wins
  if v_owner is null then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    select v_form.organization_id, r.user_id, 'lead_new', 'ליד חדש מחכה למי שייקח אותו', 'lead', v_lead
      from app.intake_unowned_recipients(v_form.organization_id, v_team) r;
  end if;

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    v_task := app.intake_call_task(v_form.organization_id, v_owner, v_lead, null, v_callback = 'now', v_callback_at,
                                   v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    -- SPD-01: the lead's call task follows "לקחתי"
    insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
    values (v_task, v_form.organization_id, v_lead) on conflict do nothing;
    update public.notifications n set body = v_callback_note
     where n.organization_id = v_form.organization_id and n.entity_type = 'lead' and n.entity_id = v_lead
       and n.body is null;
  end if;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;
revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;

-- ----------------------------------------------------------------------------
-- app.run_automation_actions: the body of lead_distribution (019100). The round robin on a
-- lead goes through app.lead_distribution_route; a rule's person is assigned as the
-- "assign to a person" step does (app.assign_lead_owner_auto, the same warnings).
-- ----------------------------------------------------------------------------
create or replace function app.run_automation_actions(p_auto public.automations, p_entity text, p_id uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := p_auto.organization_id;
  v_table text := app.automation_table(p_entity);
  v_record jsonb;
  v_action jsonb;
  v_type text;
  v_steps jsonb := '[]'::jsonb;
  v_name text;
  v_title text;
  v_user uuid;
  v_id uuid;
  v_due timestamptz;
  v_task_type text;
  v_count integer;
  v_kind public.lead_status_kind;
  v_reason text;
  v_warning text;
  v_warning_name text;
  v_kept uuid;
  v_zone text;
  v_local timestamp;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
begin
  for v_action in select * from jsonb_array_elements(p_auto.actions) loop
    v_type := v_action ->> 'type';
    v_record := app.automation_record(p_entity, v_org, p_id);
    v_name := app.automation_display_name(v_record);
    v_warning_name := null;
    begin
      if v_record is null then
        raise exception 'the record no longer exists';
      end if;

      if v_type = 'create_task' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'משימה'), '{{name}}', v_name), 300);
        v_due := null;
        v_warning := null;
        -- HEB-03: due in N business days (0..60), at the current local time of day
        if v_action ? 'due_in_business_days' then
          if jsonb_typeof(v_action -> 'due_in_business_days') = 'number'
             and (v_action ->> 'due_in_business_days')::numeric between 0 and 60
             and (v_action ->> 'due_in_business_days')::numeric = trunc((v_action ->> 'due_in_business_days')::numeric) then
            select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_org;
            v_zone := coalesce(v_zone, 'Asia/Jerusalem');
            v_local := now() at time zone v_zone;
            v_due := (app.add_business_days(v_org, v_local::date, (v_action ->> 'due_in_business_days')::numeric::int) + v_local::time)
                     at time zone v_zone;
          else
            v_warning := 'the business-day offset is invalid';
          end if;
        end if;
        if v_due is null and (v_action ? 'due_in_minutes' or v_action ? 'due_in_days') then
          v_due := now()
            + make_interval(mins => coalesce((v_action ->> 'due_in_minutes')::int, 0))
            + make_interval(days => coalesce((v_action ->> 'due_in_days')::int, 0));
        end if;
        v_user := case when v_action ->> 'assign' = 'user'
                       then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                       else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
        v_task_type := case when v_action ->> 'task_type' in ('todo', 'call', 'meeting', 'follow_up')
                            then v_action ->> 'task_type' else 'todo' end;
        insert into public.tasks (organization_id, title, task_type, due_at, owner_id, lead_id, contact_id, company_id, deal_id)
        values (
          v_org, v_title, v_task_type, v_due, v_user,
          case when p_entity = 'lead' then p_id when p_entity = 'task' then (v_record ->> 'lead_id')::uuid end,
          case when p_entity = 'contact' then p_id when p_entity in ('task', 'deal') then (v_record ->> 'contact_id')::uuid end,
          case when p_entity = 'company' then p_id when p_entity = 'task' then (v_record ->> 'company_id')::uuid end,
          case when p_entity = 'deal' then p_id when p_entity = 'task' then (v_record ->> 'deal_id')::uuid end);

      elsif v_type = 'notify' then
        v_title := left(replace(coalesce(nullif(btrim(v_action ->> 'title'), ''), 'עדכון מאוטומציה'), '{{name}}', v_name), 200);
        if v_action ->> 'to' = 'admins' then
          insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
          select v_org, m.user_id, 'automation', v_title, p_entity, p_id
            from public.memberships m
           where m.organization_id = v_org and m.status = 'active' and m.role in ('owner', 'admin');
          get diagnostics v_count = row_count;
        else
          v_user := case when v_action ->> 'to' = 'user'
                         then app.automation_member(v_org, (v_action ->> 'user_id')::uuid)
                         else app.automation_member(v_org, (v_record ->> 'owner_id')::uuid) end;
          v_count := 0;
          if v_user is not null then
            insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
            values (v_org, v_user, 'automation', v_title, p_entity, p_id);
            v_count := 1;
          end if;
        end if;
        if v_count = 0 then
          raise exception 'nobody to notify';
        end if;

      elsif v_type = 'assign_owner' then
        v_warning := null;
        if v_action ->> 'mode' = 'round_robin' then
          if (v_action ->> 'team_id') is not null and not exists (
            select 1 from public.teams t where t.organization_id = v_org and t.id = (v_action ->> 'team_id')::uuid) then
            raise exception 'the team no longer exists';
          end if;
          v_rule_user := null;
          if p_entity = 'lead' then
            -- CAP-08: the rules (source, requested product, language, list field; a team or one
            -- person), then the pick
            select p.owner_id, p.rule_user into v_user, v_rule_user
              from app.lead_distribution_route(v_org, (v_action ->> 'team_id')::uuid, now(),
                                               app.lead_routing_context(v_org, p_id), '{}'::uuid[]) p;
          else
            v_user := app.next_lead_owner(v_org, (v_action ->> 'team_id')::uuid);
          end if;
          if v_rule_user is not null then
            -- a rule's person: the HEB-08 rule of a fixed person, as the "assign to a person" step
            if app.assign_lead_owner_auto(v_org, p_id, v_rule_user, (v_record ->> 'team_id')::uuid) is null then
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            v_user := null;
          elsif v_user is null then
            raise exception 'nobody is available';
          end if;
        else
          v_user := app.automation_member(v_org, (v_action ->> 'user_id')::uuid);
          if v_user is null then
            raise exception 'the user is not an active member';
          end if;
          -- HEB-08: a lead goes through the one rule for automatic assignment of a fixed
          -- person (present: them; away: their deputy; away with none: no owner, and back to
          -- them on their return)
          if p_entity = 'lead' then
            v_warning := null;
            if app.assign_lead_owner_auto(v_org, p_id, v_user, (v_record ->> 'team_id')::uuid) is null then
              -- the lead keeps the owner it has (owner, 14 October 2026): say who it stays with
              v_kept := null;
              select l.owner_id into v_kept from public.leads l where l.organization_id = v_org and l.id = p_id;
              if v_kept is not null then
                v_warning := 'the requested owner is away, the lead stays with its owner';
                v_warning_name := left(app.follow_person_name(v_kept), 200);
              else
                v_warning := 'the owner is away, the lead has no owner';
              end if;
            end if;
            -- assigned (or left unowned) above
            v_user := null;
          end if;
        end if;
        if v_user is not null then
          execute format('update public.%I set owner_id = $1 where organization_id = $2 and id = $3', v_table)
            using v_user, v_org, p_id;
        end if;

      elsif v_type = 'add_tag' then
        if p_entity = 'task' then
          raise exception 'tasks have no tags';
        end if;
        select t.id into v_id from public.tags t where t.organization_id = v_org and t.id = (v_action ->> 'tag_id')::uuid;
        if v_id is null then
          raise exception 'the tag no longer exists';
        end if;
        execute format(
          'update public.%I set tag_ids = case when $1 = any (tag_ids) then tag_ids else array_append(tag_ids, $1) end
            where organization_id = $2 and id = $3', v_table)
          using v_id, v_org, p_id;

      elsif v_type = 'set_lead_status' then
        if p_entity <> 'lead' then
          raise exception 'only for leads';
        end if;
        select s.id, s.kind into v_id, v_kind from public.lead_statuses s
         where s.organization_id = v_org and s.id = (v_action ->> 'status_id')::uuid and s.kind <> 'converted';
        if v_id is null then
          raise exception 'the status no longer exists';
        end if;
        v_warning := null;
        if v_kind = 'disqualified' then
          -- the reason is kept by id and read by name now, so a renamed reason still works;
          -- only an active reason of this organization counts (a hidden, deleted or foreign id does not)
          v_reason := null;
          -- absent, null, empty or blank: no reason was set (an old rule); anything else is looked up
          if nullif(btrim(v_action ->> 'reason_id'), '') is null then
            v_warning := 'no reason is set';
          else
            select r.name into v_reason from public.disqualify_reasons r
             where r.organization_id = v_org and r.is_active
               and r.id::text = (v_action ->> 'reason_id');
            if v_reason is null then
              v_warning := 'the reason no longer exists';
            end if;
          end if;
          -- status and reason in one update: leads_disqualify_reason keeps a reason a server write sets
          -- together with the move, and clears the old one when none is given
          if v_reason is not null then
            update public.leads set status_id = v_id, disqualify_reason = v_reason where organization_id = v_org and id = p_id;
          else
            update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
          end if;
        else
          update public.leads set status_id = v_id where organization_id = v_org and id = p_id;
        end if;

      elsif v_type = 'move_deal_stage' then
        if p_entity <> 'deal' then
          raise exception 'only for deals';
        end if;
        select s.id into v_id from public.stages s
         where s.organization_id = v_org and s.id = (v_action ->> 'stage_id')::uuid
           and s.pipeline_id = (v_record ->> 'pipeline_id')::uuid;
        if v_id is null then
          raise exception 'the stage is not in this deal''s pipeline';
        end if;
        update public.deals set stage_id = v_id where organization_id = v_org and id = p_id;

      else
        raise exception 'unknown action %', coalesce(v_type, '(none)');
      end if;

      v_steps := v_steps || jsonb_build_array(
        jsonb_build_object('action', v_type, 'status', 'ok')
        || case when v_type in ('set_lead_status', 'create_task', 'assign_owner') and v_warning is not null
                then jsonb_build_object('warning', v_warning) else '{}'::jsonb end
        || case when v_type = 'assign_owner' and v_warning is not null and v_warning_name is not null
                then jsonb_build_object('warning_name', v_warning_name) else '{}'::jsonb end);
    exception when others then
      v_steps := v_steps || jsonb_build_array(jsonb_build_object('action', v_type, 'status', 'error', 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return v_steps;
end;
$$;
revoke all on function app.run_automation_actions(public.automations, text, uuid) from public, anon, authenticated;
