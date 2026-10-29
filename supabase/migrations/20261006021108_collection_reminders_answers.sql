-- =============================================================================
-- COL-04, the owner's answers of 29 October 2026 (docs/DECISIONS.md "תזכורות גבייה"): (1) (א) the collection WhatsApp
-- template is added now to every existing business that has none; (2) (ב) a reminder whose day is a rest day or holiday of the
-- business is made on the next working day; (3) the final wording of the template; (4) (ב) the system closes a reminder task by
-- itself once the debt is paid, with the note "נסגרה: החוב שולם".
-- =============================================================================
-- (2) The reminder day of offset k is app.add_business_days' rule with n = 0 (the calendar day due + k itself when the business
--     works on it, else its next working day; CAL-03 settings), here walked with app.rest_day_with and the settings read once
--     (keep in step with app.add_business_days; a day with no working day within 366 days stays as it is, like nextWorkingDay()).
--     app.collection_reminder_at(org, due, today) is the one rule (mirrored by collectionReminderAt() in
--     src/features/collection/reminders.ts; test 267 compares them day by day for several settings): on a WORKING day of the
--     business, the latest offset whose reminder day has come, for 7 days from that reminder day (so a long holiday never eats
--     the window); a rest day makes nothing. The once-key stays (document, due date, OFFSET): two offsets moved onto the same
--     day give the later one only, and a shift never repeats a reminder. The task's title names the stage by the reminder day
--     (app.collection_reminder_stage(reminder day - due date): "מחר מועד התשלום", "יום אחרי מועד התשלום" ...; equal to the old
--     four texts when nothing moved). The title the job gave is now kept in app.collection_reminders_sent.task_title, so a task
--     is still recognised as "as the job left it" whatever its stage text was (rows made before this keep the old rule).
--     The cheap bound on the due date widens to today - 50 (a reminder moved by more than 30 days of rest in a row is not made).
-- (1) app.collection_template_backfill(p_orgs) inserts the template once into every business that has no template of kind
--     'collection_reminder' (renamed or not): name "תזכורת לתשלום", else "תזכורת גבייה" when a template of that name exists,
--     else the business is skipped; a business at the 50-template cap is skipped; insert only (on conflict do nothing), at the end
--     of the list. Run once below for every business. The app keeps offering the same text unsaved when a business has no such
--     template (deleted later, or skipped here).
-- (3) app.seed_whatsapp_templates gets the final wording (mirrored by DEFAULT_TEMPLATES and COLLECTION_REMINDER_TEXT). Templates
--     businesses already have are not rewritten.
-- (4) app.close_paid_collection_tasks(p_orgs), run by app.send_collection_reminders first (the same pg_cron job every 15 minutes):
--     an open, not binned task marked with tasks.collection_document_id is set done with outcome "נסגרה: החוב שולם" when its
--     document has no balance (public.money_allocation_state; a proforma billed by an active tax invoice is judged by that
--     invoice, as COL-03 judges it), or "נסגרה: המסמך בוטל" when the document is cancelled. Never a task whose status a person
--     ever changed (any audit 'update' entry of the task that names status: a person closed it, or reopened it after the
--     system closed it). Only in a writable business (not gated by plan keys: it only tidies a task the feature made). Fair like
--     the reminders: 200 per business and 2,000 per run (the same settings), businesses by their turn, failures after fresh ones
--     and skipped after 3 (app.collection_task_closes, no grants, RLS on); each task in its own exception block with one
--     redacted warning line. The close is an ordinary task update (audited with no actor; automations see "task done").
-- Every statement is safe to run twice. No object or row is removed.

-- ----------------------------------------------------------------------------
-- (2) The stage, by the days between the reminder day and the due date (mirrored by collectionReminderStage)
-- ----------------------------------------------------------------------------
create or replace function app.collection_reminder_stage(p_offset integer) returns text
language sql immutable
set search_path = ''
as $$
  select case
           when p_offset is null then null
           when p_offset = 0 then 'היום מועד התשלום'
           when p_offset = -1 then 'מחר מועד התשלום'
           when p_offset = -2 then 'בעוד יומיים מועד התשלום'
           when p_offset < 0 then 'בעוד ' || (-p_offset)::text || ' ימים מועד התשלום'
           when p_offset = 1 then 'יום אחרי מועד התשלום'
           when p_offset = 2 then 'יומיים אחרי מועד התשלום'
           else p_offset::text || ' ימים אחרי מועד התשלום'
         end;
$$;
revoke all on function app.collection_reminder_stage(integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (2) The rule: which reminder is due on p_today, and its (moved) day
-- ----------------------------------------------------------------------------
create or replace function app.collection_reminder_at(p_org uuid, p_due date, p_today date,
                                                      out offset_days integer, out reminder_day date)
language plpgsql stable
set search_path = ''
as $$
declare
  -- the defaults of app.org_rest_day() when the business has no settings row (as app.add_business_days)
  v_weekdays smallint[] := '{5,6}';
  v_holidays boolean := true;
  v_eves boolean := false;
  v_occasions text[] := '{}';
  v_row record;
  v_k integer;
  v_day date;
  v_off integer;
begin
  if p_org is null or p_due is null or p_today is null or p_today < p_due - 3 then
    return;
  end if;
  select c.rest_weekdays, c.holidays_rest, c.holiday_eves_rest, c.rest_occasions into v_row
    from public.org_calendar_settings c
   where c.organization_id = p_org;
  if found then
    v_weekdays := v_row.rest_weekdays;
    v_holidays := v_row.holidays_rest;
    v_eves := v_row.holiday_eves_rest;
    v_occasions := v_row.rest_occasions;
  end if;
  -- nothing is made on a rest day of the business
  if app.rest_day_with(p_today, v_weekdays, v_holidays, v_eves, v_occasions) then
    return;
  end if;
  foreach v_k in array (select array_agg(k order by k desc) from unnest(app.collection_reminder_offsets()) k) loop
    -- the calendar day not reached yet: its working day cannot have come either
    continue when p_due + v_k > p_today;
    -- the day itself, else the next working day (app.add_business_days(org, day, 0)); none within 366 days: the day itself
    v_day := p_due + v_k;
    v_off := 0;
    while app.rest_day_with(v_day, v_weekdays, v_holidays, v_eves, v_occasions) loop
      v_off := v_off + 1;
      if v_off > 366 then
        v_day := p_due + v_k;
        exit;
      end if;
      v_day := v_day + 1;
    end loop;
    continue when v_day > p_today;
    -- the latest offset whose day has come; its 7 days counted from that day, else nothing (an earlier one ended before it)
    if p_today < v_day + 7 then
      offset_days := v_k;
      reminder_day := v_day;
    end if;
    return;
  end loop;
end;
$$;
revoke all on function app.collection_reminder_at(uuid, date, date) from public, anon, authenticated, service_role;

-- the title the job gave its task (the stage text depends on the moved day, so the job keeps it)
alter table app.collection_reminders_sent add column if not exists task_title text;

-- ----------------------------------------------------------------------------
-- (4) Closing a reminder task once the debt is paid
-- ----------------------------------------------------------------------------
create table if not exists app.collection_task_closes (
  task_id          uuid primary key references public.tasks (id) on delete cascade,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  failures         integer not null default 0,
  last_attempt_at  timestamptz
);
create index if not exists collection_task_closes_org_idx on app.collection_task_closes (organization_id);
alter table app.collection_task_closes enable row level security;
revoke all on app.collection_task_closes from public, anon, authenticated, service_role;

create or replace function app.close_paid_collection_tasks(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_balance bigint;
  v_note text;
  v_done integer := 0;
begin
  for v_row in
    select z.* from (
      select t.organization_id, t.id as task_id, d.status as doc_status, coalesce(bi.id, d.id) as judged_id,
             f.last_attempt_at, tn.served_at,
             row_number() over (partition by t.organization_id order by f.last_attempt_at nulls first, t.created_at, t.id) as n
        from public.tasks t
        join public.accounting_documents d
          on d.organization_id = t.organization_id and d.id = t.collection_document_id
        -- a proforma billed by an active tax invoice owes through the invoice (COL-03's rule)
        left join lateral (
          select i.id, i.amount_agorot, i.proforma_id
            from public.accounting_documents i
           where d.doc_type = 'proforma' and i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'
           limit 1
        ) bi on true
        left join app.collection_task_closes f on f.task_id = t.id
        left join app.collection_reminder_turns tn on tn.organization_id = t.organization_id
       where (p_orgs is null or t.organization_id = any (p_orgs))
         and t.collection_document_id is not null
         and t.status = 'open'
         and t.deleted_at is null
         and coalesce(f.failures, 0) < 3
         and app.org_writable(t.organization_id)
         -- cancelled, or a cheap first cut of "paid" (a superset: every counted allocation and opening-credit offset on the
         -- judged document and on any proforma it bills); the balance itself is read below
         and (d.status <> 'active'
              or coalesce(bi.amount_agorot, d.amount_agorot) <=
                 coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                            where a.organization_id = d.organization_id
                              and a.document_id in (coalesce(bi.id, d.id), coalesce(bi.proforma_id, d.proforma_id))
                              and a.released_at is null and a.removed_at is null), 0)
                 + coalesce((select sum(oc.amount_agorot) from public.opening_credit_allocations oc
                              where oc.organization_id = d.organization_id
                                and oc.document_id in (coalesce(bi.id, d.id), coalesce(bi.proforma_id, d.proforma_id))
                                and oc.released_at is null and oc.removed_at is null), 0))
         -- never a task whose status a person changed (closed it, or reopened it after it was closed)
         and not exists (select 1 from public.audit_log al
                           where al.organization_id = t.organization_id and al.entity_type = 'tasks' and al.entity_id = t.id
                             and al.action = 'update' and al.changes ? 'status')
    ) z
     where z.n <= app.collection_reminder_per_org()
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.task_id
     limit app.collection_reminder_limit()
  loop
    begin
      v_note := null;
      if v_row.doc_status <> 'active' then
        v_note := 'נסגרה: המסמך בוטל';
      else
        select coalesce((x ->> 'balance')::bigint, 0) into v_balance
          from jsonb_array_elements(public.money_allocation_state(v_row.organization_id, array[v_row.judged_id], '{}'::uuid[]) -> 'documents') x
         where (x ->> 'id')::uuid = v_row.judged_id;
        if coalesce(v_balance, 0) <= 0 then
          v_note := 'נסגרה: החוב שולם';
        end if;
      end if;
      if v_note is not null then
        update public.tasks t
           set status = 'done', outcome = v_note
         where t.organization_id = v_row.organization_id and t.id = v_row.task_id
           and t.status = 'open' and t.deleted_at is null;
        if found then
          v_done := v_done + 1;
        end if;
      end if;
    exception when others then
      insert into app.collection_task_closes (task_id, organization_id, failures, last_attempt_at)
      values (v_row.task_id, v_row.organization_id, 1, now())
      on conflict (task_id)
        do update set failures = app.collection_task_closes.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-collection-reminders: closing task % failed (SQLSTATE %)', v_row.task_id, sqlstate;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.close_paid_collection_tasks(uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job: app.send_collection_reminders copied from its latest body (021101, collection_reminders) with the changes of (2)
-- and (4), each marked "answers"
-- ----------------------------------------------------------------------------
create or replace function app.send_collection_reminders(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_balance bigint;
  v_rep uuid;
  v_task uuid;
  v_title text;
  v_due_at timestamptz;
  v_done integer := 0;
  v_served uuid[] := '{}'::uuid[];
begin
  -- answers (4): first close the reminder tasks whose debt was paid
  perform app.close_paid_collection_tasks(p_orgs);

  for v_row in
    select z.* from (
      select d.organization_id, d.id, d.doc_type, d.number, d.due_date, d.deal_id, d.contact_id, d.company_id,
             c.today, c.zone, c.offset_days, c.reminder_day, s.last_attempt_at, tn.served_at,
             -- a document that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by d.organization_id order by s.last_attempt_at nulls first, d.due_date, d.id) as n
        from public.accounting_documents d
        join public.organizations o on o.id = d.organization_id
        cross join lateral (
          select (now() at time zone app.intake_zone(o.timezone))::date as today, app.intake_zone(o.timezone) as zone
        ) t0
        -- answers (2): the reminder moved to the business's next working day (app.collection_reminder_at)
        cross join lateral (
          select t0.today, t0.zone, r.offset_days, r.reminder_day
            from app.collection_reminder_at(d.organization_id, d.due_date, t0.today) r
        ) c
        left join app.collection_reminders_sent s
          on s.document_id = d.id and s.due_date = d.due_date and s.offset_days = c.offset_days
        left join app.collection_reminder_turns tn on tn.organization_id = d.organization_id
       where (p_orgs is null or d.organization_id = any (p_orgs))
         and d.status = 'active'
         and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
         and d.amount_agorot > 0
         -- a cheap bound first (every zone's today is within a day of the server's): an offset's day is reached only while
         -- today - due is in -3..20 plus the days it was moved (answers (2): up to 30), so nothing outside it can be due
         and d.due_date between current_date - 52 and current_date + 4
         and d.due_date between c.today - 50 and c.today + 3
         and c.offset_days is not null
         and (now() at time zone c.zone)::time >= time '08:00'
         and (s.document_id is null or (s.done_at is null and s.failures < 3))
         and app.org_writable(d.organization_id)
         and app.org_has_feature(d.organization_id, 'collection')
         and app.org_has_feature(d.organization_id, 'documents')
         and app.org_has_feature(d.organization_id, 'payments')
         -- a proforma billed by an active tax invoice owes through the invoice
         and not (d.doc_type = 'proforma'
                  and exists (select 1 from public.accounting_documents i
                               where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
         -- a document whose deal, contact or company is in the recycle bin waits (nothing is recorded)
         and not exists (select 1 from public.deals dl where dl.organization_id = d.organization_id and dl.id = d.deal_id and dl.deleted_at is not null)
         and not exists (select 1 from public.contacts ct where ct.organization_id = d.organization_id and ct.id = d.contact_id and ct.deleted_at is not null)
         and not exists (select 1 from public.companies co where co.organization_id = d.organization_id and co.id = d.company_id and co.deleted_at is not null)
         -- COL-03: a promise holds the reminders; nothing is recorded, so the offset is judged again after the promise. Here,
         -- before the per-business cap, so held documents never take the places of the others
         and app.collection_held_until(d.organization_id, d.id) is null
         -- a cheap first cut (public.collection_documents' candidates); the balance itself is read below
         and coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                        where a.organization_id = d.organization_id and a.document_id = d.id
                          and a.released_at is null and a.removed_at is null), 0)
             + coalesce((select sum(oc.amount_agorot) from public.opening_credit_allocations oc
                          where oc.organization_id = d.organization_id and oc.document_id = d.id
                            and oc.released_at is null and oc.removed_at is null), 0)
             < d.amount_agorot
    ) z
     where z.n <= app.collection_reminder_per_org()
     -- businesses take turns: every business's first document, then every business's second, ...; among businesses, the
     -- one served longest ago first (app.collection_reminder_turns), so a business with many documents never blocks another
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.due_date, z.id
     limit app.collection_reminder_limit()
  loop
    v_rep := null;
    v_task := null;
    v_balance := null;
    if not (v_row.organization_id = any (v_served)) then
      v_served := v_served || v_row.organization_id;
    end if;
    begin
      select coalesce((x ->> 'balance')::bigint, 0) into v_balance
        from jsonb_array_elements(public.money_allocation_state(v_row.organization_id, array[v_row.id], '{}'::uuid[]) -> 'documents') x
       where (x ->> 'id')::uuid = v_row.id;

      if coalesce(v_balance, 0) > 0 then
        -- answers (2): the stage by the (moved) reminder day
        v_title := left('תזכורת גבייה: ' || app.document_type_label(v_row.doc_type) || coalesce(' ' || v_row.number, '')
                        || ' · ' || app.collection_reminder_stage(v_row.reminder_day - v_row.due_date), 300);
        v_due_at := greatest(now(), (v_row.today + time '12:00') at time zone v_row.zone);

        -- one open reminder task per document: a still-open earlier one moves to this stage, but only while it is as the
        -- job left it (its title and due time unchanged: a person who retitled or re-dated it keeps it) and its owner is
        -- still an active, full-seat member who is not a viewer; otherwise a new task is made
        select t.id into v_task
          from public.tasks t
          join app.collection_reminders_sent s
            on s.organization_id = t.organization_id and s.task_id = t.id and s.document_id = v_row.id
          join public.memberships m
            on m.organization_id = t.organization_id and m.user_id = t.owner_id
           and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
         where t.organization_id = v_row.organization_id and t.collection_document_id = v_row.id
           and t.status = 'open' and t.deleted_at is null
           and t.due_at = s.task_due_at
           -- answers (2): the title the job kept; rows made before it, the old rule
           and t.title = coalesce(s.task_title,
                                  left('תזכורת גבייה: ' || app.document_type_label(v_row.doc_type) || coalesce(' ' || v_row.number, '')
                                       || ' · ' || app.collection_reminder_stage(s.offset_days), 300))
         order by s.done_at desc nulls last, t.created_at desc, t.id
         limit 1;

        if v_task is not null then
          update public.tasks t
             set title = v_title, due_at = v_due_at
           where t.organization_id = v_row.organization_id and t.id = v_task;
        else
          -- the rep (MNY-01's owner rule), else the business's owner, else its oldest admin
          select m.user_id into v_rep
            from public.memberships m
           where m.organization_id = v_row.organization_id and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
             and m.user_id = (select coalesce(dl.owner_id, ct.owner_id, co.owner_id)
                                from (select 1) one
                                left join public.deals dl on dl.organization_id = v_row.organization_id and dl.id = v_row.deal_id
                                left join public.contacts ct on ct.organization_id = v_row.organization_id and ct.id = v_row.contact_id
                                left join public.companies co on co.organization_id = v_row.organization_id and co.id = v_row.company_id);
          if v_rep is null then
            select m.user_id into v_rep
              from public.memberships m
             where m.organization_id = v_row.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
             order by (m.role = 'owner') desc, m.created_at, m.user_id
             limit 1;
          end if;

          insert into public.tasks (organization_id, title, task_type, due_at, priority, owner_id,
                                    deal_id, contact_id, company_id, collection_document_id)
          values (v_row.organization_id, v_title, 'todo', v_due_at, 2, v_rep,
                  v_row.deal_id, v_row.contact_id, v_row.company_id, v_row.id)
          returning id into v_task;
        end if;
      else
        v_task := null;
        v_due_at := null;
        v_title := null;
      end if;

      insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, task_id, task_due_at, task_title, done_at)
      values (v_row.organization_id, v_row.id, v_row.due_date, v_row.offset_days, v_task, v_due_at, v_title, now())
      on conflict (document_id, due_date, offset_days)
        do update set task_id = excluded.task_id, task_due_at = excluded.task_due_at, task_title = excluded.task_title,
                      done_at = excluded.done_at;
      v_done := v_done + 1;
    exception when others then
      -- this document's reminder is tried again on a later run, after the fresh ones; after 3 failures it is skipped. One
      -- redacted line: the document id and the SQLSTATE only
      insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, failures, last_attempt_at)
      values (v_row.organization_id, v_row.id, v_row.due_date, v_row.offset_days, 1, now())
      on conflict (document_id, due_date, offset_days)
        do update set failures = app.collection_reminders_sent.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-collection-reminders: document % failed (SQLSTATE %)%', v_row.id, sqlstate,
        case when coalesce((select s.failures from app.collection_reminders_sent s
                             where s.document_id = v_row.id and s.due_date = v_row.due_date and s.offset_days = v_row.offset_days), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;

  -- the businesses served in this run go to the back of the line
  insert into app.collection_reminder_turns (organization_id, served_at)
  select o, clock_timestamp() from unnest(v_served) o
  on conflict (organization_id) do update set served_at = excluded.served_at;
  return v_done;
end;
$$;
revoke all on function app.send_collection_reminders(uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (3) The final wording for new businesses (app.seed_whatsapp_templates copied from 021101, the collection text changed)
-- ----------------------------------------------------------------------------
create or replace function app.seed_whatsapp_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.whatsapp_templates (organization_id, name, body, position, kind)
  select p_org, d.name, d.body, (d.n - 1)::integer, d.kind
    from (values
      (1, 'פנייה ראשונה',
          'שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}. קיבלנו את הפנייה שלך. מתי נוח לך לדבר?', null::text),
      (2, 'לא הצלחנו להשיג',
          'שלום {שם פרטי}, ניסיתי להתקשר אליך ולא הצלחתי להשיג. מתי נוח שאחזור אליך? {שם הנציג}, {שם העסק}', null),
      (3, 'תזכורת לפגישה מחר',
          'שלום {שם פרטי}, תזכורת לפגישה שלנו מחר, {תאריך} בשעה {שעה}. אם צריך לשנות, אפשר לכתוב לי כאן. {שם הנציג}, {שם העסק}', 'meeting_reminder'),
      (4, 'תודה על השיחה',
          'תודה {שם פרטי}, היה נעים לדבר. אם יש שאלות, אני כאן. {שם הנציג}, {שם העסק}', null),
      (5, 'תזכורת לתשלום',
          'שלום {שם פרטי}, תזכורת: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה, ואפשר להתעלם מההודעה. {שם הנציג}, {שם העסק}', 'collection_reminder')
    ) as d(n, name, body, kind)
   where not exists (select 1 from public.whatsapp_templates t where t.organization_id = p_org)
   order by d.n;
end;
$$;
revoke all on function app.seed_whatsapp_templates(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- (1) The template for every existing business that has none (insert only)
-- ----------------------------------------------------------------------------
create or replace function app.collection_template_backfill(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with added as (
    insert into public.whatsapp_templates (organization_id, name, body, position, kind)
    select o.id, nm.name,
           'שלום {שם פרטי}, תזכורת: {מסמך} על סך {סכום}, מועד התשלום {מועד תשלום}. אם כבר שילמתם, תודה, ואפשר להתעלם מההודעה. {שם הנציג}, {שם העסק}',
           coalesce((select max(t.position) + 1 from public.whatsapp_templates t where t.organization_id = o.id), 0),
           'collection_reminder'
      from public.organizations o
      -- the first of the two names the business does not use already (names are unique ignoring case); none = skipped
      cross join lateral (
        select x.name from (values (1, 'תזכורת לתשלום'), (2, 'תזכורת גבייה')) as x(i, name)
         where not exists (select 1 from public.whatsapp_templates t where t.organization_id = o.id and lower(t.name) = lower(x.name))
         order by x.i
         limit 1
      ) nm
     where (p_orgs is null or o.id = any (p_orgs))
       -- already has one, renamed or not
       and not exists (select 1 from public.whatsapp_templates t where t.organization_id = o.id and t.kind = 'collection_reminder')
       -- at the 50-template cap: skipped, never a failure
       and (select count(*) from public.whatsapp_templates t where t.organization_id = o.id) < 50
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_count from added;
  return v_count;
end;
$$;
revoke all on function app.collection_template_backfill(uuid[]) from public, anon, authenticated, service_role;

select app.collection_template_backfill();
