-- =============================================================================
-- BIZ-05 part one: forms that fill an EXISTING record ("טופס שממלא רשומה קיימת ולא יוצר ליד: שאלון קליטה, פרטים לפני
-- פגישה. נשלח בקישור אישי; התשובות נכנסות לשדות ולציר הזמן")
-- =============================================================================
-- Owner, 3 November 2026, answer (70) ב: its own plan key `prefill_links`, in every plan. Owner, 11 November 2026, answer
-- (271) ב: a new secret-link public page under hard rule 5's pattern (part two, migration _prefill_links_public.sql).
-- NON-MEDICAL ONLY: a health or medical form waits for PRV-05 (wave 4), so a template never holds a field marked
-- sensitive (field_definitions.privacy_class = 'sensitive', PRK-01) and there is no health kind at all.
--
-- * The plan key: personal, basic, pro and business on (the sold plans, as public_page); app.plan_key_defaults (021253's
--   body) plus "prefill_links": false; every other plan (the hidden free plan, a plan added in the panel) holds it off.
--   public.plans_public (021260's body): the closed landing list gains 'prefill_links' after 'public_page' (the order of
--   PLAN_CAPABILITIES); nothing else changes.
-- * public.prefill_forms: a managed list per business (members read; owners/admins of a writable business write; 50 per
--   business, hint prefill_forms:max; audited). name 1..80, record_type lead|contact (insert-only), title 1..120 shown to the
--   customer, intro up to 500, fields = 1..20 keys in order, is_active. A key is a built-in of the record type from a closed
--   list (app.prefill_builtin_keys = PREFILL_BUILT_IN in src/features/prefill-links/fields.ts) or `cf:<key>` of an active
--   custom field of that type whose type a public form may show (not user, rich_text, duration, status, record_link, file;
--   = FORM_EXCLUDED_TYPES) and that is not marked sensitive. The rule is app.prefill_field_problem (null | 'field' |
--   'sensitive'); the trigger refuses a duplicate or a bad key (hint prefill_form:field) and a sensitive one (hint
--   prefill_form:sensitive), for every writer. A field that becomes unusable later is left out by the public page (judged
--   again when read). Server-only `key` (the seeded default's marker) and `draft_wording` (true on the seeded default until
--   a person changes its title or intro).
-- * The plan key (definer guard, outsider guard first): a person needs it to add, change or switch on a template; switching
--   one off (nothing else changed) and deleting stay allowed (the safe side), as document templates (SGN-01).
-- * Managed-list rule: one DRAFT default "פרטים לפני הפגישה" (contact: first name, last name, email, phone) for every new
--   business (trigger on organizations) and, once, for every live business whose list is empty (insert only).
-- Every statement is safe to run twice. No statement starts with drop; no row removal.

-- ----------------------------------------------------------------------------
-- The plan key (owner (70) ב: every plan)
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "features": { "prefill_links": true } },
  "basic": { "features": { "prefill_links": true } },
  "pro": { "features": { "prefill_links": true } },
  "business": { "features": { "prefill_links": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and p.features is distinct from (p.features || (d.v -> 'features'));

update public.plans p
   set features = coalesce(p.features, '{}'::jsonb) || '{"prefill_links": false}'::jsonb
 where not (coalesce(p.features, '{}'::jsonb) ? 'prefill_links');

-- 021253's fallback with the key (a plan that does not hold it: off)
create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": false,
    "price_lists": false,
    "discounts": false,
    "quotes": false,
    "orders": false,
    "documents": false,
    "payments": false,
    "balances": false,
    "collection": false,
    "money_waiting": false,
    "consents": false,
    "segments": false,
    "goals": false,
    "granular_permissions": false,
    "booking_page": false,
    "business_card": false,
    "qr_codes": false,
    "site_widget": false,
    "retention": false,
    "remove_built_with": false,
    "payment_links": false,
    "instant_reply": false,
    "auto_reassign": false,
    "dashboards": false,
    "goals_per_rep": false,
    "booking_team_pages": false,
    "lead_distribution": false,
    "campaign_costs": false,
    "punch_cards": false,
    "meta_leads": false,
    "meeting_reminders": false,
    "signatures": false,
    "sms": false,
    "review_requests": false,
    "public_page": false,
    "money_waiting_actions": false,
    "recurring_billing": false,
    "prefill_links": false
  },
  "limits": {
    "max_products": 0,
    "max_price_lists": 0,
    "max_quote_templates": 0,
    "max_booking_pages": 0,
    "max_booking_pages_per_user": 0,
    "max_segments": 0,
    "max_qr_codes": 0,
    "max_pdf_per_month": 0,
    "max_customer_emails_per_month": 0,
    "max_customer_emails_per_day": 0,
    "max_custom_reports": 0,
    "max_custom_objects": 0,
    "max_teams": 0,
    "max_whatsapp_numbers": 0,
    "view_seats_per_paid_seat": 0,
    "max_site_widgets": 0,
    "max_business_cards_per_user": 0,
    "max_booking_team_pages": 0,
    "ai_credits_per_month": 0,
    "ai_credits_per_user_per_month": 0,
    "max_signatures_per_month": 0,
    "max_sms_per_month": 0,
    "max_quotes_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- public.plans_public: 021260's body plus 'prefill_links'
create or replace function public.plans_public()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', p.key,
        'name', p.name_he,
        'price_monthly_agorot', p.price_monthly_agorot,
        'price_annual_agorot', p.price_annual_agorot,
        'price_unit', p.price_unit,
        'availability', p.availability,
        'position', p.position,
        'limits', (
          select coalesce(jsonb_object_agg(l.key, l.value), '{}'::jsonb)
            from jsonb_each(case when jsonb_typeof(p.limits) = 'object' then p.limits else '{}'::jsonb end) l
           where l.key in ('max_users', 'max_records', 'storage_gb')
             and jsonb_typeof(l.value) in ('number', 'null')
        ),
        'features', (
          select coalesce(jsonb_agg(c.key order by c.n), '[]'::jsonb)
            from unnest(array[
              -- landing-capabilities: built, non-core keys of PLAN_CAPABILITIES (unit test compares)
              'products', 'discounts', 'quotes', 'documents', 'payments', 'collection', 'balances',
              'booking_page', 'business_card', 'public_page', 'prefill_links', 'qr_codes', 'site_widget', 'money_waiting',
              'instant_reply', 'goals', 'campaign_costs', 'punch_cards', 'recurring_billing', 'segments', 'auto_reassign',
              'lead_distribution', 'meta_leads', 'meeting_reminders', 'signatures', 'sms', 'review_requests', 'orders',
              'goals_per_rep', 'granular_permissions', 'view_seats', 'remove_built_with'
              -- end landing-capabilities
            ]::text[]) with ordinality c(key, n)
           where jsonb_typeof(p.features) = 'object'
             and p.features -> c.key = 'true'::jsonb
        )
      )
      order by p.position, p.key
    ),
    '[]'::jsonb
  )
  from public.plans p
  where p.availability in ('available', 'coming_soon')
$$;

comment on function public.plans_public() is
  'LND-13: the public fields of available and coming-soon plans for the landing page price list; anon may execute it (owner, 11 November 2026).';

-- anon and authenticated only (owner, 11 November 2026); test 01 names it beside health_check
revoke all on function public.plans_public() from public, anon, authenticated, service_role;
grant execute on function public.plans_public() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- The field rule (= src/features/prefill-links/fields.ts)
-- ----------------------------------------------------------------------------
-- The built-in fields a template may ask, per record type (a closed list; the unit test reads it)
create or replace function app.prefill_builtin_keys(p_record_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_record_type
    -- prefill-builtins:lead
    when 'lead' then array['full_name', 'phone', 'email', 'company_name', 'job_title']
    -- prefill-builtins:contact
    when 'contact' then array['first_name', 'last_name', 'phone', 'email', 'job_title', 'address_line', 'city', 'birth_date']
    else array[]::text[] end
$$;
revoke all on function app.prefill_builtin_keys(text) from public, anon, authenticated;

-- The custom field types a public form never shows (= FORM_EXCLUDED_TYPES in src/features/intake/fields.ts)
create or replace function app.prefill_excluded_types() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['user', 'rich_text', 'duration', 'status', 'record_link', 'file']
$$;
revoke all on function app.prefill_excluded_types() from public, anon, authenticated;

-- null = the key may be asked; 'field' = unknown, switched off or a type no public form shows; 'sensitive' = PRK-01's mark
create or replace function app.prefill_field_problem(p_org uuid, p_record_type text, p_key text) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_def public.field_definitions;
begin
  if p_key is null then
    return 'field';
  end if;
  if p_key = any (app.prefill_builtin_keys(p_record_type)) then
    return null;
  end if;
  if p_key !~ '^cf:[a-z][a-z0-9_]{0,39}$' then
    return 'field';
  end if;
  select * into v_def from public.field_definitions d
   where d.organization_id = p_org and d.object_type = p_record_type and d.key = substr(p_key, 4);
  if v_def.id is null or not v_def.is_active or v_def.field_type = any (app.prefill_excluded_types()) then
    return 'field';
  end if;
  if v_def.privacy_class = 'sensitive' then
    return 'sensitive';
  end if;
  return null;
end;
$$;
revoke all on function app.prefill_field_problem(uuid, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The templates
-- ----------------------------------------------------------------------------
create table if not exists public.prefill_forms (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  record_type     text not null check (record_type in ('lead', 'contact')),
  title           text not null check (char_length(title) between 1 and 120 and title = btrim(title) and title !~ '[[:cntrl:]]'),
  intro           text check (intro is null or (char_length(intro) between 1 and 500 and intro = btrim(intro))),
  fields          text[] not null check (cardinality(fields) between 1 and 20),
  is_active       boolean not null default true,
  -- server only: the seeded default's marker; null on every template a person made
  key             text check (key in ('before_meeting')),
  -- server only: the seeded default's wording, until a person changes its title or intro
  draft_wording   boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index if not exists prefill_forms_key_idx on public.prefill_forms (organization_id, key) where key is not null;
create index if not exists prefill_forms_org_idx on public.prefill_forms (organization_id, record_type);

alter table public.prefill_forms enable row level security;

revoke all on public.prefill_forms from anon, authenticated;
grant select, delete on public.prefill_forms to authenticated;
grant insert (organization_id, name, record_type, title, intro, fields, is_active) on public.prefill_forms to authenticated;
grant update (name, title, intro, fields, is_active) on public.prefill_forms to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prefill_forms' and policyname = 'prefill_forms_select') then
    create policy prefill_forms_select on public.prefill_forms for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prefill_forms' and policyname = 'prefill_forms_insert') then
    create policy prefill_forms_insert on public.prefill_forms for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prefill_forms' and policyname = 'prefill_forms_update') then
    create policy prefill_forms_update on public.prefill_forms for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prefill_forms' and policyname = 'prefill_forms_delete') then
    create policy prefill_forms_delete on public.prefill_forms for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger prefill_forms_touch before update on public.prefill_forms
  for each row execute function app.touch_row();
create or replace trigger prefill_forms_audit after insert or update or delete on public.prefill_forms
  for each row execute function app.audit_row();

-- The key, the cap and the fields (definer: it counts the business's rows and reads its field definitions)
create or replace function app.prefill_forms_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  -- the default's seed names the business it seeds (transaction-local, set only by app.seed_prefill_forms) and its row
  -- carries the server-only key no client may insert: both are needed
  v_seed boolean := tg_op = 'INSERT'
    and new.key is not null
    and coalesce(current_setting('app.prefill_form_seed', true), '') = new.organization_id::text;
  v_key text;
  v_problem text;
begin
  -- RVW-23: an outsider gets RLS's plain 42501 and learns nothing about another business
  if not v_seed and auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- insert-only and server-only columns keep their values for every writer
    new.organization_id := old.organization_id;
    new.record_type := old.record_type;
    new.key := old.key;
    new.draft_wording := old.draft_wording
      and new.title is not distinct from old.title and new.intro is not distinct from old.intro;
  elsif not v_seed then
    new.key := null;
    new.draft_wording := false;
  end if;
  -- a person needs the key to add, change or switch on a template; switching one off (nothing else changed) stays allowed
  if not v_seed and auth.uid() is not null and not app.org_has_feature(new.organization_id, 'prefill_links')
     and not (tg_op = 'UPDATE'
              and old.is_active and not new.is_active
              and new.name is not distinct from old.name
              and new.title is not distinct from old.title
              and new.intro is not distinct from old.intro
              and new.fields is not distinct from old.fields) then
    raise exception 'prefill forms are not in the plan' using errcode = 'P0001', hint = 'feature:prefill_links';
  end if;
  -- the fields: each once, each one a template may ask (judged on every write that changes them)
  if tg_op = 'INSERT' or new.fields is distinct from old.fields then
    if new.fields is null or cardinality(new.fields) not between 1 and 20
       or (select count(distinct f) from unnest(new.fields) f) <> cardinality(new.fields) then
      raise exception 'each field once, 1 to 20 fields' using errcode = 'P0001', hint = 'prefill_form:field';
    end if;
    foreach v_key in array new.fields loop
      v_problem := app.prefill_field_problem(new.organization_id, new.record_type, v_key);
      if v_problem = 'sensitive' then
        raise exception 'a sensitive field is not asked on a prefill form' using errcode = 'P0001', hint = 'prefill_form:sensitive';
      elsif v_problem is not null then
        raise exception 'a field the form cannot ask' using errcode = 'P0001', hint = 'prefill_form:field';
      end if;
    end loop;
  end if;
  if tg_op = 'INSERT' then
    -- one insert at a time per business, so two cannot both pass the count
    perform pg_advisory_xact_lock(hashtextextended('prefill_forms:' || new.organization_id::text, 0));
    if (select count(*) from public.prefill_forms t where t.organization_id = new.organization_id) >= 50 then
      raise exception 'too many prefill forms' using errcode = 'P0001', hint = 'prefill_forms:max';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.prefill_forms_check() from public, anon, authenticated;

create or replace trigger prefill_forms_check before insert or update on public.prefill_forms
  for each row execute function app.prefill_forms_check();

-- ----------------------------------------------------------------------------
-- The default (managed-list rule): one DRAFT template for new businesses and live ones whose list is empty
-- ----------------------------------------------------------------------------
create or replace function app.seed_prefill_forms(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform set_config('app.prefill_form_seed', p_org::text, true);
  insert into public.prefill_forms (organization_id, name, record_type, title, intro, fields, key, draft_wording)
  select p_org, 'פרטים לפני הפגישה', 'contact', 'פרטים לפני הפגישה',
         'כדי שנוכל להתכונן לפגישה, נשמח שתבדקו את הפרטים שלכם ותשלימו מה שחסר.',
         array['first_name', 'last_name', 'email', 'phone'], 'before_meeting', true
   where not exists (select 1 from public.prefill_forms t where t.organization_id = p_org);
  perform set_config('app.prefill_form_seed', '', true);
end;
$$;
revoke all on function app.seed_prefill_forms(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_prefill_forms() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_prefill_forms(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_prefill_forms() from public, anon, authenticated;

create or replace trigger organizations_seed_prefill_forms after insert on public.organizations
  for each row execute function app.organizations_seed_prefill_forms();

-- existing businesses whose list is empty: once each, insert only; a deleted business is skipped; one that fails is skipped
-- with a warning naming the error
do $$
declare
  v_org uuid;
begin
  for v_org in
    select o.id from public.organizations o
     where o.deleted_at is null
       and not exists (select 1 from public.prefill_forms t where t.organization_id = o.id)
     order by o.id
  loop
    begin
      perform app.seed_prefill_forms(v_org);
    exception when others then
      raise warning 'prefill form seed skipped for %: %', v_org, sqlerrm;
    end;
  end loop;
end;
$$;
