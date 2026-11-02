-- =============================================================================
-- HEB-09 answer: a collection reminder task made while customer sending is paused says so
-- =============================================================================
-- Owner, 2 November 2026, answer (45) א plus one addition: collection reminder tasks (COL-04) keep being made while
-- the business has paused automatic sending to customers (they go to the business's own rep, who sends by hand), and a
-- reminder task made WHILE sending is paused carries the line "השליחה ללקוחות עצורה" in its description (the field the
-- job writes; null otherwise). Read through app.customer_sending_paused(org), the one rule (migration
-- customer_sending_pause). The task row's WhatsApp button shows the same line (COLLECTION_PAUSED_LINE in
-- src/features/sending-pause/pause.ts, a unit test compares it with this file).
-- app.send_collection_reminders is redefined from the exact body of collection_detached_restage (021116); only the new
-- task's insert changes (description). An earlier task moved to a new stage during a pause keeps its description.
-- Safe to run twice.

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

          -- HEB-09 (owner 2 November 2026, answer (45) א): the task is still made while customer sending is paused,
          -- and then says so
          insert into public.tasks (organization_id, title, task_type, due_at, priority, owner_id,
                                    deal_id, contact_id, company_id, collection_document_id, description)
          values (v_row.organization_id, v_title, 'todo', v_due_at, 2, v_rep,
                  v_row.deal_id, v_row.contact_id, v_row.company_id, v_row.id,
                  case when app.customer_sending_paused(v_row.organization_id) then 'השליחה ללקוחות עצורה' end)
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
