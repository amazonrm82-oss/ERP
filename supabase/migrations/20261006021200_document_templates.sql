-- =============================================================================
-- SGN-01: document templates (contract, service agreement, joining form; a health declaration only when a business writes one)
-- =============================================================================
-- Owner 3 November 2026, answer (67) ג (DECISIONS.md): a new plan key `signatures` from the "בסיס" plan up (personal
-- false; basic / pro / business true) and a monthly cap `max_signatures_per_month` (personal 0, basic 20, pro 100,
-- business no cap). The cap counts documents sent for signature (SGN-02, owner's answer (191)); nothing counts it yet.
-- * The plan key: the delta pattern of punch_cards_plan / meta_leads_plan; app.plan_key_defaults() (body of
--   meeting_customer_reminders, CAL-12's 021196, the latest one before this) adds signatures: false and max_signatures_per_month: 0. Mirrored by PLAN_VALUES / PLAN_KEY_FALLBACK in src/lib/plan-keys.ts.
-- * public.document_templates is a managed list (owner's rule of 12 October 2026): every member reads; owners and admins of a
--   writable business write; audited; at most 50 per business (hint document_templates:max). A person's insert, change or
--   switch-on needs the key (hint feature:signatures); switching one off and removing one never do (the safe side; owner
--   (201) ב). The three defaults are seeded for every
--   business (insert trigger, and once for every live business whose list is empty), whatever its plan, as the other
--   managed lists (owner (200) א); a business without the key reads them, switches them off and deletes them. The seed marks its own inserts with the
--   transaction-local setting app.document_template_seed = the business id, and the guard skips the plan and outsider
--   checks only for that business's inserts that also carry the server-only key (the cap of 50 still holds). Like the other managed-list backfills, running
--   this file again seeds once more a business whose list is empty, also one that deleted all three defaults.
-- * name 1..80 (unique per business, ignoring case, one line), kind contract|service_agreement|joining_form|
--   health_declaration|other, record_type lead|contact|company|deal (the record a document is filled from), body 1..20,000
--   (REC-04's cleaned Markdown, cleaned by the app with sanitizeNote() and rendered only through NoteText, never as HTML),
--   is_active, server-only draft_wording (true on a seeded default until a person changes its body: the screen marks it
--   "טיוטה" until the lawyer approves the wording; owner, 8 October 2026: legal texts are drafts until the lawyer edits them),
--   and server-only key (the seed's marker of a default: its kind code, one per business, kept through a person's edits;
--   null on a template a person made), so a later migration finds the seeded defaults.
-- * DRAFT wording: the bodies of all three seeded defaults (service agreement, contract, joining form)
--   are drafts written by Claude Code, NOT approved by a lawyer; a new approved wording ships in a new migration that finds
--   the defaults by key and replaces a body only while draft_wording is still true (a business's own edit is never touched).
-- * Owner's answers of 10 November 2026: (200) א the defaults are seeded for every business whatever its plan; (201) ב without
--   the key a template may be switched off and deleted, while switching on, editing and creating need it (the guard below
--   and the app); (202) ב no health declaration is seeded until PRV-05 (sensitive data).
-- * Merge fields: a CLOSED list per record type, app.document_merge_fields(record_type) = the business fields plus the
--   record's own (DOCUMENT_BUSINESS_FIELDS / DOCUMENT_RECORD_FIELDS in src/features/document-templates/fields.ts, a unit
--   test reads this file). Any {text} without ":" or "|" (the pattern of app.message_unknown_field) must be one of them
--   (hint document_template:field), judged again when the record type changes; HEB-01 gender blocks hold
--   (app.template_variant_problem, hints document_template:variant | document_template:neutral).
-- * Nothing is filled, sent, signed or stored here: the settings page previews a template on a record read with the
--   user's session, in the browser only. SGN-02 (a document from a record, a secret link, signing, the signed PDF) needs the
--   owner's approval of a new public secret-link use. No filled document is stored.
-- Every statement is safe to run twice; no statement deletes.

-- ----------------------------------------------------------------------------
-- The plan key
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": { "max_signatures_per_month": 0 }, "features": { "signatures": false } },
  "basic": { "limits": { "max_signatures_per_month": 20 }, "features": { "signatures": true } },
  "pro": { "limits": { "max_signatures_per_month": 100 }, "features": { "signatures": true } },
  "business": { "limits": { "max_signatures_per_month": null }, "features": { "signatures": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- the value of a wave 2 key that a plan does not hold: the most restrictive
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
    "signatures": false
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
    "max_signatures_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- Any other plan (the hidden free plan, a plan added in the admin panel) gets the key off and the cap 0; only these keys
-- are added, a plan's own value is kept.
update public.plans p
   set features = jsonb_build_object('signatures', false) || coalesce(p.features, '{}'::jsonb)
 where not (coalesce(p.features, '{}'::jsonb) ? 'signatures');
update public.plans p
   set limits = jsonb_build_object('max_signatures_per_month', 0) || coalesce(p.limits, '{}'::jsonb)
 where not (coalesce(p.limits, '{}'::jsonb) ? 'max_signatures_per_month');

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.document_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  kind            text not null default 'other'
                  check (kind in ('contract', 'service_agreement', 'joining_form', 'health_declaration', 'other')),
  record_type     text not null check (record_type in ('lead', 'contact', 'company', 'deal')),
  body            text not null check (char_length(body) between 1 and 20000 and body = btrim(body)),
  is_active       boolean not null default true,
  -- server only: a seeded default whose wording no person changed yet (shown as a draft)
  draft_wording   boolean not null default false,
  -- server only: the seed's marker of a default (its kind code), kept through renames and edits, so a later migration
  -- finds the seeded defaults (as activity_types.key); null on every template a person made
  key             text check (key in ('service_agreement', 'contract', 'joining_form')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists document_templates_name_idx on public.document_templates (organization_id, lower(name));
create unique index if not exists document_templates_key_idx on public.document_templates (organization_id, key)
  where key is not null;
create index if not exists document_templates_org_idx on public.document_templates (organization_id, record_type);

alter table public.document_templates enable row level security;

revoke all on public.document_templates from anon, authenticated;
grant select, delete on public.document_templates to authenticated;
grant insert (organization_id, name, kind, record_type, body, is_active) on public.document_templates to authenticated;
grant update (name, kind, record_type, body, is_active) on public.document_templates to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'document_templates' and policyname = 'document_templates_select') then
    create policy document_templates_select on public.document_templates for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'document_templates' and policyname = 'document_templates_insert') then
    create policy document_templates_insert on public.document_templates for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'document_templates' and policyname = 'document_templates_update') then
    create policy document_templates_update on public.document_templates for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'document_templates' and policyname = 'document_templates_delete') then
    create policy document_templates_delete on public.document_templates for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger document_templates_touch before update on public.document_templates
  for each row execute function app.touch_row();
create or replace trigger document_templates_audit after insert or update or delete on public.document_templates
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- The plan key and the cap (definer: it counts the business's rows)
-- ----------------------------------------------------------------------------
create or replace function app.document_templates_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  -- the defaults' seed names the business it seeds (transaction-local, set only by app.seed_document_templates); its
  -- insert is judged as the server's, whoever's session runs create_organization, and still counts against the cap
  -- (review): the setting alone is not trusted; a seeded row also carries the server-only key, which no client may insert
  v_seed boolean := tg_op = 'INSERT'
    and new.key is not null
    and coalesce(current_setting('app.document_template_seed', true), '') = new.organization_id::text;
begin
  -- RVW-23: an outsider gets RLS's plain 42501 and learns nothing about another business
  if not v_seed and auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- a person needs the key to add, change or switch on a template; the server's seed does not (every business gets the
  -- defaults). Owner (201) ב: without the key, switching a template OFF (is_active true -> false, nothing else changed)
  -- stays allowed, as removing does (the safe side).
  if not v_seed and auth.uid() is not null and not app.org_has_feature(new.organization_id, 'signatures')
     and not (tg_op = 'UPDATE'
              and old.is_active and not new.is_active
              and new.name is not distinct from old.name
              and new.kind is not distinct from old.kind
              and new.record_type is not distinct from old.record_type
              and new.body is not distinct from old.body) then
    raise exception 'document templates are not in the plan' using errcode = 'P0001', hint = 'feature:signatures';
  end if;
  if tg_op = 'INSERT' then
    -- one insert at a time per business, so two cannot both pass the count
    perform pg_advisory_xact_lock(hashtextextended('document_templates:' || new.organization_id::text, 0));
    if (select count(*) from public.document_templates t where t.organization_id = new.organization_id) >= 50 then
      raise exception 'too many document templates' using errcode = 'P0001', hint = 'document_templates:max';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.document_templates_guard() from public, anon, authenticated;

create or replace trigger document_templates_guard before insert or update on public.document_templates
  for each row execute function app.document_templates_guard();

-- ----------------------------------------------------------------------------
-- Merge fields: a closed list per record type
-- ----------------------------------------------------------------------------
-- the business's fields (every record type), then the record's own; the same names in fields.ts
create or replace function app.document_merge_fields(p_record_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם העסק', 'השם הרשום של העסק', 'מספר העוסק', 'כתובת העסק', 'טלפון העסק', 'אימייל העסק', 'שם הנציג',
               'תאריך היום']::text[]
         || case p_record_type
              when 'lead' then array['שם מלא', 'שם פרטי', 'טלפון', 'אימייל', 'שם החברה', 'תפקיד']::text[]
              when 'contact' then array['שם מלא', 'שם פרטי', 'שם משפחה', 'טלפון', 'אימייל', 'תפקיד', 'כתובת', 'תעודת זהות',
                                        'כתובת לחיוב', 'שם החברה', 'תאריך לידה']::text[]
              when 'company' then array['שם החברה', 'מספר החברה', 'כתובת', 'טלפון', 'אימייל', 'שם לחיוב',
                                        'כתובת לחיוב']::text[]
              when 'deal' then array['שם העסקה', 'סכום העסקה', 'תאריך סגירה צפוי', 'שם מלא', 'שם פרטי', 'טלפון', 'אימייל',
                                     'שם החברה']::text[]
              else array[]::text[]
            end
$$;
revoke all on function app.document_merge_fields(text) from public, anon, authenticated;

-- The first {text} (without ":", "|", braces or a line break, 1..30 characters) that is not a merge field of the record
-- type; null when none. Mirrored by unknownDocumentFields() in src/features/document-templates/fields.ts (same pattern).
create or replace function app.document_unknown_field(p_text text, p_record_type text) returns text
language sql immutable
set search_path = ''
as $$
  select m[1]
    from regexp_matches(coalesce(p_text, ''), '\{([^{}:|\n]{1,30})\}', 'g') as m
   where not (m[1] = any (app.document_merge_fields(p_record_type)))
   limit 1
$$;
revoke all on function app.document_unknown_field(text, text) from public, anon, authenticated;

-- security invoker: pure checks of the row's own text, the same for every writer
create or replace function app.document_templates_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_problem text;
begin
  if tg_op = 'UPDATE' then
    if new.body is not distinct from old.body and new.record_type is not distinct from old.record_type then
      return new;
    end if;
    -- a changed wording is the business's own, no longer the seeded draft
    if new.body is distinct from old.body then
      new.draft_wording := false;
    end if;
  end if;
  -- longer than the column allows: its check constraint refuses it, without walking it
  if char_length(new.body) > 20000 then
    return new;
  end if;
  v_problem := app.template_variant_problem(new.body);
  if v_problem = 'neutral' then
    raise exception 'a gender wording needs its neutral part' using errcode = 'P0001', hint = 'document_template:neutral';
  elsif v_problem is not null then
    raise exception 'a gender wording is malformed' using errcode = 'P0001', hint = 'document_template:variant';
  end if;
  if app.document_unknown_field(new.body, new.record_type) is not null then
    raise exception 'unknown merge field' using errcode = 'P0001', hint = 'document_template:field';
  end if;
  return new;
end;
$$;
revoke all on function app.document_templates_check() from public, anon, authenticated;
-- the trigger runs as the writer (a person), who must be able to call the pure checks
grant execute on function app.document_merge_fields(text) to authenticated;
grant execute on function app.document_unknown_field(text, text) to authenticated;
grant execute on function app.template_variant_problem(text) to authenticated;

create or replace trigger document_templates_check before insert or update of body, record_type on public.document_templates
  for each row execute function app.document_templates_check();

-- ----------------------------------------------------------------------------
-- Default templates: a business starts with these and renames, changes or deletes them
-- ----------------------------------------------------------------------------
-- DRAFT wording (draft_wording = true) until the lawyer approves it; mirrored by DEFAULT_DOCUMENT_TEMPLATES in
-- src/features/document-templates/templates.ts (unit test). Owner (202) ב: no health declaration is seeded until PRV-05
-- (sensitive data); a business may still write one of kind health_declaration itself.
create or replace function app.seed_document_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform set_config('app.document_template_seed', p_org::text, true);
  insert into public.document_templates (organization_id, name, kind, record_type, body, draft_wording, key)
  select p_org, d.name, d.kind, d.record_type, d.body, true, d.kind
    from (values
      (1, 'הסכם שירות', 'service_agreement', 'contact',
          '**הסכם שירות**' || chr(10) || chr(10)
          || 'נערך ביום {תאריך היום} בין {השם הרשום של העסק}, מספר עוסק {מספר העוסק}, {כתובת העסק} (להלן: "העסק")' || chr(10)
          || 'לבין {שם מלא}, תעודת זהות {תעודת זהות}, {כתובת} (להלן: "הלקוח").' || chr(10) || chr(10)
          || '1. העסק יספק ללקוח את השירות שסוכם ביניהם.' || chr(10)
          || '2. הלקוח ישלם את התמורה שסוכמה, במועדים שסוכמו.' || chr(10)
          || '3. כל צד רשאי לסיים את ההסכם בהודעה מראש של 30 ימים.' || chr(10) || chr(10)
          || 'לשאלות: {טלפון העסק}, {אימייל העסק}.'),
      (2, 'חוזה', 'contract', 'deal',
          '**חוזה**' || chr(10) || chr(10)
          || 'נערך ביום {תאריך היום} בין {השם הרשום של העסק}, מספר עוסק {מספר העוסק} (להלן: "העסק")' || chr(10)
          || 'לבין {שם מלא}, {שם החברה} (להלן: "הלקוח").' || chr(10) || chr(10)
          || '1. נושא החוזה: {שם העסקה}.' || chr(10)
          || '2. התמורה: {סכום העסקה}.' || chr(10)
          || '3. מועד משוער לסיום: {תאריך סגירה צפוי}.' || chr(10) || chr(10)
          || 'איש הקשר מטעם העסק: {שם הנציג}, {טלפון העסק}.'),
      (3, 'טופס הצטרפות', 'joining_form', 'contact',
          '**טופס הצטרפות ל{שם העסק}**' || chr(10) || chr(10)
          || '- שם מלא: {שם מלא}' || chr(10)
          || '- תעודת זהות: {תעודת זהות}' || chr(10)
          || '- טלפון: {טלפון}' || chr(10)
          || '- אימייל: {אימייל}' || chr(10)
          || '- כתובת: {כתובת}' || chr(10)
          || '- תאריך לידה: {תאריך לידה}' || chr(10) || chr(10)
          || 'אני מאשר/ת שהפרטים נכונים. תאריך: {תאריך היום}')
    ) as d(n, name, kind, record_type, body)
   where not exists (select 1 from public.document_templates t where t.organization_id = p_org)
   order by d.n;
  perform set_config('app.document_template_seed', '', true);
end;
$$;
revoke all on function app.seed_document_templates(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_document_templates() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_document_templates(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_document_templates() from public, anon, authenticated;

create or replace trigger organizations_seed_document_templates after insert on public.organizations
  for each row execute function app.organizations_seed_document_templates();

-- existing businesses whose list is empty: once each, insert only; a deleted business is skipped; one that fails is skipped
-- with a warning naming the error
do $$
declare
  v_org uuid;
begin
  for v_org in
    select o.id from public.organizations o
     where o.deleted_at is null
       and not exists (select 1 from public.document_templates t where t.organization_id = o.id)
     order by o.id
  loop
    begin
      perform app.seed_document_templates(v_org);
    exception when others then
      raise warning 'document templates were not seeded for business %: % %', v_org, sqlstate, sqlerrm;
    end;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
