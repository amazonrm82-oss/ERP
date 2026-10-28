-- =============================================================================
-- COL-04: collection reminders on a schedule (spec 7.5): 3 days before the due date, on the due date, and 7 and 14 days after
-- it. Until there is a sending provider (COL-07, wave 3), each reminder is a TASK for the rep, and the task offers a WhatsApp
-- button with a collection template (WA-01). Plan keys `collection`, `documents` and `payments` (COL-01's keys, owner's answer
-- (4) א of 28 October 2026).
-- =============================================================================
-- * Which documents: BAL-02's debt (an active tax invoice, proforma or positive opening balance with a balance in
--   public.money_allocation_state) that has a due date (PAY-02). A proforma billed by an active tax invoice is left out: its
--   debt is the invoice's, and the invoice has its own due date. A paid or cancelled document gets nothing (spec 7.6: "a
--   collection reminder is not sent after the debt was paid").
-- * When: the offsets -3, 0, +7, +14 CALENDAR days from the due date, in the business's zone (app.collection_reminder_offsets,
--   mirrored by COLLECTION_REMINDER_OFFSETS in src/features/collection/reminders.ts). On a given day the reminder is the latest
--   offset already reached, for 7 days after it (app.collection_reminder_offset, the one rule, mirrored by
--   collectionReminderOffset(); test 267 compares them day by day): a run missed for a day catches up, and a document recorded
--   long after its due date does not get a burst of old reminders (one recorded 30 days late gets none). From 08:00 in the
--   business's zone, like the cheque reminders.
-- * Held: while app.collection_held_until(org, document) answers a date (COL-03's effective promise, held up to and including
--   the promised date), no reminder is made and none is recorded; the offset is judged again on the next run, so a reminder
--   that fell inside the promise comes the day after it, while its 7-day window lasts (owner's answer (2) א: "the reminders
--   wait, and continue from the day after").
-- * Once: app.collection_reminders_sent (no grants, RLS on; ids and dates only) keeps one row per document, due date and
--   offset. A changed due date starts its own schedule.
-- * A document whose deal, contact or company is in the recycle bin gets nothing while it is there (nothing recorded).
-- * Not writable (read-only, suspended, cancelled): nothing is made (spec 22.9: reminders of a business stop while it is not
--   active); the offset stays unrecorded and catches up inside its window when the business is writable again.
-- * The task: owner = the rep, MNY-01's rule as app.send_promise_breaks (the document's deal's owner, else its contact's,
--   else its company's) while that person is an active, full-seat, non-viewer member; else the business's active owner, else
--   its oldest active admin. Linked to the document's deal, contact and company (whatever the document has). Title: the
--   document's type and number and the stage ("תזכורת גבייה: חשבונית מס 1042 · היום מועד התשלום"), never an amount or a
--   name; due today at 12:00 in the business's zone (or now, if later); type `todo`, normal priority.
--   `tasks.collection_document_id` (server only: no client grant; composite FK, set null of the column) marks the task, so the
--   task row offers the collection WhatsApp button. A person changes the task like any other (normal task rules; the
--   automations see an ordinary task insert).
-- * One open task per document: when the next offset comes and the document's earlier reminder task is still open (not done,
--   not in the bin), still as the job left it (its title and the due time the job gave it, kept in
--   app.collection_reminders_sent.task_due_at) and its owner is still an active, full-seat member who is not a viewer, that
--   task is moved to the new stage (title, due date) instead of adding another one, so an unpaid debt is one to-do on the
--   rep's list, not four. A task a person retitled or re-dated is theirs and stays untouched; it, a done or binned task and a
--   task whose owner left all get a new task for the rep at the next reminder.
-- * Fair and safe like app.send_promise_breaks: 200 documents per business and 2,000 per run (a transaction may lower both
--   through the settings app.collection_reminder_per_org / _limit; tests do), failed ones after fresh ones. Held and binned
--   documents are left out before the cap, so they never take the places of the others. Businesses take turns: every
--   business's first document, then every business's second, and among businesses the one served longest ago first
--   (app.collection_reminder_turns, no grants, RLS on). Each document in its own exception block that records the failure
--   and writes one warning line (document id and SQLSTATE only); after 3 failures an offset is skipped. A cheap bound on the
--   due date (today - 20 .. today + 3, the only dates an offset can be due) comes before the per-row functions. pg_cron
--   `crm-collection-reminders` every 15 minutes. app.send_collection_reminders(p_orgs) takes optional businesses (tests
--   run it for their own only).
-- * Import undo (next migration, collection_reminder_import_undo): a reminder task on a document of an import is not work
--   on the imported record (app.import_record_worked), so undo_own_import still undoes it.
-- * WhatsApp template: the WA-01 managed list takes server-only kind 'collection_reminder' (one per business), seeded for NEW
--   businesses by app.seed_whatsapp_templates (mirrored by DEFAULT_TEMPLATES). The wording is a DRAFT. Existing businesses
--   are NOT given it here (adding a row to a list a business already manages is the owner's call; see the report): the button
--   then offers the same DRAFT text from the app, unsaved, beside the business's own templates.
-- Every statement is safe to run twice. No object or row is removed.

-- ----------------------------------------------------------------------------
-- The task's mark
-- ----------------------------------------------------------------------------
alter table public.tasks add column if not exists collection_document_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_collection_document_fk' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_collection_document_fk foreign key (organization_id, collection_document_id)
      references public.accounting_documents (organization_id, id) on delete set null (collection_document_id);
  end if;
end;
$$;
create index if not exists tasks_collection_document_idx on public.tasks (organization_id, collection_document_id);
-- server only: no insert or update grant on the column (select is table-wide)

-- ----------------------------------------------------------------------------
-- The schedule (pure)
-- ----------------------------------------------------------------------------
create or replace function app.collection_reminder_offsets() returns integer[]
language sql immutable
set search_path = ''
as $$ select array[-3, 0, 7, 14] $$;
revoke all on function app.collection_reminder_offsets() from public, anon, authenticated, service_role;

-- the reminder due on p_today for a document due on p_due: the latest offset already reached, for 7 days after it; else null
create or replace function app.collection_reminder_offset(p_due date, p_today date) returns integer
language sql immutable
set search_path = ''
as $$
  select k
    from unnest(app.collection_reminder_offsets()) k
   where p_due is not null and p_today is not null
     and p_due + k <= p_today and p_today < p_due + k + 7
   order by k desc
   limit 1;
$$;
revoke all on function app.collection_reminder_offset(date, date) from public, anon, authenticated, service_role;

-- the stage as the task's title says it (mirrored by COLLECTION_REMINDER_STAGES)
create or replace function app.collection_reminder_stage(p_offset integer) returns text
language sql immutable
set search_path = ''
as $$
  select case p_offset
           when -3 then 'בעוד 3 ימים מועד התשלום'
           when 0 then 'היום מועד התשלום'
           when 7 then '7 ימים אחרי מועד התשלום'
           when 14 then '14 ימים אחרי מועד התשלום'
         end;
$$;
revoke all on function app.collection_reminder_stage(integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Once per document, due date and offset
-- ----------------------------------------------------------------------------
-- done_at set once the reminder was made (or found nothing owed); failures / last_attempt_at while it fails
create table if not exists app.collection_reminders_sent (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  document_id      uuid not null,
  due_date         date not null,
  offset_days      integer not null,
  task_id          uuid references public.tasks (id) on delete set null,
  -- the due time the job gave its task (a person who re-dated the task keeps it: the next reminder makes a new one)
  task_due_at      timestamptz,
  done_at          timestamptz,
  failures         integer not null default 0,
  last_attempt_at  timestamptz,
  primary key (document_id, due_date, offset_days),
  constraint collection_reminders_sent_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete cascade
);
create index if not exists collection_reminders_sent_org_idx on app.collection_reminders_sent (organization_id, document_id);
create index if not exists collection_reminders_sent_task_idx on app.collection_reminders_sent (task_id);
alter table app.collection_reminders_sent add column if not exists task_due_at timestamptz;
alter table app.collection_reminders_sent enable row level security;
revoke all on app.collection_reminders_sent from public, anon, authenticated, service_role;

-- the business turns: when each business was last served (no grants, RLS on)
create table if not exists app.collection_reminder_turns (
  organization_id  uuid primary key references public.organizations (id) on delete cascade,
  served_at        timestamptz not null
);
alter table app.collection_reminder_turns enable row level security;
revoke all on app.collection_reminder_turns from public, anon, authenticated, service_role;

-- 200 per business and 2,000 per run; a transaction may only lower them (tests do)
create or replace function app.collection_reminder_per_org() returns integer language sql stable set search_path = '' as $$
  select least(200, greatest(1, coalesce(nullif(current_setting('app.collection_reminder_per_org', true), '')::integer, 200)))
$$;
create or replace function app.collection_reminder_limit() returns integer language sql stable set search_path = '' as $$
  select least(2000, greatest(1, coalesce(nullif(current_setting('app.collection_reminder_limit', true), '')::integer, 2000)))
$$;
revoke all on function app.collection_reminder_per_org() from public, anon, authenticated, service_role;
revoke all on function app.collection_reminder_limit() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job
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
  for v_row in
    select z.* from (
      select d.organization_id, d.id, d.doc_type, d.number, d.due_date, d.deal_id, d.contact_id, d.company_id,
             c.today, c.zone, c.offset_days, s.last_attempt_at, tn.served_at,
             -- a document that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by d.organization_id order by s.last_attempt_at nulls first, d.due_date, d.id) as n
        from public.accounting_documents d
        join public.organizations o on o.id = d.organization_id
        cross join lateral (
          select (now() at time zone app.intake_zone(o.timezone))::date as today, app.intake_zone(o.timezone) as zone
        ) t0
        cross join lateral (
          select t0.today, t0.zone, app.collection_reminder_offset(d.due_date, t0.today) as offset_days
        ) c
        left join app.collection_reminders_sent s
          on s.document_id = d.id and s.due_date = d.due_date and s.offset_days = c.offset_days
        left join app.collection_reminder_turns tn on tn.organization_id = d.organization_id
       where (p_orgs is null or d.organization_id = any (p_orgs))
         and d.status = 'active'
         and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
         and d.amount_agorot > 0
         -- a cheap bound first (every zone's today is within a day of the server's): an offset is reached only while
         -- today - due is in -3..20 (app.collection_reminder_offset), so nothing outside it can be due
         and d.due_date between current_date - 22 and current_date + 4
         and d.due_date between c.today - 20 and c.today + 3
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
        v_title := left('תזכורת גבייה: ' || app.document_type_label(v_row.doc_type) || coalesce(' ' || v_row.number, '')
                        || ' · ' || app.collection_reminder_stage(v_row.offset_days), 300);
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
           and t.title = left('תזכורת גבייה: ' || app.document_type_label(v_row.doc_type) || coalesce(' ' || v_row.number, '')
                              || ' · ' || app.collection_reminder_stage(s.offset_days), 300)
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
      end if;

      insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, task_id, task_due_at, done_at)
      values (v_row.organization_id, v_row.id, v_row.due_date, v_row.offset_days, v_task, v_due_at, now())
      on conflict (document_id, due_date, offset_days)
        do update set task_id = excluded.task_id, task_due_at = excluded.task_due_at, done_at = excluded.done_at;
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

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-collection-reminders', '*/15 * * * *', 'select app.send_collection_reminders();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- WA-01: the collection reminder template (kind server-only, one per business)
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.whatsapp_templates'::regclass and conname = 'whatsapp_templates_kind_check'
                    and pg_get_constraintdef(oid) like '%collection_reminder%') then
    alter table public.whatsapp_templates drop constraint if exists whatsapp_templates_kind_check;
    alter table public.whatsapp_templates add constraint whatsapp_templates_kind_check
      check (kind in ('meeting_reminder', 'collection_reminder'));
  end if;
end;
$$;

-- new businesses start with it (the wording is a DRAFT); an existing business keeps its list as it is
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
          'שלום {שם פרטי}, תזכורת לתשלום {מסמך} על סך {סכום}, שמועד התשלום שלו {מועד תשלום}. אם כבר שילמת, תודה ואפשר להתעלם מההודעה. {שם הנציג}, {שם העסק}', 'collection_reminder')
    ) as d(n, name, body, kind)
   where not exists (select 1 from public.whatsapp_templates t where t.organization_id = p_org)
   order by d.n;
end;
$$;
revoke all on function app.seed_whatsapp_templates(uuid) from public, anon, authenticated;
