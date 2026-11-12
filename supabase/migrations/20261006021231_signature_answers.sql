-- =============================================================================
-- The owner's answers of 12 November 2026 on SGN-04 and SGN-07: (283) ב, (287) ב, (288) ב, (289) ב, (290) ב
-- =============================================================================
-- (283) ב, SGN-04: an open renewal task of a signed contract whose validity has ended closes by itself, outcome "נסגרה: פג
--   תוקף החוזה", and the contract is marked as expired.
--   * signature_documents.contract_expired_at (timestamptz, server only; clients read it through a column select grant, as
--     every column but `people`): stamped once by the renewal job when valid_until is before the business's today (SGN-04's
--     rule, contractExpired() in src/features/signatures/validity.ts: the last day has passed; renewal_on is only the day the
--     alert counts back from and never ends a contract). Cleared by trigger signature_documents_contract_expired_clear when a
--     later change moves valid_until (the contract may be valid again; the job judges it afresh).
--   * app.close_expired_contract_renewals() (definer, no grants), called first by app.send_contract_renewals() in its own
--     exception block (review: the renewal alerts run either way): writable businesses with the `signatures` key, every
--     hour (no 08:00 or lead-time condition: closing is not an alert); signed, not erased documents whose valid_until is
--     before today and that are not marked yet, or are marked but have an open renewal task no person touched (one that
--     came back from the recycle bin after the mark: closed by the next run). Businesses take turns as in the other
--     signature jobs: app.signature_expiry_per_org() (200) a business, app.signature_expiry_limit() (2,000) a run, each
--     document in its own exception block; a document that failed 3 times for the same last day is skipped (one warning
--     line per failure, the third says so; app.contract_expiry_failures, RLS on, no grants, cascades with the document; a
--     new last day starts the count again). Lock order as the job's: the document (skip locked), then its open renewal
--     tasks (app.contract_renewal_tasks, skip locked); when any of them is held by someone the document is left for the
--     next run, so it is never marked with a task left open by mistake. After the lock the "touched" rule is judged again
--     in the closing update, so a person's change committed in between keeps the task open.
--     A task a person touched stays as it is (app.contract_renewal_task_touched): an `update` audit entry with an actor
--     that changed anything beyond the title and the description (those two are what a person's validity change retitles
--     through app.signature_documents_renewal_close, under that person's session; accepted: a person who edited only the
--     task's title or description is treated as not having touched it), or a person's `restore` entry. Then the document
--     is marked; the job never reopens a task.
-- (287) ב, SGN-07: an in-person signature also keeps the IP address of the rep's device, in the existing `ip` column (which
--   both erasures already empty). The server reads it from its request exactly as the public sign route does (clientIp() of
--   src/lib/keyed-ip-hash.ts: x-forwarded-for's first entry, else x-real-ip) and hands it to the database in the request
--   header x-crm-device-ip, read by app.in_person_device_ip() (request.headers, as x-crm-import / x-crm-sender; an address
--   of hex digits, dots and colons, 2..64 characters, else null). Lead's choice to confirm: a header, not a new argument, so
--   the signatures of public.signature_in_person_sign / quote_in_person_accept stay as they are (a new argument would leave
--   a retired copy each time a test re-runs 021227). The value is the rep's own claim, as trustworthy as the user agent.
-- (288) ב: the rep makes the signed PDF until 24 hours after the in-person signing, not one hour: app.signature_in_person_rep
--   and app.quote_in_person_rep (the only places the hour is judged; signature_in_person_pdf_allowed /
--   quote_in_person_pdf_allowed and the two service_role writers ask them).
-- (289) ב: when the rep would be the only recipient of the "signed" / "accepted" notice (and the new "declined" one), the
--   active owners and admins get it instead, never the rep: app.in_person_notice_targets(org, rep, recipients) (definer, no
--   grants).
-- (290) ב: the in-person quote screen offers accept OR decline. public.quote_in_person_decline(org, quote, fingerprint,
--   signer_name, decline_reason, user_agent) (definer, authenticated) mirrors public.quote_public_answer's rejected branch
--   (021117): the rep's right first (app.quote_in_person_quote), the decide window of the live link (10 tries in 10 minutes,
--   shared with the customer's page), the lock, the same states (already_decided | changed | closed), the fingerprint, the
--   reason up to 1,000 and an optional name 2..120, one decision 'rejected' with in_person + in_person_by + the device's user
--   agent and IP, the status (with the JWT claims set aside around the writes, as quote_in_person_accept, so the quote
--   triggers and the timeline see the same server write as the customer's decline: the `system` entry quote_rejected with no
--   author), the notice to app.quote_notice_recipients without the rep ("הצעת מחיר נדחתה במקום: " and the title; (289) ב
--   applies), and one audit entry by the rep, action in_person_decline. No PDF (app.quote_in_person_rep asks for an accepted
--   decision).
-- Redefined from their latest bodies plus the marked lines only:
--   public.signature_in_person_sign (021227): the ip value (app.in_person_device_ip()), its comment line, and the notice's
--     FROM through app.in_person_notice_targets (the `where r.user_id <> v_rep` moved into it);
--   public.quote_in_person_accept (021227): the same three changes;
--   app.signature_in_person_rep, app.quote_in_person_rep (021227): '1 hour' -> '24 hours';
--   app.send_contract_renewals (021223): at its start, the call to app.close_expired_contract_renewals() inside its own
--     begin / exception when others (one warning line, SQLSTATE only) / end block.
-- Every statement is safe to run twice. No statement starts with drop, no row removal.

-- ----------------------------------------------------------------------------
-- (283) ב: the contract's expired mark
-- ----------------------------------------------------------------------------
alter table public.signature_documents add column if not exists contract_expired_at timestamptz;
grant select (contract_expired_at) on public.signature_documents to authenticated;

-- a later change of the last day takes the mark off (the job judges the contract again)
create or replace function app.signature_documents_contract_expired_clear() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.valid_until is distinct from old.valid_until and new.contract_expired_at is not distinct from old.contract_expired_at then
    new.contract_expired_at := null;
  end if;
  return new;
end;
$$;
revoke all on function app.signature_documents_contract_expired_clear() from public, anon, authenticated, service_role;

create or replace trigger signature_documents_contract_expired_clear before update of valid_until on public.signature_documents
  for each row execute function app.signature_documents_contract_expired_clear();

-- review: a document that keeps failing is skipped after 3 tries for the same last day (schema app: RLS on, no grants;
-- cascades with the document)
create table if not exists app.contract_expiry_failures (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id     uuid not null,
  valid_until     date not null,
  failures        integer not null default 0 check (failures >= 0),
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  primary key (document_id),
  constraint contract_expiry_failures_document_fk foreign key (organization_id, document_id)
    references public.signature_documents (organization_id, id) on delete cascade
);
create index if not exists contract_expiry_failures_org_document_idx on app.contract_expiry_failures (organization_id, document_id);
alter table app.contract_expiry_failures enable row level security;
revoke all on app.contract_expiry_failures from public, anon, authenticated, service_role;

-- a person touched the task: an update by a person that changed anything beyond the title and the description, or a
-- person's restore from the recycle bin (review)
create or replace function app.contract_renewal_task_touched(p_org uuid, p_task uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.audit_log al
     where al.organization_id = p_org and al.entity_type = 'tasks' and al.entity_id = p_task and al.actor_id is not null
       and ((al.action = 'update' and (al.changes - 'title' - 'description') <> '{}'::jsonb) or al.action = 'restore'))
$$;
revoke all on function app.contract_renewal_task_touched(uuid, uuid) from public, anon, authenticated, service_role;

-- the renewal tasks of contracts whose validity ended: closed by the job, never reopened by it; a task a person touched
-- stays. A marked contract is judged again only while it has an open renewal task nobody touched (one back from the bin).
create or replace function app.close_expired_contract_renewals() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_doc public.signature_documents;
  v_open uuid[];
  v_held uuid[];
  v_done integer := 0;
  v_state text;
  v_failures integer;
begin
  for v_row in
    with orgs as materialized (
      select o.id, (now() at time zone app.intake_zone(o.timezone))::date as today
        from public.organizations o
       where exists (select 1 from public.signature_documents d
                      where d.organization_id = o.id and d.status = 'signed' and d.valid_until is not null)
         and app.org_writable(o.id)
         and app.org_has_feature(o.id, 'signatures')
    ),
    cand as materialized (
      select d.organization_id, d.id, d.valid_until, og.today, f.last_attempt_at
        from orgs og
        join public.signature_documents d on d.organization_id = og.id
        left join app.contract_expiry_failures f on f.document_id = d.id and f.valid_until = d.valid_until
       where d.status = 'signed' and d.valid_until is not null and d.valid_until < og.today and d.erased_at is null
         and coalesce(f.failures, 0) < 3
         and (d.contract_expired_at is null
              or exists (select 1 from app.contract_renewal_tasks k
                           join public.tasks t on t.organization_id = k.organization_id and t.id = k.task_id
                          where k.organization_id = d.organization_id and k.document_id = d.id
                            and t.status = 'open' and t.deleted_at is null
                            and not app.contract_renewal_task_touched(t.organization_id, t.id)))
    )
    -- businesses take turns (SGN-03's caps: app.signature_expiry_per_org() 200 a business, app.signature_expiry_limit()
    -- 2,000 a run), a document that failed before last within its business
    select z.* from (
      select c.*, row_number() over (partition by c.organization_id order by c.last_attempt_at nulls first, c.valid_until, c.id) as n
        from cand c
    ) z
     where z.n <= app.signature_expiry_per_org()
     order by z.n, z.last_attempt_at nulls first, z.organization_id, z.id
     limit app.signature_expiry_limit()
  loop
    begin
      select * into v_doc from public.signature_documents d
       where d.organization_id = v_row.organization_id and d.id = v_row.id
         and d.status = 'signed' and d.valid_until = v_row.valid_until and d.valid_until < v_row.today and d.erased_at is null
       for update skip locked;
      if found then
        -- its open renewal tasks that no person touched
        select coalesce(array_agg(t.id), '{}') into v_open
          from app.contract_renewal_tasks k
          join public.tasks t on t.organization_id = k.organization_id and t.id = k.task_id
         where k.organization_id = v_doc.organization_id and k.document_id = v_doc.id
           and t.status = 'open' and t.deleted_at is null
           and not app.contract_renewal_task_touched(t.organization_id, t.id);
        select coalesce(array_agg(x.id), '{}') into v_held
          from (select t.id from public.tasks t
                 where t.organization_id = v_doc.organization_id and t.id = any (v_open) and t.status = 'open'
                 for update skip locked) x;
        -- a task someone holds right now: the whole document waits for the next run
        if cardinality(v_held) = cardinality(v_open) then
          -- review: judged again under the lock, so a person's change committed in between keeps the task open
          update public.tasks t set status = 'done', outcome = 'נסגרה: פג תוקף החוזה'
           where t.organization_id = v_doc.organization_id and t.id = any (v_held)
             and t.status = 'open' and t.deleted_at is null
             and not app.contract_renewal_task_touched(t.organization_id, t.id);
          update public.signature_documents d set contract_expired_at = now()
           where d.organization_id = v_doc.organization_id and d.id = v_doc.id and d.contract_expired_at is null;
          update app.contract_expiry_failures f set failures = 0, last_attempt_at = now()
           where f.document_id = v_doc.id and f.failures > 0;
          v_done := v_done + 1;
        end if;
      end if;
    exception when others then
      v_state := sqlstate;
      v_failures := null;
      -- the bookkeeping in its own block (the document or the business may be gone by now: then nothing is kept)
      begin
        insert into app.contract_expiry_failures as f (organization_id, document_id, valid_until, failures, last_attempt_at)
        values (v_row.organization_id, v_row.id, v_row.valid_until, 1, now())
        on conflict (document_id) do update
          set failures = case when f.valid_until = excluded.valid_until then f.failures + 1 else 1 end,
              valid_until = excluded.valid_until, last_attempt_at = excluded.last_attempt_at
        returning f.failures into v_failures;
      exception when others then
        null;
      end;
      raise warning 'crm-contract-renewals: closing the expired document % failed (SQLSTATE %)%', v_row.id, v_state,
        case when coalesce(v_failures, 0) >= 3 then ', skipped after 3 failures' else '' end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.close_expired_contract_renewals() from public, anon, authenticated, service_role;

-- app.send_contract_renewals of 021223 with one line (marked)
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
  -- (283) ב: first, the renewal tasks of contracts whose validity ended close by themselves (never reopened); review: in
  -- its own block, so the alerts below run either way
  begin
    perform app.close_expired_contract_renewals();
  exception when others then
    raise warning 'crm-contract-renewals: closing the tasks of expired contracts failed (SQLSTATE %)', sqlstate;
  end;
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
-- (287) ב: the device's IP address, handed over by the server in a request header
-- ----------------------------------------------------------------------------
create or replace function app.in_person_device_ip() returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_value text;
begin
  begin
    v_value := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-crm-device-ip';
  exception when others then
    return null;
  end;
  v_value := btrim(coalesce(v_value, ''));
  return case when v_value ~ '^[0-9A-Fa-f.:]{2,64}$' then v_value end;
end;
$$;
revoke all on function app.in_person_device_ip() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- (289) ב: who hears of an in-person answer: the recipients without the rep; when nobody is left, the active owners and
-- admins (never the rep)
-- ----------------------------------------------------------------------------
create or replace function app.in_person_notice_targets(p_org uuid, p_rep uuid, p_recipients uuid[]) returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select u from unnest(coalesce(p_recipients, '{}')) u where u is not null and u is distinct from p_rep
  union
  select m.user_id from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin') and m.user_id is distinct from p_rep
     and not exists (select 1 from unnest(coalesce(p_recipients, '{}')) u where u is not null and u is distinct from p_rep)
$$;
revoke all on function app.in_person_notice_targets(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A document for signature: public.signature_in_person_sign of 021227 with the (287) and (289) lines (marked)
-- ----------------------------------------------------------------------------
create or replace function public.signature_in_person_sign(
  p_org uuid, p_doc uuid, p_fingerprint text, p_signer_name text, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null, p_wording_version text default null,
  p_agreed boolean default false, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  -- the rep's session first: the right that sends the document (42501 otherwise)
  v_doc public.signature_documents := app.signature_managed_document(p_org, p_doc);
  v_tries integer;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_record jsonb;
  v_rep uuid := auth.uid();
begin
  if v_rep is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the signing tries of the document's link (10 in 10 minutes), shared with the customer's page
  update app.signature_links l
     set sign_window_started_at = case when l.sign_window_started_at > now() - interval '10 minutes' then l.sign_window_started_at else now() end,
         sign_count = case when l.sign_window_started_at > now() - interval '10 minutes' then l.sign_count + 1 else 1 end
   where l.document_id = v_doc.id
  returning l.sign_count into v_tries;
  -- review (low): no link row, no counter: never signed without one
  if v_tries is null then
    return jsonb_build_object('status', 'closed');
  end if;
  if v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- locked against a second signature and a cancel in parallel (public.signature_public_sign's checks, kept in step)
  select * into v_doc from public.signature_documents d where d.organization_id = v_doc.organization_id and d.id = v_doc.id for update;
  if v_doc.status = 'signed' then
    return jsonb_build_object('status', 'already_signed');
  end if;
  if v_doc.status not in ('sent', 'viewed') or v_doc.erased_at is not null
     or (v_doc.expires_at is not null and v_doc.expires_at <= now()) then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from v_doc.content_sha256 or v_doc.content_sha256 is distinct from app.signature_fingerprint(v_doc) then
    return jsonb_build_object('status', 'changed');
  end if;
  if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
     or not exists (select 1 from app.signature_wording_versions w where w.version = p_wording_version)
     or p_signature_kind is null or p_signature_kind not in ('drawn', 'typed')
     or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                         or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
     or (v_id is not null and not app.valid_israeli_id(v_id)) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- the rep's identity and device (the user agent and, since (287) ב, the device's IP address from the server request)
  insert into public.signature_signatures (organization_id, document_id, signer_name, signer_id_number, signature_kind,
                                           signature_image, wording_version, content_sha256, ip, user_agent,
                                           in_person, in_person_by)
  values (v_doc.organization_id, v_doc.id, v_name, v_id, p_signature_kind,
          case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, v_doc.content_sha256,
          app.in_person_device_ip(), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), true, v_rep);
  update app.signature_links l set signed_token_hash = l.token_hash where l.document_id = v_doc.id;
  update public.signature_documents d
     set status = 'signed', signed_at = now(),
         people = (select coalesce(array_agg(distinct x), '{}') from unnest(d.people || app.signature_people(d)) x)
   where d.organization_id = v_doc.organization_id and d.id = v_doc.id
  returning * into v_doc;
  perform app.signature_timeline(v_doc, 'signature_signed', 'הלקוח חתם על המסמך במקום: ' || v_doc.title, v_rep);

  -- the sender and the record's owner (active, not viewers); else the active owners and admins; never the rep who was
  -- there. The title only.
  v_record := app.signature_record_row(v_doc.organization_id, app.signature_record_type(v_doc), app.signature_record_id(v_doc));
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_doc.organization_id, r.user_id, 'system', 'מסמך נחתם בקישור', v_doc.title,
         app.signature_record_type(v_doc), app.signature_record_id(v_doc)
    -- (289) ב: when the rep would be the only one, the active owners and admins instead (never the rep)
    from app.in_person_notice_targets(v_doc.organization_id, v_rep, array(
          select m.user_id from public.memberships m
           where m.organization_id = v_doc.organization_id and m.status = 'active' and m.role <> 'viewer'
             and m.user_id in (v_doc.sent_by, (v_record ->> 'owner_id')::uuid)
          union
          select m.user_id from public.memberships m
           where m.organization_id = v_doc.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
             and not exists (select 1 from public.memberships o
                              where o.organization_id = v_doc.organization_id and o.status = 'active' and o.role <> 'viewer'
                                and o.user_id in (v_doc.sent_by, (v_record ->> 'owner_id')::uuid)))) r(user_id);

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_doc.organization_id, v_rep, 'in_person_signature', 'signature_documents', v_doc.id,
          jsonb_build_object('status', 'signed', 'in_person', true, 'record_type', app.signature_record_type(v_doc)));
  return jsonb_build_object('status', 'signed');
end;
$$;
revoke all on function public.signature_in_person_sign(uuid, uuid, text, text, text, text, text, text, boolean, text) from public, anon;
grant execute on function public.signature_in_person_sign(uuid, uuid, text, text, text, text, text, text, boolean, text) to authenticated;

-- (288) ב: within 24 hours (021227's body, '1 hour' -> '24 hours')
create or replace function app.signature_in_person_rep(p_org uuid, p_doc uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.signature_signatures s
     where s.organization_id = p_org and s.document_id = p_doc and s.in_person and s.in_person_by = p_user
       and s.erased_at is null and s.signed_at > now() - interval '24 hours')
$$;
revoke all on function app.signature_in_person_rep(uuid, uuid, uuid) from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- A quote: public.quote_in_person_accept of 021227 with the (287) and (289) lines (marked)
-- ----------------------------------------------------------------------------
create or replace function public.quote_in_person_accept(
  p_org uuid, p_quote uuid, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false, p_user_agent text default null,
  p_optional_keys integer[] default null, p_accepted_total_agorot bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes := app.quote_in_person_quote(p_org, p_quote);
  v_rep uuid := auth.uid();
  v_tries integer;
  v_state text;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_deal_note text;
  v_choice uuid[];
  v_matched integer;
  v_totals jsonb;
  v_claims text;
  v_claim_sub text;
begin
  -- the decide window of the quote's live link (10 tries in 10 minutes, shared with the customer's page); review (low): no
  -- live link, no counter, so nothing is accepted without one
  update app.quote_links l
     set decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.quote_id = v_quote.id and l.organization_id = v_quote.organization_id and l.token_hash is not null
  returning l.decide_count into v_tries;
  if v_tries is null then
    return jsonb_build_object('status', 'closed');
  end if;
  if v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- locked against a second decision in parallel; then the same states as the customer's page
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id for update;
  v_state := app.quote_in_person_state(v_quote);
  if v_state = 'decided' then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  if v_state = 'superseded' then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_state <> 'open' then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from app.quote_fingerprint(v_quote) then
    return jsonb_build_object('status', 'changed');
  end if;

  if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
     or coalesce(p_wording_version, '') !~ '^[a-z0-9-]{1,40}$'
     or p_signature_kind is null or p_signature_kind not in ('drawn', 'typed')
     or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                         or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
     or (v_id is not null and not app.valid_israeli_id(v_id)) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- QUO-08: the optional lines ticked, by their place in the page's list (as public.quote_public_answer)
  if p_optional_keys is null then
    if p_accepted_total_agorot is not null then
      return jsonb_build_object('status', 'invalid');
    end if;
    select coalesce(array_agg(l.id order by l.position, l.id), '{}') into v_choice
      from public.quote_lines l
     where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
       and l.kind = 'item' and l.is_optional and l.optional_selected;
  else
    if p_accepted_total_agorot is null or cardinality(p_optional_keys) > 200 or array_position(p_optional_keys, null) is not null
       or cardinality(p_optional_keys) <> (select count(distinct k) from unnest(p_optional_keys) k) then
      return jsonb_build_object('status', 'invalid');
    end if;
    select coalesce(array_agg(o.id order by o.place), '{}'), count(*) into v_choice, v_matched
      from (select l.id, l.kind, l.is_optional, row_number() over (order by l.position, l.id) as place
              from public.quote_lines l
             where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id) o
     where o.place = any (p_optional_keys) and o.kind = 'item' and o.is_optional;
    if v_matched <> cardinality(p_optional_keys) then
      return jsonb_build_object('status', 'invalid');
    end if;
  end if;
  begin
    v_totals := app.quote_counted_totals(v_quote, v_quote.vat_rate_bp, v_choice);
  exception when sqlstate '22023' then
    return jsonb_build_object('status', 'invalid');
  end;
  if p_accepted_total_agorot is not null and p_accepted_total_agorot is distinct from (v_totals ->> 'total_agorot')::bigint then
    return jsonb_build_object('status', 'changed');
  end if;

  -- the writes below are the server's, as the customer's acceptance (the quote triggers judge a write with no person)
  v_claims := current_setting('request.jwt.claims', true);
  v_claim_sub := current_setting('request.jwt.claim.sub', true);
  if v_claims is not null then
    perform set_config('request.jwt.claims', '', true);
  end if;
  if v_claim_sub is not null then
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  -- the rep's identity and device (the user agent and, since (287) ב, the device's IP address from the server request)
  insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                      signature_image, wording_version, content_sha256, ip, user_agent,
                                      optional_line_ids, choice_sha256, sent_net_total_agorot, sent_total_agorot,
                                      accepted_subtotal_agorot, accepted_discount_total_agorot, accepted_net_total_agorot,
                                      accepted_vat_agorot, accepted_total_agorot, in_person, in_person_by)
  values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
          case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
          app.in_person_device_ip(), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
          v_choice, app.quote_choice_fingerprint(p_fingerprint, v_choice), v_quote.net_total_agorot, v_quote.total_agorot,
          (v_totals ->> 'subtotal_agorot')::bigint, (v_totals ->> 'document_discount_agorot')::bigint,
          (v_totals ->> 'net_total_agorot')::bigint, (v_totals ->> 'vat_agorot')::bigint, (v_totals ->> 'total_agorot')::bigint,
          true, v_rep);

  perform set_config('app.quote_accept_choice', v_quote.id::text, true);
  update public.quote_lines l
     set optional_selected = (l.id = any (v_choice))
   where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
     and l.kind = 'item' and l.is_optional and l.optional_selected is distinct from (l.id = any (v_choice));
  update public.quotes q set status = 'accepted'
   where q.organization_id = v_quote.organization_id and q.id = v_quote.id;
  perform set_config('app.quote_accept_choice', '', true);
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  -- QUO-13: the deal of an accepted quote, by the business's setting; never fails the decision
  begin
    v_deal_note := app.quote_accept_deal(v_quote);
  exception when others then
    raise warning 'QUO-13: the deal step of quote % failed: % (%)', v_quote.id, sqlerrm, sqlstate;
    v_deal_note := 'לא הצלחנו לטפל בעסקה של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה.';
  end;

  if v_claims is not null then
    perform set_config('request.jwt.claims', v_claims, true);
  end if;
  if v_claim_sub is not null then
    perform set_config('request.jwt.claim.sub', v_claim_sub, true);
  end if;

  -- the quote's owner hears of it, never the rep who was there: number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left('הצעת מחיר אושרה במקום: ' || v_quote.title, 200),
         nullif(concat_ws(' · ', case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end, v_deal_note), ''),
         'quote', v_quote.id
    -- (289) ב: when the rep would be the only one, the active owners and admins instead (never the rep)
    from app.in_person_notice_targets(v_quote.organization_id, v_rep,
                                      array(select n.user_id from app.quote_notice_recipients(v_quote) n(user_id))) r(user_id);

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_quote.organization_id, v_rep, 'in_person_signature', 'quotes', v_quote.id,
          jsonb_build_object('status', 'accepted', 'in_person', true));
  return jsonb_build_object('status', 'accepted');
end;
$$;
revoke all on function public.quote_in_person_accept(uuid, uuid, text, text, text, text, text, text, boolean, text, integer[], bigint) from public, anon;
grant execute on function public.quote_in_person_accept(uuid, uuid, text, text, text, text, text, text, boolean, text, integer[], bigint) to authenticated;

-- (288) ב: within 24 hours (021227's body, '1 hour' -> '24 hours')
create or replace function app.quote_in_person_rep(p_org uuid, p_quote uuid, p_user uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.quote_decisions d
     where d.organization_id = p_org and d.quote_id = p_quote and d.decision = 'accepted' and d.in_person
       and d.in_person_by = p_user and d.erased_at is null and d.decided_at > now() - interval '24 hours')
$$;
revoke all on function app.quote_in_person_rep(uuid, uuid, uuid) from public, anon, authenticated, service_role;


-- ----------------------------------------------------------------------------
-- (290) ב: a quote declined in person (public.quote_public_answer's rejected branch, 021117; kept in step)
-- ----------------------------------------------------------------------------
create or replace function public.quote_in_person_decline(
  p_org uuid, p_quote uuid, p_fingerprint text,
  p_signer_name text default null, p_decline_reason text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  -- the rep's session first: the right that sends a quote (42501 otherwise)
  v_quote public.quotes := app.quote_in_person_quote(p_org, p_quote);
  v_rep uuid := auth.uid();
  v_tries integer;
  v_state text;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_reason text := nullif(btrim(coalesce(p_decline_reason, '')), '');
  v_claims text;
  v_claim_sub text;
begin
  -- the decide window of the quote's live link (10 tries in 10 minutes, shared with the customer's page); no live link, no
  -- counter, so nothing is decided without one
  update app.quote_links l
     set decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.quote_id = v_quote.id and l.organization_id = v_quote.organization_id and l.token_hash is not null
  returning l.decide_count into v_tries;
  if v_tries is null then
    return jsonb_build_object('status', 'closed');
  end if;
  if v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- locked against a second decision in parallel; then the same states as the customer's page
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id for update;
  v_state := app.quote_in_person_state(v_quote);
  if v_state = 'decided' then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  if v_state = 'superseded' then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_state <> 'open' then
    return jsonb_build_object('status', 'closed');
  end if;
  if p_fingerprint is distinct from app.quote_fingerprint(v_quote) then
    return jsonb_build_object('status', 'changed');
  end if;
  if (v_reason is not null and char_length(v_reason) > 1000) or (v_name is not null and char_length(v_name) not between 2 and 120) then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- the writes below are the server's, as the customer's decline (the quote triggers judge a write with no person)
  v_claims := current_setting('request.jwt.claims', true);
  v_claim_sub := current_setting('request.jwt.claim.sub', true);
  if v_claims is not null then
    perform set_config('request.jwt.claims', '', true);
  end if;
  if v_claim_sub is not null then
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  -- the rep's identity and device: the user agent and the device's IP address from the server request
  insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, content_sha256, ip, user_agent, decline_reason,
                                      in_person, in_person_by)
  values (v_quote.organization_id, v_quote.id, 'rejected', v_name, p_fingerprint,
          app.in_person_device_ip(), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), v_reason, true, v_rep);
  update public.quotes q set status = 'rejected'
   where q.organization_id = v_quote.organization_id and q.id = v_quote.id;
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  if v_claims is not null then
    perform set_config('request.jwt.claims', v_claims, true);
  end if;
  if v_claim_sub is not null then
    perform set_config('request.jwt.claim.sub', v_claim_sub, true);
  end if;

  -- the quote's owner hears of it, never the rep who was there ((289) ב: else the owners and admins): number and title
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left('הצעת מחיר נדחתה במקום: ' || v_quote.title, 200),
         case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end,
         'quote', v_quote.id
    from app.in_person_notice_targets(v_quote.organization_id, v_rep,
                                      array(select n.user_id from app.quote_notice_recipients(v_quote) n(user_id))) r(user_id);

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_quote.organization_id, v_rep, 'in_person_decline', 'quotes', v_quote.id,
          jsonb_build_object('status', 'rejected', 'in_person', true));
  return jsonb_build_object('status', 'rejected');
end;
$$;
revoke all on function public.quote_in_person_decline(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.quote_in_person_decline(uuid, uuid, text, text, text, text) to authenticated;
