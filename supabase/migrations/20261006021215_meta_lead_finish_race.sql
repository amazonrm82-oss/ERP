-- CAP-11 follow-up (pinned in CLAUDE.md, "Integrations screen and sync log": "Known (pinned, separate fix)").
--
-- public.meta_lead_finish's lost-the-race branch: an UNVERIFIED connection whose fetch succeeds after the page was verified
-- by another connection meanwhile (a verification whose app.meta_lead_end_connection skipped this connection's row because
-- another transaction held it). It called app.meta_lead_end_connection on its own connection, whose status update
-- ('connected' -> 'error') goes through the going-live check of app.integrations_check and is refused while the page is
-- verified elsewhere (P0001 integration:taken). The finish raised, its transaction rolled back, and the arrival stayed
-- pending under its lease until the 3-day give-up.
--
-- Now that branch ends the connection the way integration_test_finish does (021208): the status is left as it is, the row
-- gets last_error_code 'page_taken' and last_error_at now() (so app.meta_lead_connection_open is false for it: receive
-- makes no arrival for it and claim takes none; the INT-03 log line and the once-a-day failure notice to its owners and
-- admins follow from app.integrations_events, as for a connection ended by app.meta_lead_end_connection), and every pending
-- arrival of it, this one included, ends as app.meta_lead_end_connection ends them: status 'refused', last_error_code
-- 'page_taken', done_at now(), lease cleared (rows another transaction holds are skipped, never waited for). The answer is
-- 'refused', as before the raise. No lead is made. Every other line of the function is unchanged (same signature, grants).
--
-- No destructive statements and no escaped code points; safe to run twice.

create or replace function public.meta_lead_finish(p_arrival uuid, p_lease uuid, p_lead jsonb default null, p_error text default null)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_arr app.meta_lead_arrivals;
  v_code text;
  v_row public.meta_lead_forms;
  v_token text;
  v_form uuid;
  v_payload jsonb;
  v_platform text;
  v_result jsonb;
  v_state text;
  v_hint text;
  v_lead uuid;
  v_message text;
  v_int public.integrations;
  v_other record;
  v_page text;
begin
  select * into v_arr from app.meta_lead_arrivals a
   where a.id = p_arrival and a.lease = p_lease and a.status = 'pending' and a.lease_until >= now()
   for update;
  if not found then
    return 'stale';
  end if;

  -- (143) ב: no lead without the plan key (lost since the claim)
  if not app.org_has_feature(v_arr.organization_id, 'meta_leads') then
    update app.meta_lead_arrivals a set status = 'refused', last_error_code = 'feature_off', done_at = now(), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'refused';
  end if;

  -- re-review N2: the page lock BEFORE the connection's row (the order of integration_secret_set); the own row is taken
  -- SKIP LOCKED, so a person's status update (row first, then the page lock in its trigger) never deadlocks with this
  select i.external_id into v_page from public.integrations i
   where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id;
  perform pg_advisory_xact_lock(hashtextextended('meta_page:' || coalesce(v_page, ''), 0));
  select * into v_int from public.integrations i
   where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id
   for update skip locked;
  if not found then
    update app.meta_lead_arrivals a
       set next_try_at = now() + interval '1 minute', attempts = greatest(a.attempts - 1, 0), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'retry';
  end if;

  if p_lead is null or p_error is not null then
    v_code := case when p_error ~ '^[a-z_]{1,40}$' then p_error else 'error' end;
    -- review finding 1 and re-review N3: an UNVERIFIED connection whose envelope does not decrypt ends at once with its
    -- arrivals; one whose token does not open the lead is ended (terminal for receive and claim) but its arrivals wait,
    -- due at once, for a new token (a real owner's expired token loses nothing; the 3-day give-up still applies)
    if v_int.verified_at is null and v_code = 'secret_unreadable' then
      perform app.meta_lead_end_connection(v_arr.organization_id, v_arr.integration_id, v_code);
      return 'refused';
    end if;
    if v_int.verified_at is null and v_code = 'token_invalid' then
      update public.integrations i set status = 'error', last_error_code = v_code, last_error_at = now()
       where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id and i.status in ('connected', 'error');
      update app.meta_lead_arrivals a
         set last_error_code = v_code, next_try_at = now(), lease = null, lease_until = null
       where a.id = v_arr.id;
      return 'retry';
    end if;
    if v_code = 'not_found' then
      update app.meta_lead_arrivals a set status = 'refused', last_error_code = v_code, done_at = now(), lease = null, lease_until = null
       where a.id = v_arr.id;
      return 'refused';
    end if;
    if v_code = 'token_invalid' then
      update public.integrations i set status = 'error', last_error_code = v_code, last_error_at = now()
       where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id and i.status = 'connected';
    end if;
    update app.meta_lead_arrivals a
       set last_error_code = v_code, next_try_at = app.meta_lead_retry_at(v_arr.attempts), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'retry';
  end if;

  if jsonb_typeof(p_lead) <> 'object' then
    raise exception 'invalid lead' using errcode = '22023';
  end if;

  -- review finding 1: a successful fetch with the connection's own token is the proof that the business holds the page.
  -- The first one verifies the connection; every other connection naming the page ends (moved to 'error', its pending
  -- arrivals ended with page_taken). A connection that lost the race (the page verified elsewhere meanwhile) ends itself.
  if v_int.verified_at is null then
    -- the page lock is held since the row was read (re-review N2)
    if exists (select 1 from public.integrations o
                where o.provider = 'meta_lead_ads' and o.external_id = v_int.external_id and o.id <> v_int.id
                  and o.status in ('connected', 'error') and o.verified_at is not null) then
      -- Not app.meta_lead_end_connection here (021215): moving this row's status while the page is verified elsewhere is
      -- refused by app.integrations_check (integration:taken), which rolled the finish back and left the arrival pending.
      -- The code alone ends the connection for CAP-11 (app.meta_lead_connection_open is false for an unverified one with
      -- page_taken); its own row is held since it was read; its pending arrivals end as end_connection ends them.
      update public.integrations i set last_error_code = 'page_taken', last_error_at = now()
       where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id;
      update app.meta_lead_arrivals a
         set status = 'refused', last_error_code = 'page_taken', done_at = now(), lease = null, lease_until = null
       where a.id in (select o.id from app.meta_lead_arrivals o
                       where o.organization_id = v_arr.organization_id and o.integration_id = v_arr.integration_id
                         and o.status = 'pending'
                       for update skip locked);
      return 'refused';
    end if;
    for v_other in
      select o.organization_id, o.id from public.integrations o
       where o.provider = 'meta_lead_ads' and o.external_id = v_int.external_id and o.id <> v_int.id
         and o.status in ('connected', 'error')
       order by o.id
    loop
      perform app.meta_lead_end_connection(v_other.organization_id, v_other.id, 'page_taken');
    end loop;
    update public.integrations i set verified_at = now()
     where i.organization_id = v_arr.organization_id and i.id = v_arr.integration_id;
  end if;

  -- the form row: this Meta form's, else the page's default ("every other form"), made again if it was removed
  select * into v_row from public.meta_lead_forms f
   where f.organization_id = v_arr.organization_id and f.integration_id = v_arr.integration_id
     and f.meta_form_id = v_arr.meta_form_id;
  if not found then
    select * into v_row from public.meta_lead_forms f
     where f.organization_id = v_arr.organization_id and f.integration_id = v_arr.integration_id and f.meta_form_id is null;
    if not found then
      insert into public.meta_lead_forms (organization_id, integration_id, meta_form_id, name, assign_mode)
      values (v_arr.organization_id, v_arr.integration_id, null, 'כל הטפסים בדף', 'round_robin')
      on conflict do nothing;
      select * into v_row from public.meta_lead_forms f
       where f.organization_id = v_arr.organization_id and f.integration_id = v_arr.integration_id and f.meta_form_id is null;
    end if;
  end if;
  if not v_row.is_active then
    update app.meta_lead_arrivals a set status = 'refused', last_error_code = 'form_off', done_at = now(), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'refused';
  end if;
  select f.id, f.token into v_form, v_token from public.forms f
   where f.organization_id = v_arr.organization_id and f.meta_lead_form_id = v_row.id;
  -- the source follows the business's "פייסבוק/אינסטגרם" entry (renamed, switched off or made again)
  perform set_config('app.meta_form', 'on', true);
  update public.forms f set source_id = app.meta_lead_source(v_arr.organization_id)
   where f.organization_id = v_arr.organization_id and f.id = v_form
     and f.source_id is distinct from app.meta_lead_source(v_arr.organization_id);
  perform set_config('app.meta_form', '', true);

  -- only the fields the intake knows; everything else the person answered goes into the message
  v_platform := case when p_lead ->> 'platform' = 'ig' then 'instagram' else 'facebook' end;
  v_message := app.meta_lead_text(p_lead -> 'message', 5000);
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'full_name', app.meta_lead_text(p_lead -> 'full_name', 200),
    'phone', app.meta_lead_text(p_lead -> 'phone', 40),
    'email', app.meta_lead_text(p_lead -> 'email', 254),
    'company_name', app.meta_lead_text(p_lead -> 'company_name', 200),
    'message', v_message,
    'attribution', jsonb_strip_nulls(jsonb_build_object(
      'utm_source', v_platform, 'utm_medium', 'lead_ads',
      'utm_campaign', app.meta_lead_text(p_lead -> 'campaign', 200)))));

  begin
    v_result := public.intake_submit(v_token, 'meta', v_payload, null, 'meta-lead-ads', false);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_hint = 'rate_limited' or v_state not in ('22023', 'P0002', 'P0001') then
      update app.meta_lead_arrivals a
         set last_error_code = case when v_hint = 'rate_limited' then 'rate_limited' else 'intake_error' end,
             next_try_at = app.meta_lead_retry_at(v_arr.attempts), lease = null, lease_until = null
       where a.id = v_arr.id;
      return 'retry';
    end if;
    -- bad data (no name, phone or email; an invalid email), a form switched off, a business that takes no leads
    update app.meta_lead_arrivals a
       set status = 'refused', last_error_code = case when v_state = '22023' then 'invalid' else 'not_taken' end,
           done_at = now(), lease = null, lease_until = null
     where a.id = v_arr.id;
    return 'refused';
  end;

  v_lead := case when v_result ->> 'lead_id' ~ '^[0-9a-f-]{36}$' then (v_result ->> 'lead_id')::uuid end;
  -- the lead it made (or the open lead a repeat inquiry matched) carries the Meta id, once per business
  if v_lead is not null then
    update public.leads l set meta_lead_id = v_arr.meta_lead_id
     where l.organization_id = v_arr.organization_id and l.id = v_lead and l.meta_lead_id is null
       and not exists (select 1 from public.leads o
                        where o.organization_id = v_arr.organization_id and o.meta_lead_id = v_arr.meta_lead_id);
  end if;
  update app.meta_lead_arrivals a
     set status = 'done', outcome = case when v_result ->> 'status' = 'duplicate' then 'duplicate' else 'accepted' end,
         lead_id = v_lead, done_at = now(), last_error_code = null, lease = null, lease_until = null
   where a.id = v_arr.id;
  return case when v_result ->> 'status' = 'duplicate' then 'duplicate' else 'accepted' end;
end;
$$;
revoke all on function public.meta_lead_finish(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.meta_lead_finish(uuid, uuid, jsonb, text) to service_role;
