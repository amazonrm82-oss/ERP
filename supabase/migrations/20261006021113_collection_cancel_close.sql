-- COL-04 (20), the owner's answer of 1 November 2026, (א): when a reminder task's document is CANCELLED, the system closes the
-- open reminder task with outcome "נסגרה: המסמך בוטל".
--
-- app.close_paid_collection_tasks is redefined from its latest body (021108, collection_reminders_answers). Changes:
-- * a third branch: an open, not binned task marked with tasks.collection_document_id, without a repeat rule, never closed by the
--   system before (no marker: an open marked task was reopened by someone else) and whose status no person ever changed, is set
--   done with outcome "נסגרה: המסמך בוטל" when the task's own document has status 'cancelled'. No balance is read for it.
-- * the loop chooses the note by the document's status (doc_status in the row).
-- Unchanged: only tasks with tasks.collection_document_id are touched (a task detached from its document, null, is never closed by
-- itself: the owner's exception); the businesses (app.collection_reminder_orgs: writable, the three plan keys); the caps and turns;
-- the marker (app.collection_task_closes.closed_at / outcome); the per-task exception block; the "paid" close; the reopen, which
-- still needs an ACTIVE document, so a cancelled document never "owes again" (a document is never un-cancelled). A task the system
-- closed as paid whose document is cancelled later keeps its "paid" note. The cheap cut (app.collection_document_paid) only
-- narrows the paid and reopen branches; the cancel branch reads no money.
-- Safe to run twice. No object or row is removed.

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
      select t.organization_id, t.id as task_id, t.status::text as task_status, j.id as judged_id, d.status::text as doc_status,
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
         and (
           -- "paid" closes and reopens only while the task's document is active (the owner's answer (4) ב)
           (d.status = 'active' and (
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
           (d.status = 'cancelled' and t.status = 'open' and f.closed_at is null
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
