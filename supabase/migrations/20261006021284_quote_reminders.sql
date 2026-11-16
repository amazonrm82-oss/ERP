-- QUO-18, the reminders (the owner's answers (381) ב, (382) א, (383) א, (384) ב, 16 November 2026, docs/DECISIONS.md): automatic
-- reminders to the customer about a sent quote, through the quote send path of 021283 (a message.send job with quote_id, a
-- SERVICE message of type requested_document, to the customer address on the quote).
--
-- * (381) ב: a customer who did NOT open the quote (status still 'sent') gets up to two reminders, 3 and 7 business days after
--   the day it was sent (app.add_business_days, the business calendar): stage 'unopened_1' from the 3rd business day until the
--   7th, stage 'unopened_2' from the 7th business day for 3 more business days (a switch turned on late never sends an old
--   reminder about a quote sent long ago); never after the quote's validity (app.quote_offer_open).
-- * (382) א: a customer who opened it (status 'viewed') and did not answer gets ONE reminder ('expiring') from two calendar days
--   before the last day of validity, until that day; a quote without valid_until gets none of this kind. Once opened, no
--   'unopened' reminder goes (the job and the composer both judge the status).
-- * (383) א: org_document_settings.quote_customer_reminder, OFF by default; owners/admins of a writable business through column
--   grants (the settings row is audited).
-- * (384) ב: plan key `quote_reminders`, basic, pro and business (personal and free off; the fallback is off).
-- * Stops when the quote is accepted, declined, cancelled, expired, or a newer version was sent (app.quote_shown_version): the job
--   judges it, and the composers judge it again through app.quote_message_refusal (redefined here: the branch for a message no
--   person sent); its row in app.quote_reminders (once per quote and stage), the template's mark, the key and the switch too.
-- * The channel: the channel the quote was last sent on by a person (QUO-18 part one), else email, else SMS (SMS only with the
--   `sms` key), the first with an address on the customer and an active template marked 'quote_reminder' on that channel.
-- * Templates: two DRAFT templates (email, SMS) with notice_kind 'quote_reminder' and wording_version 'quote-reminder-draft-1',
--   seeded once per business and channel by the job (app.quote_reminder_template_seeds; a business at the 50 cap gets none);
--   = DEFAULT_QUOTE_REMINDER_TEMPLATES. A template with a notice_kind is never offered on a card, a quote send or a rule and is
--   refused on every person's path (021218's pattern, unchanged).
-- * pg_cron `crm-quote-reminders` (every 15 minutes) runs app.send_quote_reminders(): from 08:00 in the business's zone, writable
--   businesses with the key and the switch, not while HEB-09 pauses; businesses take turns (app.quote_reminder_turns), 100
--   businesses, 200 quotes per business and 2,000 a run, an exception block per quote (3 failures then skipped).
-- * Lead's choice (review F6): only a quote a person sent through the system (a person's quote message of it that went, job
--   status done) gets reminders; a quote only marked sent (printed, a PDF) gets none.
-- * Review F2: the cap counts only quotes with a stage due today and not done; review F7: 'no_template' and 'no_customer' are
--   tried again until the stage's window ends, and the switch is turned on only while the plan holds the key.
-- * The message log (public.messages) and the quote's own list (public.quote_message_queue: "תזכורת אוטומטית") show them.
-- Every statement is safe to run twice; no row is removed here.

-- ----------------------------------------------------------------------------
-- The switch (383) א
-- ----------------------------------------------------------------------------
alter table public.org_document_settings add column if not exists quote_customer_reminder boolean not null default false;
grant select (quote_customer_reminder) on public.org_document_settings to authenticated;
grant insert (quote_customer_reminder) on public.org_document_settings to authenticated;
grant update (quote_customer_reminder) on public.org_document_settings to authenticated;

-- ----------------------------------------------------------------------------
-- The plan key (384) ב: basic and up
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": {}, "features": { "quote_reminders": false } },
  "basic": { "limits": {}, "features": { "quote_reminders": true } },
  "pro": { "limits": {}, "features": { "quote_reminders": true } },
  "business": { "limits": {}, "features": { "quote_reminders": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- ----------------------------------------------------------------------------
-- The system's own mark (021235's list plus 'quote_reminder'); added not valid, then validated (RVW-102)
-- ----------------------------------------------------------------------------
alter table public.message_templates
  drop constraint if exists message_templates_notice_kind_check,
  add constraint message_templates_notice_kind_check
    check (notice_kind is null or notice_kind in ('punch_card_low', 'punch_card_expiry',
                                                  'meeting_confirm', 'meeting_moved', 'meeting_day', 'meeting_hour',
                                                  'signature_reminder', 'instant_reply_open', 'instant_reply_closed',
                                                  'collection_reminder', 'review_request', 'quote_reminder')) not valid;
alter table public.message_templates validate constraint message_templates_notice_kind_check;

-- ----------------------------------------------------------------------------
-- Once per quote and stage; the seeds; the businesses' turns (schema app, RLS on, no grants)
-- ----------------------------------------------------------------------------
create table if not exists app.quote_reminders (
  quote_id        uuid not null,
  stage           text not null check (stage in ('unopened_1', 'unopened_2', 'expiring')),
  organization_id uuid not null,
  outcome         text,
  channel         text,
  job_id          uuid,
  failures        integer not null default 0,
  last_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  primary key (quote_id, stage),
  constraint quote_reminders_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade
);
create index if not exists quote_reminders_org_quote_idx on app.quote_reminders (organization_id, quote_id);
create index if not exists quote_reminders_job_idx on app.quote_reminders (job_id) where job_id is not null;
alter table app.quote_reminders enable row level security;
revoke all on app.quote_reminders from public, anon, authenticated, service_role;

create table if not exists app.quote_reminder_template_seeds (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel         text not null check (channel in ('email', 'sms')),
  seeded_at       timestamptz not null default now(),
  primary key (organization_id, channel)
);
alter table app.quote_reminder_template_seeds enable row level security;
revoke all on app.quote_reminder_template_seeds from public, anon, authenticated, service_role;

create table if not exists app.quote_reminder_turns (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  last_run_at     timestamptz not null default now()
);
alter table app.quote_reminder_turns enable row level security;
revoke all on app.quote_reminder_turns from public, anon, authenticated, service_role;

-- 200 quotes per business a run; a test may lower it for its own transaction (setting app.quote_reminder_per_org), never raise it
create or replace function app.quote_reminder_per_org() returns integer
language sql stable set search_path = ''
as $$ select least(200, greatest(1, coalesce(nullif(current_setting('app.quote_reminder_per_org', true), '')::integer, 200))) $$;
revoke all on function app.quote_reminder_per_org() from public, anon, authenticated, service_role;
create or replace function app.quote_reminder_limit() returns integer
language sql immutable set search_path = '' as $$ select 2000 $$;
revoke all on function app.quote_reminder_limit() from public, anon, authenticated, service_role;

-- A stage is done once it was handled, or failed three times; 'no_template' and 'no_customer' are tried again on later runs
-- until the stage's window ends (review F7)
create or replace function app.quote_reminder_done(p_outcome text, p_failures integer) returns boolean
language sql immutable set search_path = ''
as $$ select coalesce(p_failures, 0) >= 3 or (p_outcome is not null and p_outcome not in ('no_template', 'no_customer')) $$;
revoke all on function app.quote_reminder_done(text, integer) from public, anon, authenticated, service_role;

-- the quote's messages, for the job's "sent by a person" rule and the quote's own list
create index if not exists jobs_quote_message_idx on app.jobs (organization_id, (payload ->> 'quote_id'))
  where kind = 'message.send' and payload ? 'quote_id';

-- (384) ב: the switch is turned on only while the plan holds the key; switching off is always allowed (review F7). An outsider
-- is left to RLS first (the quota-trigger guard).
create or replace function app.org_document_settings_quote_reminder_key() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not coalesce(new.quote_customer_reminder, false)
     or (tg_op = 'UPDATE' and coalesce(old.quote_customer_reminder, false)) then
    return new;
  end if;
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if not coalesce(app.org_has_feature(new.organization_id, 'quote_reminders'), false) then
    raise exception 'quote reminders are not in this plan' using errcode = 'P0001', hint = 'feature:quote_reminders';
  end if;
  return new;
end;
$$;
revoke all on function app.org_document_settings_quote_reminder_key() from public, anon, authenticated, service_role;

create or replace trigger org_document_settings_quote_reminder_key
  before insert or update of quote_customer_reminder on public.org_document_settings
  for each row execute function app.org_document_settings_quote_reminder_key();

-- ----------------------------------------------------------------------------
-- The stage a quote is due for today (null = none): the owner's (381) ב and (382) א
-- ----------------------------------------------------------------------------
create or replace function app.quote_reminder_stage(p_quote public.quotes, p_today date) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_sent date;
  v_d3 date;
  v_d7 date;
begin
  if p_quote.id is null or p_quote.sent_at is null or p_today is null
     or not coalesce(app.quote_offer_open(p_quote), false)
     or (app.quote_shown_version(p_quote)).id is distinct from p_quote.id then
    return null;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = p_quote.organization_id;
  v_sent := (p_quote.sent_at at time zone v_zone)::date;
  if p_quote.status = 'sent' then
    v_d3 := app.add_business_days(p_quote.organization_id, v_sent, 3);
    v_d7 := app.add_business_days(p_quote.organization_id, v_sent, 7);
    if p_today >= v_d7 then
      if p_today <= app.add_business_days(p_quote.organization_id, v_d7, 3) then
        return 'unopened_2';
      end if;
    elsif p_today >= v_d3 then
      return 'unopened_1';
    end if;
  elsif p_quote.status = 'viewed' and p_quote.valid_until is not null
        and p_today >= p_quote.valid_until - 2 and p_today <= p_quote.valid_until then
    return 'expiring';
  end if;
  return null;
end;
$$;
revoke all on function app.quote_reminder_stage(public.quotes, date) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The DRAFT templates (= DEFAULT_QUOTE_REMINDER_TEMPLATES), once per business and channel (signature reminders' pattern)
-- ----------------------------------------------------------------------------
create or replace function app.seed_quote_reminder_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    select d.* from (values
      (1, 'הצעת מחיר: תזכורת (אימייל)', 'email', 'תזכורת: הצעת המחיר מ{שם העסק}',
          'שלום {שם פרטי},' || chr(10) || chr(10) || 'רצינו להזכיר שהצעת המחיר מחכה לך כאן: {קישור להצעה}{ ההצעה בתוקף עד {תוקף}.}' || chr(10) || chr(10) || '{שם הנציג}, {שם העסק}'),
      (2, 'הצעת מחיר: תזכורת (SMS)', 'sms', null::text,
          'שלום {שם פרטי}, תזכורת: הצעת המחיר מ{שם העסק} מחכה לך כאן: {קישור להצעה}{ בתוקף עד {תוקף}}. {שם העסק}')
    ) as d(n, name, channel, subject, body)
     where not exists (select 1 from app.quote_reminder_template_seeds s where s.organization_id = p_org and s.channel = d.channel)
     order by d.n
  loop
    begin
      if not exists (select 1 from public.message_templates t
                      where t.organization_id = p_org and t.notice_kind = 'quote_reminder' and t.channel = v_row.channel)
         and not exists (select 1 from public.message_templates t where t.organization_id = p_org and lower(t.name) = lower(v_row.name)) then
        insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind, wording_version)
        values (p_org, v_row.name, v_row.channel, 'requested_document', v_row.subject, v_row.body, 'quote_reminder',
                'quote-reminder-draft-1');
      end if;
      insert into app.quote_reminder_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    exception when others then
      raise warning 'quote reminder template % not seeded for business % (SQLSTATE %)', v_row.n, p_org, sqlstate;
      insert into app.quote_reminder_template_seeds (organization_id, channel) values (p_org, v_row.channel)
      on conflict (organization_id, channel) do nothing;
    end;
  end loop;
end;
$$;
revoke all on function app.seed_quote_reminder_templates(uuid) from public, anon, authenticated, service_role;

-- The channel and template: the channel the quote was last sent on by a person, else email, else SMS (SMS with the `sms` key),
-- the first with an address on the customer and an active template marked 'quote_reminder' on it
create or replace function app.quote_reminder_template(p_quote public.quotes, p_contact uuid)
returns table (template_id uuid, channel text)
language sql stable security definer
set search_path = ''
as $$
  with last_sent as (
    select j.payload ->> 'channel' as ch
      from app.jobs j
     where j.organization_id = p_quote.organization_id and j.kind = 'message.send'
       and j.payload ->> 'quote_id' = p_quote.id::text
       and (j.payload ? 'reply_to_user_id' or j.payload ? 'sent_by_user_id')
     order by j.created_at desc, j.id desc
     limit 1
  ), customer as (
    select c.email, c.phone_e164 from public.contacts c
     where c.organization_id = p_quote.organization_id and c.id = p_contact and c.deleted_at is null
  )
  select t.id, t.channel
    from customer cu
    cross join lateral (
      select ch, ord from (values ((select ch from last_sent), 0), ('email', 1), ('sms', 2)) v(ch, ord) where ch in ('email', 'sms')
    ) o
    join public.message_templates t
      on t.organization_id = p_quote.organization_id and t.channel = o.ch and t.is_active
     and t.message_type = 'requested_document' and t.notice_kind = 'quote_reminder'
   where case when o.ch = 'email' then btrim(coalesce(cu.email, '')) ~ '^[^@[:space:]]+@[^@[:space:]]+$'
              else nullif(btrim(coalesce(cu.phone_e164, '')), '') is not null
                   and coalesce(app.org_has_feature(p_quote.organization_id, 'sms'), false) end
   order by o.ord, t.created_at, t.id
   limit 1
$$;
revoke all on function app.quote_reminder_template(public.quotes, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job
-- ----------------------------------------------------------------------------
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

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-quote-reminders', '4,19,34,49 * * * *', 'select app.send_quote_reminders();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- app.quote_message_refusal: 021283's body, the branch for a message no person sent (the reminder) now judged
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- app.plan_key_defaults: 021281's fallback with the new key off
-- ----------------------------------------------------------------------------
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
    "prefill_links": false,
    "daily_digest": false,
    "quote_reminders": false
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

-- ----------------------------------------------------------------------------
-- public.plans_public: 021281's body plus 'quote_reminders' (a built capability of PLAN_CAPABILITIES, after 'quotes')
-- ----------------------------------------------------------------------------
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
              'products', 'discounts', 'quotes', 'quote_reminders', 'documents', 'payments', 'collection', 'balances',
              'booking_page', 'business_card', 'public_page', 'prefill_links', 'qr_codes', 'site_widget', 'money_waiting',
              'daily_digest',
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

-- anon and authenticated only (owner, 11 November 2026), as before; test 01 names it beside health_check
revoke all on function public.plans_public() from public, anon, authenticated, service_role;
grant execute on function public.plans_public() to anon, authenticated;
