-- =============================================================================
-- SGN-04: a signed contract's validity and renewal date on the record, with an alert before it ends
-- =============================================================================
-- Plan key `signatures` (already in the plans). Lead's choices until the owner answers (DECISIONS.md):
-- (a) both: document_templates.default_validity_months (null = none, 1..120; owners/admins through column grants, the
--     table's own rules) fills a signed document's valid_until when it is signed (the last day of that many months from the
--     signing day in the business zone: signing day + N months - 1 day), and staff set or change both dates after signing;
-- (b) the lead time is per business: org_document_settings.contract_renewal_days (0 = off, 1..365, default 30; owners and
--     admins through column grants; audited by the table's audit trigger);
-- (c) the alerted person: the document's sender while an active full-seat non-viewer who reads the record, else the record's
--     owner under the same rule, else the business owner, else its oldest admin (SGN-03's rule plus the record owner);
-- (d) a task and a notice (SGN-03's staff reminder): one open task per document, re-dated for a new date, closed by itself
--     when the dates are cleared or moved out of the window, the document stops being signed, or its text is erased.
--
-- * signature_documents.valid_until / renewal_on (date, null): only on a signed document, renewal_on only with valid_until
--   and never after it (constraint signature_documents_validity_shape). No client writes the table (021212): a person sets
--   them only through public.signature_document_set_validity (definer; app.signature_managed_document: whoever may edit the
--   document's live record, in a writable business with the key; hints signature_document:validity_status | validity_erased
--   | validity_date | validity_renewal), audited 'signature_validity' with the dates only. Clients read both (column
--   grants, as every column but `people`).
-- * Signing (trigger signature_documents_validity_fill, BEFORE UPDATE OF status, definer): a move into 'signed' with no
--   valid_until takes the template's default_validity_months, read live at signing (a template deleted since gives none).
--   public.signature_public_sign keeps its 021212 body.
-- * The job: pg_cron `crm-contract-renewals` (hourly at :17) runs app.send_contract_renewals(): from 08:00 in the business
--   zone, writable businesses with the key and a lead time above 0, a signed document with valid_until, not erased, on a
--   live record not in the bin, whose target day (renewal_on, else valid_until) minus the lead time is today or earlier
--   while valid_until is today or later. Once per document and target day (app.contract_renewal_alerts, RLS on, no grants);
--   businesses take turns (app.signature_expiry_per_org() 200 / app.signature_expiry_limit() 2,000, SGN-03's caps); each
--   document in its own exception block, 3 failures in a row for a target day skip it (one warning line, id and SQLSTATE).
--   Lock order: the document row (skip locked), then its open task (skip locked; a task someone holds waits for the next
--   run). Each alert: the document's open renewal task is re-dated and retitled when its owner is still usable, else closed
--   ("נסגרה: הועברה לאחראי אחר") and a new one made by rule (c); due 10:00 on the target day in the business zone (or now,
--   when later); linked to the document's record. Title: "לחדש חוזה שנחתם ב-DD.MM.YYYY (בתוקף עד DD.MM.YYYY)",
--   never the document's title or a name (delta review: the task and its audit entries hold nothing personal). The assignee gets one notice of
--   the existing mutable kind `signature_reminder` whose title and body name nothing (the task as its entity); the task
--   insert sets app.intake_quiet_task, so app.notify_assignment sends no 'assigned' notice beside it.
-- * A task closes itself (trigger signature_documents_renewal_close, AFTER UPDATE OF status, valid_until, renewal_on,
--   erased_at): text erased "נסגרה: פרטי המסמך נמחקו"; no longer signed "נסגרה: המסמך בוטל"; valid_until cleared "נסגרה:
--   תאריך התוקף הוסר"; the target day moved so that it is outside the window "נסגרה: מועד החידוש נדחה". A target moved
--   inside the window keeps the task, and the job re-dates it.
-- * Erasure: the two dates are not personal; app.signature_documents_erase and app.signature_documents_erase_named stay as
--   they are (021216). An erased document gets no alert and its task closes.
-- * app.document_templates_guard (021200's body): switching a template off without the key stays allowed only while the
--   default validity is unchanged too (one line added).
-- * Review fixes (same migration, not applied anywhere yet):
--   1. a change of the target day re-opens that day's alert row (alerted_at and failures cleared, an update), so a target
--      that comes back to a day alerted before is alerted again and the open task follows the current target;
--   2. a change of valid_until or renewal_on that keeps the task retitles it in place;
--   3. (delta review) a renewal task never carries the document's title or a name, in its title or description (so neither
--      the task nor its audit entries hold anything a person's erasure must reach); a named person's erasure
--      (text_erased_at, 021216) therefore changes nothing on the tasks;
--   4. the last day of N months (app.contract_validity_end = validityEnd() in src/features/signatures/validity.ts, shared
--      fixture tests/unit/fixtures/contract-validity-end.json): the same day N months later minus one day; when that month
--      has no such day, its last day (31 Jan + 1 month = 28/29 Feb; 1 Jan + 12 months = 31 Dec);
--   5. the job's failure bookkeeping runs in its own exception block (a document or business deleted mid-run is skipped).
--   Every renewal task a document had is kept in app.contract_renewal_tasks (RLS on, no grants; cascades with the document
--   and the task), which the job, the closing and the retitles read.
-- Every statement is safe to run twice. No statement starts with drop, no row removal.

-- ----------------------------------------------------------------------------
-- The last day of N months from a day (review fix 4)
-- ----------------------------------------------------------------------------
create or replace function app.contract_validity_end(p_day date, p_months integer) returns date
language sql immutable
set search_path = ''
as $$
  -- PostgreSQL clamps an overflowing day to the month's last day: then that last day is the end, else the day before
  select case when extract(day from (p_day + make_interval(months => p_months))::date) < extract(day from p_day)
              then (p_day + make_interval(months => p_months))::date
              else (p_day + make_interval(months => p_months))::date - 1 end
$$;
revoke all on function app.contract_validity_end(date, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The template's default validity
-- ----------------------------------------------------------------------------
alter table public.document_templates add column if not exists default_validity_months smallint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_templates_default_validity_check'
                  and conrelid = 'public.document_templates'::regclass) then
    alter table public.document_templates add constraint document_templates_default_validity_check
      check (default_validity_months is null or default_validity_months between 1 and 120);
  end if;
end;
$$;

grant insert (default_validity_months) on public.document_templates to authenticated;
grant update (default_validity_months) on public.document_templates to authenticated;

-- 021200's body; the switch-off exemption also needs the default validity unchanged
create or replace function app.document_templates_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  -- the defaults' seed names the business it seeds (transaction-local, set only by app.seed_document_templates); its
  -- insert is judged as the server's, whoever's session runs create_organization, and still counts against the cap
  -- (review): the setting alone is not trusted; a seeded row also carries the server-only key, which no client may insert
  v_seed boolean := tg_op = 'INSERT'
    and new.key is not null
    and coalesce(current_setting('app.document_template_seed', true), '') = new.organization_id::text;
begin
  -- RVW-23: an outsider gets RLS's plain 42501 and learns nothing about another business
  if not v_seed and auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- a person needs the key to add, change or switch on a template; the server's seed does not (every business gets the
  -- defaults). Owner (201) ב: without the key, switching a template OFF (is_active true -> false, nothing else changed)
  -- stays allowed, as removing does (the safe side).
  if not v_seed and auth.uid() is not null and not app.org_has_feature(new.organization_id, 'signatures')
     and not (tg_op = 'UPDATE'
              and old.is_active and not new.is_active
              and new.name is not distinct from old.name
              and new.kind is not distinct from old.kind
              and new.record_type is not distinct from old.record_type
              and new.body is not distinct from old.body
              -- SGN-04
              and new.default_validity_months is not distinct from old.default_validity_months) then
    raise exception 'document templates are not in the plan' using errcode = 'P0001', hint = 'feature:signatures';
  end if;
  if tg_op = 'INSERT' then
    -- one insert at a time per business, so two cannot both pass the count
    perform pg_advisory_xact_lock(hashtextextended('document_templates:' || new.organization_id::text, 0));
    if (select count(*) from public.document_templates t where t.organization_id = new.organization_id) >= 50 then
      raise exception 'too many document templates' using errcode = 'P0001', hint = 'document_templates:max';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.document_templates_guard() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The document's dates (read by the record's readers; written only by the server and the function below)
-- ----------------------------------------------------------------------------
alter table public.signature_documents add column if not exists valid_until date;
alter table public.signature_documents add column if not exists renewal_on date;
grant select (valid_until, renewal_on) on public.signature_documents to authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'signature_documents_validity_shape'
                  and conrelid = 'public.signature_documents'::regclass) then
    alter table public.signature_documents add constraint signature_documents_validity_shape check (
      (valid_until is null and renewal_on is null)
      or (status = 'signed' and valid_until is not null and (renewal_on is null or renewal_on <= valid_until)));
  end if;
end;
$$;

-- the job's candidates and the "ending soon" list
create index if not exists signature_documents_validity_idx on public.signature_documents (organization_id, valid_until)
  where status = 'signed' and valid_until is not null;

-- ----------------------------------------------------------------------------
-- The lead time: days before the target day, 0 = off
-- ----------------------------------------------------------------------------
alter table public.org_document_settings add column if not exists contract_renewal_days smallint not null default 30;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_document_settings_contract_renewal_days_check'
                  and conrelid = 'public.org_document_settings'::regclass) then
    alter table public.org_document_settings add constraint org_document_settings_contract_renewal_days_check
      check (contract_renewal_days between 0 and 365);
  end if;
end;
$$;

grant select (contract_renewal_days) on public.org_document_settings to authenticated;
grant insert (contract_renewal_days) on public.org_document_settings to authenticated;
grant update (contract_renewal_days) on public.org_document_settings to authenticated;

-- ----------------------------------------------------------------------------
-- Signing fills valid_until from the template's default (read live)
-- ----------------------------------------------------------------------------
create or replace function app.signature_documents_validity_fill() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_months smallint;
  v_zone text;
begin
  if old.status = 'signed' or new.status <> 'signed' or new.valid_until is not null or new.template_id is null then
    return new;
  end if;
  select t.default_validity_months into v_months
    from public.document_templates t
   where t.organization_id = new.organization_id and t.id = new.template_id;
  if v_months is null then
    return new;
  end if;
  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = new.organization_id;
  new.valid_until := app.contract_validity_end((coalesce(new.signed_at, now()) at time zone v_zone)::date, v_months);
  return new;
end;
$$;
revoke all on function app.signature_documents_validity_fill() from public, anon, authenticated, service_role;

create or replace trigger signature_documents_validity_fill before update of status on public.signature_documents
  for each row execute function app.signature_documents_validity_fill();

-- ----------------------------------------------------------------------------
-- Staff set or change the dates after signing
-- ----------------------------------------------------------------------------
create or replace function public.signature_document_set_validity(p_org uuid, p_doc uuid, p_valid_until date, p_renewal_on date)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents;
  v_signed_day date;
begin
  -- whoever may edit the live record, in a writable business with the key (42501 / feature:signatures)
  v_doc := app.signature_managed_document(p_org, p_doc);
  select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = p_doc for update;
  if v_doc.status <> 'signed' then
    raise exception 'only a signed document has a validity' using errcode = 'P0001', hint = 'signature_document:validity_status';
  end if;
  if v_doc.erased_at is not null then
    raise exception 'the document was erased' using errcode = 'P0001', hint = 'signature_document:validity_erased';
  end if;
  v_signed_day := (v_doc.signed_at at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
  if p_valid_until is not null and (p_valid_until < v_signed_day or p_valid_until > date '2100-12-31') then
    raise exception 'the validity ends before the signing day or too far ahead' using errcode = 'P0001', hint = 'signature_document:validity_date';
  end if;
  if p_renewal_on is not null and (p_valid_until is null or p_renewal_on > p_valid_until or p_renewal_on < v_signed_day) then
    raise exception 'the renewal day needs a validity and falls within it' using errcode = 'P0001', hint = 'signature_document:validity_renewal';
  end if;
  if v_doc.valid_until is not distinct from p_valid_until and v_doc.renewal_on is not distinct from p_renewal_on then
    return jsonb_build_object('valid_until', p_valid_until, 'renewal_on', p_renewal_on);
  end if;
  update public.signature_documents d set valid_until = p_valid_until, renewal_on = p_renewal_on
   where d.organization_id = p_org and d.id = p_doc;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'signature_validity', 'signature_documents', p_doc,
          jsonb_build_object('valid_until', jsonb_build_object('old', v_doc.valid_until, 'new', p_valid_until),
                             'renewal_on', jsonb_build_object('old', v_doc.renewal_on, 'new', p_renewal_on)));
  return jsonb_build_object('valid_until', p_valid_until, 'renewal_on', p_renewal_on);
end;
$$;
revoke all on function public.signature_document_set_validity(uuid, uuid, date, date) from public, anon;
grant execute on function public.signature_document_set_validity(uuid, uuid, date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- Server-only bookkeeping: one row per document and target day (schema app: RLS on, no grants)
-- ----------------------------------------------------------------------------
create table if not exists app.contract_renewal_alerts (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id     uuid not null,
  alert_day       date not null,
  task_id         uuid,
  failures        integer not null default 0 check (failures >= 0),
  last_attempt_at timestamptz,
  alerted_at      timestamptz,
  created_at      timestamptz not null default now(),
  primary key (document_id, alert_day),
  constraint contract_renewal_alerts_document_fk foreign key (organization_id, document_id)
    references public.signature_documents (organization_id, id) on delete cascade
);
create index if not exists contract_renewal_alerts_org_document_idx on app.contract_renewal_alerts (organization_id, document_id);
create index if not exists contract_renewal_alerts_task_idx on app.contract_renewal_alerts (task_id) where task_id is not null;
alter table app.contract_renewal_alerts enable row level security;
revoke all on app.contract_renewal_alerts from public, anon, authenticated, service_role;

-- every renewal task a document ever had (the alerts above keep only the latest task per target day), so closing and the
-- date retitles reach them all
create table if not exists app.contract_renewal_tasks (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id     uuid not null,
  task_id         uuid not null,
  created_at      timestamptz not null default now(),
  primary key (task_id),
  constraint contract_renewal_tasks_document_fk foreign key (organization_id, document_id)
    references public.signature_documents (organization_id, id) on delete cascade,
  constraint contract_renewal_tasks_task_fk foreign key (organization_id, task_id)
    references public.tasks (organization_id, id) on delete cascade
);
create index if not exists contract_renewal_tasks_org_document_idx on app.contract_renewal_tasks (organization_id, document_id);
create index if not exists contract_renewal_tasks_org_task_idx on app.contract_renewal_tasks (organization_id, task_id);
alter table app.contract_renewal_tasks enable row level security;
revoke all on app.contract_renewal_tasks from public, anon, authenticated, service_role;

-- the person who gets the alert: sender, else the record's owner (each an active full-seat non-viewer who reads the
-- record), else the business owner, else its oldest admin
create or replace function app.contract_renewal_recipient(p_doc public.signature_documents, p_record jsonb) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select m.user_id from public.memberships m
      where m.organization_id = p_doc.organization_id and m.user_id = p_doc.sent_by
        and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
        and app.user_can_read_record(p_doc.organization_id, m.user_id, (p_record ->> 'owner_id')::uuid, (p_record ->> 'team_id')::uuid)),
    (select m.user_id from public.memberships m
      where m.organization_id = p_doc.organization_id and m.user_id = (p_record ->> 'owner_id')::uuid
        and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
        and app.user_can_read_record(p_doc.organization_id, m.user_id, (p_record ->> 'owner_id')::uuid, (p_record ->> 'team_id')::uuid)),
    (select m.user_id from public.memberships m
      where m.organization_id = p_doc.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
      order by (m.role = 'owner') desc, m.created_at, m.user_id
      limit 1))
$$;
revoke all on function app.contract_renewal_recipient(public.signature_documents, jsonb) from public, anon, authenticated, service_role;

-- The renewal task's title and description (the job and the trigger below): dates only, never the document's title or a
-- name, so nothing personal reaches the task or its audit entries (delta review).
create or replace function app.contract_renewal_task_text(p_doc public.signature_documents) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'title',
    -- delta review: never the document's free title (it may hold a name, and the task's audit entries would keep it); the
    -- task's record link tells which document
    'לחדש חוזה שנחתם ב-' || coalesce(to_char((p_doc.signed_at at time zone z.zone)::date, 'DD.MM.YYYY'), '')
    || coalesce(' (בתוקף עד ' || to_char(p_doc.valid_until, 'DD.MM.YYYY') || ')', ''),
    'description',
    coalesce('תוקף המסמך החתום מסתיים ב-' || to_char(p_doc.valid_until, 'DD.MM.YYYY') || '.', '')
    || coalesce(' מועד החידוש: ' || to_char(p_doc.renewal_on, 'DD.MM.YYYY') || '.', '')
    || ' את התאריכים משנים בכרטיס "מסמכים לחתימה".')
    from (select app.intake_zone((select o.timezone from public.organizations o where o.id = p_doc.organization_id)) as zone) z
$$;
revoke all on function app.contract_renewal_task_text(public.signature_documents) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The job
-- ----------------------------------------------------------------------------
create or replace function app.send_contract_renewals() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_doc public.signature_documents;
  v_record jsonb;
  v_rep uuid;
  v_task uuid;
  v_open uuid;
  v_locked boolean;
  v_title text;
  v_description text;
  v_text jsonb;
  v_due_at timestamptz;
  v_quiet text;
  v_state text;
  v_done integer := 0;
begin
  for v_row in
    with orgs as materialized (
      -- the businesses first: writable, with the key, the lead time above 0, from 08:00 in their zone
      select o.id, z.zone, (now() at time zone z.zone)::date as today, coalesce(s.contract_renewal_days, 30) as days
        from public.organizations o
        cross join lateral (select app.intake_zone(o.timezone) as zone) z
        left join public.org_document_settings s on s.organization_id = o.id
       where coalesce(s.contract_renewal_days, 30) > 0
         and (now() at time zone z.zone)::time >= time '08:00'
         and exists (select 1 from public.signature_documents d
                      where d.organization_id = o.id and d.status = 'signed' and d.valid_until is not null)
         and app.org_writable(o.id)
         and app.org_has_feature(o.id, 'signatures')
    ),
    cand as materialized (
      select d.organization_id, d.id, og.zone, og.today, coalesce(d.renewal_on, d.valid_until) as alert_day,
             r.last_attempt_at
        from orgs og
        join public.signature_documents d on d.organization_id = og.id
        left join app.contract_renewal_alerts r on r.document_id = d.id and r.alert_day = coalesce(d.renewal_on, d.valid_until)
       where d.status = 'signed' and d.valid_until is not null and d.erased_at is null
         and num_nonnulls(d.lead_id, d.contact_id, d.company_id, d.deal_id) = 1
         and d.valid_until >= og.today
         and coalesce(d.renewal_on, d.valid_until) - og.days <= og.today
         and (r.document_id is null or (r.alerted_at is null and r.failures < 3))
         -- a record in the recycle bin waits (nothing is recorded)
         and not exists (select 1 from public.leads l where l.organization_id = d.organization_id and l.id = d.lead_id and l.deleted_at is not null)
         and not exists (select 1 from public.contacts c where c.organization_id = d.organization_id and c.id = d.contact_id and c.deleted_at is not null)
         and not exists (select 1 from public.companies c where c.organization_id = d.organization_id and c.id = d.company_id and c.deleted_at is not null)
         and not exists (select 1 from public.deals dl where dl.organization_id = d.organization_id and dl.id = d.deal_id and dl.deleted_at is not null)
    )
    select z.* from (
      select c.*, row_number() over (partition by c.organization_id order by c.last_attempt_at nulls first, c.alert_day, c.id) as n
        from cand c
    ) z
     where z.n <= app.signature_expiry_per_org()
     order by z.n, z.last_attempt_at nulls first, z.organization_id, z.id
     limit app.signature_expiry_limit()
  loop
    begin
      v_rep := null;
      v_task := null;
      v_open := null;
      v_locked := false;
      -- a document being changed right now is left for the next run; judged again under the lock
      select * into v_doc from public.signature_documents d
       where d.organization_id = v_row.organization_id and d.id = v_row.id
         and d.status = 'signed' and d.valid_until is not null and d.erased_at is null
         and coalesce(d.renewal_on, d.valid_until) = v_row.alert_day
       for update skip locked;
      if found then
        v_due_at := greatest(now(), (v_row.alert_day + time '10:00') at time zone v_row.zone);
        v_record := app.signature_record_row(v_doc.organization_id, app.signature_record_type(v_doc), app.signature_record_id(v_doc));
        v_text := app.contract_renewal_task_text(v_doc);
        v_title := v_text ->> 'title';
        v_description := v_text ->> 'description';

        -- the document's renewal task still open: re-dated while its owner is usable (taken skip locked after the document)
        select k.task_id into v_open
          from app.contract_renewal_tasks k
          join public.tasks t on t.organization_id = k.organization_id and t.id = k.task_id
         where k.organization_id = v_doc.organization_id and k.document_id = v_doc.id
           and t.status = 'open' and t.deleted_at is null
         order by k.created_at desc
         limit 1;
        if v_open is not null then
          select t.id, t.owner_id into v_task, v_rep
            from public.tasks t
           where t.organization_id = v_doc.organization_id and t.id = v_open and t.status = 'open' and t.deleted_at is null
           for update skip locked;
          if v_task is null then
            v_locked := true;
          elsif not exists (select 1 from public.memberships m
                             where m.organization_id = v_doc.organization_id and m.user_id = v_rep
                               and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
                               and app.user_can_read_record(v_doc.organization_id, m.user_id, (v_record ->> 'owner_id')::uuid,
                                                            (v_record ->> 'team_id')::uuid)) then
            update public.tasks t set status = 'done', outcome = 'נסגרה: הועברה לאחראי אחר'
             where t.organization_id = v_doc.organization_id and t.id = v_task;
            v_task := null;
            v_rep := null;
          else
            update public.tasks t set due_at = v_due_at, title = v_title, description = v_description
             where t.organization_id = v_doc.organization_id and t.id = v_task;
          end if;
        end if;

        if not v_locked and v_task is null then
          v_rep := app.contract_renewal_recipient(v_doc, v_record);
          if v_rep is not null then
            v_quiet := current_setting('app.intake_quiet_task', true);
            perform set_config('app.intake_quiet_task', v_rep::text, true);
            insert into public.tasks (organization_id, title, task_type, due_at, priority, owner_id,
                                      lead_id, contact_id, company_id, deal_id, description)
            values (v_doc.organization_id, v_title, 'todo', v_due_at, 2, v_rep,
                    v_doc.lead_id, v_doc.contact_id, v_doc.company_id, v_doc.deal_id, v_description)
            returning id into v_task;
            perform set_config('app.intake_quiet_task', coalesce(v_quiet, ''), true);
            insert into app.contract_renewal_tasks (organization_id, document_id, task_id)
            values (v_doc.organization_id, v_doc.id, v_task);
          end if;
        end if;

        if not v_locked then
          -- the existing mutable kind of signature reminders; nothing personal in it
          if v_rep is not null and v_task is not null then
            insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
            values (v_doc.organization_id, v_rep, 'signature_reminder', 'תזכורת: חוזה מתקרב לסוף התוקף',
                    'יש לך משימה לטפל בחידוש של מסמך חתום.', 'task', v_task);
          end if;
          insert into app.contract_renewal_alerts as r (organization_id, document_id, alert_day, task_id, failures,
                                                        last_attempt_at, alerted_at)
          values (v_doc.organization_id, v_doc.id, v_row.alert_day, v_task, 0, now(), now())
          on conflict (document_id, alert_day) do update
            set task_id = coalesce(excluded.task_id, r.task_id), failures = 0,
                last_attempt_at = excluded.last_attempt_at, alerted_at = excluded.alerted_at;
          v_done := v_done + 1;
        end if;
      end if;
    exception when others then
      v_state := sqlstate;
      -- fix 5: the bookkeeping in its own block (the document or the business may be gone by now: then nothing is kept)
      begin
        insert into app.contract_renewal_alerts (organization_id, document_id, alert_day, failures, last_attempt_at)
        values (v_row.organization_id, v_row.id, v_row.alert_day, 1, now())
        on conflict (document_id, alert_day) do update
          set failures = app.contract_renewal_alerts.failures + 1, last_attempt_at = excluded.last_attempt_at;
      exception when others then
        null;
      end;
      raise warning 'crm-contract-renewals: document % failed (SQLSTATE %)%', v_row.id, v_state,
        case when coalesce((select r.failures from app.contract_renewal_alerts r
                             where r.document_id = v_row.id and r.alert_day = v_row.alert_day), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_contract_renewals() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The renewal task closes itself when it no longer applies
-- ----------------------------------------------------------------------------
create or replace function app.signature_documents_renewal_close() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_note text;
  v_days integer;
  v_today date;
  v_old_target date := case when old.valid_until is not null then coalesce(old.renewal_on, old.valid_until) end;
  v_new_target date := case when new.valid_until is not null then coalesce(new.renewal_on, new.valid_until) end;
  v_text jsonb;
begin
  -- fix 1: a new target day is alerted afresh, also a day alerted before (an update, never a removal)
  if v_new_target is not null and v_new_target is distinct from v_old_target then
    update app.contract_renewal_alerts a set alerted_at = null, failures = 0, last_attempt_at = null
     where a.document_id = new.id and a.alert_day = v_new_target;
  end if;

  if old.erased_at is null and new.erased_at is not null then
    v_note := 'נסגרה: פרטי המסמך נמחקו';
  elsif old.status = 'signed' and new.status <> 'signed' then
    v_note := 'נסגרה: המסמך בוטל';
  elsif old.valid_until is not null and new.valid_until is null then
    v_note := 'נסגרה: תאריך התוקף הוסר';
  elsif v_new_target is not null and v_new_target is distinct from v_old_target then
    select coalesce(s.contract_renewal_days, 30) into v_days
      from public.organizations o
      left join public.org_document_settings s on s.organization_id = o.id
     where o.id = new.organization_id;
    select (now() at time zone app.intake_zone(o.timezone))::date into v_today from public.organizations o where o.id = new.organization_id;
    if not (v_days > 0 and v_new_target - v_days <= v_today and new.valid_until >= v_today) then
      v_note := 'נסגרה: מועד החידוש נדחה';
    end if;
    -- inside the window the task stays: retitled below, re-dated by the job (fix 1)
  end if;

  if v_note is not null then
    update public.tasks t
       set status = 'done', outcome = v_note
      from app.contract_renewal_tasks k
     where k.organization_id = new.organization_id and k.document_id = new.id and k.task_id = t.id
       and t.organization_id = new.organization_id and t.status = 'open' and t.deleted_at is null;
  end if;

  v_text := app.contract_renewal_task_text(new);
  -- fix 2: the open task kept through a change of the dates says the current dates
  if v_note is null and new.valid_until is not null
     and (new.valid_until is distinct from old.valid_until or new.renewal_on is distinct from old.renewal_on) then
    update public.tasks t
       set title = v_text ->> 'title', description = v_text ->> 'description'
      from app.contract_renewal_tasks k
     where k.organization_id = new.organization_id and k.document_id = new.id and k.task_id = t.id
       and t.organization_id = new.organization_id and t.status = 'open' and t.deleted_at is null;
  end if;
  return null;
end;
$$;
revoke all on function app.signature_documents_renewal_close() from public, anon, authenticated, service_role;

create or replace trigger signature_documents_renewal_close
  after update of status, valid_until, renewal_on, erased_at on public.signature_documents
  for each row execute function app.signature_documents_renewal_close();

-- ----------------------------------------------------------------------------
-- The job's schedule
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-contract-renewals', '17 * * * *', 'select app.send_contract_renewals();');
  end if;
end;
$$;
