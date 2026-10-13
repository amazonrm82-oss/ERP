-- =============================================================================
-- Consents: merge, privacy erasure, conversion and sample data (CNS-01, CNS-02, LEAD-07)
-- =============================================================================
-- Follow-ups of the consent register (migration consents):
-- * app.merge_move_links(): a merged-away lead's or contact's consent history moves
--   to the kept record (the guard allows the move; subject_id follows; created_at
--   and seq stay, so the current state is still the latest by time).
-- * public.audit_erase_record(): an erased lead or contact keeps only the hash, the
--   state, the channel, the source and the time of its consents (method, wording
--   and recorded_by are emptied, CNS-02), and the stored address of an entry still
--   waiting for its hash is blanked. Rows are found by subject_type/subject_id.
-- * LEAD-07: when a lead is converted (converted_at set for the first time, by
--   convert_lead() or by a merge), the latest entry of each channel of the lead is
--   copied to the new contact as a new row: same state, source, wording, method,
--   recorder, time and address hash, with copied_from = the lead's entry. A copy
--   that exists already is not made again. convert_lead() is unchanged.
-- * app.sample_untouched(): a consent recorded on a sample lead or contact makes
--   it real work (the record is kept).
-- * Owner's decision (13 October 2026): an erasure of a lead or contact that still has
--   consent entries waiting for their hash while the key is missing is paused, not
--   refused: it is recorded in app.pending_erasures, the person is marked withdrawn
--   on every channel whose address is known (source 'erasure'), platform staff see it
--   (app.platform_log 'consent_erasure_pending', app.pending_erasure_count()), and the
--   function returns -1. The hourly backfill completes it once the key is there and
--   tells the business's owners and admins ('system' notification, no personal data).
-- Each function is redefined from its latest body. Every statement is safe to run twice.

create or replace function app.merge_move_links(p_org uuid, p_type text, p_keep uuid, p_merge uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_owner uuid;
  v_team uuid;
begin
  execute format('update public.activities set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.tasks set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.files set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  execute format('update public.meetings set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  update public.notifications set entity_id = p_keep where organization_id = p_org and entity_id = p_merge;
  -- CNS-01: the duplicate's consent history goes to the kept record (time and seq kept;
  -- the guard lets the link move and subject_id follows)
  if p_type in ('lead', 'contact') then
    execute format('update public.consents set %1$I = $1 where organization_id = $2 and %1$I = $3', v_col) using p_keep, p_org, p_merge;
  end if;
  -- followers who may read the kept record, one row per user; a row that would
  -- clash, or whose user may not read the kept record, stays and goes with the duplicate
  execute format('select owner_id, team_id from public.%I where organization_id = $1 and id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' else 'companies' end)
    into v_owner, v_team using p_org, p_keep;
  execute format(
    'update public.record_followers f set %1$I = $1
      where f.organization_id = $2 and f.%1$I = $3
        and app.user_can_read_record($2, f.user_id, $4, $5)
        and not exists (select 1 from public.record_followers k
                         where k.organization_id = $2 and k.user_id = f.user_id and k.%1$I = $1)', v_col)
    using p_keep, p_org, p_merge, v_owner, v_team;

  if p_type = 'lead' then
    update public.form_submissions set lead_id = p_keep where organization_id = p_org and lead_id = p_merge;
  elsif p_type = 'contact' then
    update public.deals set contact_id = p_keep where organization_id = p_org and contact_id = p_merge;
    -- one row per deal: a row that would clash stays and goes with the duplicate
    update public.deal_contacts dc set contact_id = p_keep
     where dc.organization_id = p_org and dc.contact_id = p_merge
       and not exists (select 1 from public.deal_contacts k where k.deal_id = dc.deal_id and k.contact_id = p_keep);
    update public.leads set converted_contact_id = p_keep where organization_id = p_org and converted_contact_id = p_merge;
    perform app.merge_contact_channels_move(p_org, p_keep, p_merge);
  elsif p_type = 'company' then
    update public.contacts set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.deals set company_id = p_keep where organization_id = p_org and company_id = p_merge;
    update public.leads set converted_company_id = p_keep where organization_id = p_org and converted_company_id = p_merge;
    update public.companies set parent_company_id = case when id = p_keep then null else p_keep end
     where organization_id = p_org and parent_company_id = p_merge;
  end if;
end;
$$;
revoke all on function app.merge_move_links(uuid, text, uuid, uuid) from public, anon, authenticated;

-- The erasure itself (the body of audit_erase_record before CNS), without the permission
-- check, so the backfill can complete a paused request; p_actor is who asked.
create or replace function app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := case p_type when 'leads' then 'lead_id' when 'contacts' then 'contact_id'
                            when 'companies' then 'company_id' when 'deals' then 'deal_id' end;
  v_exists boolean;
  v_row jsonb;
  v_child record;
  v_children text[] := '{}';
  v_count integer;
  v_more integer;
begin
  if v_col is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;

  -- the deleted row, for the form submissions below (before it is erased)
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;

  -- tasks, files and notes that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
    union
    select 'activities', l.activity_id from app.activity_audit_links l
     where l.organization_id = p_org and l.record_id = p_id
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org
     and ((a.entity_type = p_type and a.entity_id = p_id) or (a.entity_type || ':' || a.entity_id) = any (v_children))
     and a.action <> 'erase'
     and a.changes is distinct from '{"erased": true}'::jsonb;
  get diagnostics v_count = row_count;

  -- the copy kept by a merge, on the record it was merged into
  update public.activities ac
     set metadata = ac.metadata - 'merged', body = 'מוזג עם רשומה כפולה (הפרטים נמחקו)'
   where ac.organization_id = p_org and ac.metadata ->> 'merged_id' = p_id::text and ac.metadata ? 'merged';
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  v_count := v_count + app.erase_submissions(p_org, v_row);

  -- CNS-02: its consent history keeps only the hash, the state and the time
  if p_type in ('leads', 'contacts') then
    update public.consents c set method = null, wording = null, recorded_by = null, lift_note = null
     where c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id
       and (c.method is not null or c.wording is not null or c.recorded_by is not null or c.lift_note is not null);
    get diagnostics v_more = row_count;
    v_count := v_count + v_more;
    -- an entry still waiting for its hash (written without the key): with the key there,
    -- it gets its hash first, so the opt-out keeps working; then the stored address is
    -- blanked. Without the key it stays unmatchable and keeps app.consent_suppressed() at
    -- "cannot check" for its channel (fail closed).
    if app.consent_key_present() then
      update public.consents c set address_hash = app.consent_pending_hash(c.id)
       where c.organization_id = p_org
         and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
         and c.subject_id = p_id and c.address_hash is null and c.hash_version = 1
         and app.consent_pending_hash(c.id) is not null;
    end if;
    update app.consent_pending_address p set value = null
      from public.consents c
     where c.id = p.consent_id and c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id and p.value is not null;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure paused while the hash key is missing (owner, 13 October 2026)
-- ----------------------------------------------------------------------------
-- Every erasure request of a lead or contact; open ones (completed_at null) wait for the key.
create table if not exists app.pending_erasures (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  record_type     text not null,
  record_id       uuid not null,
  requested_by    uuid references auth.users (id) on delete set null,
  requested_at    timestamptz not null default now(),
  completed_at    timestamptz,
  -- completion attempts that failed; retried hourly up to 24 times, then left for staff
  attempts        integer not null default 0,
  -- the person's own request (owner, 13 October 2026): only then is "do not contact" recorded
  person_request  boolean not null default true,
  unique (organization_id, record_type, record_id),
  constraint pending_erasures_type check (record_type in ('leads', 'contacts'))
);
alter table app.pending_erasures enable row level security;
revoke all on app.pending_erasures from public, anon, authenticated;

-- "Do not contact" for an erasure at the person's request (owner, 13 October 2026): a
-- withdrawn entry, source 'erasure', on every channel for every address of the person
-- that is known: each distinct address of their entries (a copy of the latest entry of
-- that address) and their phone and email as the record was deleted (its snapshot in the
-- audit log; stored like an entry made without the key and hashed from it). Called
-- before the erasure blanks the snapshot.
create or replace function app.consent_erasure_marks(p_org uuid, p_type text, p_id uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_subject text := case p_type when 'leads' then 'lead' else 'contact' end;
  v_row jsonb;
  v_channel text;
  v_kind text;
  v_source record;
  v_value text;
  v_hash text;
  v_id uuid;
  v_count integer := 0;
begin
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;
  foreach v_channel in array array['email', 'sms', 'whatsapp', 'phone'] loop
    v_kind := app.consent_address_kind(v_channel);
    for v_source in
      select distinct on (coalesce(c.address_hash, 'pending:' || p.value)) c.id
        from public.consents c
        left join app.consent_pending_address p on p.consent_id = c.id
       where c.organization_id = p_org and c.subject_type = v_subject and c.subject_id = p_id
         and c.hash_version = 1 and c.source <> 'erasure' and app.consent_address_kind(c.channel) = v_kind
         and (c.address_hash is not null or p.value is not null)
         -- a request repeated after its completion adds no second mark for the same address
         and not exists (
           select 1 from public.consents e
             left join app.consent_pending_address pe on pe.consent_id = e.id
            where e.organization_id = p_org and e.subject_type = v_subject and e.subject_id = p_id
              and e.channel = v_channel and e.source = 'erasure'
              and ((c.address_hash is not null and e.address_hash = c.address_hash) or (p.value is not null and pe.value = p.value)))
       order by coalesce(c.address_hash, 'pending:' || p.value), c.created_at desc, c.seq desc
    loop
      insert into public.consents (organization_id, channel, state, source, copied_from)
      values (p_org, v_channel, 'withdrawn', 'erasure', v_source.id);
      v_count := v_count + 1;
    end loop;
    -- the record's own address, unless an entry above already covered it
    v_value := case when v_kind = 'email' then nullif(lower(btrim(v_row ->> 'email')), '')
                    else coalesce(nullif(v_row ->> 'phone_e164', ''), app.normalize_phone(v_row ->> 'phone')) end;
    if v_value is not null then
      v_hash := case when app.consent_key_present() then app.consent_address_hash(p_org, v_kind, v_value) end;
      if not exists (
        select 1 from public.consents c
          left join app.consent_pending_address p on p.consent_id = c.id
         where c.organization_id = p_org and c.subject_type = v_subject and c.subject_id = p_id
           and c.channel = v_channel and c.source = 'erasure'
           and ((v_hash is not null and c.address_hash = v_hash) or p.value = v_value)
      ) then
        v_id := gen_random_uuid();
        insert into app.consent_pending_address (consent_id, organization_id, kind, value)
        values (v_id, p_org, v_kind, v_value);
        insert into public.consents (id, organization_id, subject_type, subject_id, channel, state, source)
        values (v_id, p_org, v_subject, p_id, v_channel, 'withdrawn', 'erasure');
        v_count := v_count + 1;
      end if;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.consent_erasure_marks(uuid, text, uuid) from public, anon, authenticated;

-- Owners and admins of a writable organization. p_person_request: the erasure is the
-- person's own request (the default in the app); only then is "do not contact" recorded
-- (an erasure under the retention policy or a business's clean-up adds nothing; an
-- existing opt-out stays). Returns how many entries were erased, or -1 when it is paused:
-- the key is missing and the lead or contact has entries still waiting for their hash,
-- or "do not contact" must be recorded (it can only be hashed with the key). Then the
-- request is kept, the marks are written, platform staff are told, and the backfill
-- completes it. Every request is kept in app.pending_erasures (an immediate one as done).
create or replace function public.audit_erase_request(p_org uuid, p_type text, p_id uuid, p_person_request boolean)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_subject text := case p_type when 'leads' then 'lead' when 'contacts' then 'contact' end;
  v_exists boolean;
  v_person boolean := coalesce(p_person_request, true);
  v_result integer;
  v_was_person boolean;
  v_attempts integer;
  v_done_before boolean;
  v_marks integer;
begin
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if v_subject is null then
    return app.audit_erase_core(p_org, p_type, p_id, auth.uid());
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;
  -- asked again while it waits: the first request, its time and asker stand; it becomes the
  -- person's own request when this one is (with the do-not-contact marks, never repeated), and
  -- a request whose completion stopped after 24 failures is retried again
  select e.person_request, e.attempts into v_was_person, v_attempts
    from app.pending_erasures e
   where e.organization_id = p_org and e.record_type = p_type and e.record_id = p_id
     and e.completed_at is null
   for update;
  if found then
    update app.pending_erasures e
       set person_request = e.person_request or v_person,
           attempts = case when e.attempts >= 24 then 0 else e.attempts end
     where e.organization_id = p_org and e.record_type = p_type and e.record_id = p_id
       and e.completed_at is null;
    if v_attempts >= 24 then
      perform app.log_platform('consent_erasure_restarted', p_org, jsonb_build_object('record_type', p_type));
    end if;
    if v_person and not v_was_person then
      perform app.consent_erasure_marks(p_org, p_type, p_id);
    end if;
    return -1;
  end if;

  -- an earlier erasure of this record was completed: its details (and so its phone and email)
  -- are gone already
  v_done_before := exists (select 1 from app.pending_erasures e
                            where e.organization_id = p_org and e.record_type = p_type and e.record_id = p_id
                              and e.completed_at is not null);

  if not app.consent_key_present()
     and (v_person or exists (select 1 from public.consents c
                               where c.organization_id = p_org and c.subject_type = v_subject and c.subject_id = p_id
                                 and c.address_hash is null and c.hash_version = 1)) then
    insert into app.pending_erasures (organization_id, record_type, record_id, requested_by, person_request)
    values (p_org, p_type, p_id, auth.uid(), v_person)
    on conflict (organization_id, record_type, record_id)
      do update set requested_by = excluded.requested_by, requested_at = now(), completed_at = null,
                    attempts = 0, person_request = excluded.person_request;
    if v_person then
      v_marks := app.consent_erasure_marks(p_org, p_type, p_id);
      -- the person's request after a completed erasure that was not: no phone or email is left
      -- to put on the do-not-contact list, so say so (nothing is changed)
      if v_marks = 0 and v_done_before
         and not exists (select 1 from public.consents c
                          where c.organization_id = p_org and c.subject_type = v_subject and c.subject_id = p_id
                            and c.source = 'erasure') then
        raise exception 'no phone or email is left to mark' using errcode = 'P0001', hint = 'erase:no_address_left';
      end if;
    end if;
    perform app.log_platform('consent_erasure_pending', p_org, jsonb_build_object('record_type', p_type));
    return -1;
  end if;

  if v_person then
    v_marks := app.consent_erasure_marks(p_org, p_type, p_id);
    -- the person's request after a completed erasure that was not: no phone or email is left
    -- to put on the do-not-contact list, so say so (nothing is changed)
    if v_marks = 0 and v_done_before
       and not exists (select 1 from public.consents c
                        where c.organization_id = p_org and c.subject_type = v_subject and c.subject_id = p_id
                          and c.source = 'erasure') then
      raise exception 'no phone or email is left to mark' using errcode = 'P0001', hint = 'erase:no_address_left';
    end if;
  end if;
  v_result := app.audit_erase_core(p_org, p_type, p_id, auth.uid());
  insert into app.pending_erasures (organization_id, record_type, record_id, requested_by, person_request, completed_at)
  values (p_org, p_type, p_id, auth.uid(), v_person, now())
  on conflict (organization_id, record_type, record_id)
    do update set requested_by = excluded.requested_by, requested_at = now(), completed_at = now(),
                  attempts = 0, person_request = excluded.person_request;
  return v_result;
end;
$$;
revoke all on function public.audit_erase_request(uuid, text, uuid, boolean) from public, anon;
grant execute on function public.audit_erase_request(uuid, text, uuid, boolean) to authenticated;

-- The erasure as it was called before (an erasure at the person's request).
create or replace function public.audit_erase_record(p_org uuid, p_type text, p_id uuid)
returns integer
language sql security definer
set search_path = ''
as $$
  select public.audit_erase_request(p_org, p_type, p_id, true);
$$;
revoke all on function public.audit_erase_record(uuid, text, uuid) from public, anon;
grant execute on function public.audit_erase_record(uuid, text, uuid) to authenticated;

-- Completes the paused erasures once the key is there (called by the hourly backfill,
-- after the hashes are filled) and tells the business's owners and admins.
create or replace function app.complete_pending_erasures() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_done integer := 0;
begin
  if not app.consent_key_present() then
    return 0;
  end if;
  for v_row in
    select e.* from app.pending_erasures e where e.completed_at is null and e.attempts < 24 order by e.requested_at
  loop
    begin
      perform app.audit_erase_core(v_row.organization_id, v_row.record_type, v_row.record_id, v_row.requested_by);
      update app.pending_erasures set completed_at = now() where id = v_row.id;
      insert into public.notifications (organization_id, user_id, type, title, body)
      select m.organization_id, m.user_id, 'system', 'המחיקה שביקשתם הושלמה',
             case v_row.record_type when 'leads' then 'ליד' else 'איש קשר' end
        from public.memberships m
       where m.organization_id = v_row.organization_id and m.status = 'active' and m.role in ('owner', 'admin');
      v_done := v_done + 1;
    exception when others then
      update app.pending_erasures set attempts = attempts + 1 where id = v_row.id;
      -- logged on the first failure and when retrying stops, not every hour
      if v_row.attempts + 1 in (1, 24) then
        perform app.log_platform('consent_erasure_failed', v_row.organization_id,
                                 jsonb_build_object('record_type', v_row.record_type, 'sqlstate', sqlstate,
                                                    'attempts', v_row.attempts + 1));
      end if;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.complete_pending_erasures() from public, anon, authenticated;
grant execute on function app.complete_pending_erasures() to service_role;

-- platform health: erasures waiting for the key
create or replace function app.pending_erasure_count() returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer from app.pending_erasures e where e.completed_at is null;
$$;
revoke all on function app.pending_erasure_count() from public, anon, authenticated;
grant execute on function app.pending_erasure_count() to service_role;

-- The platform panel's alert (owner's point 4): platform owner and support, second step required.
create or replace function public.platform_consent_health() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support']);
  return jsonb_build_object(
    'key_present', app.consent_key_present(),
    'pending_erasures', (select count(*) from app.pending_erasures e where e.completed_at is null and e.attempts < 24),
    'erasures_stopped', (select count(*) from app.pending_erasures e where e.completed_at is null and e.attempts >= 24),
    'unhashed_optouts_total', (select count(*) from public.consents c
                                where c.address_hash is null and c.hash_version = 1 and c.state in ('withdrawn', 'denied')),
    'erasure_failures_last_7d', (select count(*) from app.platform_log l
                                  where l.action = 'consent_erasure_failed' and l.created_at > now() - interval '7 days'));
end;
$$;
revoke all on function public.platform_consent_health() from public, anon;
grant execute on function public.platform_consent_health() to authenticated;


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
    return true;
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
  -- a task that is not an unchanged sample task
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and not app.sample_pristine($1, ''task'', t.id))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id));
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id);
  end if;
end;
$$;
revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- LEAD-07: the lead's consents go with it to the new contact
-- ----------------------------------------------------------------------------
create or replace function app.convert_consents() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.converted_at is not null or new.converted_at is null or new.converted_contact_id is null then
    return null;
  end if;
  insert into public.consents (organization_id, contact_id, channel, state, source, wording, method,
                               address_hash, hash_version, copied_from, recorded_by, created_at)
  select l.organization_id, new.converted_contact_id, l.channel, l.state, l.source, l.wording, l.method,
         l.address_hash, l.hash_version, l.id, l.recorded_by, l.created_at
    from (select distinct on (c.channel) c.*
            from public.consents c
           where c.organization_id = new.organization_id and c.lead_id = new.id
           order by c.channel, c.created_at desc, c.seq desc) l
   where exists (select 1 from public.contacts ct
                  where ct.organization_id = new.organization_id and ct.id = new.converted_contact_id)
     and not exists (select 1 from public.consents k
                      where k.organization_id = new.organization_id and k.contact_id = new.converted_contact_id
                        and k.copied_from = l.id)
   order by l.created_at, l.seq;
  return null;
end;
$$;
revoke all on function app.convert_consents() from public, anon, authenticated;

create or replace trigger leads_convert_consents after update of converted_at on public.leads
  for each row
  when (old.converted_at is null and new.converted_at is not null)
  execute function app.convert_consents();
