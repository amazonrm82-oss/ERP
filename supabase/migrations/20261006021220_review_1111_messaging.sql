-- Weekly review of 11 November 2026 (docs/reviews/2026-11-11.md), messaging findings RVW-80, RVW-81, RVW-82.
-- Every function keeps its signature, grants and settings; each body is its latest one with only the lines named here.
--
-- RVW-80: app.jobs_record_message() (021160's body, pinned by md5 in test 284) returns early for a job whose payload names
--   a sender check (`sender_check_id`, SMS-01b, 021204): that code goes to the business's own phone, names no lead or
--   contact, and recording it only failed messages_one_record and raised the "was not recorded" warning on every finish.
--   No public.messages row for it. Every other job is recorded as before.
-- RVW-81: public.sms_sender_verify_start() (021204's body) refuses a business whose plan has no `sms` (P0001, hint
--   `feature:sms`), after the owner/admin and writable checks: the code is an SMS the platform pays for, and
--   job_message_may_send exempts verification codes from the plan flag.
-- RVW-82 (lead's choice, owner question pending): a preferences link whose active token was copied by a person on the staff
--   (public.consent_preference_link_create sets app.consent_preference_links.created_by; the future sender's
--   consent_preference_link_for_job mints with created_by null) unsubscribes as before but never turns a channel on:
--   app.consent_preference_channels() (021210's body) answers can_turn_on false for it, so
--   public.consent_preferences_submit() (unchanged) answers 'refused' for an "on". public.consent_preferences_public()
--   (021210's body) adds one key, `staff_link` (true only on the full page of such a link), so the page tells the customer
--   that this link only removes. A token minted before this migration is judged by the same column (the link already kept
--   who minted its active token). No new column, no change to stored rows.

-- ----------------------------------------------------------------------------
-- RVW-80
-- ----------------------------------------------------------------------------
-- 021160's body plus the early return for a sender-verification job (pinned by test 284)
create or replace function app.jobs_record_message() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead uuid;
  v_contact uuid;
  v_status text := new.message_outcome;
  v_provider_id text := new.provider_message_id;
begin
  if new.kind <> 'message.send' or v_status is null then
    return null;
  end if;
  -- RVW-80: a sender-verification code (SMS-01b) goes to the business's own phone, never to a lead or a contact: there is
  -- no timeline to show it on (it named no record, so recording it would only fail the one-record check and warn)
  if new.payload ? 'sender_check_id' then
    return null;
  end if;
  -- MSG-02 (103): a message refused for its filled length tells the owners and admins (once per template a day); never
  -- fails the finish
  if v_status = 'failed' and new.provider_error_code = 'too_long' and new.provider is null then
    begin
      perform app.message_send_refused(new.organization_id,
                                       case when new.payload ? 'template_id' then (new.payload ->> 'template_id')::uuid end,
                                       'too_long');
    exception when others then
      raise warning 'jobs_record_message: the refusal notice of job % was not written (%)', new.id, sqlstate;
    end;
  end if;
  if new.payload ? 'lead_id' then
    v_lead := (new.payload ->> 'lead_id')::uuid;
  else
    v_contact := (new.payload ->> 'contact_id')::uuid;
  end if;
  for v_try in 1..2 loop
    begin
      insert into public.messages (organization_id, lead_id, contact_id, channel, direction, status, provider,
                                   provider_message_id, provider_error_code, job_id, occurred_at, sent_at)
      values (new.organization_id, v_lead, v_contact, new.payload ->> 'channel', 'outbound', v_status, new.provider,
              v_provider_id, new.provider_error_code, new.id, now(), case when v_status = 'sent' then now() end)
      on conflict (job_id) do update
        set status = excluded.status, provider = excluded.provider, provider_message_id = excluded.provider_message_id,
            provider_error_code = excluded.provider_error_code, occurred_at = excluded.occurred_at, sent_at = excluded.sent_at;
      return null;
    exception
      -- the lead or contact was purged since the send check: there is no timeline to show it on
      when foreign_key_violation then
        return null;
      -- another message of this business already holds the provider's id: kept without it
      when unique_violation then
        if v_provider_id is null then
          return null;
        end if;
        v_provider_id := null;
      -- recording never fails the finish (a refused finish would send the message again): one warning, the job id only
      when others then
        raise warning 'jobs_record_message: the message of job % was not recorded (%)', new.id, sqlstate;
        return null;
    end;
  end loop;
  return null;
end;
$$;
revoke all on function app.jobs_record_message() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- RVW-81
-- ----------------------------------------------------------------------------
-- 021204's body plus the plan check
create or replace function public.sms_sender_verify_start(p_org uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_until timestamptz;
  v_check uuid;
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) or not coalesce(app.org_writable(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- RVW-81: the code is an SMS the platform pays for; a business whose plan has no SMS asks for none
  if not coalesce(app.org_has_feature(p_org, 'sms'), false) then
    raise exception 'sms is not in the plan' using errcode = 'P0001', hint = 'feature:sms';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sms_sender_check:' || p_org::text, 0));
  select app.normalize_phone(o.phone) into v_phone from public.organizations o where o.id = p_org;
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'no_phone');
  end if;
  v_until := app.sms_sender_cooling(p_org);
  if v_until is not null then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_seconds', greatest(ceil(extract(epoch from v_until - now())), 1)::integer);
  end if;
  if (select count(*) from app.sms_sender_checks k where k.organization_id = p_org and k.created_at > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'rate');
  end if;
  insert into app.sms_sender_checks (organization_id, phone, created_by) values (p_org, v_phone, auth.uid())
  returning id into v_check;
  perform app.enqueue_job(p_org, 'message.send',
    jsonb_build_object('channel', 'sms', 'message_type', 'verification_code', 'sender_check_id', v_check), null);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.sms_sender_verify_start(uuid) from public, anon;
grant execute on function public.sms_sender_verify_start(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- RVW-82
-- ----------------------------------------------------------------------------
-- 021210's body plus the staff-link line
create or replace function app.consent_preference_channels(p_token app.consent_preference_tokens)
returns table (channel text, address_hash text, address text, state text, can_turn_on boolean, full_page boolean, own boolean)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_link app.consent_preference_links;
  v_full boolean;
  v_live boolean;
  v_writable boolean;
  v_key boolean;
  v_ch text;
  v_address text;
  v_hash text;
  v_raw text;
  v_locked boolean;
  v_suppressed boolean;
  v_staff boolean;
begin
  select * into v_link from app.consent_preference_links l where l.id = p_token.link_id;
  v_live := app.consent_preference_record_live(p_token.organization_id, v_link.lead_id, v_link.contact_id);
  -- the full page: the link's active token, of a record that still lives
  v_full := v_link.token_hash = p_token.token_hash and v_live;
  v_writable := coalesce(app.org_writable(p_token.organization_id), false);
  v_key := app.consent_key_present();
  -- RVW-82 (lead's choice, owner question pending): the link's active token was copied by a person on the staff
  -- (consent_preference_link_create sets created_by; the sender's mint clears it). Such a link only unsubscribes: a
  -- re-subscribe from it would read as the customer's own act while a person on the staff could have made it
  v_staff := v_link.created_by is not null;
  foreach v_ch in array array['email', 'sms', 'whatsapp'] loop
    v_address := null;
    v_hash := null;
    if v_live then
      v_address := app.consent_record_address(p_token.organization_id, v_link.lead_id, v_link.contact_id, v_ch);
      if v_address is not null and v_key then
        v_hash := app.consent_address_hash(p_token.organization_id, app.consent_address_kind(v_ch), v_address, 1::smallint);
      end if;
    end if;
    if v_ch = p_token.channel then
      -- the token's own channel: always shown, judged on the address the token was made for
      if v_hash is distinct from p_token.address_hash then
        v_address := null;
      end if;
      v_hash := p_token.address_hash;
    elsif not v_full or v_hash is null then
      continue;
    end if;
    v_raw := app.consent_state_of(p_token.organization_id, v_ch, v_hash, null, null);
    state := case when v_raw in ('out', 'blocked', 'listed') then 'out' when v_raw = 'in' then 'in' else 'unknown' end;
    can_turn_on := false;
    -- review 1: ON only on the token's own channel, while the record's current address is the token's address
    if v_staff then
      can_turn_on := false;
    elsif v_ch = p_token.channel and v_full and v_writable and v_address is not null and state = 'unknown' then
      v_locked := app.consent_address_locked(p_token.organization_id, v_link.lead_id, v_link.contact_id, v_ch, v_address);
      v_suppressed := app.consent_suppressed(p_token.organization_id, v_ch, v_address);
      can_turn_on := not coalesce(v_locked, true) and v_suppressed is not distinct from false;
    elsif v_ch = p_token.channel and v_full and v_writable and v_address is not null and state = 'out' then
      -- owner (231) ב: only the person's own unsubscribe of this address is lifted here (fail closed)
      can_turn_on := app.consent_preference_relist_ok(p_token.organization_id, v_ch, v_hash);
    end if;
    channel := v_ch;
    address_hash := v_hash;
    address := v_address;
    full_page := v_full;
    own := v_ch = p_token.channel;
    return next;
  end loop;
end;
$$;
revoke all on function app.consent_preference_channels(app.consent_preference_tokens) from public, anon, authenticated, service_role;

-- 021210's body plus the `staff_link` key
-- ----------------------------------------------------------------------------
create or replace function public.consent_preferences_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token app.consent_preference_tokens;
  v_org public.organizations;
  v_built_with boolean;
  v_channels jsonb;
  v_full boolean := false;
  v_row record;
  v_staff boolean;
begin
  v_token := app.consent_preference_find(p_token);
  if not app.consent_preference_count(v_token.link_id, p_ip_hash) then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_channels := '[]'::jsonb;
  -- review 1: the token's own channel only; the page never tells which other channels hold an address
  for v_row in select * from app.consent_preference_channels(v_token) c where c.own loop
    v_full := v_row.full_page;
    -- the channel and its state only: never the address or its hash
    v_channels := v_channels || jsonb_build_array(jsonb_build_object(
      'channel', v_row.channel, 'state', v_row.state, 'can_turn_on', v_row.can_turn_on));
  end loop;
  -- RVW-82: whether the link's active token was copied by staff (then nothing is turned on from it; the page says so)
  select l.created_by is not null into v_staff from app.consent_preference_links l where l.id = v_token.link_id;
  select * into v_org from public.organizations o where o.id = v_token.organization_id;
  begin
    v_built_with := coalesce(app.show_built_with(v_token.organization_id), true);
  exception when others then
    v_built_with := true;
  end;
  -- the business's display name and brand, and the channels: nothing about the person or the record
  return jsonb_build_object(
    'business', v_org.name,
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'built_with', v_built_with,
    'channel', v_token.channel,
    'full', v_full,
    'staff_link', coalesce(v_staff, false) and v_full,
    'channels', v_channels);
end;
$$;
revoke all on function public.consent_preferences_public(text, text) from public, anon, authenticated;
grant execute on function public.consent_preferences_public(text, text) to service_role;

notify pgrst, 'reload schema';
