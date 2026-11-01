-- COL-04 follow-up of 021113 (the owner's answer (21) (א) of 1 November 2026: a task is detached when a rep moved it to another
-- record, i.e. changed its deal, contact or company so that they no longer belong to the document).
--
-- 021113 made app.close_paid_collection_tasks leave a detached task alone, but app.send_collection_reminders (last redefined in
-- 021108) could still move ("restage") a detached, still-open earlier reminder task to the next stage: retitle and re-date it.
-- This file gives both one rule:
-- * app.collection_task_attached(task deal, task contact, task company, document deal, document contact, document company)
--   (pure, immutable, no grants): the task's link of the kind of the document's first link (the deal when the document has one,
--   else its contact, else its company) equals the document's; a document with none of the three is never "attached".
-- * app.close_paid_collection_tasks: redefined from its latest body (021113) with the inline case expression replaced by the
--   helper. Same behaviour.
-- * app.send_collection_reminders: redefined from its latest body (021108). The only change: the open earlier reminder task is
--   moved to the new stage only while it is still attached. A detached task does not count as "the open reminder" of the
--   document: it belongs to the rep now and is never moved, retitled or re-dated by the job; the job makes a new, attached task
--   for the stage, as it already does when the earlier task cannot be moved (retitled, re-dated, owner gone), also while the
--   detached task is still open.
--   Also: a document with no deal, contact or company (its customer was purged and the foreign keys were set null) is left out
--   of the reminder candidates altogether: there is no customer to remind, and no task could ever be attached to it (each
--   offset would otherwise make a new task with no links that nothing ever closes). Nothing is recorded for it.
-- Safe to run twice. No object or row is removed.

create or replace function app.collection_task_attached(
  p_task_deal uuid, p_task_contact uuid, p_task_company uuid,
  p_doc_deal uuid, p_doc_contact uuid, p_doc_company uuid
) returns boolean
language sql immutable
set search_path = ''
as $$
  select case when p_doc_deal is not null then p_task_deal is not distinct from p_doc_deal
              when p_doc_contact is not null then p_task_contact is not distinct from p_doc_contact
              when p_doc_company is not null then p_task_company is not distinct from p_doc_company
              else false end
$$;
revoke all on function app.collection_task_attached(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

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
      select t.organization_id, t.id as task_id, t.status::text as task_status, j.id as judged_id, jd.status::text as doc_status,
             f.last_attempt_at, tn.served_at,
             row_number() over (partition by t.organization_id order by f.last_attempt_at nulls first, t.created_at, t.id) as n
        from app.collection_reminder_orgs(p_orgs) og(id)
        join public.tasks t on t.organization_id = og.id
        join public.accounting_documents d
          on d.organization_id = t.organization_id and d.id = t.collection_document_id
        -- the judged document: a proforma billed by an active tax invoice owes through the invoice (COL-03's rule)
        cross join lateral (
          select coalesce((select i.id from public.accounting_documents i
                            where d.doc_type = 'proforma' and i.organization_id = d.organization_id and i.proforma_id = d.id
                              and i.status = 'active'
                            limit 1), d.id) as id
        ) j
        join public.accounting_documents jd on jd.organization_id = d.organization_id and jd.id = j.id
        left join app.collection_task_closes f on f.task_id = t.id
        left join app.collection_reminder_turns tn on tn.organization_id = t.organization_id
       where t.collection_document_id is not null
         and t.deleted_at is null
         -- a repeating task is never closed (no next occurrence is made behind the person's back)
         and t.recurrence is null
         and coalesce(f.failures, 0) < 3
         -- not detached: the task still carries its document's first link (deal, else contact, else company)
         and app.collection_task_attached(t.deal_id, t.contact_id, t.company_id, d.deal_id, d.contact_id, d.company_id)
         and (
           -- "paid" closes and reopens only while the judged document is active (the owner's answer (4) ב)
           (jd.status = 'active' and (
             -- to close: open and not closed by the system before (a system-closed task that is open again was reopened by a
             -- person: the system reopen clears the marker), no status change by a person ever, and the cheap cut says paid
             (t.status = 'open' and f.closed_at is null
              and app.collection_document_paid(jd.organization_id, jd.id) >= jd.amount_agorot
              and not exists (select 1 from public.audit_log al
                               where al.organization_id = t.organization_id and al.entity_type = 'tasks' and al.entity_id = t.id
                                 and al.action = 'update' and al.changes ? 'status' and al.actor_id is not null))
             or
             -- to reopen: closed by the system, still done, no status change by anyone since that close, and owed again
             (t.status = 'done' and f.closed_at is not null
              and app.collection_document_paid(jd.organization_id, jd.id) < jd.amount_agorot
              and not exists (select 1 from public.audit_log al
                               where al.organization_id = t.organization_id and al.entity_type = 'tasks' and al.entity_id = t.id
                                 and al.action = 'update' and al.changes ? 'status' and al.created_at > f.closed_at))
           ))
           or
           -- a cancelled document closes its open task (the owner's answer (20) א, 1 November 2026), under the same rules as
           -- "paid" (open, no marker, no status change by a person ever); no money is read; never reopened (a cancelled
           -- document is never un-cancelled, and the reopen above needs an active document)
           (jd.status = 'cancelled' and t.status = 'open' and f.closed_at is null
            and not exists (select 1 from public.audit_log al
                             where al.organization_id = t.organization_id and al.entity_type = 'tasks' and al.entity_id = t.id
                               and al.action = 'update' and al.changes ? 'status' and al.actor_id is not null))
         )
    ) z
     where z.n <= app.collection_reminder_per_org()
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.task_id
     limit app.collection_reminder_limit()
  loop
    begin
      if v_row.doc_status = 'cancelled' then
        if v_row.task_status = 'open' then
          v_note := 'נסגרה: המסמך בוטל';
          update public.tasks t
             set status = 'done', outcome = v_note
           where t.organization_id = v_row.organization_id and t.id = v_row.task_id
             and t.status = 'open' and t.deleted_at is null;
          if found then
            insert into app.collection_task_closes (task_id, organization_id, failures, last_attempt_at, closed_at, outcome)
            values (v_row.task_id, v_row.organization_id, 0, null, now(), v_note)
            on conflict (task_id) do update
              set failures = 0, last_attempt_at = null, closed_at = excluded.closed_at, outcome = excluded.outcome;
            v_done := v_done + 1;
          end if;
        end if;
        continue;
      end if;
      select coalesce((x ->> 'balance')::bigint, 0) into v_balance
        from jsonb_array_elements(public.money_allocation_state(v_row.organization_id, array[v_row.judged_id], '{}'::uuid[]) -> 'documents') x
       where (x ->> 'id')::uuid = v_row.judged_id;
      v_balance := coalesce(v_balance, 0);
      if v_row.task_status = 'open' and v_balance <= 0 then
        v_note := 'נסגרה: החוב שולם';
        update public.tasks t
           set status = 'done', outcome = v_note
         where t.organization_id = v_row.organization_id and t.id = v_row.task_id
           and t.status = 'open' and t.deleted_at is null;
        if found then
          insert into app.collection_task_closes (task_id, organization_id, failures, last_attempt_at, closed_at, outcome)
          values (v_row.task_id, v_row.organization_id, 0, null, now(), v_note)
          on conflict (task_id) do update
            set failures = 0, last_attempt_at = null, closed_at = excluded.closed_at, outcome = excluded.outcome;
          v_done := v_done + 1;
        end if;
      elsif v_row.task_status = 'done' and v_balance > 0 then
        -- the debt came back (a payment failed, an allocation was released): the task the system closed is open again.
        -- The outcome is cleared only while it is still the system's own note (a person's edited outcome is kept), and
        -- only while the task's owner is still an active, full-seat member who is not a viewer (else it stays done; the
        -- reminder job makes a new task at the next stage)
        update public.tasks t
           set status = 'open',
               outcome = case when t.outcome is not distinct from c.outcome then null else t.outcome end
          from app.collection_task_closes c
         where c.task_id = t.id
           and t.organization_id = v_row.organization_id and t.id = v_row.task_id
           and t.status = 'done' and t.deleted_at is null
           and exists (select 1 from public.memberships m
                        where m.organization_id = t.organization_id and m.user_id = t.owner_id
                          and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full');
        if found then
          update app.collection_task_closes c
             set closed_at = null, outcome = null, failures = 0, last_attempt_at = null
           where c.task_id = v_row.task_id;
          v_done := v_done + 1;
        end if;
      end if;
    exception when others then
      insert into app.collection_task_closes (task_id, organization_id, failures, last_attempt_at)
      values (v_row.task_id, v_row.organization_id, 1, now())
      on conflict (task_id)
        do update set failures = app.collection_task_closes.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-collection-reminders: closing task % failed (SQLSTATE %)%', v_row.task_id, sqlstate,
        case when coalesce((select c.failures from app.collection_task_closes c where c.task_id = v_row.task_id), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.close_paid_collection_tasks(uuid[]) from public, anon, authenticated, service_role;

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
    -- answers (review): the businesses first (writable, the three keys), then the documents that can be due at all, and only
    -- then the per-document rule (app.collection_reminder_at)
    with cand as materialized (
      select d.organization_id, d.id, d.doc_type, d.number, d.due_date, d.deal_id, d.contact_id, d.company_id, d.amount_agorot,
             o.timezone
        from app.collection_reminder_orgs(p_orgs) og(id)
        join public.organizations o on o.id = og.id
        join public.accounting_documents d on d.organization_id = og.id
       where d.status = 'active'
         and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
         and d.amount_agorot > 0
         -- 021116: a document with no customer left (deal, contact and company all purged) gets no reminder
         and (d.deal_id is not null or d.contact_id is not null or d.company_id is not null)
         -- a cheap bound first (every zone's today is within a day of the server's): an offset's day is reached only while
         -- today - due is in -3..20 plus the days it was moved (answers (2): up to 30), so nothing outside it can be due
         and d.due_date between current_date - 52 and current_date + 4
         -- a proforma billed by an active tax invoice owes through the invoice
         and not (d.doc_type = 'proforma'
                  and exists (select 1 from public.accounting_documents i
                               where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
         -- a document whose deal, contact or company is in the recycle bin waits (nothing is recorded)
         and not exists (select 1 from public.deals dl where dl.organization_id = d.organization_id and dl.id = d.deal_id and dl.deleted_at is not null)
         and not exists (select 1 from public.contacts ct where ct.organization_id = d.organization_id and ct.id = d.contact_id and ct.deleted_at is not null)
         and not exists (select 1 from public.companies co where co.organization_id = d.organization_id and co.id = d.company_id and co.deleted_at is not null)
         -- a cheap first cut (public.collection_documents' candidates); the balance itself is read below
         and coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                        where a.organization_id = d.organization_id and a.document_id = d.id
                          and a.released_at is null and a.removed_at is null), 0)
             + coalesce((select sum(oc.amount_agorot) from public.opening_credit_allocations oc
                          where oc.organization_id = d.organization_id and oc.document_id = d.id
                            and oc.released_at is null and oc.removed_at is null), 0)
             < d.amount_agorot
    )
    select z.* from (
      select d.organization_id, d.id, d.doc_type, d.number, d.due_date, d.deal_id, d.contact_id, d.company_id,
             c.today, c.zone, c.offset_days, c.reminder_day, s.last_attempt_at, tn.served_at,
             -- a document that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by d.organization_id order by s.last_attempt_at nulls first, d.due_date, d.id) as n
        from cand d
        cross join lateral (
          select (now() at time zone app.intake_zone(d.timezone))::date as today, app.intake_zone(d.timezone) as zone
        ) t0
        -- answers (2): the reminder moved to the business's next working day (app.collection_reminder_at)
        cross join lateral (
          select t0.today, t0.zone, r.offset_days, r.reminder_day
            -- no day (nothing to do, the rule is not evaluated) outside the bound or before 08:00 in the business's zone
            from app.collection_reminder_at(d.organization_id, d.due_date,
                                            case when d.due_date between t0.today - 50 and t0.today + 3
                                                      and (now() at time zone t0.zone)::time >= time '08:00'
                                                 then t0.today end) r
        ) c
        left join app.collection_reminders_sent s
          on s.document_id = d.id and s.due_date = d.due_date and s.offset_days = c.offset_days
        left join app.collection_reminder_turns tn on tn.organization_id = d.organization_id
       where c.offset_days is not null
         and (s.document_id is null or (s.done_at is null and s.failures < 3))
         -- COL-03: a promise holds the reminders; nothing is recorded, so the offset is judged again after the promise. Here,
         -- before the per-business cap, so held documents never take the places of the others
         and app.collection_held_until(d.organization_id, d.id) is null
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
        -- job left it (its title and due time unchanged: a person who retitled or re-dated it keeps it), still attached to
        -- its document (021116: a task a rep moved to another record belongs to the rep, app.collection_task_attached, the
        -- rule of app.close_paid_collection_tasks) and its owner is still an active, full-seat member who is not a viewer;
        -- otherwise a new task is made
        select t.id into v_task
          from public.tasks t
          join app.collection_reminders_sent s
            on s.organization_id = t.organization_id and s.task_id = t.id and s.document_id = v_row.id
          join public.memberships m
            on m.organization_id = t.organization_id and m.user_id = t.owner_id
           and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
         where t.organization_id = v_row.organization_id and t.collection_document_id = v_row.id
           and t.status = 'open' and t.deleted_at is null
           and app.collection_task_attached(t.deal_id, t.contact_id, t.company_id, v_row.deal_id, v_row.contact_id, v_row.company_id)
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
