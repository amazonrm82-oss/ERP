-- RVW-89 (weekly review of 13 November 2026, docs/reviews/2026-11-13.md): a message the SMS composer refuses for something
-- the business set up wrong reached nobody. A marketing SMS (review_request too, owner (321)) carries the sender line
-- "{שם העסק} · {טלפון העסק} · {כתובת העסק}" (app.sms_marketing_envelope); a business with no address (document settings'
-- address line and city) or no phone (document settings' phone, else the business phone) is refused 'unfilled_field' on
-- every such message (owner (322) א, correct in itself), the worker ends the job with no provider and that code, and only
-- 'too_long' told the owners. Every function keeps its signature, grants and settings; each body is its latest one with
-- only the lines named here.
--
-- * app.message_send_refusal_text(reason) (021233's body): four more reasons, the business's own setup:
--   'unfilled_field', 'feature_off', 'link_blocked', 'link_invalid'. A consent refusal (consent_missing, consent_suppressed,
--   consent_blocked, consent_unknown) is about one customer, not the business's setup, and tells no one (as before).
-- * app.message_send_refused(org, template, reason) (021160's body): the notice's last sentence says where to fix it for
--   those four reasons (the document settings for a missing field, the plan or the type's settings for a switched-off
--   feature, support for the platform's outside-link switch, the review request settings for an invalid link); every
--   other reason keeps its sentence. Still once per business, template and reason a business day; never raises.
-- * app.jobs_record_message() (021220's body, pinned by md5 in test 284): the refusal notice is written for a job that ends
--   failed with NO provider and one of 'too_long', 'unfilled_field', 'feature_off', 'link_blocked', 'link_invalid' (was:
--   'too_long' only). Every other line unchanged; the notice stays in its own exception block (the finish never fails).
-- The timeline's Hebrew line for every composer refusal code is in the app (src/features/messaging/timeline-entry.ts).

create or replace function app.message_send_refusal_text(p_reason text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_reason
    when 'too_long' then 'ארוכה מדי: אחרי מילוי השדות היא עוברת את מספר התווים המותר בערוץ הזה'
    when 'field_not_allowed' then 'יש בתבנית שדה שלא מתאים לסוג ההודעה'
    when 'glued_address' then 'יש בתבנית כתובת צמודה לטקסט'
    when 'external_link' then 'יש בתבנית קישור חיצוני'
    -- SPD-04 (282) ב
    when 'offer' then 'יש בתבנית מחיר, הנחה או מילה שיווקית'
    when 'inactive' then 'התבנית כבויה'
    -- RVW-89: the business's own setup
    when 'unfilled_field' then 'שדה בהודעה לא התמלא (למשל כתובת העסק או הטלפון חסרים בהגדרות המסמכים, או פרט חסר אצל הלקוח)'
    when 'feature_off' then 'סוג ההודעה כבוי בהגדרות או לא כלול בחבילה'
    when 'link_blocked' then 'הקישורים החיצוניים של העסק כובו על ידי צוות המערכת'
    when 'link_invalid' then 'הקישור לביקורת לא תקין'
  end;
$$;
revoke all on function app.message_send_refusal_text(text) from public, anon, authenticated;

-- 021160's body plus the last sentence by reason (RVW-89)
create or replace function app.message_send_refused(p_org uuid, p_template uuid, p_reason text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text;
  v_reason text := app.message_send_refusal_text(p_reason);
  v_today date;
  v_body text;
  v_fix text;
  v_count integer := 0;
begin
  if v_reason is null or p_org is null then
    return 0;
  end if;
  select (now() at time zone app.intake_zone(o.timezone))::date into v_today from public.organizations o where o.id = p_org;
  if not found then
    return 0;
  end if;
  insert into app.message_refusal_notices as r (organization_id, template_key, reason, notified_on)
  values (p_org, coalesce(p_template, '00000000-0000-0000-0000-000000000000'::uuid), p_reason, v_today)
  on conflict (organization_id, template_key, reason)
    do update set notified_on = excluded.notified_on where r.notified_on < excluded.notified_on;
  if not found then
    -- told already today
    return 0;
  end if;
  if p_template is not null then
    select t.name into v_name from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  end if;
  -- RVW-89: where the business fixes it
  v_fix := case p_reason
             when 'unfilled_field' then 'אפשר להשלים את כתובת העסק והטלפון בהגדרות, במע"מ ופרטים למסמכים, ולבדוק את השדות בתבנית ואצל הלקוח.'
             when 'feature_off' then 'אפשר לבדוק את ההגדרות של סוג ההודעה ואת החבילה.'
             when 'link_blocked' then 'לפרטים פנו לתמיכה.'
             when 'link_invalid' then 'אפשר לתקן את הקישור בהגדרות, בבקשת ביקורת.'
           end;
  v_body := case when v_name is not null
                 then format('ההודעה מהתבנית "%s" לא נשלחה. %s. %s', v_name, v_reason,
                             coalesce(v_fix, 'אפשר לתקן את התבנית בהגדרות, בתבניות הודעה.'))
                 else format('הודעה ללקוח לא נשלחה. %s. %s', v_reason,
                             coalesce(v_fix, 'אפשר לבדוק את התבניות בהגדרות, בתבניות הודעה.')) end;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select m.organization_id, m.user_id, 'system', 'הודעה ללקוח לא נשלחה', v_body, 'message_template',
         case when v_name is not null then p_template end
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  raise warning 'message_send_refused: % (template %)', sqlstate, p_template;
  return 0;
end;
$$;
revoke all on function app.message_send_refused(uuid, uuid, text) from public, anon, authenticated;

-- 021220's body; RVW-89 widens the refusal notice from 'too_long' to the business's own setup (pinned by test 284)
create or replace function app.jobs_record_message() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead uuid;
  v_contact uuid;
  v_status text := new.message_outcome;
  v_provider_id text := new.provider_message_id;
begin
  if new.kind <> 'message.send' or v_status is null then
    return null;
  end if;
  -- RVW-80: a sender-verification code (SMS-01b) goes to the business's own phone, never to a lead or a contact: there is
  -- no timeline to show it on (it named no record, so recording it would only fail the one-record check and warn)
  if new.payload ? 'sender_check_id' then
    return null;
  end if;
  -- MSG-02 (103): a message refused for its filled length tells the owners and admins (once per template a day); never
  -- fails the finish. RVW-89: so does a refusal the business can fix (a field left unfilled, a feature switched off, the
  -- outside-link switch, an invalid review link); a consent refusal is about one customer and tells no one
  if v_status = 'failed' and new.provider is null
     and new.provider_error_code in ('too_long', 'unfilled_field', 'feature_off', 'link_blocked', 'link_invalid') then
    begin
      perform app.message_send_refused(new.organization_id,
                                       case when new.payload ? 'template_id' then (new.payload ->> 'template_id')::uuid end,
                                       new.provider_error_code);
    exception when others then
      raise warning 'jobs_record_message: the refusal notice of job % was not written (%)', new.id, sqlstate;
    end;
  end if;
  if new.payload ? 'lead_id' then
    v_lead := (new.payload ->> 'lead_id')::uuid;
  else
    v_contact := (new.payload ->> 'contact_id')::uuid;
  end if;
  for v_try in 1..2 loop
    begin
      insert into public.messages (organization_id, lead_id, contact_id, channel, direction, status, provider,
                                   provider_message_id, provider_error_code, job_id, occurred_at, sent_at)
      values (new.organization_id, v_lead, v_contact, new.payload ->> 'channel', 'outbound', v_status, new.provider,
              v_provider_id, new.provider_error_code, new.id, now(), case when v_status = 'sent' then now() end)
      on conflict (job_id) do update
        set status = excluded.status, provider = excluded.provider, provider_message_id = excluded.provider_message_id,
            provider_error_code = excluded.provider_error_code, occurred_at = excluded.occurred_at, sent_at = excluded.sent_at;
      return null;
    exception
      -- the lead or contact was purged since the send check: there is no timeline to show it on
      when foreign_key_violation then
        return null;
      -- another message of this business already holds the provider's id: kept without it
      when unique_violation then
        if v_provider_id is null then
          return null;
        end if;
        v_provider_id := null;
      -- recording never fails the finish (a refused finish would send the message again): one warning, the job id only
      when others then
        raise warning 'jobs_record_message: the message of job % was not recorded (%)', new.id, sqlstate;
        return null;
    end;
  end loop;
  return null;
end;
$$;
revoke all on function app.jobs_record_message() from public, anon, authenticated, service_role;
