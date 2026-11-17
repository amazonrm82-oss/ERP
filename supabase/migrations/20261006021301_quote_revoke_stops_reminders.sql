-- =============================================================================
-- Owner (400) א, 17 November 2026 (RVW-107, QUO-18): "ביטול כל הקישורים" also stops the quote's automatic reminders
-- =============================================================================
-- public.quote_link_revoke ended every live link, but the next QUO-18 reminder minted a new live link and sent it to the
-- customer. Now the revoke is recorded on the quote's row, app.quote_links.reminders_stopped_at (server only, schema app,
-- no grants), and:
-- * app.send_quote_reminders (021284's body): no reminder is queued for a quote while it is stopped;
-- * app.quote_message_refusal (021284's body): a reminder job queued before the revoke is refused at compose time,
--   'reminders_stopped' (a person's send is never judged by it);
-- * public.quote_link_revoke (021285's body): stamps reminders_stopped_at = now() (making the row when the quote never had
--   a link), under the same row lock, and writes one audit entry `quote_link` every time: {link: revoked,
--   reminders_stopped: true} when it ended live links, else {reminders_stopped: true};
-- * the stop ends when a person sends the quote again from the screen (app.quote_message_enqueue, 021283's body, after the
--   job is queued) or makes a new link from the screen (public.quote_link_create, 021285's body): the stamp is cleared.
-- A reminder stage whose job was refused this way counts as tried (app.quote_reminders keeps 'queued'), as any refused
-- reminder. Safe to run twice (add column if not exists, create or replace, the same grants). No drop, no delete.

alter table app.quote_links add column if not exists reminders_stopped_at timestamptz;

-- public.quote_link_revoke(uuid, uuid): 021285's body plus the stop
create or replace function public.quote_link_revoke(p_org uuid, p_quote uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer;
begin
  perform app.quote_link_quote(p_org, p_quote);
  -- delta review 1: the quote's row first, the lock order of app.quote_link_token_issue, so a revoke racing an issue never
  -- leaves a live link behind a row that says none (and the two never deadlock)
  perform 1 from app.quote_links l where l.organization_id = p_org and l.quote_id = p_quote for update;
  -- owner (400) א: the revoke also stops the quote's automatic reminders (QUO-18) until a person sends the quote again
  -- (public.quote_message_send) or makes a new link from the screen (public.quote_link_create)
  insert into app.quote_links as l (quote_id, organization_id, reminders_stopped_at)
  values (p_quote, p_org, now())
  on conflict (quote_id) do update set reminders_stopped_at = now();
  -- owner (385) ב: the screen's "revoke" ends every live link of the quote
  update app.quote_link_tokens t set revoked_at = now()
   where t.organization_id = p_org and t.quote_id = p_quote and t.revoked_at is null;
  update app.quote_links l
     set token_hash = null, created_at = null, window_started_at = null, window_count = 0
   where l.organization_id = p_org and l.quote_id = p_quote and l.token_hash is not null;
  get diagnostics v_count = row_count;
  -- review: the stop is always in the log, also when no link was live (the entry then carries only the marker)
  if v_count > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'quote_link', 'quotes', p_quote, jsonb_build_object('link', 'revoked', 'reminders_stopped', true));
  else
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'quote_link', 'quotes', p_quote, jsonb_build_object('reminders_stopped', true));
  end if;
  return v_count > 0;
end;
$function$;


-- public.quote_link_create(uuid, uuid): 021285's body plus the resume
create or replace function public.quote_link_create(p_org uuid, p_quote uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote public.quotes;
  v_token text;
begin
  v_quote := app.quote_link_quote(p_org, p_quote);
  if v_quote.status = 'draft' then
    raise exception 'only a sent quote has a link' using errcode = 'P0001', hint = 'quote:not_sent';
  end if;
  if not app.quote_link_open(v_quote) then
    raise exception 'the quote is no longer open' using errcode = 'P0001', hint = 'quote:closed';
  end if;

  -- owner (385) ב: one more live link; the earlier ones keep working (at most 10 live, the oldest revoked)
  v_token := app.quote_link_token_issue(p_org, p_quote, auth.uid(), 'screen', null);
  -- owner (400) א: a new link from the screen resumes the automatic reminders a revoke stopped
  update app.quote_links l set reminders_stopped_at = null
   where l.organization_id = p_org and l.quote_id = p_quote and l.reminders_stopped_at is not null;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'quote_link', 'quotes', p_quote, jsonb_build_object('link', 'created'));
  return v_token;
end;
$function$;


-- app.quote_message_enqueue: 021283's body plus the resume
create or replace function app.quote_message_enqueue(p_org uuid, p_quote uuid, p_channel text, p_template uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_quote public.quotes;
  v_contact uuid;
  v_c_owner uuid;
  v_c_team uuid;
  v_email text;
  v_phone text;
  v_tpl public.message_templates%rowtype;
  v_problem text;
  v_missing text[];
  v_found integer;
  v_payload jsonb;
  v_job uuid;
begin
  if v_user is null or p_org is null or p_quote is null or p_template is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('email', 'sms') then
    raise exception 'unknown channel' using errcode = 'P0001', hint = 'quote_message:channel';
  end if;
  -- a member who may write (never a viewer or a support session) in a writable business
  if not app.can_write(p_org) then
    raise exception 'not permitted' using errcode = '42501', hint = 'quote_message:not_permitted';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found then
    raise exception 'quote not found' using errcode = 'P0001', hint = 'quote_message:not_found';
  end if;
  -- the rule of the quote's link (QUO-08): whoever may edit its deal, else its contact
  if not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501', hint = 'quote_message:not_permitted';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if p_channel = 'sms' and not app.org_has_feature(p_org, 'sms') then
    raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:sms';
  end if;
  if v_quote.status = 'draft' then
    raise exception 'only a sent quote is sent to the customer' using errcode = 'P0001', hint = 'quote:not_sent';
  end if;
  if not app.quote_offer_open(v_quote) then
    raise exception 'the quote is no longer open' using errcode = 'P0001', hint = 'quote:closed';
  end if;
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    raise exception 'a newer version was sent' using errcode = 'P0001', hint = 'quote:superseded';
  end if;
  if not app.quote_link_usable(v_quote) then
    raise exception 'the customer link cannot open now' using errcode = 'P0001', hint = 'quote_message:link_closed';
  end if;

  -- the customer on the quote, live and readable by the sender
  v_contact := app.quote_message_customer(v_quote);
  if v_contact is not null then
    select c.owner_id, c.team_id, c.email, c.phone_e164 into v_c_owner, v_c_team, v_email, v_phone
      from public.contacts c where c.organization_id = p_org and c.id = v_contact;
  end if;
  if v_contact is null or not app.record_email_readable(p_org, 'contact', v_contact, v_c_owner, v_c_team) then
    raise exception 'the quote has no customer to send to' using errcode = 'P0001', hint = 'quote_message:no_contact';
  end if;
  if p_channel = 'email' and (v_email is null or btrim(v_email) !~ '^[^@[:space:]]+@[^@[:space:]]+$') then
    raise exception 'the customer has no email' using errcode = 'P0001', hint = 'record_email:no_address';
  end if;
  if p_channel = 'sms' and nullif(btrim(coalesce(v_phone, '')), '') is null then
    raise exception 'the customer has no phone' using errcode = 'P0001', hint = 'record_sms:no_phone';
  end if;

  -- the template: a requested_document of the channel, not one the system sends itself, sendable now
  select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    raise exception 'template not found' using errcode = 'P0001', hint = 'quote_message:template';
  end if;
  if v_tpl.channel <> p_channel then
    raise exception 'not a template of this channel' using errcode = 'P0001', hint = 'quote_message:channel';
  end if;
  if v_tpl.notice_kind is not null then
    raise exception 'the system sends this template itself' using errcode = 'P0001', hint = 'record_message:notice_template';
  end if;
  if v_tpl.message_type is distinct from 'requested_document' then
    raise exception 'a quote is sent as a requested document' using errcode = 'P0001', hint = 'quote_message:type';
  end if;
  v_problem := app.message_template_sendable(p_org, p_template);
  if v_problem is not null then
    raise exception 'the template cannot be sent' using errcode = 'P0001', hint = 'record_email:not_sendable', detail = v_problem;
  end if;
  v_missing := app.quote_unfillable_fields(v_tpl.message_type, v_tpl.subject, v_tpl.body);
  if cardinality(v_missing) > 0 then
    raise exception 'the template holds a field a quote send cannot fill' using errcode = 'P0001',
      hint = 'record_message:unfillable_field', detail = array_to_string(v_missing, ', ');
  end if;
  -- an optional part ("{ בתוקף עד {תוקף}}") disappears without a value (app.sms_fill's first pass), so only a bare {תוקף} counts
  if v_quote.valid_until is null
     and strpos(regexp_replace(coalesce(v_tpl.subject, '') || chr(10) || coalesce(v_tpl.body, ''),
                               '\{[^{}:|\n]{0,20}\{[^{}:|\n]{1,30}\}[^{}:|\n]{0,20}\}', '', 'g'), '{תוקף}') > 0 then
    raise exception 'the quote has no validity date' using errcode = 'P0001', hint = 'quote_message:no_validity';
  end if;

  -- the card's cap: 30 a person an hour across every business, counted under a lock of the person
  if p_channel = 'email' then
    perform pg_advisory_xact_lock(hashtextextended('record_email:' || v_user::text, 0));
    v_found := app.automation_email_sent_last_hour(v_user);
    if v_found >= app.record_email_hourly_limit() then
      raise exception 'too many emails this hour' using errcode = 'P0001', hint = 'record_email:rate';
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('record_sms:' || v_user::text, 0));
    v_found := app.record_sms_sent_last_hour(v_user);
    if v_found >= app.record_sms_hourly_limit() then
      raise exception 'too many SMS this hour' using errcode = 'P0001', hint = 'record_sms:rate';
    end if;
  end if;

  v_payload := jsonb_build_object('channel', p_channel, 'message_type', 'requested_document', 'template_id', v_tpl.id,
                                  'quote_id', v_quote.id, 'contact_id', v_contact)
               || case when p_channel = 'email' then jsonb_build_object('reply_to_user_id', v_user)
                       else jsonb_build_object('sent_by_user_id', v_user) end;
  v_job := app.enqueue_job(p_org, 'message.send', v_payload, null);
  -- owner (400) א: a person's send from the quote screen resumes the automatic reminders "ביטול כל הקישורים" stopped
  update app.quote_links l set reminders_stopped_at = null
   where l.organization_id = p_org and l.quote_id = v_quote.id and l.reminders_stopped_at is not null;
  return jsonb_build_object('job_id', v_job, 'paused', coalesce(app.customer_sending_paused(p_org), false));
end;
$$;
revoke all on function app.quote_message_enqueue(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function app.quote_message_enqueue(uuid, uuid, text, uuid) to authenticated;

-- app.send_quote_reminders: 021284's body; a stopped quote is not a candidate
create or replace function app.send_quote_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org record;
  v_row record;
  v_quote public.quotes;
  v_today date;
  v_stage text;
  v_contact uuid;
  v_template uuid;
  v_channel text;
  v_problem text;
  v_outcome text;
  v_job uuid;
  v_done integer := 0;
  v_seen integer := 0;
begin
  for v_org in
    select o.id, app.intake_zone(o.timezone) as zone
      from public.organizations o
      join public.org_document_settings s on s.organization_id = o.id and s.quote_customer_reminder
      left join app.quote_reminder_turns tn on tn.organization_id = o.id
     where o.deleted_at is null
       and app.org_writable(o.id)
       and app.org_has_feature(o.id, 'quote_reminders')
       and app.org_has_feature(o.id, 'quotes')
       and not coalesce(app.customer_sending_paused(o.id), true)
       and (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00'
       and exists (select 1 from public.quotes q
                    where q.organization_id = o.id and q.status in ('sent', 'viewed') and q.sent_at is not null)
     order by tn.last_run_at nulls first, o.id
     limit 100
  loop
    exit when v_seen >= app.quote_reminder_limit();
    insert into app.quote_reminder_turns as t (organization_id, last_run_at) values (v_org.id, now())
    on conflict (organization_id) do update set last_run_at = excluded.last_run_at;
    v_today := (now() at time zone v_org.zone)::date;
    for v_row in
      select q.id, st.stage
        from public.quotes q
        cross join lateral (select app.quote_reminder_stage(q, v_today) as stage) st
        -- the stage's earlier try, if any: stages tried least recently come first (delta review 4: a stage stuck on
        -- no_template or no_customer rotates behind the others instead of taking a slot on every run)
        left join app.quote_reminders pr on pr.quote_id = q.id and pr.stage = st.stage
       where q.organization_id = v_org.id and q.status in ('sent', 'viewed') and q.sent_at is not null
         and q.customer_deleted_at is null
         and (q.valid_until is null or q.valid_until >= v_today)
         -- a cheap bound first: not opened, sent between two and forty days ago (the last stage ends ten business days
         -- after sending), or opened with the last day near
         and ((q.status = 'sent' and q.sent_at < now() - interval '2 days' and q.sent_at > now() - interval '40 days')
              or (q.status = 'viewed' and q.valid_until is not null and q.valid_until <= v_today + 2))
         -- lead's choice (review F6): only a quote a person sent through the system (a person's quote message that went)
         and exists (select 1 from app.jobs j
                      where j.organization_id = q.organization_id and j.kind = 'message.send'
                        and j.payload ? 'quote_id' and (j.payload ->> 'quote_id') = q.id::text
                        and (j.payload ? 'reply_to_user_id' or j.payload ? 'sent_by_user_id')
                        and j.status = 'done')
         -- review F2: only a stage DUE today and not done counts against the cap, so waiting quotes never starve a due one
         and st.stage is not null
         and not app.quote_reminder_done(pr.outcome, pr.failures)
         -- owner (400) א: no reminder while "ביטול כל הקישורים" stopped them (until a person sends the quote again)
         and not exists (select 1 from app.quote_links ql
                          where ql.organization_id = q.organization_id and ql.quote_id = q.id
                            and ql.reminders_stopped_at is not null)
       order by pr.last_attempt_at nulls first, q.sent_at, q.id
       limit app.quote_reminder_per_org()
    loop
      exit when v_seen >= app.quote_reminder_limit();
      v_seen := v_seen + 1;
      v_stage := null;
      begin
        v_template := null;
        v_channel := null;
        v_outcome := null;
        v_job := null;
        select * into v_quote from public.quotes q
         where q.organization_id = v_org.id and q.id = v_row.id and q.status in ('sent', 'viewed')
         for update skip locked;
        if found then
          -- judged again under the lock
          v_stage := app.quote_reminder_stage(v_quote, v_today);
        end if;
        if v_stage is not null
           and not exists (select 1 from app.quote_reminders r
                            where r.quote_id = v_quote.id and r.stage = v_stage and app.quote_reminder_done(r.outcome, r.failures)) then
          v_contact := app.quote_message_customer(v_quote);
          if v_contact is null then
            v_outcome := 'no_customer';
          else
            perform app.seed_quote_reminder_templates(v_org.id);
            select qt.template_id, qt.channel into v_template, v_channel from app.quote_reminder_template(v_quote, v_contact) qt;
            if v_template is null then
              v_outcome := 'no_template';
            else
              v_problem := app.message_template_sendable(v_org.id, v_template);
              if v_problem is not null then
                perform app.message_send_refused(v_org.id, v_template, v_problem);
                v_outcome := 'template:' || left(regexp_replace(v_problem, '[^a-z_]', '_', 'g'), 40);
              else
                -- ids only (owner (55) א); the composer re-reads the quote by quote_id and mints the link itself
                v_job := app.enqueue_job(
                  v_org.id, 'message.send',
                  jsonb_build_object('channel', v_channel, 'message_type', 'requested_document', 'template_id', v_template,
                                     'quote_id', v_quote.id, 'contact_id', v_contact)
                  || case when v_quote.valid_until is not null
                          then jsonb_build_object('event_at', to_char(((v_quote.valid_until + 1)::timestamp at time zone v_org.zone)
                                                                       at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
                          else '{}'::jsonb end,
                  null);
                v_outcome := 'queued';
              end if;
            end if;
          end if;
          insert into app.quote_reminders as r (quote_id, stage, organization_id, outcome, channel, job_id, failures, last_attempt_at)
          values (v_quote.id, v_stage, v_org.id, v_outcome, v_channel, v_job, 0, now())
          on conflict (quote_id, stage) do update
            set outcome = excluded.outcome, channel = excluded.channel, job_id = excluded.job_id, last_attempt_at = excluded.last_attempt_at;
          if v_outcome = 'queued' then
            v_done := v_done + 1;
          end if;
        end if;
      exception when others then
        -- delta review 4: a failure counts even when it came before the stage was judged under the lock (the candidate's stage)
        v_stage := coalesce(v_stage, v_row.stage);
        if v_stage is not null then
          insert into app.quote_reminders (quote_id, stage, organization_id, failures, last_attempt_at)
          values (v_row.id, v_stage, v_org.id, 1, now())
          on conflict (quote_id, stage) do update
            set failures = app.quote_reminders.failures + 1, last_attempt_at = excluded.last_attempt_at;
        end if;
        raise warning 'crm-quote-reminders: quote % failed (SQLSTATE %)', v_row.id, sqlstate;
      end;
    end loop;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_quote_reminders() from public, anon, authenticated, service_role;

-- app.quote_message_refusal: 021284's body; a reminder of a stopped quote is refused
create or replace function app.quote_message_refusal(p_job app.jobs, p_quote public.quotes, p_contact uuid,
                                                     p_template public.message_templates)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_shown public.quotes;
  v_stage text;
begin
  if p_quote.id is null or p_quote.organization_id is distinct from p_job.organization_id then
    return 'quote_changed';
  end if;
  if not coalesce(app.org_has_feature(p_quote.organization_id, 'quotes'), false) then
    return 'feature_off';
  end if;
  -- sent or viewed, on offer today in the business's zone, the customer not deleted
  if not coalesce(app.quote_offer_open(p_quote), false) then
    return 'quote_changed';
  end if;
  -- the chain's newest sent version only (a newer sent version supersedes it)
  v_shown := app.quote_shown_version(p_quote);
  if v_shown.id is distinct from p_quote.id then
    return 'quote_changed';
  end if;
  -- the link must open: public pages open (app.quote_link_usable's rule)
  if not coalesce(app.quote_link_usable(p_quote), false) then
    return 'pages_closed';
  end if;
  -- still the quote's customer
  if p_contact is null or app.quote_message_customer(p_quote) is distinct from p_contact then
    return 'customer_changed';
  end if;
  if (p_job.payload ? 'reply_to_user_id') or (p_job.payload ? 'sent_by_user_id') then
    -- a person's send: never from a template the system sends itself
    if p_template.notice_kind is not null then
      return 'template_changed';
    end if;
    return null;
  end if;
  -- QUO-18 reminders: a message no person sent is a reminder the job queued: its own row, the system's template, the key and
  -- the switch still on, and the stage still holds (an opened quote gets no 'unopened' reminder; 'expiring' needs a last day)
  select r.stage into v_stage from app.quote_reminders r
   where r.organization_id = p_quote.organization_id and r.quote_id = p_quote.id and r.job_id = p_job.id;
  if v_stage is null then
    return 'unsupported';
  end if;
  -- owner (400) א: a reminder queued before "ביטול כל הקישורים" is not sent while the reminders stay stopped
  if exists (select 1 from app.quote_links l
              where l.organization_id = p_quote.organization_id and l.quote_id = p_quote.id
                and l.reminders_stopped_at is not null) then
    return 'reminders_stopped';
  end if;
  if p_template.notice_kind is distinct from 'quote_reminder' then
    return 'template_changed';
  end if;
  if not coalesce(app.org_has_feature(p_quote.organization_id, 'quote_reminders'), false) then
    return 'feature_off';
  end if;
  if not coalesce((select s.quote_customer_reminder from public.org_document_settings s
                    where s.organization_id = p_quote.organization_id), false) then
    return 'reminder_off';
  end if;
  if (v_stage in ('unopened_1', 'unopened_2') and p_quote.status <> 'sent')
     or (v_stage = 'expiring' and p_quote.valid_until is null) then
    return 'quote_changed';
  end if;
  return null;
end;
$$;
revoke all on function app.quote_message_refusal(app.jobs, public.quotes, uuid, public.message_templates)
  from public, anon, authenticated, service_role;
