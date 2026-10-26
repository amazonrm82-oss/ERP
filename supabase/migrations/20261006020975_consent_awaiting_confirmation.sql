-- =============================================================================
-- CAP-07 follow-up: a public-form tick on a blocked address waits for a double opt-in
-- =============================================================================
-- Owner, 26 October 2026 (DECISIONS.md, CAP-07 answer 3): "(א) when there is a sending provider (double opt-in); until
-- then (ב): a tick on the form does not bring a consent back after an opt-out, and it is recorded as 'awaiting double
-- opt-in'." Until now app.intake_marketing_consent skipped a locked address (an opt-out, an erasure block, or since
-- CNS-06 the business's blocklist) and the tick stayed on the inquiry only.
--
-- * Where the marker lives: in the register itself, as a new state of public.consents: 'awaiting_confirmation'. It is
--   one more append-only fact of the same record, channel and address, so it gets everything the register already
--   does for free and in the same way: the hash from consent_hash_key (or the pending address while the key is missing,
--   then the backfill), no client may select the hash, consents_guard keeps it unchanged, a merge moves it, a privacy
--   erasure empties its texts and blanks a waiting address, rights follow the record, the full export and the person's
--   export list it. A separate table would have needed its own copy of each of those. Only the server writes it: a
--   browser may insert only source 'manual', and constraint consents_awaiting_form allows the state with source 'form'
--   only. It never changes the state of an address: app.consent_state_of reads granted / withdrawn / denied only, so an
--   awaiting entry lifts nothing, counts for nothing, and app.consent_suppressed is unchanged.
-- * What it holds: state 'awaiting_confirmation', source 'form', the server's wording and its version (as a granted
--   form consent would), the address hash of the record's address (the one typed), the time, and in `method` the name
--   of the form it came from ("טופס: <name>"). The later double opt-in (when a sending provider exists; out of scope)
--   confirms THIS entry: it will write a new 'granted' entry for the same record and channel with copied_from = the
--   awaiting entry's id (so it carries the same address hash), from its own source; that flow decides then how a
--   confirmation lifts a lock. Nothing here confirms anything. That flow MUST check the business's blocklist again
--   (app.consent_suppressed / app.consent_address_locked) before it writes: consents_prepare skips its write-time lock
--   for a copy (copied_from), and the blocklist (CNS-06) is never lifted by any consent.
-- * At most one awaiting entry per record, channel and day in the business's time zone: a tick repeated the same day
--   writes nothing new.
-- * public.intake_submit sets the transaction setting app.intake_form_id (the body of 020935 plus that one line; the
--   v_rotation_closed, v_leads_on and app.org_takes_leads lines unchanged), and app.intake_marketing_consent reads it
--   (the form must belong to the business). Every tick that is not written as a consent because the address is locked
--   is written as awaiting instead; an unticked box, a tick without its address, or a record whose own address is not
--   the typed one still writes nothing (as before).
-- * public.consent_current (the card's state per channel) skips awaiting entries, so the card shows the real state;
--   the app adds "ממתין לאישור כפול" from the history. app.convert_consents (LEAD-07) copies, per channel, the latest
--   real entry as before and the awaiting entries after it.
-- * Out of scope (question to the owner): an import 'granted' that hits a lock stays 'locked' (CNS-05), not awaiting.
-- Every statement is safe to run twice.

alter table public.consents drop constraint if exists consents_state;
alter table public.consents add constraint consents_state check (state in ('granted', 'denied', 'withdrawn', 'unknown', 'awaiting_confirmation'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'consents_awaiting_form' and conrelid = 'public.consents'::regclass) then
    alter table public.consents add constraint consents_awaiting_form
      check (state <> 'awaiting_confirmation' or source = 'form');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The ticked boxes on one record: 020950's body; a locked address gets an awaiting entry instead of nothing
-- ----------------------------------------------------------------------------
create or replace function app.intake_marketing_consent(p_org uuid, p_lead uuid, p_contact uuid, p_channels text[],
                                                        p_wording jsonb, p_email text, p_phone_e164 text)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_channel text;
  v_address text;
  v_count integer := 0;
  v_form_name text;
begin
  if num_nonnulls(p_lead, p_contact) <> 1 then
    return 0;
  end if;
  -- the form this request came through (set by intake_submit), only one of this business
  select f.name into v_form_name
    from public.forms f
   where f.organization_id = p_org
     and f.id = (select nullif(current_setting('app.intake_form_id', true), '')::uuid);
  foreach v_channel in array coalesce(p_channels, '{}'::text[]) loop
    continue when v_channel not in ('email', 'sms', 'whatsapp');
    v_address := case when v_channel = 'email' then p_email else p_phone_e164 end;
    continue when v_address is null;
    continue when app.consent_record_address(p_org, p_lead, p_contact, v_channel) is distinct from v_address;
    if app.consent_address_locked(p_org, p_lead, p_contact, v_channel, v_address) then
      -- an opt-out, an erasure block or the blocklist is never lifted by a public-form tick (owner, CAP-07 answer 3):
      -- the tick is kept as an entry awaiting a double opt-in, which lifts nothing. One per record, channel and day (the
      -- business's zone): a tick repeated the same day writes nothing new
      continue when exists (
        select 1 from public.consents c
          join public.organizations o on o.id = c.organization_id
         where c.organization_id = p_org and c.channel = v_channel and c.state = 'awaiting_confirmation'
           and ((p_lead is not null and c.lead_id = p_lead) or (p_contact is not null and c.contact_id = p_contact))
           and (c.created_at at time zone o.timezone)::date = (now() at time zone o.timezone)::date);
      insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, wording, wording_version, method)
      values (p_org, p_lead, p_contact, v_channel, 'awaiting_confirmation', 'form',
              nullif(p_wording ->> v_channel, ''), app.marketing_consent_version(),
              case when v_form_name is not null then left('טופס: ' || v_form_name, 500) end);
    else
      insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, wording, wording_version)
      values (p_org, p_lead, p_contact, v_channel, 'granted', 'form',
              nullif(p_wording ->> v_channel, ''), app.marketing_consent_version());
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.intake_marketing_consent(uuid, uuid, uuid, text[], jsonb, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The card's state per channel: 0155's body; an awaiting entry is not a state
-- ----------------------------------------------------------------------------
create or replace function public.consent_current(p_org uuid, p_kind text, p_id uuid)
returns table (
  channel text,
  state text,
  source text,
  method text,
  wording text,
  recorded_by uuid,
  created_at timestamptz,
  current_address boolean
)
language sql stable security invoker
set search_path = ''
as $$
  select distinct on (c.channel)
         c.channel, c.state, c.source, c.method, c.wording, c.recorded_by, c.created_at,
         app.consent_is_current(c.id) as current_address
    from public.consents c
   where c.organization_id = p_org
     and ((p_kind = 'lead' and c.lead_id = p_id) or (p_kind = 'contact' and c.contact_id = p_id))
     and c.state <> 'awaiting_confirmation'
   order by c.channel, c.created_at desc, c.seq desc;
$$;
revoke all on function public.consent_current(uuid, text, uuid) from public, anon;
grant execute on function public.consent_current(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- LEAD-07: 015510's body; per channel the latest real entry, and the awaiting entries after it
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
    from (select c.*
            from public.consents c
            left join lateral (
              select r.created_at, r.seq from public.consents r
               where r.organization_id = c.organization_id and r.lead_id = c.lead_id and r.channel = c.channel
                 and r.state <> 'awaiting_confirmation'
               order by r.created_at desc, r.seq desc
               limit 1) latest on true
           where c.organization_id = new.organization_id and c.lead_id = new.id
             and ((c.state <> 'awaiting_confirmation' and c.created_at = latest.created_at and c.seq = latest.seq)
                  or (c.state = 'awaiting_confirmation'
                      and (latest.seq is null or (c.created_at, c.seq) > (latest.created_at, latest.seq))))) l
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

-- ----------------------------------------------------------------------------
-- public.intake_submit: the body of 020935, plus the transaction setting app.intake_form_id (CAP-07 follow-up)
-- ----------------------------------------------------------------------------
create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_phone_e164 text;
  -- matched lead (and the contact it became) or matched contact
  v_lead_match uuid;
  v_lead_owner uuid;
  v_lead_contact uuid;
  v_contact_match uuid;
  v_contact_owner uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
  -- CAP-02 / ADS-01: where the visit came from (cleaned, known keys only)
  v_attr jsonb := app.intake_attribution(p_payload -> 'attribution');
  -- CAP-01: custom values as sent, and what is kept of them
  v_custom_in jsonb := case when jsonb_typeof(p_payload -> 'custom') = 'object' then p_payload -> 'custom' else '{}'::jsonb end;
  v_custom jsonb := '{}'::jsonb;
  -- values of the shown fields by form key, for the conditions of later fields
  v_values jsonb := '{}'::jsonb;
  v_shown text[] := '{}';
  v_value jsonb;
  v_cond jsonb;
  v_type text;
  v_options jsonb;
  -- SPD-05: when the person asked to be called back ('now' or a slot 'YYYY-MM-DD-HH', its business date and start hour)
  v_callback text := nullif(left(btrim(coalesce(p_payload ->> 'callback', '')), 40), '');
  v_callback_at timestamptz;
  v_callback_phrase text;
  v_callback_note text;
  v_task_owner uuid;
  v_task uuid;
  -- CAP-09: the rotation has members, but none is in working hours (or all are on leave)
  v_rotation_closed boolean := false;
  -- CAP-08: the team the new lead belongs to and is distributed in (the form's, or a matching rule's)
  v_team uuid;
  -- HEB-08: the form's owner was away with no usable deputy
  v_absent uuid;
  -- CON-10: how the person likes to be contacted, when the form asks (one of the four, else none)
  v_channel text := case when p_payload ->> 'preferred_channel' in ('phone', 'whatsapp', 'email', 'sms')
                         then p_payload ->> 'preferred_channel' end;
  -- CAP-08: the person's language, when the form asks (one of the contacts' codes, else none)
  v_locale text := case when p_payload ->> 'preferred_locale' in ('he', 'ar', 'en', 'ru', 'am', 'fr', 'es')
                        then p_payload ->> 'preferred_locale' end;
  -- CAP-08: a distribution rule that names one person
  v_rule_user uuid;
  -- LEAD-08 (owner, 18 October 2026, answer (א)): the business switched leads off; the inquiry becomes a contact
  v_leads_on boolean;
  v_contact uuid;
  v_name text;
  -- LEAD-04 / CAP-08 (020830): the product the person asked about, when the form asks (checked below)
  v_product_raw text := case when jsonb_typeof(p_payload -> 'requested_product_id') = 'string'
                             then nullif(left(btrim(p_payload ->> 'requested_product_id'), 64), '') end;
  v_product uuid;
  v_product_name text;
  -- CAP-07 / CNS-04: the channels whose marketing-consent box the person ticked (as sent; checked below), the ones
  -- that count, their wording, and the inquiry as stored (the ticked boxes' wording and version with it)
  v_consent_in text[] := case jsonb_typeof(p_payload -> 'marketing_consent')
                           when 'array' then array(select left(e.value, 20) from jsonb_array_elements_text(
                                                     case when jsonb_typeof(p_payload -> 'marketing_consent') = 'array'
                                                          then p_payload -> 'marketing_consent' end) with ordinality as e(value, n)
                                                    where e.n <= 10)
                           when 'string' then array[left(p_payload ->> 'marketing_consent', 20)]
                           else '{}'::text[] end;
  v_consent text[] := '{}';
  v_consent_wording jsonb;
  v_payload jsonb;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  -- read-only and suspended businesses keep taking leads (owner, 8 and 13 October 2026)
  if not app.org_takes_leads(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  v_leads_on := app.org_leads_enabled(v_form.organization_id);
  -- CAP-07 follow-up: the form this request came through, for an entry awaiting a double opt-in
  -- (app.intake_marketing_consent reads it; transaction-local)
  perform set_config('app.intake_form_id', v_form.id::text, true);

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam',
            -- CAP-07 / CNS-04: never the sender's own consent record
            case when jsonb_typeof(p_payload) = 'object' then p_payload - 'marketing_consent' else coalesce(p_payload, '{}'::jsonb) end,
            p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  -- CAP-01: the form's fields in order. A hidden field loses its value and is
  -- never required; a shown custom field must hold a valid value.
  if v_form.kind = 'form' then
    for v_field in
      select a.value from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end) a
    loop
      continue when jsonb_typeof(v_field) <> 'object';
      v_key := v_field ->> 'key';
      continue when v_key is null or v_key = any (v_shown);
      v_type := null;
      v_options := null;
      if v_key like 'cf:%' then
        select d.field_type, d.options into v_type, v_options
          from public.field_definitions d
         where d.organization_id = v_form.organization_id and d.object_type = 'lead'
           and d.key = substr(v_key, 4) and d.is_active;
        -- a field that is gone, switched off or picks a team member is not on the form (FLD-06 part B: nor a record link or a file)
        continue when v_type is null or v_type in ('user', 'record_link', 'file');
        v_value := v_custom_in -> substr(v_key, 4);
      elsif v_key = 'full_name' then v_value := to_jsonb(v_full_name);
      elsif v_key = 'phone' then v_value := to_jsonb(v_phone);
      elsif v_key = 'email' then v_value := to_jsonb(v_email);
      elsif v_key = 'company_name' then v_value := to_jsonb(v_company);
      elsif v_key = 'message' then v_value := to_jsonb(v_message);
      else
        continue;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;

      v_cond := v_field -> 'show_if';
      if jsonb_typeof(v_cond) = 'object'
         and not coalesce((v_cond ->> 'field') = any (v_shown)
                          and app.intake_condition_met(v_values -> (v_cond ->> 'field'), v_cond ->> 'value'), false) then
        -- hidden: whatever was sent for it is dropped
        if v_key = 'full_name' then v_full_name := null;
        elsif v_key = 'phone' then v_phone := null;
        elsif v_key = 'email' then v_email := null;
        elsif v_key = 'company_name' then v_company := null;
        elsif v_key = 'message' then v_message := null;
        end if;
        continue;
      end if;

      v_shown := v_shown || v_key;
      if v_type is not null and app.intake_has_value(v_value) then
        if not app.custom_value_ok(v_type, v_options, v_value) then
          raise exception 'invalid custom field: %', substr(v_key, 4) using errcode = '22023';
        end if;
        v_custom := v_custom || jsonb_build_object(substr(v_key, 4), v_value);
      end if;
      if app.intake_has_value(v_value) then
        v_values := v_values || jsonb_build_object(v_key, v_value);
      end if;
      if v_field -> 'required' = 'true'::jsonb and not app.intake_has_value(v_value) then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;

  -- CAP-07 / CNS-04: a ticked box counts only on a web form that shows it now, and only with the address it is for
  -- (an email for email, a phone for SMS and WhatsApp; a field hidden by its condition gave none). An unticked or
  -- unknown box records nothing. The wording is the server's own, never the sender's.
  if v_form.kind = 'form' then
    select coalesce(array_agg(c.channel order by c.ord), '{}'),
           jsonb_object_agg(c.channel, app.marketing_consent_wording(c.channel, o.name))
      into v_consent, v_consent_wording
      from unnest(app.form_marketing_channels(v_form.marketing_consent_channels, v_form.fields)) with ordinality as c(channel, ord)
      cross join public.organizations o
     where o.id = v_form.organization_id
       and c.channel = any (v_consent_in)
       and ((c.channel = 'email' and v_email is not null) or (c.channel <> 'email' and v_phone is not null));
  end if;
  -- the inquiry as stored: never the sender's own "marketing_consent"; the server's record of the ticked boxes instead
  v_payload := case when jsonb_typeof(p_payload) = 'object' then p_payload - 'marketing_consent' else coalesce(p_payload, '{}'::jsonb) end
               || case when cardinality(v_consent) > 0
                       then jsonb_build_object('marketing_consent', jsonb_build_object(
                              'version', app.marketing_consent_version(), 'channels', to_jsonb(v_consent),
                              'wording', v_consent_wording))
                       else '{}'::jsonb end;

  -- CON-10: a channel counts only when the form asks
  if v_form.kind <> 'form' or not v_form.channel_choice then
    v_channel := null;
  end if;
  -- CAP-08: a language counts only when the form asks
  if v_form.kind <> 'form' or not v_form.locale_choice then
    v_locale := null;
  end if;
  -- LEAD-04 / CAP-08 (020830): a requested product counts only when the form asks and the business has the products
  -- flag. It must be one the form offers now (app.intake_form_products, the list intake_form shows); any other id,
  -- whatever it is (another business's, archived, not picked, unknown), gets the same refusal
  if v_form.kind = 'form' and v_form.product_choice and v_product_raw is not null
     and app.org_has_feature(v_form.organization_id, 'products') then
    if v_product_raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select p.id, p.name into v_product, v_product_name
        from app.intake_form_products(v_form.organization_id, v_form.product_ids, v_form.product_category_ids) p
       where p.id = v_product_raw::uuid;
    end if;
    if v_product is null then
      raise exception 'invalid requested product' using errcode = '22023', hint = 'requested_product:invalid';
    end if;
  end if;

  -- SPD-05: a call-back time counts only when the form offers the choice; a
  -- choice that is not one of the slots, or a slot that has ended, is refused
  -- (SPD-05 follow-ups: the slots this form offers now, app.intake_callback_pick())
  if v_form.kind = 'form' and v_form.callback_choice and v_callback is not null then
    select p.at, p.phrase into v_callback_at, v_callback_phrase
      from app.intake_callback_pick(v_form.organization_id, v_form.callback_slots_off, v_callback, now()) p;
    v_callback_note := 'ביקשו שנחזור אליהם ' || v_callback_phrase;
  else
    v_callback := null;
  end if;

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  -- LEAD-08: with leads off only contacts are matched (the business's old leads stay as they are)
  if v_leads_on then
    select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
      from public.leads l
     where l.organization_id = v_form.organization_id and l.deleted_at is null
       and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
            or (v_email is not null and lower(l.email) = v_email))
     order by l.created_at desc
     limit 1;
  end if;
  if v_lead_match is null then
    -- CON-01: the contact's primary phone or email, or any of its other ones
    select c.id, c.owner_id into v_contact_match, v_contact_owner
      from public.contacts c
     where c.organization_id = v_form.organization_id and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and c2.phone_e164 = v_phone_e164)
                 or (v_email is not null and lower(c2.email) = v_email))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = v_form.organization_id
            and ((v_phone_e164 is not null and ch.value_e164 = v_phone_e164)
                 or (v_email is not null and ch.kind = 'email' and ch.value = v_email)))
     order by c.created_at desc
     limit 1;
  end if;

  if v_lead_match is not null or v_contact_match is not null then
    -- first touch wins: the lead keeps its attribution and custom fields;
    -- this visit's are kept on the inquiry
    insert into public.activities (organization_id, type, body, lead_id, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_lead_match,
      coalesce(v_lead_contact, v_contact_match),
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end
        || case when v_product is not null
                then jsonb_build_object('requested_product_id', v_product, 'requested_product', v_product_name)
                else '{}'::jsonb end);
    -- CAP-08: the form's language fills an empty one only
    if v_locale is not null then
      if v_lead_match is not null then
        update public.leads l set preferred_locale = v_locale
         where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.preferred_locale is null;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c set preferred_locale = v_locale
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and c.preferred_locale is null;
      end if;
    end if;
    -- LEAD-04 (020830): the form's product fills a matched lead's empty one only (a contact has no requested product;
    -- it stays on the inquiry entry)
    if v_product is not null and v_lead_match is not null then
      update public.leads l set requested_product_id = v_product
       where l.organization_id = v_form.organization_id and l.id = v_lead_match and l.requested_product_id is null;
    end if;
    -- CON-10 (owner, 14 October 2026): the form's channel fills an empty one, or replaces one
    -- that came from a form; a channel a person set (or one older than its source) stays
    if v_channel is not null then
      if v_lead_match is not null then
        update public.leads l
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where l.organization_id = v_form.organization_id and l.id = v_lead_match
           and (l.preferred_channel is null or l.preferred_channel_source = 'form')
           and l.preferred_channel is distinct from v_channel;
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        update public.contacts c
           set preferred_channel = v_channel, preferred_channel_source = 'form'
         where c.organization_id = v_form.organization_id and c.id = coalesce(v_lead_contact, v_contact_match)
           and (c.preferred_channel is null or c.preferred_channel_source = 'form')
           and c.preferred_channel is distinct from v_channel;
      end if;
    end if;
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      -- SPD-05: the requested call-back time, when there is one, in the body
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים', v_callback_note,
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    -- SPD-05: a call task for the record's owner, else the form's owner
    if v_callback_at is not null then
      -- the record's owner while an active member who is not a viewer, else the form's owner, same check
      select m.user_id into v_task_owner from public.memberships m
       where m.organization_id = v_form.organization_id and m.user_id = v_owner
         and m.status = 'active' and m.role <> 'viewer';
      if v_task_owner is null then
        select m.user_id into v_task_owner from public.memberships m
         where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
           and m.status = 'active' and m.role <> 'viewer';
      end if;
      v_task := app.intake_call_task(v_form.organization_id, v_task_owner, v_lead_match,
                                     coalesce(v_lead_contact, v_contact_match), v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- SPD-01: the lead's call task follows "לקחתי"
      if v_lead_match is not null then
        insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
        values (v_task, v_form.organization_id, v_lead_match) on conflict do nothing;
      end if;
    end if;
    -- LEAD-08: with leads off a repeat inquiry from a contact also gets "לחזור ללקוח" (the call-back task does it when asked)
    if not v_leads_on and v_callback_at is null then
      -- the contact's own team (its task and, with no owner, who is told)
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, v_form.owner_id,
                                           (select c.team_id from public.contacts c
                                             where c.organization_id = v_form.organization_id and c.id = v_contact_match),
                                           v_contact_match,
                                           -- LEAD-04 (020830): the product's name in the task's title
                                           nullif(concat_ws(' · ', coalesce(v_full_name, v_phone, v_email), v_product_name), ''),
                                           v_form.name, false);
    end if;
    -- CAP-07 / CNS-04: the ticked boxes on the matched lead and on the contact the inquiry entry is on
    if cardinality(v_consent) > 0 then
      if v_lead_match is not null then
        perform app.intake_marketing_consent(v_form.organization_id, v_lead_match, null, v_consent, v_consent_wording,
                                             v_email, v_phone_e164);
      end if;
      if coalesce(v_lead_contact, v_contact_match) is not null then
        perform app.intake_marketing_consent(v_form.organization_id, null, coalesce(v_lead_contact, v_contact_match),
                                             v_consent, v_consent_wording, v_email, v_phone_e164);
      end if;
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, v_payload, p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  if v_leads_on then
    select s.id into v_status from public.lead_statuses s
     where s.organization_id = v_form.organization_id and s.kind = 'open'
     order by s.is_default desc, s.position
     limit 1;
    if v_status is null then
      raise exception 'the organization has no open lead status' using errcode = 'P0001';
    end if;
  end if;

  v_team := v_form.team_id;
  if v_form.assign_mode = 'round_robin' then
    -- CAP-08: the rules (source, language, list field; a team or one person), then the pick
    select p.owner_id, p.team_id, p.rule_user, p.absent_user into v_owner, v_team, v_rule_user, v_absent
      from app.lead_distribution_route(v_form.organization_id, v_form.team_id, now(),
                                       jsonb_build_object('source_id', v_form.source_id, 'locale', v_locale,
                                                          -- LEAD-04 (020830): the product rule sees the form's product
                                                          'product_id', v_product,
                                                          -- the values the lead will hold: with the
                                                          -- fields' defaults (FLD-07) the insert adds
                                                          'custom_fields', (select d.p_result from app.custom_field_defaults_apply(
                                                                              v_form.organization_id, 'lead', v_custom) d)),
                                       '{}'::uuid[]) p;
    -- CAP-09 (owner, 13 October 2026): nobody of the rotation in hours: the lead waits
    -- with no owner for a "לקחתי"; nobody available at all keeps the form owner's fallback
    v_rotation_closed := v_owner is null and v_rule_user is null and app.rotation_has_members(v_form.organization_id, v_team);
  end if;
  -- CAP-08: a rule's person (HEB-08 already applied) never falls back to the form's owner
  if v_owner is null and not v_rotation_closed and v_rule_user is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
    -- HEB-08: an absent form owner's new lead goes to their deputy; with no usable
    -- deputy it has no owner and takes the SPD-01 route (no chain)
    -- (app.auto_lead_owner: the rule every automatic assigner of a fixed person uses)
    if v_owner is not null then
      select a.owner_id, a.absent_user into v_owner, v_absent
        from app.auto_lead_owner(v_form.organization_id, v_owner, now()) a;
    end if;
  end if;

  -- LEAD-08 (owner, 18 October 2026, answer (א)): leads are off: the same owner pick made a contact's owner, the
  -- inquiry is a contact with the details on its timeline, and someone is asked to call back ("לחזור ללקוח").
  -- With no owner (the rotation closed, an absent owner with no deputy) the contact waits for whoever takes the
  -- task: there is no waiting list for contacts, so nobody is handed it later.
  if not v_leads_on then
    v_name := coalesce(v_full_name, '');
    insert into public.contacts (organization_id, first_name, last_name, phone, email, source_id, owner_id, team_id,
                                 preferred_channel, preferred_channel_source, preferred_locale)
    values (v_form.organization_id,
            case when position(' ' in v_name) > 0 then split_part(v_name, ' ', 1) else nullif(v_name, '') end,
            case when position(' ' in v_name) > 0 then btrim(substr(v_name, position(' ' in v_name) + 1)) end,
            v_phone, v_email, v_form.source_id, v_owner, v_team,
            v_channel, case when v_channel is not null then 'form' end, v_locale)
    returning id into v_contact;
    -- what a lead would have held and a contact has no field for (message, company name, campaign, the form's own
    -- fields) is kept on the contact's timeline
    insert into public.activities (organization_id, type, body, contact_id, metadata)
    values (
      v_form.organization_id, 'inquiry', v_message, v_contact,
      jsonb_build_object('form_id', v_form.id, 'form_name', v_form.name,
                         'full_name', v_full_name, 'phone', v_phone, 'email', v_email, 'company_name', v_company)
        || case when v_attr <> '{}'::jsonb then jsonb_build_object('attribution', v_attr) else '{}'::jsonb end
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end
        || case when v_callback_at is not null then jsonb_build_object('callback_at', v_callback_at) else '{}'::jsonb end
        || case when v_channel is not null then jsonb_build_object('preferred_channel', v_channel) else '{}'::jsonb end
        || case when v_locale is not null then jsonb_build_object('preferred_locale', v_locale) else '{}'::jsonb end
        || case when v_product is not null
                then jsonb_build_object('requested_product_id', v_product, 'requested_product', v_product_name)
                else '{}'::jsonb end);
    if v_callback_at is not null then
      -- SPD-05: the requested time is the follow-up; told first, so the task itself is quiet for the owner
      perform app.intake_contact_notice(v_form.organization_id, v_owner, v_team, v_contact, v_callback_note);
      v_task := app.intake_call_task(v_form.organization_id, v_owner, null, v_contact, v_callback = 'now', v_callback_at,
                                     v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
      -- the call task takes the contact's team, as "לחזור ללקוח" does (intake_call_task finds a team on a lead only)
      update public.tasks t set team_id = v_team
       where t.organization_id = v_form.organization_id and t.id = v_task and v_team is not null
         and t.team_id is distinct from v_team;
    else
      perform app.intake_contact_follow_up(v_form.organization_id, v_owner, null, v_team, v_contact,
                                           -- LEAD-04 (020830): the product's name in the task's title
                                           nullif(concat_ws(' · ', coalesce(v_full_name, v_phone, v_email), v_product_name), ''),
                                           v_form.name, true);
    end if;
    -- CAP-07 / CNS-04: the ticked boxes on the new contact
    if cardinality(v_consent) > 0 then
      perform app.intake_marketing_consent(v_form.organization_id, null, v_contact, v_consent, v_consent_wording,
                                           v_email, v_phone_e164);
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'accepted', null, v_payload, p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'accepted',
      'contact_id', v_contact,
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  -- SPD-01: the owner is told as 'lead_new' (app.notify_assignment())
  perform set_config('app.intake', 'on', true);
  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields, preferred_channel, preferred_channel_source, preferred_locale,
                            requested_product_id)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_team,
          v_full_name, v_phone, v_email, v_company, v_message,
          v_attr ->> 'utm_campaign',
          jsonb_strip_nulls(jsonb_build_object(
            'utm_source', v_attr -> 'utm_source', 'utm_medium', v_attr -> 'utm_medium',
            'utm_campaign', v_attr -> 'utm_campaign', 'utm_term', v_attr -> 'utm_term',
            'utm_content', v_attr -> 'utm_content',
            -- CAP-02: the extra parameters of the closed list, in one place
            'extra', v_attr -> 'extra')),
          v_attr ->> 'referrer_url', v_attr ->> 'landing_url',
          v_attr ->> 'gclid', v_attr ->> 'fbclid', v_attr ->> 'ctwa_clid',
          v_custom, v_channel, case when v_channel is not null then 'form' end, v_locale,
          v_product)
  returning id into v_lead;
  perform set_config('app.intake', '', true);

  -- CAP-09: if nobody takes it, the rotation gives it to the first member back in hours
  if v_rotation_closed then
    insert into app.rotation_waiting_leads (lead_id, organization_id, team_id)
    values (v_lead, v_form.organization_id, v_team) on conflict do nothing;
  end if;

  -- HEB-08: back from the absence, the form's owner gets it if nobody took it (app.return_absence_leads())
  if v_owner is null and v_absent is not null then
    perform app.lead_waits_for_absent(v_form.organization_id, v_lead, v_form.id, v_absent);
  end if;

  -- SPD-01: nobody owns it: whoever may take it is told, and the first "לקחתי" wins
  if v_owner is null then
    insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
    select v_form.organization_id, r.user_id, 'lead_new', 'ליד חדש מחכה למי שייקח אותו', 'lead', v_lead
      from app.intake_unowned_recipients(v_form.organization_id, v_team) r;
  end if;

  -- SPD-05: a call task for the new lead's owner, and the requested time in the
  -- body of the new-lead notification (whichever kind it was sent as)
  if v_callback_at is not null then
    v_task := app.intake_call_task(v_form.organization_id, v_owner, v_lead, null, v_callback = 'now', v_callback_at,
                                   v_callback_phrase, coalesce(v_full_name, v_phone, v_email), v_form.name);
    -- SPD-01: the lead's call task follows "לקחתי"
    insert into app.intake_callback_tasks (task_id, organization_id, lead_id)
    values (v_task, v_form.organization_id, v_lead) on conflict do nothing;
    update public.notifications n set body = v_callback_note
     where n.organization_id = v_form.organization_id and n.entity_type = 'lead' and n.entity_id = v_lead
       and n.body is null;
  end if;

  -- CAP-07 / CNS-04: the ticked boxes on the new lead
  if cardinality(v_consent) > 0 then
    perform app.intake_marketing_consent(v_form.organization_id, v_lead, null, v_consent, v_consent_wording,
                                         v_email, v_phone_e164);
  end if;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, v_payload, p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;
revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;


notify pgrst, 'reload schema';
