-- =============================================================================
-- 021272 ADM-03: a business asks to be deleted, waits 30 days, and may cancel (owner, 13 November 2026, answers (361) ב,
-- (362) ב, (363) ב; privacy, every plan, never locked by plan)
-- =============================================================================
-- * app.org_deletions (schema app, RLS on, no grants): one row per request. requested_by / requested_at; the open request
--   lasts as long as Supabase Auth's email code (app.org_deletion_code_seconds(), 3,600 s, the Supabase default);
--   code_tries; confirmed_at and scheduled_for (= confirmed_at + 30 days); replaced_at (a newer request of the same business
--   took its place before it was confirmed); cancelled_at / cancelled_by; done_at. No foreign key to the business: the row
--   stays as history (ids and times only) after the business is gone.
-- * public.org_deletion_request(org, typed_name) (definer, authenticated): the business's owner (app.membership_role), in a
--   session that passed the second step (aal2), the typed name equal to organizations.name after btrim, nothing pending,
--   3 requests per business a day. Answers {ok, expires_at}; no secret. An open, unconfirmed request is replaced. Audit
--   org_deletion {step: requested}. The server action then asks Supabase Auth to email the owner a reauthentication code
--   (auth.reauthenticate(), the user's own session; owner's answer (373) ג).
-- * public.org_deletion_confirm(org, code) (definer, authenticated): the requester, still the owner, aal2, the open
--   request. The database verifies the code itself, against what only Supabase Auth writes: auth.users.reauthentication_token
--   is GoTrue's hash of the address and the code, hex(SHA-224(email || code)) (crypto.GenerateTokenHash, GoTrue v2.197.0;
--   "pkce_" prefix also accepted), stored by GET /reauthenticate together with reauthentication_sent_at. The code is accepted
--   only when that send is after the request (2 minutes' clock tolerance between Auth and the database) and within the code's
--   validity. GoTrue's only consumer of the code is a password change, so the database does not wait for it to be consumed;
--   instead a request is confirmed once, and a code sent before a request never confirms it. 5 wrong codes end the request,
--   and 5 wrong codes per person and sent code (app.org_deletion_code_tries, across every business of the person) end
--   that code: a new one must be sent (the counter row is made first, then locked, so parallel confirms through several
--   businesses share one count). Refused while the account's address is changing (auth.users.email_change set, or
--   email_change_sent_at within the code's lifetime): GoTrue sends the code to the CURRENT address, and a deletion is not
--   confirmed while that address is about to change. Answers {ok:true, scheduled_for} or {ok:false, reason:
--   invalid|expired|mfa|pending|no_code|email_change|code|tries}. From then the
--   business is read-only (app.org_writable false), takes no leads (app.org_takes_leads false) and its public pages are
--   closed (app.org_public_pages_open false) until the request is cancelled or carried out. organizations.status is not
--   touched. Audit {step: confirmed}; a `system` notice to the active owners and admins.
-- * public.org_deletion_cancel(org) (definer): the owner; the pending request (or an open unconfirmed one) is cancelled,
--   the business is writable again at once. Audit {step: cancelled}; a notice to the active owners and admins.
-- * public.org_deletion_status(org) (definer, members and support sessions through app.role_in): {pending, scheduled_for,
--   confirmed_at} and, for the owner only, the open unconfirmed request's end ({awaiting_until}).
-- * app.run_org_deletions(limit) (pg_cron 'crm-org-deletions', daily 02:13 UTC, before the 03:00 file cleanup): each due
--   request (confirmed, not cancelled, scheduled_for passed) is carried out by app.org_deletion_purge(org), in its own
--   exception block. The purge removes rows, so it lives in _org_deletion_purge.sql, which the owner pastes by hand; until
--   then the wrapper does nothing and the business simply stays read-only. User accounts (auth.users, profiles) stay
--   (answer (363) ב). One app.platform_log entry org_deletion.done per business.
-- Safe to run twice. Nothing is removed by this file.

create table if not exists app.org_deletions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  requested_by    uuid not null,
  requested_at    timestamptz not null default now(),
  code_tries      integer not null default 0,
  confirmed_at    timestamptz,
  scheduled_for   timestamptz,
  replaced_at     timestamptz,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  done_at         timestamptz,
  constraint org_deletions_code_tries check (code_tries between 0 and 5),
  constraint org_deletions_scheduled_shape check ((confirmed_at is null) = (scheduled_for is null))
);
alter table app.org_deletions enable row level security;
revoke all on app.org_deletions from public, anon, authenticated, service_role;

create index if not exists org_deletions_org_idx on app.org_deletions (organization_id, requested_at desc);
-- at most one pending (confirmed, not cancelled, not carried out) request per business
create unique index if not exists org_deletions_one_pending on app.org_deletions (organization_id)
  where confirmed_at is not null and cancelled_at is null and done_at is null;
create index if not exists org_deletions_due_idx on app.org_deletions (scheduled_for)
  where confirmed_at is not null and cancelled_at is null and done_at is null;

-- wrong codes per person and sent code (Supabase Auth's one reauthentication code), across every business of the person
create table if not exists app.org_deletion_code_tries (
  user_id    uuid not null,
  sent_at    timestamptz not null,
  tries      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, sent_at)
);
alter table app.org_deletion_code_tries enable row level security;
revoke all on app.org_deletion_code_tries from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rule: a confirmed request that was neither cancelled nor carried out
-- ----------------------------------------------------------------------------
create or replace function app.org_deletion_pending(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.org_deletions d
     where d.organization_id = p_org
       and d.confirmed_at is not null and d.cancelled_at is null and d.done_at is null)
$$;
revoke all on function app.org_deletion_pending(uuid) from public, anon, authenticated, service_role;

-- app.org_writable: the body of _foundation.sql (0001), plus the pending deletion
create or replace function app.org_writable(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org
      and o.deleted_at is null
      and o.status in ('trial', 'active', 'past_due')
  )
  and not app.org_deletion_pending(p_org)
$$;

-- app.org_takes_leads: the body of _suspended_no_access.sql (0171), plus the pending deletion
create or replace function app.org_takes_leads(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org
       and o.deleted_at is null
       and o.status in ('trial', 'active', 'past_due', 'read_only', 'suspended')
  )
  and not app.org_deletion_pending(p_org)
$$;
revoke all on function app.org_takes_leads(uuid) from public, anon, authenticated;

-- app.org_public_pages_open: the body of _suspended_lead_notices.sql (0173), plus the pending deletion
create or replace function app.org_public_pages_open(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizations o
     where o.id = p_org and o.deleted_at is null and o.status <> 'cancelled'
  )
  and not app.org_deletion_pending(p_org)
$$;
revoke all on function app.org_public_pages_open(uuid) from public, anon, authenticated;
grant execute on function app.org_public_pages_open(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- A notice to the business's active owners and admins (system, nothing personal; the id is the business)
-- ----------------------------------------------------------------------------
create or replace function app.org_deletion_notify(p_org uuid, p_title text, p_body text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select p_org, m.user_id, 'system', p_title, p_body, 'org_deletion', p_org
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
end;
$$;
revoke all on function app.org_deletion_notify(uuid, text, text) from public, anon, authenticated, service_role;

-- the day in the business's zone, dd/mm/yyyy
create or replace function app.org_deletion_day(p_org uuid, p_at timestamptz) returns text
language sql stable security definer
set search_path = ''
as $$
  select to_char((p_at at time zone coalesce(
    (select o.timezone from public.organizations o where o.id = p_org), 'Asia/Jerusalem'))::date, 'DD/MM/YYYY')
$$;
revoke all on function app.org_deletion_day(uuid, timestamptz) from public, anon, authenticated, service_role;

-- how long Supabase Auth's email code lasts (Mailer OTP expiry; 3,600 s is the Supabase default)
create or replace function app.org_deletion_code_seconds() returns integer
language sql immutable
set search_path = ''
as $$ select 3600 $$;
revoke all on function app.org_deletion_code_seconds() from public, anon, authenticated, service_role;

-- the business's open request: not confirmed, replaced or cancelled, and younger than the code
create or replace function app.org_deletion_open(p_org uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select d.id from app.org_deletions d
   where d.organization_id = p_org and d.confirmed_at is null and d.cancelled_at is null and d.replaced_at is null
     and d.requested_at > now() - make_interval(secs => app.org_deletion_code_seconds())
   order by d.requested_at desc limit 1
$$;
revoke all on function app.org_deletion_open(uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The request (the owner, aal2, the typed name)
-- ----------------------------------------------------------------------------
create or replace function public.org_deletion_request(p_org uuid, p_typed_name text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text;
  v_at timestamptz := now();
begin
  if app.membership_role(p_org) is distinct from 'owner' or app.support_session(p_org) then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  if app.session_aal() is distinct from 'aal2' then
    raise exception 'deleting the business needs the second step' using errcode = 'P0001', hint = 'org_deletion:mfa';
  end if;
  -- the business row, locked: two requests of one business never cross
  select o.name into v_name from public.organizations o where o.id = p_org and o.deleted_at is null for update;
  if not found then
    raise exception 'not found' using errcode = '42501';
  end if;
  if btrim(coalesce(p_typed_name, '')) = '' or btrim(p_typed_name) <> btrim(v_name) then
    raise exception 'the typed name is not the business name' using errcode = 'P0001', hint = 'org_deletion:name';
  end if;
  if app.org_deletion_pending(p_org) then
    raise exception 'a deletion is already pending' using errcode = 'P0001', hint = 'org_deletion:pending';
  end if;
  if (select count(*) from app.org_deletions d
       where d.organization_id = p_org and d.requested_at > now() - interval '1 day') >= 3 then
    raise exception 'too many requests today' using errcode = 'P0001', hint = 'org_deletion:rate';
  end if;
  -- an open, unconfirmed request is replaced
  update app.org_deletions d set replaced_at = now()
   where d.organization_id = p_org and d.confirmed_at is null and d.cancelled_at is null and d.replaced_at is null;
  insert into app.org_deletions (organization_id, requested_by, requested_at) values (p_org, auth.uid(), v_at);
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'org_deletion', 'organizations', p_org, jsonb_build_object('step', 'requested'));
  return jsonb_build_object('ok', true,
    'expires_at', v_at + make_interval(secs => app.org_deletion_code_seconds()));
end;
$$;
revoke all on function public.org_deletion_request(uuid, text) from public, anon;
grant execute on function public.org_deletion_request(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The code from Supabase Auth's reauthentication email (the requester, still the owner, aal2)
-- ----------------------------------------------------------------------------
create or replace function public.org_deletion_confirm(p_org uuid, p_code text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row app.org_deletions%rowtype;
  v_id uuid;
  v_email text;
  v_token text;
  v_sent timestamptz;
  v_hash text;
  v_change text;
  v_change_sent timestamptz;
  v_user_tries integer;
begin
  if auth.uid() is null or app.membership_role(p_org) is distinct from 'owner' or app.support_session(p_org) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if app.session_aal() is distinct from 'aal2' then
    return jsonb_build_object('ok', false, 'reason', 'mfa');
  end if;
  perform 1 from public.organizations o where o.id = p_org and o.deleted_at is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if app.org_deletion_pending(p_org) then
    return jsonb_build_object('ok', false, 'reason', 'pending');
  end if;
  v_id := app.org_deletion_open(p_org);
  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select * into v_row from app.org_deletions d where d.id = v_id for update;
  -- only the person who asked confirms
  if v_row.requested_by is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if v_row.code_tries >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'tries');
  end if;
  select u.email, u.reauthentication_token, u.reauthentication_sent_at, u.email_change, u.email_change_sent_at
    into v_email, v_token, v_sent, v_change, v_change_sent
    from auth.users u where u.id = auth.uid();
  -- Supabase Auth sent no code after this request (or it ran out)
  if v_email is null or coalesce(v_token, '') = '' or v_sent is null
     or v_sent < v_row.requested_at - interval '2 minutes'
     or v_sent <= now() - make_interval(secs => app.org_deletion_code_seconds()) then
    return jsonb_build_object('ok', false, 'reason', 'no_code');
  end if;
  -- the account's address is changing (GoTrue sends the code to the current address): no confirmation until it settles
  if coalesce(v_change, '') <> ''
     or v_change_sent > now() - make_interval(secs => app.org_deletion_code_seconds()) then
    return jsonb_build_object('ok', false, 'reason', 'email_change');
  end if;
  -- one sent code, five guesses, whichever businesses they come through: the row exists before it is locked, so
  -- confirms running in parallel through several businesses wait for each other and share one count
  insert into app.org_deletion_code_tries (user_id, sent_at, tries) values (auth.uid(), v_sent, 0)
  on conflict (user_id, sent_at) do nothing;
  select t.tries into v_user_tries from app.org_deletion_code_tries t
   where t.user_id = auth.uid() and t.sent_at = v_sent for update;
  if coalesce(v_user_tries, 0) >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'tries');
  end if;
  v_hash := case when coalesce(p_code, '') ~ '^[0-9]{6,10}$'
                 then encode(sha224(convert_to(v_email || p_code, 'UTF8')), 'hex') end;
  if v_hash is null or (v_token <> v_hash and v_token <> 'pkce_' || v_hash) then
    update app.org_deletions d set code_tries = d.code_tries + 1 where d.id = v_row.id;
    insert into app.org_deletion_code_tries as t (user_id, sent_at, tries) values (auth.uid(), v_sent, 1)
    on conflict (user_id, sent_at) do update set tries = t.tries + 1, updated_at = now();
    return jsonb_build_object('ok', false, 'reason',
      case when v_row.code_tries + 1 >= 5 or coalesce(v_user_tries, 0) + 1 >= 5 then 'tries' else 'code' end);
  end if;
  update app.org_deletions d
     set confirmed_at = now(), scheduled_for = now() + interval '30 days'
   where d.id = v_row.id
  returning * into v_row;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'org_deletion', 'organizations', p_org,
          jsonb_build_object('step', 'confirmed', 'scheduled_for', v_row.scheduled_for));
  perform app.org_deletion_notify(p_org, 'העסק יימחק',
    'בעל העסק אישר את מחיקת העסק. ב-' || app.org_deletion_day(p_org, v_row.scheduled_for)
    || ' יימחקו כל נתוני העסק וקבציו. עד אז אפשר רק לקרוא ולייצא, ובעל העסק יכול לבטל את המחיקה.');
  return jsonb_build_object('ok', true, 'scheduled_for', v_row.scheduled_for);
end;
$$;
revoke all on function public.org_deletion_confirm(uuid, text) from public, anon;
grant execute on function public.org_deletion_confirm(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Cancel (the owner): the business is writable again at once
-- ----------------------------------------------------------------------------
create or replace function public.org_deletion_cancel(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_pending boolean;
  v_n integer;
begin
  if app.membership_role(p_org) is distinct from 'owner' or app.support_session(p_org) then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  v_pending := app.org_deletion_pending(p_org);
  update app.org_deletions d set cancelled_at = now(), cancelled_by = auth.uid()
   where d.organization_id = p_org and d.cancelled_at is null and d.done_at is null and d.replaced_at is null
     and (d.confirmed_at is not null or d.id = app.org_deletion_open(p_org));
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'org_deletion', 'organizations', p_org,
          jsonb_build_object('step', 'cancelled', 'was_pending', v_pending));
  if v_pending then
    perform app.org_deletion_notify(p_org, 'מחיקת העסק בוטלה',
      'בעל העסק ביטל את מחיקת העסק. העסק חזר לפעול כרגיל.');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.org_deletion_cancel(uuid) from public, anon;
grant execute on function public.org_deletion_cancel(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The banner and the settings page
-- ----------------------------------------------------------------------------
create or replace function public.org_deletion_status(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role text := app.role_in(p_org);
  v_pending app.org_deletions%rowtype;
  v_awaiting timestamptz;
begin
  if v_role is null then
    return null;
  end if;
  select * into v_pending from app.org_deletions d
   where d.organization_id = p_org and d.confirmed_at is not null and d.cancelled_at is null and d.done_at is null;
  if app.membership_role(p_org) = 'owner' and not app.support_session(p_org) then
    select d.requested_at + make_interval(secs => app.org_deletion_code_seconds()) into v_awaiting
      from app.org_deletions d where d.id = app.org_deletion_open(p_org);
  end if;
  return jsonb_build_object(
    'pending', v_pending.id is not null,
    'scheduled_for', v_pending.scheduled_for,
    'confirmed_at', v_pending.confirmed_at,
    'awaiting_until', v_awaiting);
end;
$$;
revoke all on function public.org_deletion_status(uuid) from public, anon;
grant execute on function public.org_deletion_status(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The daily run. The purge itself is in _org_deletion_purge.sql (pasted by hand: it removes rows)
-- ----------------------------------------------------------------------------
create or replace function app.run_org_deletions(p_limit integer default 20) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row record;
  v_done boolean;
  v_n integer := 0;
begin
  -- the guess counters of old codes (the pasted _org_deletion_purge.sql; nothing until it exists)
  if to_regprocedure('app.purge_old_org_deletion_code_tries()') is not null then
    begin
      execute 'select app.purge_old_org_deletion_code_tries()';
    exception when others then
      raise warning 'run_org_deletions: old code counters were not removed (%)', sqlstate;
    end;
  end if;
  if to_regprocedure('app.org_deletion_purge(uuid)') is null then
    return 0;
  end if;
  for v_row in
    select d.id, d.organization_id from app.org_deletions d
     where d.confirmed_at is not null and d.cancelled_at is null and d.done_at is null and d.scheduled_for <= now()
     order by d.scheduled_for
     limit greatest(coalesce(p_limit, 0), 0)
     for update skip locked
  loop
    begin
      execute 'select app.org_deletion_purge($1)' into v_done using v_row.organization_id;
      if coalesce(v_done, false) then
        update app.org_deletions d set done_at = now() where d.id = v_row.id;
        insert into app.platform_log (actor_id, action, organization_id, details)
        values (null, 'org_deletion.done', v_row.organization_id, jsonb_build_object('request_id', v_row.id));
        v_n := v_n + 1;
      end if;
    exception when others then
      raise warning 'run_org_deletions: business % was not deleted (%)', v_row.organization_id, sqlstate;
    end;
  end loop;
  return v_n;
end;
$$;
revoke all on function app.run_org_deletions(integer) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-org-deletions', '13 2 * * *', 'select app.run_org_deletions(20);');
  end if;
end;
$$;

notify pgrst, 'reload schema';
