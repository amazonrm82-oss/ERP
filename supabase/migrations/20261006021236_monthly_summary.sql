-- MNY-06 part one: "what the system did for you this month" (owner (273): every plan, no plan key).
--
-- public.report_monthly_summary(org, month) is a report for owners and admins only ({allowed: false} to anyone else, a
-- support session included), for one calendar month in the business's time zone (null = the current month). Counts only,
-- never a name or an id. It is security invoker and reads nothing itself: every count comes from ONE narrow definer count
-- helper, app.monthly_summary_counts, which checks app.is_admin(org) FIRST (null otherwise) and returns counts only.
-- (Review: under RLS every audit_log row paid audit_log_select's is_admin, 61.9 s on 300k rows; the report is admin-only,
-- so the definer exposes nothing more.) Every audit_log read is bounded by created_at (audit_log_org_time_idx); no read
-- walks a lead's whole history.
--   * leads_distributed: distinct leads the SERVER gave their owner in the month:
--       - a lead whose insert entry in the month has no actor (a server write: intake, booking, Meta), not an import,
--         with an owner at insert time (the `old` value of its first owner change if there is one, else its owner now);
--       - an owner change in the month with no actor (rotation waiting, absence return, pass-on) or naming an automation.
--     An unowned lead that a person later took or assigned never counts. A lead in the recycle bin still counts.
--   * automation_tasks: tasks an automation made (the audit log's insert entries that name a rule, PRM-01's `automation`).
--   * reminder_tasks: distinct tasks created in the month that a COL-04 collection stage gave
--     (app.collection_reminders_sent.task_id), SGN-03 signature reminder tasks (app.signature_reminders.task_id) and SGN-04
--     contract renewal tasks (app.contract_renewal_tasks), each created in the month.
--   * customer_messages: AUTOMATIC OPS-04 `message.send` jobs made in the month, by message type collection |
--     meeting_reminder | instant_reply | review_request; a job a person sent or pressed (payload sent_by_user_id,
--     reply_to_user_id or pressed_by_user_id) is left out. `queued` = every such job but those the queue refused
--     (cancelled); `sent` = the provider took it (message_outcome 'sent'), 0 until a provider sends. Counted when queued.
--   * collected_after_reminder: debt documents with a counted payment (recorded/confirmed, allocation neither removed nor
--     released) whose paid_on is in the month, after a collection stage that really reminded (a task, or a customer
--     message queued or sent) and within app.monthly_summary_window_days() (14, lead's choice) days of it. The rule: paid_on
--     after the reminder's day in the business zone, or on that same day only when the payment was recorded after the
--     reminder (payments.created_at > done_at). `documents` and `payments` counts.
-- app.monthly_summary_counts is executable by authenticated only because the invoker report calls it; app is not exposed
-- by the API. No grant to anon, public or service_role.
--
-- Safe to run twice. No drop, no delete.

create or replace function app.monthly_summary_window_days() returns integer
language sql immutable
set search_path = ''
as $$ select 14 $$;

revoke all on function app.monthly_summary_window_days() from public, anon, authenticated, service_role;

create or replace function app.monthly_summary_counts(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_from_day date, p_to_day date, p_zone text
) returns jsonb
language plpgsql stable security definer
set search_path = ''
set jit = off
as $$
declare
  v_window integer := app.monthly_summary_window_days();
  v_leads bigint;
  v_automation_tasks bigint;
  v_collection_tasks bigint;
  v_signature_tasks bigint;
  v_renewal_tasks bigint;
  v_messages jsonb;
  v_docs bigint;
  v_payments bigint;
begin
  -- owners and admins only; anyone else learns nothing
  if p_org is null or not app.is_admin(p_org) then
    return null;
  end if;

  -- leads the server gave their owner (distinct). One bounded scan of the lead audit entries from the month's start:
  -- server inserts in the month, and owner changes from the month's start until now (the first one of a lead made in
  -- the month tells its owner at insert time).
  with entries as materialized (
    select a.id, a.entity_id, a.action, a.actor_id, a.created_at, a.changes
      from public.audit_log a
     where a.organization_id = p_org and a.created_at >= p_from
       and a.entity_type = 'leads'
       and ((a.action = 'insert' and a.created_at < p_to and a.actor_id is null)
            or (a.action = 'update' and a.changes ? 'owner_id'))
  ),
  first_change as (
    select distinct on (e.entity_id) e.entity_id, e.changes -> 'owner_id' ->> 'old' as old_owner
      from entries e
     where e.action = 'update'
     order by e.entity_id, e.created_at, e.id
  ),
  made as (
    select e.entity_id as id
      from entries e
      join public.leads l on l.organization_id = p_org and l.id = e.entity_id
      left join first_change f on f.entity_id = e.entity_id
     where e.action = 'insert' and l.created_by is null and l.import_job_id is null
       and case when f.entity_id is not null then f.old_owner is not null else l.owner_id is not null end
  ),
  moved as (
    select e.entity_id as id
      from entries e
     where e.action = 'update' and e.created_at < p_to
       and (e.changes -> 'owner_id' ->> 'new') is not null
       and (e.actor_id is null or e.changes ? 'automation')
  )
  select count(*) into v_leads from (select id from made union select id from moved) x;

  select count(*) into v_automation_tasks
    from public.audit_log a
   where a.organization_id = p_org and a.created_at >= p_from and a.created_at < p_to
     and a.entity_type = 'tasks' and a.action = 'insert' and a.changes ? 'automation';

  select count(distinct r.task_id) into v_collection_tasks
    from app.collection_reminders_sent r
    join public.tasks t on t.organization_id = r.organization_id and t.id = r.task_id
   where r.organization_id = p_org and t.created_at >= p_from and t.created_at < p_to;

  select count(*) into v_signature_tasks
    from app.signature_reminders s
    join public.tasks t on t.organization_id = s.organization_id and t.id = s.task_id
   where s.organization_id = p_org and t.created_at >= p_from and t.created_at < p_to;

  select count(*) into v_renewal_tasks
    from app.contract_renewal_tasks c
   where c.organization_id = p_org and c.created_at >= p_from and c.created_at < p_to;

  select jsonb_object_agg(k.kind, jsonb_build_object(
           'queued', coalesce(m.queued, 0),
           'sent', coalesce(m.sent, 0)))
    into v_messages
    from unnest(array['collection', 'meeting_reminder', 'instant_reply', 'review_request']) as k(kind)
    left join (
      select j.payload ->> 'message_type' as kind,
             count(*) filter (where j.status <> 'refused') as queued,
             count(*) filter (where j.message_outcome = 'sent') as sent
        from app.jobs j
       where j.organization_id = p_org and j.kind = 'message.send'
         and j.created_at >= p_from and j.created_at < p_to
         -- automatic sends only: a person's card send, reply or button press is not the system's work
         and not (j.payload ?| array['sent_by_user_id', 'reply_to_user_id', 'pressed_by_user_id'])
       group by 1
    ) m on m.kind = k.kind;

  with reminders as (
    select r.document_id, r.done_at, (r.done_at at time zone p_zone)::date as day
      from app.collection_reminders_sent r
     where r.organization_id = p_org and r.done_at is not null
       and r.done_at >= p_from - make_interval(days => v_window + 1) and r.done_at < p_to
       -- only a stage that really reminded: a task for the rep, or a message to the customer
       and (r.task_id is not null or r.customer_outcome in ('queued', 'sent'))
  ),
  paid as (
    select distinct a.document_id, a.payment_id
      from public.payment_allocations a
      join public.payments p on p.organization_id = a.organization_id and p.id = a.payment_id
     where a.organization_id = p_org and a.removed_at is null and a.released_at is null
       and p.status in ('recorded', 'confirmed')
       and p.paid_on >= p_from_day and p.paid_on < p_to_day
       and exists (select 1 from reminders x
                    where x.document_id = a.document_id
                      and p.paid_on <= x.day + v_window
                      and (p.paid_on > x.day or (p.paid_on = x.day and p.created_at > x.done_at)))
  )
  select count(distinct document_id), count(distinct payment_id) into v_docs, v_payments from paid;

  return jsonb_build_object(
    'leads_distributed', v_leads,
    'automation_tasks', v_automation_tasks,
    'reminder_tasks', jsonb_build_object(
      'collection', v_collection_tasks,
      'signature', v_signature_tasks,
      'contract_renewal', v_renewal_tasks),
    'customer_messages', v_messages,
    'collected_after_reminder', jsonb_build_object(
      'window_days', v_window,
      'documents', v_docs,
      'payments', v_payments));
end;
$$;

revoke all on function app.monthly_summary_counts(uuid, timestamptz, timestamptz, date, date, text) from public, anon, service_role;
grant execute on function app.monthly_summary_counts(uuid, timestamptz, timestamptz, date, date, text) to authenticated;

create or replace function public.report_monthly_summary(p_org uuid, p_month date default null)
returns jsonb
language plpgsql stable
set search_path = ''
set jit = off
as $$
declare
  v_zone text;
  v_month date;
  v_from timestamptz;
  v_to timestamptz;
  v_counts jsonb;
begin
  if p_org is null or not app.is_admin(p_org) then
    return jsonb_build_object('allowed', false);
  end if;
  select coalesce(o.timezone, 'Asia/Jerusalem') into v_zone from public.organizations o where o.id = p_org;
  if v_zone is null then
    return jsonb_build_object('allowed', false);
  end if;
  v_month := date_trunc('month', coalesce(p_month, (now() at time zone v_zone)::date))::date;
  if v_month < date '2000-01-01' or v_month > (now() at time zone v_zone)::date then
    raise exception 'invalid month' using errcode = '22023', hint = 'report:month';
  end if;
  v_from := v_month::timestamp at time zone v_zone;
  v_to := (v_month + interval '1 month')::timestamp at time zone v_zone;

  v_counts := app.monthly_summary_counts(p_org, v_from, v_to, v_month, (v_month + interval '1 month')::date, v_zone);
  if v_counts is null then
    return jsonb_build_object('allowed', false);
  end if;

  return jsonb_build_object(
    'allowed', true,
    'month', to_char(v_month, 'YYYY-MM-DD'),
    'leads_distributed', v_counts -> 'leads_distributed',
    'automation_tasks', v_counts -> 'automation_tasks',
    'reminder_tasks', v_counts -> 'reminder_tasks',
    'customer_messages', v_counts -> 'customer_messages',
    'collected_after_reminder', v_counts -> 'collected_after_reminder');
end;
$$;

revoke all on function public.report_monthly_summary(uuid, date) from public, anon;
grant execute on function public.report_monthly_summary(uuid, date) to authenticated;
