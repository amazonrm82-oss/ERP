-- =============================================================================
-- PRK-02 follow-up: how long a privacy request keeps the person's details (owner, 3 November 2026, answer (76) א)
-- =============================================================================
-- The personal details of a privacy request (requester_name, contact_value, details, verify_note; a refusal reason becomes a
-- neutral line) are emptied 12 months after the request was closed (closed_at), and a request never closed 12 months after it
-- was received (received_at). Emptying is an update, never a delete: the row stays as the log that the request was handled
-- (type, status, dates, who verified and closed it).
--
-- * public.privacy_requests.erased_by_retention (server only, no client grant): true when this job emptied the request, so
--   the screen can say "פרטי הבקשה נמחקו לפי מדיניות השמירה" instead of the privacy-erasure line. A request emptied by a
--   privacy erasure first keeps false (erased_at already set, so the job never touches it).
-- * app.privacy_request_retention_due() is the one rule for "due": not emptied yet, and coalesce(closed_at, received_at) more
--   than 12 months ago. The partial index privacy_requests_retention_idx reads exactly that expression.
-- * app.run_privacy_request_retention(p_limit) (definer, no grants; pg_cron crm-privacy-request-retention, daily at 02:23 UTC)
--   empties up to p_limit (default 1,000) due requests a run, oldest first, rows locked with SKIP LOCKED, then erases the
--   requests' own audit entries exactly like app.privacy_requests_erase does (the identity note, the refusal reason, and the
--   entry the emptying update itself just wrote). Keep the emptied columns and the audit step in step with that trigger.
--   The update runs as the function's owner, so app.privacy_requests_check treats it as a server write (no person rules, no
--   closing stamp: status is unchanged). Answers the number emptied.
-- Not here: app.privacy_request_notice_days rows are never cleared (a cleanup needs a delete, which goes in a hand-pasted file).
-- Every statement is safe to run twice. No drops, no row removal.

alter table public.privacy_requests add column if not exists erased_by_retention boolean not null default false;

comment on column public.privacy_requests.erased_by_retention is
  'PRK-02 (76) א: true when the retention job emptied the personal details (12 months after closing, or after receipt if never closed); server only';

create index if not exists privacy_requests_retention_idx
  on public.privacy_requests ((coalesce(closed_at, received_at)))
  where erased_at is null;

-- 12 months: one place
create or replace function app.privacy_request_retention_months() returns integer
language sql immutable
set search_path = ''
as $$ select 12 $$;
revoke all on function app.privacy_request_retention_months() from public, anon, authenticated, service_role;

create or replace function app.run_privacy_request_retention(p_limit integer default 1000) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_orgs uuid[];
  v_cutoff timestamptz := now() - make_interval(months => app.privacy_request_retention_months());
begin
  if p_limit is null or p_limit < 1 then
    return 0;
  end if;

  with due as (
    select r.id
      from public.privacy_requests r
     where r.erased_at is null
       and coalesce(r.closed_at, r.received_at) < v_cutoff
     order by coalesce(r.closed_at, r.received_at), r.id
     limit least(p_limit, 10000)
       for update skip locked),
  emptied as (
    -- the same columns app.privacy_requests_erase empties (keep the two in step)
    update public.privacy_requests r
       set requester_name = null, contact_value = null, details = null, verify_note = null,
           refusal_reason = case when r.refusal_reason is not null then 'הסיבה נמחקה (מדיניות שמירה)' end,
           erased_at = now(),
           erased_by_retention = true
      from due d
     where r.id = d.id
    returning r.id, r.organization_id)
  select coalesce(array_agg(e.id), '{}'::uuid[]), coalesce(array_agg(distinct e.organization_id), '{}'::uuid[])
    into v_ids, v_orgs
    from emptied e;

  if cardinality(v_ids) > 0 then
    -- the requests' own history (as app.privacy_requests_erase: identity note, refusal reason, and the entries the update
    -- above just wrote, whose before-values hold the details)
    update public.audit_log a set changes = '{"erased": true}'::jsonb
     where a.organization_id = any (v_orgs) and a.entity_type = 'privacy_requests' and a.entity_id = any (v_ids);
  end if;
  return cardinality(v_ids);
end;
$$;
revoke all on function app.run_privacy_request_retention(integer) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-privacy-request-retention', '23 2 * * *', 'select app.run_privacy_request_retention();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
