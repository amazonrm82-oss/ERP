-- =============================================================================
-- MSG-02: shared message templates (email, SMS, WhatsApp)
-- =============================================================================
-- Owner 3 November 2026, answers (68) א and (73) א (DECISIONS.md):
-- * Every plan, no plan key, at most 50 per business (hint message_templates:max).
-- * A template's type is one of the CLOSED list of message types (app.message_types(), migration message_types):
--   the service types (app.service_message_types(): meeting_reminder, requested_document, collection, verification_code)
--   or marketing. Never a free service/marketing switch a business sets.
-- * public.message_templates is a managed list (owner's rule of 12 October 2026): every member reads; owners and admins of
--   a writable business write; audited. name 1..80 (unique per business, ignoring case), channel email|sms|whatsapp,
--   subject for email only (1..150), body 1..2000 (SMS length is only a warning in the app), locale from the CON-10 list,
--   is_active.
-- * Merge fields: a closed list, app.message_merge_fields() = MESSAGE_MERGE_FIELDS in src/features/message-templates/fields.ts
--   (a unit test reads this file). Any {text} without ":" or "|" in the subject or the body must be one of them
--   (hint message_template:field); the HEB-01 gender block rule (app.template_variant_problem) holds for both
--   (hints message_template:variant | message_template:neutral).
-- * Defaults: app.seed_message_templates(org) inserts them while the business has no message template at all; it runs from
--   the after insert trigger organizations_seed_message_templates and once for every business whose list is empty now
--   (insert only, one business per exception block). The texts mirror DEFAULT_MESSAGE_TEMPLATES (unit test).
-- * Nothing sends yet: no job is enqueued from a template (AUT-08 and the sending modules will). WA-01's
--   whatsapp_templates stay as they are (the record button's wa.me texts).
-- Every statement is safe to run twice.

create table if not exists public.message_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- name and subject: no control characters (a future email adapter puts the subject in a header; review finding 3)
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  channel         text not null check (channel in ('email', 'sms', 'whatsapp')),
  message_type    text not null
                  check (message_type in ('meeting_reminder', 'requested_document', 'collection', 'verification_code', 'marketing')),
  subject         text check (subject is null or (char_length(subject) between 1 and 150 and subject = btrim(subject) and subject !~ '[[:cntrl:]]')),
  body            text not null check (char_length(body) between 1 and 2000 and body = btrim(body)),
  locale          text not null default 'he' check (locale in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  -- an email has a subject; an SMS or a WhatsApp message has none
  constraint message_templates_subject_shape check ((channel = 'email') = (subject is not null))
);

create unique index if not exists message_templates_name_idx on public.message_templates (organization_id, lower(name));
create index if not exists message_templates_org_idx on public.message_templates (organization_id, channel, message_type);

alter table public.message_templates enable row level security;

revoke all on public.message_templates from anon, authenticated;
grant select, delete on public.message_templates to authenticated;
grant insert (organization_id, name, channel, message_type, subject, body, locale, is_active) on public.message_templates to authenticated;
grant update (name, channel, message_type, subject, body, locale, is_active) on public.message_templates to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'message_templates' and policyname = 'message_templates_select') then
    create policy message_templates_select on public.message_templates for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'message_templates' and policyname = 'message_templates_insert') then
    create policy message_templates_insert on public.message_templates for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'message_templates' and policyname = 'message_templates_update') then
    create policy message_templates_update on public.message_templates for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'message_templates' and policyname = 'message_templates_delete') then
    create policy message_templates_delete on public.message_templates for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger message_templates_touch before update on public.message_templates
  for each row execute function app.touch_row();
create or replace trigger message_templates_audit after insert or update or delete on public.message_templates
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- At most 50 templates per business
-- ----------------------------------------------------------------------------
create or replace function app.message_templates_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- RVW-23: an outsider gets RLS's plain 42501 and learns nothing about another business
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- one insert at a time per business, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('message_templates:' || new.organization_id::text, 0));
  if (select count(*) from public.message_templates t where t.organization_id = new.organization_id) >= 50 then
    raise exception 'too many message templates' using errcode = 'P0001', hint = 'message_templates:max';
  end if;
  return new;
end;
$$;
revoke all on function app.message_templates_cap() from public, anon, authenticated;

create or replace trigger message_templates_cap before insert on public.message_templates
  for each row execute function app.message_templates_cap();

-- ----------------------------------------------------------------------------
-- Merge fields: a closed list
-- ----------------------------------------------------------------------------
create or replace function app.message_merge_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'תאריך', 'שעה', 'מסמך', 'סכום', 'מועד תשלום', 'קישור להצעה',
               'טלפון העסק', 'כתובת העסק', 'תוקף', 'תוכן העדכון', 'קישור הסרה']::text[]
$$;
revoke all on function app.message_merge_fields() from public, anon, authenticated;

-- The first {text} (without ":", "|", braces or a line break, 1..30 characters) that is not a merge field; null when none.
-- Mirrored by unknownMergeFields() in src/features/message-templates/fields.ts (same pattern).
create or replace function app.message_unknown_field(p_text text) returns text
language sql immutable
set search_path = ''
as $$
  select m[1]
    from regexp_matches(coalesce(p_text, ''), '\{([^{}:|\n]{1,30})\}', 'g') as m
   where not (m[1] = any (app.message_merge_fields()))
   limit 1
$$;
revoke all on function app.message_unknown_field(text) from public, anon, authenticated;

-- security invoker: pure checks of the row's own text, the same for every writer
create or replace function app.message_templates_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_text text;
  v_problem text;
begin
  if tg_op = 'UPDATE' and new.body is not distinct from old.body and new.subject is not distinct from old.subject then
    return new;
  end if;
  foreach v_text in array array[new.subject, new.body] loop
    -- null, or longer than the columns allow: their check constraints refuse it, without walking it
    continue when v_text is null or char_length(v_text) > 2000;
    v_problem := app.template_variant_problem(v_text);
    if v_problem = 'neutral' then
      raise exception 'a gender wording needs its neutral part' using errcode = 'P0001', hint = 'message_template:neutral';
    elsif v_problem is not null then
      raise exception 'a gender wording is malformed' using errcode = 'P0001', hint = 'message_template:variant';
    end if;
    if app.message_unknown_field(v_text) is not null then
      raise exception 'unknown merge field' using errcode = 'P0001', hint = 'message_template:field';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function app.message_templates_check() from public, anon, authenticated;
-- the trigger runs as the writer (a person), who must be able to call the pure checks
grant execute on function app.message_merge_fields() to authenticated;
grant execute on function app.message_unknown_field(text) to authenticated;
grant execute on function app.template_variant_problem(text) to authenticated;

create or replace trigger message_templates_check before insert or update of subject, body on public.message_templates
  for each row execute function app.message_templates_check();

-- ----------------------------------------------------------------------------
-- Default templates: a business starts with these and renames, changes or deletes them
-- ----------------------------------------------------------------------------
-- Owner 3 November 2026, answer (88). The wording is a DRAFT until the lawyer approves it.
-- * The quote email has no "reply to this email" line: there is no email provider or reply-to setting yet. The line
--   "אם יש שאלות, אפשר לענות למייל הזה." may be added once an email reply-to equal to the business's email exists.
-- * The marketing update holds only its greeting and content: "פרסומת" in front of the subject, the sender line and the
--   unsubscribe line are added by the system to every marketing message (marketingEnvelope() in
--   src/features/message-templates/envelope.ts), so a business cannot remove them from a template.
create or replace function app.seed_message_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.message_templates (organization_id, name, channel, message_type, subject, body)
  select p_org, d.name, d.channel, d.message_type, d.subject, d.body
    from (values
      (1, 'תזכורת לפגישה', 'sms', 'meeting_reminder', null::text,
          'שלום {שם פרטי}, תזכורת לפגישה ב-{תאריך} בשעה {שעה}. לשינוי או ביטול: {טלפון העסק}. {שם העסק}'),
      (2, 'הצעת מחיר', 'email', 'requested_document', 'הצעת המחיר מ{שם העסק}',
          'שלום {שם פרטי},' || chr(10) || chr(10) || 'הצעת המחיר מחכה כאן: {קישור להצעה}' || chr(10)
          || 'ההצעה בתוקף עד {תוקף}.' || chr(10) || chr(10) || '{שם הנציג}, {שם העסק}'),
      (3, 'תזכורת לתשלום', 'sms', 'collection', null::text,
          'שלום {שם פרטי}, תזכורת: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה. {שם העסק}'),
      (4, 'עדכון ללקוחות', 'email', 'marketing', 'פרסומת: חדש ב{שם העסק}',
          'שלום {שם פרטי}, {תוכן העדכון}')
    ) as d(n, name, channel, message_type, subject, body)
   where not exists (select 1 from public.message_templates t where t.organization_id = p_org)
   order by d.n;
end;
$$;
revoke all on function app.seed_message_templates(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_message_templates() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_message_templates(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_message_templates() from public, anon, authenticated;

create or replace trigger organizations_seed_message_templates after insert on public.organizations
  for each row execute function app.organizations_seed_message_templates();

-- existing businesses whose list is empty: once each, insert only; a deleted business is skipped; one that fails is skipped
-- with a warning naming the error
do $$
declare
  v_org uuid;
begin
  for v_org in
    select o.id from public.organizations o
     where o.deleted_at is null
       and not exists (select 1 from public.message_templates t where t.organization_id = o.id)
     order by o.id
  loop
    begin
      perform app.seed_message_templates(v_org);
    exception when others then
      raise warning 'message templates were not seeded for business %: % %', v_org, sqlstate, sqlerrm;
    end;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
