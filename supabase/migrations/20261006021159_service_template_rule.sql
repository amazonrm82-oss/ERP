-- =============================================================================
-- MSG-02 follow-up: what a SERVICE message template may hold (owner's answer (90) ג, 3 November 2026)
-- =============================================================================
-- "A service template is limited to the merge fields of its type, with no external links (system links only), with a
-- length cap, and is checked before every send; a template that does not pass is not sent and the business sees why;
-- changing a template's type is recorded in the audit."
--
-- * THE rule is app.message_template_problem(channel, message_type, subject, body): null, or one closed code:
--     field_not_allowed  a {field} that is not one of the type's merge fields (app.message_type_fields(type))
--     external_link      "http://", "https://" or "www." anywhere in the subject or the body (ignoring case); the system's
--                        own links come only through merge fields ({קישור להצעה}), filled by the sender
--     too_long           the body is longer than the channel's cap for a service message (app.message_service_body_max):
--                        SMS 300, WhatsApp 1000, email 2000 characters, counted on the template as written (before the
--                        fields are filled and before a gender block is picked)
--   judged in that order; a marketing template (any type outside app.service_message_types()) is never judged here
--   (marketing has its own conditions: consent, the envelope of envelope.ts).
--   Mirrored by messageTemplateProblem() in src/features/message-templates/service-rule.ts; both run
--   tests/unit/fixtures/message-template-problems.json (unit test and test 291).
-- * It does NOT refuse saving (the owner: "checked before every send"): the settings page shows the problem on the
--   template, and the editor warns on save.
-- * EVERY future sender of a template (AUT-08, the quote screen, the collection and meeting reminder senders, the OPS-04
--   message.send path) MUST ask app.message_template_sendable(org, template) (or, in TS, assertTemplateSendable()) right
--   before it sends, and must not send while it answers a code. Nothing sends from a template yet.
--   app.message_template_sendable answers not_found | inactive | the rule's codes, or null.
-- * The type change is audited by app.audit_row already (message_templates_audit, every column): test 291 checks it.
-- * Merge fields: {קוד אימות} joins the closed list (app.message_merge_fields(), redefined here with it at the end),
--   for the verification code template.
-- Every statement is safe to run twice.

create or replace function app.message_merge_fields() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'תאריך', 'שעה', 'מסמך', 'סכום', 'מועד תשלום', 'קישור להצעה',
               'טלפון העסק', 'כתובת העסק', 'תוקף', 'תוכן העדכון', 'קישור הסרה', 'קוד אימות']::text[]
$$;
revoke all on function app.message_merge_fields() from public, anon, authenticated;
-- the table's check trigger runs as the writer (a person)
grant execute on function app.message_merge_fields() to authenticated;

-- The merge fields a service type may hold; null for a type that is not a service type. Mirrors SERVICE_TYPE_FIELDS.
create or replace function app.message_type_fields(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'meeting_reminder' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'תאריך', 'שעה']::text[]
    when 'requested_document' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'מסמך', 'קישור להצעה', 'תוקף']::text[]
    when 'collection' then array['שם פרטי', 'שם מלא', 'שם הנציג', 'שם העסק', 'טלפון העסק', 'כתובת העסק', 'מסמך', 'סכום', 'מועד תשלום']::text[]
    when 'verification_code' then array['שם העסק', 'קוד אימות']::text[]
  end
$$;
revoke all on function app.message_type_fields(text) from public, anon, authenticated;

-- A service message's body cap by channel (characters). Mirrors SERVICE_BODY_MAX.
create or replace function app.message_service_body_max(p_channel text) returns integer
language sql immutable
set search_path = ''
as $$
  select case p_channel when 'sms' then 300 when 'whatsapp' then 1000 when 'email' then 2000 end
$$;
revoke all on function app.message_service_body_max(text) from public, anon, authenticated;

create or replace function app.message_template_problem(p_channel text, p_message_type text, p_subject text, p_body text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_fields text[];
  v_text text := coalesce(p_subject, '') || chr(10) || coalesce(p_body, '');
begin
  if not (coalesce(p_message_type, '') = any (app.service_message_types())) then
    return null;
  end if;
  v_fields := coalesce(app.message_type_fields(p_message_type), '{}'::text[]);
  -- the same field pattern as app.message_unknown_field / MERGE_FIELD_PATTERN (a gender block always holds ":")
  if exists (select 1
               from regexp_matches(v_text, '\{([^{}:|\n]{1,30})\}', 'g') as m
              where not (m[1] = any (v_fields))) then
    return 'field_not_allowed';
  end if;
  if v_text ~* '(https?://|www\.)' then
    return 'external_link';
  end if;
  if char_length(coalesce(p_body, '')) > coalesce(app.message_service_body_max(p_channel), 0) then
    return 'too_long';
  end if;
  return null;
end;
$$;
revoke all on function app.message_template_problem(text, text, text, text) from public, anon, authenticated;

-- What a sender asks right before it sends one template of a business: null = may send; else a code (not_found,
-- inactive, or the rule's). Definer, no grants: for the server's senders only (definer functions and service_role jobs
-- call it through their own definer code).
create or replace function app.message_template_sendable(p_org uuid, p_template uuid) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row public.message_templates;
begin
  select * into v_row from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    return 'not_found';
  end if;
  if not v_row.is_active then
    return 'inactive';
  end if;
  return app.message_template_problem(v_row.channel, v_row.message_type, v_row.subject, v_row.body);
end;
$$;
revoke all on function app.message_template_sendable(uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
