-- =============================================================================
-- MSG-03: every outgoing and incoming message is kept, with channel, direction, delivery status and provider id, and
-- shown on the record's timeline (owner 3 November 2026, answer (75) א: the log keeps no content and no cost)
-- =============================================================================
-- * public.messages: one row per message, on one lead or one contact (composite foreign keys, cascade: purging the
--   record, an erasure and the retention policy take its messages with it). channel email | sms | whatsapp, direction
--   outbound | inbound, status sent | delivered | read | failed (outbound) or received (inbound), provider (the
--   adapter's code, the namespace of its id) and provider_message_id, unique per business and provider so a delivery
--   report or a repeated callback never counts a message twice, provider_error_code (the provider's short error code of
--   a failed message), job_id (the OPS-04 job that sent it, one message per job), template_code (null until MSG-02) and
--   times. Owner (75) א: no content, no subject, no cost, no purpose: the text lives in the provider, the address on the
--   record, the cost waits for MSG-05.
--   Read by whoever reads the record (the activities rule, app.can_read_activity_subject); NO client writes (no insert,
--   update or delete grant): only the server writes it.
-- * The one writer today is the OPS-04 queue (owner 3 November 2026, answer (75) א: approved; the write goes only through
--   the worker's service_role path, finish_job and then this pinned trigger, never direct table access):
--   - public.job_message_may_send stamps app.jobs.send_checked_lease with the live lease when it answers yes, so the
--     queue knows this attempt passed the check and reached the provider;
--   - public.finish_job gains three optional arguments (p_provider, p_provider_message_id, p_provider_error_code) that it
--     keeps on app.jobs (codes and ids, never personal data; a value of the wrong shape is dropped), and sets app.jobs.message_outcome: 'sent' when the job is done,
--     'failed' when it ends dead after this attempt reached the provider (the provider refused it for good, p_final, or
--     answered a failure on the last allowed try), both only when this lease passed the send check. Its body still
--     touches no public table. Nothing else sets an outcome: a refused job (counted only) and a lease that ran out in
--     claim_jobs (outcome unknown) record nothing.
--   - The AFTER trigger jobs_record_message (app.jobs_record_message, definer, no grants; the only trigger on app.jobs,
--     pinned by test 284) writes the message when message_outcome is set. It never fails the finish: a record purged
--     meanwhile records nothing (foreign key, caught), a provider id another message already holds is kept off the new
--     row, and any other error is caught with one warning naming the job id only.
--   The old six-argument finish_job is renamed to app.finish_job_021146_retired and loses every grant (the 0180
--   pattern), so PostgREST resolves one function; the live site's six named arguments still reach the new one.
-- * A merge moves the duplicate's messages to the kept record through the `merged` timeline entry
--   (app.merge_messages, as app.merge_payment_promises), before the duplicate is deleted.
-- * app.sample_untouched (last redefined in 021148, RVW-64) also counts a message as real work.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  lead_id             uuid,
  contact_id          uuid,
  channel             text not null,
  direction           text not null,
  status              text not null,
  provider            text,
  provider_message_id text,
  provider_error_code text,
  job_id              uuid,
  template_code       text,
  occurred_at         timestamptz not null default now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, id),
  constraint messages_one_record check (num_nonnulls(lead_id, contact_id) = 1),
  constraint messages_channel check (channel in ('email', 'sms', 'whatsapp')),
  constraint messages_direction check (direction in ('outbound', 'inbound')),
  constraint messages_status check (
    (direction = 'outbound' and status in ('sent', 'delivered', 'read', 'failed'))
    or (direction = 'inbound' and status = 'received')),
  constraint messages_provider_code check (provider is null or provider ~ '^[a-z0-9_-]{1,40}$'),
  constraint messages_provider_id check (
    provider_message_id is null or (provider is not null and provider_message_id ~ '^[!-~]{1,200}$')),
  -- a provider's error code: short, letters, digits and _.:- only
  constraint messages_provider_error_code check (provider_error_code is null or provider_error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  constraint messages_template_code check (template_code is null or template_code ~ '^[a-z0-9_.-]{1,60}$'),
  -- the provider's id, once per business and provider (MSG-03: no duplicates)
  constraint messages_provider_unique unique (organization_id, provider, provider_message_id),
  -- one message per queued job
  constraint messages_job_unique unique (job_id),
  constraint messages_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete cascade,
  constraint messages_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade
);

comment on table public.messages is
  'MSG-03: messages sent to or received from a lead or contact (channel, direction, delivery status, provider id); no content; server writes only';

-- full indexes, so they also cover the foreign keys (test 130); the timeline reads newest first through them
create index if not exists messages_lead_idx on public.messages (organization_id, lead_id, occurred_at desc);
create index if not exists messages_contact_idx on public.messages (organization_id, contact_id, occurred_at desc);

alter table public.messages enable row level security;
revoke all on public.messages from anon, authenticated;
grant select on public.messages to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'messages_select') then
    -- whoever reads the lead or contact reads its messages (the rule of activities_select)
    create policy messages_select on public.messages for select to authenticated
      using (app.is_member(organization_id)
             and app.can_read_activity_subject(lead_id, contact_id, null, null));
  end if;
end;
$$;

create or replace trigger messages_touch before update on public.messages
  for each row execute function app.touch_row();

-- ----------------------------------------------------------------------------
-- What finish_job keeps on the job (codes and ids only)
-- ----------------------------------------------------------------------------
alter table app.jobs add column if not exists provider text;
alter table app.jobs add column if not exists provider_message_id text;
alter table app.jobs add column if not exists provider_error_code text;
-- the lease whose send check answered yes (the attempt reached the provider), and what to record when the job ends
alter table app.jobs add column if not exists send_checked_lease uuid;
alter table app.jobs add column if not exists message_outcome text;
alter table app.jobs drop constraint if exists jobs_provider_shape;
-- a provider's id is printable ASCII only (no spaces or control characters)
alter table app.jobs add constraint jobs_provider_shape check (
  (provider is null or provider ~ '^[a-z0-9_-]{1,40}$')
  and (provider_message_id is null or (provider is not null and provider_message_id ~ '^[!-~]{1,200}$'))
  and (provider_error_code is null or provider_error_code ~ '^[A-Za-z0-9_.:-]{1,64}$')
  and (message_outcome is null or message_outcome in ('sent', 'failed')));

-- ----------------------------------------------------------------------------
-- finish_job: the same rules, plus the provider's answer on success
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.finish_job(uuid, uuid, boolean, text, boolean, boolean)') is not null then
    alter function public.finish_job(uuid, uuid, boolean, text, boolean, boolean) rename to finish_job_021146_retired;
    alter function public.finish_job_021146_retired(uuid, uuid, boolean, text, boolean, boolean) set schema app;
    revoke all on function app.finish_job_021146_retired(uuid, uuid, boolean, text, boolean, boolean)
      from public, anon, authenticated, service_role;
  end if;
end;
$$;

create or replace function public.finish_job(p_job uuid, p_lease uuid, p_ok boolean, p_error text default null,
                                             p_final boolean default false, p_started boolean default true,
                                             p_provider text default null, p_provider_message_id text default null,
                                             p_provider_error_code text default null)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs%rowtype;
  v_provider text;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.status <> 'running' or p_lease is null or v_job.lease_id is distinct from p_lease
     or not (v_job.locked_until > now()) then
    return 'stale';
  end if;
  v_provider := case when p_provider ~ '^[a-z0-9_-]{1,40}$' then p_provider end;
  if not coalesce(p_started, true) then
    -- claimed but never started: back to the queue at once, the attempt not counted
    update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null
     where j.id = p_job;
    return 'released';
  end if;
  if coalesce(p_ok, false) then
    -- MSG-03: the provider's code and its message id, kept on the job; a value of the wrong shape is left out (never an
    -- error: the message went out, and a refused finish would send it again)
    update app.jobs j set status = 'done', lease_id = null, locked_until = null, finished_at = now(), last_error = null,
                          provider = v_provider,
                          provider_message_id = case when v_provider is not null
                                                      and btrim(p_provider_message_id) ~ '^[!-~]{1,200}$'
                                                     then btrim(p_provider_message_id) end,
                          provider_error_code = null,
                          -- a message is recorded only when this attempt passed the send check
                          message_outcome = case when v_job.send_checked_lease = p_lease then 'sent' end
     where j.id = p_job;
    return 'done';
  end if;
  if coalesce(p_final, false) or v_job.attempts >= app.job_max_attempts() then
    -- 'failed' when this attempt passed the send check and the provider answered a failure (for good, or on the last
    -- allowed try); a dead job whose attempt never reached the provider records nothing
    update app.jobs j set status = 'dead', lease_id = null, locked_until = null, finished_at = now(),
                          last_error = coalesce(app.job_error_redact(p_error), 'failed'),
                          -- the provider's code and its short error code of the failure (dropped when malformed)
                          provider = v_provider,
                          provider_message_id = null,
                          provider_error_code = case when btrim(p_provider_error_code) ~ '^[A-Za-z0-9_.:-]{1,64}$'
                                                     then btrim(p_provider_error_code) end,
                          message_outcome = case when v_job.send_checked_lease = p_lease then 'failed' end
     where j.id = p_job;
    return 'dead';
  end if;
  update app.jobs j set status = 'failed', lease_id = null, locked_until = null,
                        next_run_at = now() + app.job_backoff(v_job.attempts),
                        last_error = coalesce(app.job_error_redact(p_error), 'failed')
   where j.id = p_job;
  return 'failed';
end;
$$;
revoke all on function public.finish_job(uuid, uuid, boolean, text, boolean, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.finish_job(uuid, uuid, boolean, text, boolean, boolean, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The send check: 021137's body, plus the stamp of the lease that passed it
-- ----------------------------------------------------------------------------
create or replace function public.job_message_may_send(p_job uuid, p_lease uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs%rowtype;
  v_channel text;
  v_record uuid;
  v_found boolean := false;
  v_email text;
  v_phone text;
  v_address text;
  v_suppressed boolean;
  v_reason text;
  v_event_at timestamptz;
  v_paused_at timestamptz;
  v_pause public.org_sending_pauses%rowtype;
begin
  select * into v_job from app.jobs j where j.id = p_job for update;
  if not found or v_job.kind <> 'message.send' or v_job.status <> 'running'
     or p_lease is null or v_job.lease_id is distinct from p_lease or not (v_job.locked_until > now()) then
    return jsonb_build_object('may_send', false, 'reason', 'stale');
  end if;

  v_channel := v_job.payload ->> 'channel';
  if v_job.payload ? 'lead_id' then
    v_record := (v_job.payload ->> 'lead_id')::uuid;
    select true, l.email, l.phone into v_found, v_email, v_phone
      from public.leads l
     where l.organization_id = v_job.organization_id and l.id = v_record and l.deleted_at is null;
  else
    v_record := (v_job.payload ->> 'contact_id')::uuid;
    select true, c.email, c.phone into v_found, v_email, v_phone
      from public.contacts c
     where c.organization_id = v_job.organization_id and c.id = v_record and c.deleted_at is null;
  end if;

  if v_job.payload ? 'event_at' then
    begin
      v_event_at := (v_job.payload ->> 'event_at')::timestamptz;
    exception when others then
      v_event_at := '-infinity';
    end;
  end if;

  if not app.org_writable(v_job.organization_id) then
    v_reason := 'business_closed';
  elsif v_event_at is not null and v_event_at < now() then
    v_reason := 'event_passed';
  elsif app.customer_sending_paused(v_job.organization_id) then
    select p.paused_at into v_paused_at from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if coalesce(v_paused_at, now()) < now() - interval '24 hours' then
      v_reason := 'pause_expired';
    else
      -- (52) ג: wait for the business to resume; not refused, the attempt not counted
      update app.jobs j set status = 'queued', attempts = greatest(j.attempts - 1, 0), lease_id = null, locked_until = null,
                            next_run_at = now() + interval '5 minutes', last_error = 'waiting:sending_paused'
       where j.id = p_job;
      -- the business's other message jobs already due wait with it, in one update (no attempt is counted: they were
      -- not claimed), so a paused business does not churn the queue one job at a time. Only jobs already due: a job
      -- due later is marked when its own time comes, so one due after the resume never carries the mark (review)
      update app.jobs j set next_run_at = now() + interval '5 minutes', last_error = 'waiting:sending_paused'
       where j.organization_id = v_job.organization_id and j.kind = 'message.send' and j.id <> p_job
         and j.status in ('queued', 'failed') and j.next_run_at <= now();
      return jsonb_build_object('may_send', false, 'reason', 'sending_paused', 'retry', true);
    end if;
  end if;

  -- (52) ג after the resume: the business's latest pause lasted more than 24 hours and this job waited through it
  -- (it was told to wait, or it was made before the resume and due by its end) = cancelled, even when no check
  -- happened during the pause (worker down, hourly wake). A job made during the pause for a time after the resume
  -- never waited and is sent (review M-1). Only the latest pause is known: a re-pause before an older long pause's
  -- backlog drained forgets it (review L-a, accepted)
  if v_reason is null then
    select * into v_pause from public.org_sending_pauses p where p.organization_id = v_job.organization_id;
    if found and not v_pause.paused and v_pause.paused_at is not null and v_pause.resumed_at is not null
       and v_pause.resumed_at - v_pause.paused_at > interval '24 hours'
       and (v_job.last_error = 'waiting:sending_paused'
            or (v_job.created_at <= v_pause.resumed_at and v_job.next_run_at <= v_pause.resumed_at)) then
      v_reason := 'pause_expired';
    end if;
  end if;

  if v_reason is not null then
    null;
  elsif not coalesce(v_found, false) then
    v_reason := 'record_gone';
  else
    v_address := nullif(btrim(case when v_channel = 'email' then v_email else v_phone end), '');
    if v_address is null then
      v_reason := 'no_address';
    else
      v_suppressed := app.consent_suppressed(v_job.organization_id, v_channel, v_address);
      if v_suppressed is null then
        v_reason := 'consent_unknown';
      elsif v_suppressed then
        v_reason := 'consent_suppressed';
      end if;
    end if;
  end if;

  if v_reason is null then
    -- MSG-03: this lease passed the check; finish_job records the message only for such an attempt
    update app.jobs j set send_checked_lease = p_lease where j.id = p_job;
    return jsonb_build_object('may_send', true);
  end if;
  update app.jobs j set status = 'refused', lease_id = null, locked_until = null, finished_at = now(),
                        last_error = 'refused:' || v_reason
   where j.id = p_job;
  insert into app.job_cancel_counts (organization_id, reason, pending)
  values (v_job.organization_id, v_reason, 1)
  on conflict (organization_id, reason) do update set pending = app.job_cancel_counts.pending + 1;
  return jsonb_build_object('may_send', false, 'reason', v_reason);
end;
$$;
revoke all on function public.job_message_may_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.job_message_may_send(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- The message, written when a message.send job ends
-- ----------------------------------------------------------------------------
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

create or replace trigger jobs_record_message after update of message_outcome on app.jobs
  for each row
  when (new.kind = 'message.send' and new.message_outcome is not null and old.message_outcome is null)
  execute function app.jobs_record_message();

-- ----------------------------------------------------------------------------
-- Merge: the duplicate's messages go to the kept record (before the duplicate is deleted)
-- ----------------------------------------------------------------------------
create or replace function app.merge_messages() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.lead_id is not null and v_merged <> new.lead_id then
    update public.messages m set lead_id = new.lead_id
     where m.organization_id = new.organization_id and m.lead_id = v_merged;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update public.messages m set contact_id = new.contact_id
     where m.organization_id = new.organization_id and m.contact_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_messages() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_messages after insert on public.activities
  for each row
  when (new.type = 'system' and (new.lead_id is not null or new.contact_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_messages();

-- ----------------------------------------------------------------------------
-- Sample data: a message sent to a sample lead or contact is real work (021148's body, RVW-64's promise lines included, plus the two message lines)
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    -- TASK-06: a sample task a person gave steps to is real work
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id)
       -- TASK-06 part B: a sub-task a person added under it (sample data makes none)
       and not exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- notes, files and meetings are never sample data
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task, or one a person gave steps to (TASK-06; removing the record would
  -- take such a task with it)
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and (not app.sample_pristine($1, ''task'', t.id)
                          or exists (select 1 from public.task_checklist_items i
                                      where i.organization_id = t.organization_id and i.task_id = t.id)))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id)
       -- MSG-03: sample data sends no messages; one sent or received is real
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- ORD-01: sample data makes no orders; one made is real work
       and not exists (select 1 from public.orders od where od.organization_id = p_org and p_id in (od.contact_id, od.delivery_contact_id))
       -- DOC-01: sample data records no documents; one recorded is real work
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.contact_id = p_id)
       -- PAY-01: sample data records no payments; one recorded is real work
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.contact_id = p_id)
       -- COL-05: sample data holds nobody; a hold set is real work
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- RVW-64 (COL-03): sample data makes no payment promises; one recorded on the customer is real work
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.contact_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id)
       -- MSG-03
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.company_id = p_id)
       -- COL-05
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.company_id = p_id)
       -- RVW-64 (COL-03): a payment promise on the company, or on one of its own documents (an opening balance)
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.company_id = p_id)
       and not exists (select 1 from public.payment_promises pp
                         join public.accounting_documents ad on ad.organization_id = pp.organization_id and ad.id = pp.document_id
                        where pp.organization_id = p_org and ad.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.deal_id = p_id)
       -- DOC-01
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.deal_id = p_id)
       -- PAY-01
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.deal_id = p_id);
  end if;
end;
$$;

revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

notify pgrst, 'reload schema';

