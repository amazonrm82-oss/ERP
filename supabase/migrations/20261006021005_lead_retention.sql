-- =============================================================================
-- PRV-01: retention policy for inactive leads (owner, 13 and 18 October 2026)
-- =============================================================================
-- The guiding rule: whenever in doubt, the policy keeps the lead.
-- * Off by default. Owners and admins of a writable business turn it on, pick a number of months (6..120), change it
--   or turn it off, through public.lead_retention_set; turning it on and every change of the months needs the
--   preview (public.lead_retention_preview) and a confirmation (p_confirm, hint retention:confirm). Every change is
--   audited (action retention_policy) and cancels the open round, so a new round always starts with its own notice.
-- * Inactive (owner, 18 October, answer (ב), and 13 October point 3), app.lead_retention_candidates: an unconverted
--   lead, not in the bin, not sample data, made more than X months ago, with no contact for X months: no
--   last_contacted_at since, no entry of a contact type (call, message, note, meeting; private notes and entries with
--   no author included) and no 'inquiry' (a public form, a booking page, a business card or a site widget: the customer
--   came back) since, no meeting that started since (held or not, unless cancelled); no open task, no planned meeting
--   that has not ended; and not kept or restored within X months (app.lead_retention_keeps). An unconverted lead has
--   no deal of its own (deals reach a lead only through its conversion), so "no open deal" holds for every lead that
--   can be chosen. GAP-12 follow-up: an imported lead is judged by its real activity (imports carry no original date).
--   Private notes count as contact HERE ONLY (owner, 26 October 2026, answer (א)): nothing else changes; the response
--   time report, last_contacted_at (app.stamp_last_contact), activation and the lead score keep their own rules, in
--   which a private note is not contact.
-- * Rounds (pg_cron crm-lead-retention, hourly): a business with the policy on and no open round gets a round of the
--   leads that will be inactive within 14 days, and one 'system' notice to every active owner and admin. 14 days later
--   the round moves the leads that are still inactive to the recycle bin (deleted_at, as a server write; each lead
--   locked and judged again just before); a lead kept from the list ("להשאיר", public.lead_retention_keep) or active
--   again is left out. A round whose business is not writable when it comes due is cancelled, never carried out
--   later: the business gets a new round with a new 14-day notice once it is writable again. The bin keeps restoring
--   possible for 30 days; the existing app.purge_trash removes them after that.
-- * A lead the policy binned that is restored, or binned again by a person (deleted_at no longer the policy's), counts
--   as kept and leaves the policy's hands.
-- * After the final deletion the job erases the lead's details from the audit log with the same core as
--   public.audit_erase_request (app.audit_erase_core), as an erasure that is NOT the person's request: no
--   do-not-contact entry is written, and an existing opt-out stays. Only when the row that was deleted is the one the
--   policy binned (the 'delete' audit snapshot carries the policy's deleted_at): a lead merged away or deleted after a
--   restore is not the policy's. A person's "delete forever" of a lead still in the bin from the policy (before the 30
--   days) is erased like the purge. Like audit_erase_request it waits while the hash key is missing and the lead has a
--   consent entry not hashed yet (counted; waiting rows go last; the platform log is told after a week of waiting).
--   One audit line per business and run (action retention_purge, the count only); each lead's own row of the core is
--   recorded as action 'retention' (owner, 26 October 2026), not 'erase'.
-- * The erasure runs whatever the business's state (read-only, suspended, closed): the purge removes the rows anyway,
--   and their personal details must not outlive them in the audit log (intended).
-- * Locks: the job runs as one transaction, so the step that locks leads (the move to the bin) runs last, after the
--   erasures and the new rounds. It locks each lead, then its round row; public.lead_retention_keep takes them in the
--   same order. A deadlock (40P01) or any other failure on one lead leaves that lead out of the bin (the safe side; the
--   next round may list it again); a person whose "keep" fails tries again.
-- * After 24 failed erasure attempts of one lead the job stops trying it and tells app.platform_log once
--   (lead_retention_erase_stopped). Follow-up: a path for platform staff to restart it.
-- * Fair and capped: new rounds for 50 businesses a run (oldest checked first), 1,000 leads to the bin per business
--   and 5,000 per run, 50 erasures per business and 300 per run; one exception block per business, per round and per
--   row, failures in app.platform_log.
-- No statement deletes rows; the tables live in schema app (RLS on, no grants). Safe to run twice.

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table if not exists app.lead_retention_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  enabled         boolean not null default false,
  months          integer not null default 12,
  changed_at      timestamptz not null default now(),
  changed_by      uuid,
  -- the round job's cursor: businesses checked longest ago come first
  checked_at      timestamptz,
  constraint lead_retention_settings_months check (months between 6 and 120)
);
alter table app.lead_retention_settings enable row level security;
revoke all on app.lead_retention_settings from public, anon, authenticated;

create table if not exists app.lead_retention_rounds (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  months          integer not null,
  noticed_at      timestamptz not null default now(),
  due_at          timestamptz not null,
  status          text not null default 'open',
  finished_at     timestamptz,
  binned          integer not null default 0,
  constraint lead_retention_rounds_status check (status in ('open', 'done', 'cancelled'))
);
alter table app.lead_retention_rounds enable row level security;
revoke all on app.lead_retention_rounds from public, anon, authenticated;
create unique index if not exists lead_retention_rounds_one_open
  on app.lead_retention_rounds (organization_id) where status = 'open';
-- the organization key (and the last finished round of the status page)
create index if not exists lead_retention_rounds_org
  on app.lead_retention_rounds (organization_id, finished_at desc);
create index if not exists lead_retention_rounds_due
  on app.lead_retention_rounds (due_at) where status = 'open';

-- the leads of a round; ids only (no name), kept after the lead is purged so its erasure can follow
create table if not exists app.lead_retention_round_leads (
  round_id        uuid not null references app.lead_retention_rounds (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id         uuid not null,
  kept_at         timestamptz,
  kept_by         uuid,
  -- no longer inactive when the round came due
  skipped_at      timestamptz,
  binned_at       timestamptz,
  -- restored, binned again by a person, or deleted otherwise than the policy's bin: no longer the policy's
  restored_at     timestamptz,
  erased_at       timestamptz,
  erase_attempts  integer not null default 0,
  -- runs that found the hash key missing for this lead's unhashed consent entry
  erase_waits     integer not null default 0,
  primary key (round_id, lead_id)
);
alter table app.lead_retention_round_leads enable row level security;
revoke all on app.lead_retention_round_leads from public, anon, authenticated;
create index if not exists lead_retention_round_leads_lead
  on app.lead_retention_round_leads (organization_id, lead_id);
create index if not exists lead_retention_round_leads_to_erase
  on app.lead_retention_round_leads (organization_id)
  where binned_at is not null and restored_at is null and erased_at is null;

-- "keep" from the list, or a restore from the bin: the count starts again from kept_at
create table if not exists app.lead_retention_keeps (
  organization_id uuid not null,
  lead_id         uuid not null,
  kept_at         timestamptz not null default now(),
  kept_by         uuid,
  primary key (organization_id, lead_id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade
);
alter table app.lead_retention_keeps enable row level security;
revoke all on app.lead_retention_keeps from public, anon, authenticated;

alter table app.lead_retention_round_leads add column if not exists erase_waits integer not null default 0;

-- ----------------------------------------------------------------------------
-- The rule: the leads of a business (or the one lead p_lead) inactive since before p_cutoff
-- ----------------------------------------------------------------------------
create or replace function app.lead_retention_candidates(p_org uuid, p_cutoff timestamptz, p_lead uuid default null)
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select l.id
    from public.leads l
   where l.organization_id = p_org
     and (p_lead is null or l.id = p_lead)
     and l.deleted_at is null
     and l.converted_at is null
     and l.created_at < p_cutoff
     and (l.last_contacted_at is null or l.last_contacted_at < p_cutoff)
     -- sample data (USR-04) is removed by its own button, never by the policy
     and not exists (select 1 from app.sample_records s where s.organization_id = p_org and s.lead_id = l.id)
     -- contact of any author (call, message, note, meeting; private notes too) and the customer's own inquiries
     and not exists (select 1 from public.activities a
                      where a.organization_id = p_org and a.lead_id = l.id
                        and (a.type = any (app.contact_types()) or a.type = 'inquiry')
                        and (a.occurred_at >= p_cutoff or a.created_at >= p_cutoff))
     and not exists (select 1 from public.tasks t
                      where t.organization_id = p_org and t.lead_id = l.id
                        and t.deleted_at is null and t.status = 'open')
     -- a planned meeting still ahead, or any meeting that was not cancelled within the window
     and not exists (select 1 from public.meetings m
                      where m.organization_id = p_org and m.lead_id = l.id
                        and ((m.status = 'planned' and m.ends_at > now())
                             or (m.status <> 'cancelled' and m.starts_at >= p_cutoff)))
     and not exists (select 1 from app.lead_retention_keeps k
                      where k.organization_id = p_org and k.lead_id = l.id and k.kept_at >= p_cutoff);
$$;
revoke all on function app.lead_retention_candidates(uuid, timestamptz, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Owners and admins: preview, status, the round's list, set, keep
-- ----------------------------------------------------------------------------
create or replace function app.lead_retention_admin(p_org uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) then
    raise exception 'owners and admins only' using errcode = '42501';
  end if;
end;
$$;
revoke all on function app.lead_retention_admin(uuid) from public, anon, authenticated;

-- how many leads the policy would take with p_months: inactive now (the first round lists them, and those that
-- become inactive within its 14 days)
create or replace function public.lead_retention_preview(p_org uuid, p_months integer) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.lead_retention_admin(p_org);
  if p_months is null or p_months < 6 or p_months > 120 then
    raise exception 'months out of range' using errcode = 'P0001', hint = 'retention:months';
  end if;
  return jsonb_build_object(
    'months', p_months,
    'now', (select count(*) from app.lead_retention_candidates(p_org, now() - make_interval(months => p_months))),
    'within_notice', (select count(*) from app.lead_retention_candidates(p_org, now() - make_interval(months => p_months) + interval '14 days')));
end;
$$;
revoke all on function public.lead_retention_preview(uuid, integer) from public, anon;
grant execute on function public.lead_retention_preview(uuid, integer) to authenticated;

create or replace function public.lead_retention_status(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_set app.lead_retention_settings;
  v_open app.lead_retention_rounds;
  v_last app.lead_retention_rounds;
begin
  perform app.lead_retention_admin(p_org);
  select * into v_set from app.lead_retention_settings s where s.organization_id = p_org;
  select * into v_open from app.lead_retention_rounds r where r.organization_id = p_org and r.status = 'open';
  select * into v_last from app.lead_retention_rounds r
   where r.organization_id = p_org and r.status = 'done' order by r.finished_at desc limit 1;
  return jsonb_build_object(
    'enabled', coalesce(v_set.enabled, false),
    'months', v_set.months,
    'changed_at', v_set.changed_at,
    'changed_by', v_set.changed_by,
    'open_round', case when v_open.id is null then null else jsonb_build_object(
      'id', v_open.id, 'months', v_open.months, 'noticed_at', v_open.noticed_at, 'due_at', v_open.due_at,
      'total', (select count(*) from app.lead_retention_round_leads rl where rl.round_id = v_open.id),
      'kept', (select count(*) from app.lead_retention_round_leads rl where rl.round_id = v_open.id and rl.kept_at is not null)) end,
    'last_round', case when v_last.id is null then null else jsonb_build_object(
      'id', v_last.id, 'finished_at', v_last.finished_at, 'binned', v_last.binned) end);
end;
$$;
revoke all on function public.lead_retention_status(uuid) from public, anon;
grant execute on function public.lead_retention_status(uuid) to authenticated;

-- the open round's list, 100 a page, least recently contacted first
create or replace function public.lead_retention_round_leads(p_org uuid, p_offset integer default 0) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_round app.lead_retention_rounds;
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
begin
  perform app.lead_retention_admin(p_org);
  select * into v_round from app.lead_retention_rounds r where r.organization_id = p_org and r.status = 'open';
  if v_round.id is null then
    return jsonb_build_object('round', null, 'leads', '[]'::jsonb, 'has_more', false);
  end if;
  -- 101 rows at most: the extra one only says that another page exists (no separate count)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'name', x.full_name, 'phone', x.phone, 'email', x.email,
           'created_at', x.created_at, 'last_contacted_at', x.last_contacted_at,
           'kept_at', x.kept_at, 'binned', x.binned_at is not null or x.deleted_at is not null, 'skipped', x.skipped_at is not null)
           order by x.sort_at, x.id), '[]'::jsonb)
    into v_rows
    from (select l.id, l.full_name, l.phone, l.email, l.created_at, l.last_contacted_at, rl.kept_at, rl.binned_at, rl.skipped_at, l.deleted_at,
                 coalesce(l.last_contacted_at, l.created_at) as sort_at
            from app.lead_retention_round_leads rl
            join public.leads l on l.organization_id = rl.organization_id and l.id = rl.lead_id
           where rl.round_id = v_round.id
           order by coalesce(l.last_contacted_at, l.created_at), l.id
           offset v_offset limit 101) x;
  return jsonb_build_object(
    'round', jsonb_build_object('id', v_round.id, 'months', v_round.months, 'noticed_at', v_round.noticed_at, 'due_at', v_round.due_at),
    'leads', case when jsonb_array_length(v_rows) > 100 then v_rows - 100 else v_rows end,
    'has_more', jsonb_array_length(v_rows) > 100);
end;
$$;
revoke all on function public.lead_retention_round_leads(uuid, integer) from public, anon;
grant execute on function public.lead_retention_round_leads(uuid, integer) to authenticated;

create or replace function public.lead_retention_set(p_org uuid, p_enabled boolean, p_months integer, p_confirm boolean)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old app.lead_retention_settings;
  v_months integer;
  v_cancelled integer;
begin
  perform app.lead_retention_admin(p_org);
  if not app.org_writable(p_org) then
    raise exception 'read only' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'enabled is required' using errcode = '22023';
  end if;
  select * into v_old from app.lead_retention_settings s where s.organization_id = p_org for update;
  v_months := coalesce(p_months, v_old.months, 12);
  if v_months < 6 or v_months > 120 then
    raise exception 'months out of range' using errcode = 'P0001', hint = 'retention:months';
  end if;
  if coalesce(v_old.enabled, false) = p_enabled and (not p_enabled or v_old.months = v_months) then
    return jsonb_build_object('changed', false);
  end if;
  -- turning it on, or a change of the months while on, is confirmed after the preview
  if p_enabled and not coalesce(p_confirm, false) then
    raise exception 'confirm the preview first' using errcode = 'P0001', hint = 'retention:confirm';
  end if;

  insert into app.lead_retention_settings (organization_id, enabled, months, changed_at, changed_by)
  values (p_org, p_enabled, v_months, now(), auth.uid())
  on conflict (organization_id) do update
    set enabled = excluded.enabled, months = excluded.months, changed_at = excluded.changed_at,
        changed_by = excluded.changed_by, checked_at = null;

  -- the open round was noticed under the old setting: it stops, and a new one starts with its own notice
  update app.lead_retention_rounds r set status = 'cancelled', finished_at = now()
   where r.organization_id = p_org and r.status = 'open';
  get diagnostics v_cancelled = row_count;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'retention_policy', 'lead_retention', null,
          jsonb_build_object('enabled', p_enabled, 'months', v_months,
                             'previous_enabled', coalesce(v_old.enabled, false), 'previous_months', v_old.months,
                             'round_cancelled', v_cancelled > 0));
  return jsonb_build_object('changed', true, 'round_cancelled', v_cancelled > 0);
end;
$$;
revoke all on function public.lead_retention_set(uuid, boolean, integer, boolean) from public, anon;
grant execute on function public.lead_retention_set(uuid, boolean, integer, boolean) to authenticated;

-- "keep" one lead of the open round: it leaves the round and its count starts again
create or replace function public.lead_retention_keep(p_org uuid, p_lead uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_round uuid;
begin
  perform app.lead_retention_admin(p_org);
  if not app.org_writable(p_org) then
    raise exception 'read only' using errcode = '42501';
  end if;
  -- the lead first, then its round row: the job's order, so a "keep" and the job's move to the bin never cross. After
  -- the lock the round row is read again: a lead the job has just binned (or a person has) is no longer on the list.
  perform 1 from public.leads l
    where l.organization_id = p_org and l.id = p_lead and l.deleted_at is null
    for update;
  if found then
    select rl.round_id into v_round
      from app.lead_retention_round_leads rl
      join app.lead_retention_rounds r on r.id = rl.round_id
     where r.organization_id = p_org and r.status = 'open' and rl.lead_id = p_lead
       and rl.binned_at is null and rl.skipped_at is null
     for update of rl;
  end if;
  if v_round is null then
    raise exception 'not on the list' using errcode = 'P0001', hint = 'retention:not_listed';
  end if;
  update app.lead_retention_round_leads rl set kept_at = now(), kept_by = auth.uid()
   where rl.round_id = v_round and rl.lead_id = p_lead and rl.kept_at is null;
  if not found then
    return;
  end if;
  insert into app.lead_retention_keeps (organization_id, lead_id, kept_at, kept_by)
  values (p_org, p_lead, now(), auth.uid())
  on conflict (organization_id, lead_id) do update set kept_at = excluded.kept_at, kept_by = excluded.kept_by;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'retention_keep', 'leads', p_lead, '{}'::jsonb);
end;
$$;
revoke all on function public.lead_retention_keep(uuid, uuid) from public, anon;
grant execute on function public.lead_retention_keep(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The job
-- ----------------------------------------------------------------------------
-- one notice to every active owner and admin
create or replace function app.lead_retention_notify(p_org uuid, p_round uuid, p_title text, p_body text, p_entity text)
returns void
language sql security definer
set search_path = ''
as $$
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select m.organization_id, m.user_id, 'system', p_title, p_body, p_entity, p_round
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
$$;
revoke all on function app.lead_retention_notify(uuid, uuid, text, text, text) from public, anon, authenticated;

-- Erases the audit details of one purged lead the policy binned at p_binned_at. Answers:
--   'erased'     done now;
--   'already'    erased before (a privacy request, PRV-03): nothing to do;
--   'not_policy' the row that was deleted is not the one the policy binned (restored and deleted otherwise, merged
--                away, or no 'delete' entry to prove it): never erased by the policy;
--   'wait'       the hash key is missing and the lead has a consent entry not hashed yet (the rule of
--                public.audit_erase_request).
create or replace function app.lead_retention_erase(p_org uuid, p_lead uuid, p_binned_at timestamptz) returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_found boolean;
begin
  if exists (select 1 from app.pending_erasures e
              where e.organization_id = p_org and e.record_type = 'leads' and e.record_id = p_lead) then
    return 'already';
  end if;
  -- the deleted row as the audit log kept it: it must still carry the policy's deleted_at
  select true, (a.changes ->> 'deleted_at')::timestamptz into v_found, v_deleted_at
    from public.audit_log a
   where a.organization_id = p_org and a.entity_type = 'leads' and a.entity_id = p_lead and a.action = 'delete'
   order by a.id desc limit 1;
  if v_found is null or v_deleted_at is distinct from p_binned_at then
    return 'not_policy';
  end if;
  if not app.consent_key_present()
     and exists (select 1 from public.consents c
                  where c.organization_id = p_org and c.subject_type = 'lead' and c.subject_id = p_lead
                    and c.address_hash is null and c.hash_version = 1) then
    return 'wait';
  end if;
  -- not the person's request: no do-not-contact entry (owner, 13 October 2026)
  perform app.audit_erase_core(p_org, 'leads', p_lead, null);
  -- owner, 26 October 2026: the policy's erasure is recorded as action 'retention', not 'erase' (a privacy request).
  -- app.audit_erase_core is shared ground and keeps its signature and body: its own last row is renamed here, in the
  -- same transaction, matched exactly (this lead, the core's action and count, no actor, this transaction's time).
  update public.audit_log a set action = 'retention'
   where a.id = (select max(b.id) from public.audit_log b
                  where b.organization_id = p_org and b.entity_type = 'leads' and b.entity_id = p_lead
                    and b.action = 'erase' and b.actor_id is null and b.created_at = now() and b.changes ? 'entries');
  insert into app.pending_erasures (organization_id, record_type, record_id, requested_by, person_request, completed_at)
  values (p_org, 'leads', p_lead, null, false, now())
  on conflict (organization_id, record_type, record_id) do nothing;
  return 'erased';
end;
$$;
revoke all on function app.lead_retention_erase(uuid, uuid, timestamptz) from public, anon, authenticated;

create or replace function app.run_lead_retention() returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_org record;
  v_round record;
  v_round_id uuid;
  v_count integer;
  v_result text;
  v_attempts integer;
  v_months integer;
  v_erased integer := 0;
  v_restored integer := 0;
  v_binned integer := 0;
  v_rounds integer := 0;
  v_cancelled integer := 0;
  v_org_binned integer;
  v_cutoff timestamptz;
  v_tz text;
  v_now timestamptz := now();
begin
  -- 1. per business, the leads the policy binned: restored or binned again by a person -> kept; purged -> erased
  for v_org in
    select distinct rl.organization_id from app.lead_retention_round_leads rl
     where rl.binned_at is not null and rl.restored_at is null and rl.erased_at is null and rl.erase_attempts < 24
  loop
    begin
      with left_policy as (
        update app.lead_retention_round_leads rl set restored_at = v_now
          from public.leads l
         where rl.organization_id = v_org.organization_id
           and rl.binned_at is not null and rl.restored_at is null and rl.erased_at is null
           and l.organization_id = rl.organization_id and l.id = rl.lead_id
           and l.deleted_at is distinct from rl.binned_at
        returning rl.organization_id, rl.lead_id)
      insert into app.lead_retention_keeps (organization_id, lead_id, kept_at)
      select distinct organization_id, lead_id, v_now from left_policy
      on conflict (organization_id, lead_id) do update set kept_at = excluded.kept_at, kept_by = null;
      get diagnostics v_count = row_count;
      v_restored := v_restored + v_count;

      v_count := 0;
      if v_erased < 300 then
        for v_row in
          select rl.round_id, rl.lead_id, rl.binned_at, rl.erase_waits from app.lead_retention_round_leads rl
           where rl.organization_id = v_org.organization_id
             and rl.binned_at is not null and rl.restored_at is null and rl.erased_at is null and rl.erase_attempts < 24
             and not exists (select 1 from public.leads l where l.organization_id = rl.organization_id and l.id = rl.lead_id)
           -- rows waiting for the hash key go last, so they never hold back the ones that can be erased
           order by rl.erase_waits, rl.binned_at
           limit least(50, 300 - v_erased)
        loop
          begin
            v_result := app.lead_retention_erase(v_org.organization_id, v_row.lead_id, v_row.binned_at);
            if v_result in ('erased', 'already') then
              update app.lead_retention_round_leads set erased_at = v_now
               where round_id = v_row.round_id and lead_id = v_row.lead_id;
              if v_result = 'erased' then
                v_count := v_count + 1;
              end if;
            elsif v_result = 'not_policy' then
              update app.lead_retention_round_leads set restored_at = v_now
               where round_id = v_row.round_id and lead_id = v_row.lead_id;
            else
              update app.lead_retention_round_leads set erase_waits = erase_waits + 1
               where round_id = v_row.round_id and lead_id = v_row.lead_id;
              -- a week of hourly runs: the platform staff are told once (the key is a setting of ours)
              if v_row.erase_waits + 1 = 168 then
                perform app.log_platform('lead_retention_erase_waiting_for_key', v_org.organization_id,
                                         jsonb_build_object('waits', v_row.erase_waits + 1));
              end if;
            end if;
          exception when others then
            update app.lead_retention_round_leads set erase_attempts = erase_attempts + 1
             where round_id = v_row.round_id and lead_id = v_row.lead_id
            returning erase_attempts into v_attempts;
            perform app.log_platform('lead_retention_erase_failed', v_org.organization_id, jsonb_build_object('sqlstate', sqlstate));
            if v_attempts >= 24 then
              -- no more tries: said plainly, once (follow-up: a restart path for platform staff)
              perform app.log_platform('lead_retention_erase_stopped', v_org.organization_id,
                                       jsonb_build_object('attempts', v_attempts, 'sqlstate', sqlstate));
            end if;
          end;
        end loop;
      end if;
      if v_count > 0 then
        begin
          -- one line, no identifying details (owner, 13 October 2026, point 5)
          insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
          values (v_org.organization_id, null, 'retention_purge', 'lead_retention', null, jsonb_build_object('count', v_count));
        exception when others then
          perform app.log_platform('lead_retention_purge_line_failed', v_org.organization_id,
                                   jsonb_build_object('sqlstate', sqlstate, 'count', v_count));
        end;
        v_erased := v_erased + v_count;
      end if;
    exception when others then
      perform app.log_platform('lead_retention_business_failed', v_org.organization_id, jsonb_build_object('sqlstate', sqlstate));
    end;
  end loop;

  -- 2. new rounds: businesses with the policy on and no open round, checked longest ago first
  for v_org in
    select s.organization_id, s.months from app.lead_retention_settings s
     where s.enabled and app.org_writable(s.organization_id)
       and not exists (select 1 from app.lead_retention_rounds r where r.organization_id = s.organization_id and r.status = 'open')
     order by s.checked_at nulls first, s.organization_id
     limit 50
  loop
    begin
      -- read again under a lock against public.lead_retention_set: a policy turned off or changed meanwhile gets no round
      -- and no stale notice
      select s.months into v_months from app.lead_retention_settings s
       where s.organization_id = v_org.organization_id and s.enabled
       for update;
      if not found or v_months <> v_org.months then
        continue;
      end if;
      update app.lead_retention_settings set checked_at = v_now where organization_id = v_org.organization_id;
      v_cutoff := v_now - make_interval(months => v_org.months) + interval '14 days';
      -- the rule is judged once: the round is made only when it has leads
      with c as (select x as lead_id from app.lead_retention_candidates(v_org.organization_id, v_cutoff) x),
           r as (insert into app.lead_retention_rounds (organization_id, months, noticed_at, due_at)
                 select v_org.organization_id, v_org.months, v_now, v_now + interval '14 days'
                  where exists (select 1 from c)
                 returning id)
      insert into app.lead_retention_round_leads (round_id, organization_id, lead_id)
      select r.id, v_org.organization_id, c.lead_id from r cross join c;
      get diagnostics v_count = row_count;
      if v_count > 0 then
        select r.id into v_round_id from app.lead_retention_rounds r
         where r.organization_id = v_org.organization_id and r.status = 'open';
        select coalesce(nullif(o.timezone, ''), 'Asia/Jerusalem') into v_tz
          from public.organizations o where o.id = v_org.organization_id;
        perform app.lead_retention_notify(v_org.organization_id, v_round_id,
          case when v_count = 1 then 'מדיניות השמירה: ליד אחד יעבור לסל המחזור בעוד 14 יום'
               else 'מדיניות השמירה: ' || v_count || ' לידים יעברו לסל המחזור בעוד 14 יום' end,
          'ב-' || to_char((v_now + interval '14 days') at time zone v_tz, 'DD.MM.YYYY')
            || '. ברשימה אפשר לסמן "להשאיר".', 'lead_retention');
        v_rounds := v_rounds + 1;
      end if;
    exception when others then
      perform app.log_platform('lead_retention_round_failed', v_org.organization_id, jsonb_build_object('sqlstate', sqlstate));
    end;
  end loop;

  -- 3. last, because it locks leads: rounds that came due. A business that cannot be written now loses the round (a
  --    new notice comes later); else each still-inactive lead, locked and judged again, goes to the bin; the rest leave the round
  for v_round in
    select r.* from app.lead_retention_rounds r
     where r.status = 'open' and r.due_at <= v_now
     order by r.due_at
  loop
    exit when v_binned >= 5000;
    begin
      if not app.org_writable(v_round.organization_id)
         or not exists (select 1 from app.lead_retention_settings s
                         where s.organization_id = v_round.organization_id and s.enabled and s.months = v_round.months) then
        update app.lead_retention_rounds set status = 'cancelled', finished_at = v_now where id = v_round.id;
        v_cancelled := v_cancelled + 1;
        continue;
      end if;
      v_cutoff := v_now - make_interval(months => v_round.months);
      update app.lead_retention_round_leads rl set skipped_at = v_now
       where rl.round_id = v_round.id and rl.binned_at is null and rl.skipped_at is null and rl.kept_at is null
         and rl.lead_id not in (select c from app.lead_retention_candidates(v_round.organization_id, v_cutoff) c);
      v_org_binned := 0;
      for v_row in
        select rl.lead_id from app.lead_retention_round_leads rl
         where rl.round_id = v_round.id and rl.binned_at is null and rl.skipped_at is null and rl.kept_at is null
         limit least(1000, 5000 - v_binned)
      loop
        begin
          perform 1 from public.leads l
            where l.organization_id = v_round.organization_id and l.id = v_row.lead_id and l.deleted_at is null
            for update;
          if found and exists (select 1 from app.lead_retention_candidates(v_round.organization_id, v_cutoff, v_row.lead_id)) then
            update public.leads l set deleted_at = v_now
             where l.organization_id = v_round.organization_id and l.id = v_row.lead_id;
            update app.lead_retention_round_leads set binned_at = v_now
             where round_id = v_round.id and lead_id = v_row.lead_id;
            v_org_binned := v_org_binned + 1;
          else
            update app.lead_retention_round_leads set skipped_at = v_now
             where round_id = v_round.id and lead_id = v_row.lead_id;
          end if;
        exception when others then
          update app.lead_retention_round_leads set skipped_at = v_now
           where round_id = v_round.id and lead_id = v_row.lead_id;
          perform app.log_platform('lead_retention_bin_failed', v_round.organization_id, jsonb_build_object('sqlstate', sqlstate));
        end;
      end loop;
      v_binned := v_binned + v_org_binned;
      update app.lead_retention_rounds set binned = binned + v_org_binned where id = v_round.id;

      if not exists (select 1 from app.lead_retention_round_leads rl
                      where rl.round_id = v_round.id and rl.binned_at is null and rl.skipped_at is null and rl.kept_at is null) then
        update app.lead_retention_rounds set status = 'done', finished_at = v_now where id = v_round.id
        returning binned into v_count;
        if v_count > 0 then
          perform app.lead_retention_notify(v_round.organization_id, v_round.id,
            case when v_count = 1 then 'מדיניות השמירה העבירה ליד אחד לסל המחזור'
                 else 'מדיניות השמירה העבירה ' || v_count || ' לידים לסל המחזור' end,
            'אפשר לשחזר מסל המחזור במשך 30 יום. אחר כך המחיקה סופית.', 'lead_retention_binned');
        end if;
      end if;
    exception when others then
      perform app.log_platform('lead_retention_round_due_failed', v_round.organization_id, jsonb_build_object('sqlstate', sqlstate));
    end;
  end loop;

  return jsonb_build_object('restored', v_restored, 'erased', v_erased, 'binned', v_binned, 'rounds', v_rounds,
                            'cancelled', v_cancelled);
end;
$$;
revoke all on function app.run_lead_retention() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-lead-retention', '20 * * * *', 'select app.run_lead_retention();');
  end if;
end;
$$;
