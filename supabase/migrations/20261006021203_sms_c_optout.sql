-- =============================================================================
-- SMS-03: an SMS reply "הסר" records an SMS opt-out and blocks the number (the database side only)
-- =============================================================================
-- SPEC-ADDITIONS SMS-03: a marketing SMS carries "פרסומת" and the opt-out line (marketingEnvelope, MSG-02 owner (88) and (92);
-- the card checks the filled text against app.message_filled_problem, SMS-02), and a reply "הסר" updates the consent.
-- Receiving the reply needs the provider's inbound webhook, approved as wave 3 use (2) (one webhook per provider, refused
-- before the database and without logging the body when the signature is not valid) and NOT BUILT: no provider is chosen.
-- This migration holds only the database side the future webhook will call. NO ROUTE CALLS IT YET; it gets its own "In use"
-- line in hard rule 5 together with the webhook, after an independent review.
--
-- * public.sms_inbound_optout(org, phone, body) (definer, granted to service_role only; no direct table access for the
--   caller): the future webhook passes the business the inbound number belongs to, the sender's number and the reply's text.
--   - The text is judged here, never by the caller, and never stored. Owner's answer (209) ב: app.sms_optout_reply =
--     isSmsOptOutReply() (src/features/messaging/sms-optout.ts; both run tests/unit/fixtures/sms-optout-replies.json): the
--     WHOLE reply, after removing spaces, niqqud, punctuation, digits and every other mark and folding Latin capitals, equals
--     one word of the one shared list (src/features/messaging/sms-optout-words.json, mirrored word for word by
--     app.sms_optout_words(); a unit test compares them); a word inside a sentence never counts. Anything else answers
--     {status:'ignored'}.
--   - The number is normalized (app.normalize_phone); none = {status:'invalid'}.
--   - Owner's answer (208) ב: the number ALWAYS joins the business's blocklist (CNS-06 public.consent_blocklist: kind phone,
--     channel sms, reason 'sms_reply' = "בקשת הסרה ב-SMS", a reason only the server writes; HMAC hash only, with
--     consent_hash_key; while the key is missing the number waits in app.consent_blocklist_pending exactly as an owner's add
--     does and app.consent_blocklist_backfill hashes it, so the send check fails closed meanwhile), also when no record holds
--     it. No second active entry: an active entry of the number on channel sms or all is enough (the rule of
--     consent_blocklist_add_noted, under its business lock). The business's blocklist size cap is not applied: an opt-out is
--     never dropped, and SMS-reply entries do not count against the owners' 100,000 active entries (review (5),
--     consent_blocklist_add_noted redefined below). One audit entry 'consent_blocklist_add' (no actor, reason, counts only) when an entry is added.
--   - Every lead and contact of the business whose primary phone is that number (phone_e164; in the recycle bin too) also
--     gets one consent entry through the existing consent path: channel sms, state 'withdrawn', source 'unsubscribe', method
--     'תשובת "הסר" ב-SMS'; app.consent_prepare makes its HMAC hash (waiting in app.consent_pending_address without the key).
--     A record whose own state for that address is already out (or blocked) gets nothing new. While the key is missing
--     there is no hash to match by: the record is "already out" only when its latest sms entry made for this very number
--     (its address waiting in app.consent_pending_address) is an opt-out; otherwise a withdrawn entry is written (F5).
--   - A contact holding the number only as a further phone (CON-01 contact_channels.value_e164) is protected by the
--     blocklist entry, which every sender judges by (app.consent_suppressed, across the business). It gets no consent
--     entry, because a consent entry is about the record's primary address and would opt out that one instead; such
--     contacts are counted in the answer (further_phone_contacts) (F2).
--   - Answers {status:'recorded', records: n, further_phone_contacts: m, blocklisted: true|false} when anything was written (blocklisted = a new
--     blocklist entry), {status:'already'} when nothing was; the business is locked for the call (the blocklist's advisory
--     lock), so two deliveries of the same reply cannot both write.
--   - Rate limit: at most app.sms_optout_per_minute() (600) opt-out replies a business a minute (review (6): counted only
--     after the reply is judged an opt-out), counted in app.sms_optout_counts
--     (one row per business: the minute and the count; no number or hash kept), then {status:'rate_limited'}: the
--     webhook must keep the reply and try again (it must never drop an opt-out).
--   - A business that does not exist answers {status:'unknown_business'}. Never raises on input.
-- * The opt-out line itself (SMS-02's marketingEnvelope) makes a marketing SMS longer: the card refuses one too long after
--   filling, and THE FUTURE SENDER judges the filled, enveloped text through app.message_filled_problem before sending (F7).
-- No row is deleted here. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The blocklist's server-only reason (owner (208) ב); consent_blocklist_add_noted still accepts the person's five only
-- ----------------------------------------------------------------------------
alter table public.consent_blocklist drop constraint if exists consent_blocklist_reason;
alter table public.consent_blocklist add constraint consent_blocklist_reason check (reason in ('person_request', 'complaint', 'legal', 'not_the_person', 'other', 'sms_reply'));

-- Review (5): 021030's consent_blocklist_add_noted with one change: SMS-reply entries are left out of the 100,000 cap
create or replace function public.consent_blocklist_add_noted(p_org uuid, p_channel text, p_addresses text[], p_reason text,
                                                          p_note text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_key boolean;
  v_item text;
  v_kind text;
  v_value text;
  v_hash text;
  v_id uuid;
  v_added integer := 0;
  v_existing integer := 0;
  v_invalid integer[] := '{}';
  i integer;
  -- CNS-06 answer 4: one optional note for the entries of this call
  v_note text := nullif(btrim(p_note), '');
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) or not coalesce(app.org_writable(p_org), false) then
    raise exception 'owners and admins only' using errcode = '42501';
  end if;
  if p_channel is null or p_channel not in ('all', 'email', 'sms', 'whatsapp', 'phone') then
    raise exception 'unknown channel' using errcode = 'P0001', hint = 'consent_blocklist:channel';
  end if;
  if p_reason is null or p_reason not in ('person_request', 'complaint', 'legal', 'not_the_person', 'other') then
    raise exception 'pick a reason' using errcode = 'P0001', hint = 'consent_blocklist:reason';
  end if;
  if char_length(v_note) > 200 then
    raise exception 'the note is too long' using errcode = 'P0001', hint = 'consent_blocklist:note';
  end if;
  if coalesce(cardinality(p_addresses), 0) = 0 then
    raise exception 'no address' using errcode = 'P0001', hint = 'consent_blocklist:empty';
  end if;
  if cardinality(p_addresses) > 500 then
    raise exception 'too many addresses in one call' using errcode = 'P0001', hint = 'consent_blocklist:too_many';
  end if;
  -- one writer per business at a time (the active-entry count and the repeat check)
  perform pg_advisory_xact_lock(hashtextextended('consent_blocklist:' || p_org::text, 0));
  -- SMS-03 review (5): entries an SMS reply added (reason 'sms_reply') are not counted against the owners' 100,000
  if (select count(*) from public.consent_blocklist b
       where b.organization_id = p_org and b.removed_at is null and b.reason <> 'sms_reply')
     + cardinality(p_addresses) > 100000 then
    raise exception 'the blocklist is full' using errcode = 'P0001', hint = 'consent_blocklist:max';
  end if;
  v_key := app.consent_key_present();

  for i in 1 .. cardinality(p_addresses) loop
    v_item := nullif(btrim(p_addresses[i]), '');
    continue when v_item is null;
    if position('@' in v_item) > 0 then
      v_kind := 'email';
      v_value := lower(v_item);
      if v_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_value) > 320 then
        v_value := null;
      end if;
    else
      v_kind := 'phone';
      v_value := app.normalize_phone(v_item);
    end if;
    if v_value is null or (p_channel <> 'all' and app.consent_address_kind(p_channel) <> v_kind) then
      v_invalid := v_invalid || i;
      continue;
    end if;
    v_hash := case when v_key then app.consent_address_hash(p_org, v_kind, v_value, 1::smallint) end;
    if exists (
      select 1 from public.consent_blocklist b
       where b.organization_id = p_org and b.removed_at is null and b.kind = v_kind and b.channel in ('all', p_channel)
         and ((v_hash is not null and b.address_hash = v_hash)
              or (b.address_hash is null and exists (select 1 from app.consent_blocklist_pending p
                                                      where p.entry_id = b.id and p.value = v_value)))) then
      v_existing := v_existing + 1;
      continue;
    end if;
    v_id := gen_random_uuid();
    if v_hash is null then
      -- no key: the address waits (schema app, no API access) until the backfill hashes it
      insert into app.consent_blocklist_pending (entry_id, organization_id, kind, value) values (v_id, p_org, v_kind, v_value);
    end if;
    insert into public.consent_blocklist (id, organization_id, kind, channel, address_hash, reason, added_by, note)
    values (v_id, p_org, v_kind, p_channel, v_hash, p_reason, auth.uid(), v_note);
    v_added := v_added + 1;
  end loop;

  if v_added > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'consent_blocklist_add', 'consent_blocklist', null,
            jsonb_build_object('channel', p_channel, 'reason', p_reason, 'added', v_added, 'existing', v_existing)
            -- whether a note was written, never its text (the audit log is not emptied with the person)
            || case when v_note is not null then jsonb_build_object('with_note', true) else '{}'::jsonb end);
  end if;
  return jsonb_build_object('added', v_added, 'existing', v_existing, 'invalid', to_jsonb(v_invalid));
end;
$$;

revoke all on function public.consent_blocklist_add_noted(uuid, text, text[], text, text) from public, anon;
grant execute on function public.consent_blocklist_add_noted(uuid, text, text[], text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The reply's words: is the whole reply an opt-out?
-- ----------------------------------------------------------------------------
create or replace function app.sms_optout_words() returns text[]
language sql immutable set search_path = '' as $$
  select array['הסר', 'הסרה', 'להסרה', 'הסירו', 'תסירו', 'הסר אותי', 'הסירו אותי', 'תסירו אותי', 'הפסק', 'הפסיקו', 'תפסיקו', 'לא לשלוח', 'אל תשלחו', 'הסר מרשימת התפוצה', 'stop', 'unsubscribe', 'remove']::text[]
$$;
revoke all on function app.sms_optout_words() from public, anon, authenticated;

-- the reply folded: Latin capitals to small letters, then every character that is not a Hebrew letter (א..ת) or a Latin
-- small letter removed (spaces, niqqud, punctuation, quotes, emoji, digits). ASCII rules only, so it never depends on the
-- database's locale (= foldSmsReply()).
create or replace function app.sms_optout_fold(p_body text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(translate(coalesce(p_body, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
                        '[^א-תa-z]', '', 'g')
$$;
revoke all on function app.sms_optout_fold(text) from public, anon, authenticated;

create or replace function app.sms_optout_reply(p_body text) returns boolean
language sql immutable set search_path = '' as $$
  select p_body is not null and char_length(p_body) <= 160 and app.sms_optout_fold(p_body) <> ''
     and app.sms_optout_fold(p_body) in (select app.sms_optout_fold(w) from unnest(app.sms_optout_words()) w)
$$;
revoke all on function app.sms_optout_reply(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The rate limit: one row per business, the current minute and its count
-- ----------------------------------------------------------------------------
create or replace function app.sms_optout_per_minute() returns integer
language sql immutable set search_path = '' as $$ select 600 $$;
revoke all on function app.sms_optout_per_minute() from public, anon, authenticated;

create table if not exists app.sms_optout_counts (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  minute          timestamptz not null,
  n               integer not null check (n >= 0)
);
alter table app.sms_optout_counts enable row level security;
revoke all on app.sms_optout_counts from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The call the future inbound webhook makes
-- ----------------------------------------------------------------------------
create or replace function public.sms_inbound_optout(p_org uuid, p_phone text, p_body text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_phone text;
  v_minute timestamptz := date_trunc('minute', now());
  v_n integer;
  v_hash text;
  v_key boolean;
  v_record record;
  v_state text;
  v_written integer := 0;
  v_listed boolean := false;
  v_id uuid;
  v_extra integer := 0;
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    return jsonb_build_object('status', 'unknown_business');
  end if;
  -- review (6): only an opt-out reply is counted (an ordinary reply never uses the business's minute)
  if not app.sms_optout_reply(p_body) then
    return jsonb_build_object('status', 'ignored');
  end if;
  insert into app.sms_optout_counts as c (organization_id, minute, n) values (p_org, v_minute, 1)
  on conflict (organization_id) do update
    set minute = excluded.minute, n = case when c.minute = excluded.minute then c.n + 1 else 1 end
  returning n into v_n;
  if v_n > app.sms_optout_per_minute() then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  v_phone := app.normalize_phone(p_phone);
  if v_phone is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- the blocklist's own business lock (consent_blocklist_add_noted takes the same): one writer, so two deliveries of the
  -- same reply write once
  perform pg_advisory_xact_lock(hashtextextended('consent_blocklist:' || p_org::text, 0));
  v_key := app.consent_key_present();
  v_hash := case when v_key then app.consent_address_hash(p_org, 'phone', v_phone, 1::smallint) end;

  -- (208) ב: the number joins the blocklist (channel sms), unless an active entry on sms or all already holds it
  if not exists (
    select 1 from public.consent_blocklist b
     where b.organization_id = p_org and b.removed_at is null and b.kind = 'phone' and b.channel in ('all', 'sms')
       and ((v_hash is not null and b.address_hash = v_hash)
            or (b.address_hash is null and exists (select 1 from app.consent_blocklist_pending p
                                                    where p.entry_id = b.id and p.value = v_phone)))) then
    v_id := gen_random_uuid();
    if v_hash is null then
      -- no key: the number waits (schema app, no API access) until the backfill hashes it
      insert into app.consent_blocklist_pending (entry_id, organization_id, kind, value) values (v_id, p_org, 'phone', v_phone);
    end if;
    insert into public.consent_blocklist (id, organization_id, kind, channel, address_hash, reason, added_by)
    values (v_id, p_org, 'phone', 'sms', v_hash, 'sms_reply', null);
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, null, 'consent_blocklist_add', 'consent_blocklist', null,
            jsonb_build_object('channel', 'sms', 'reason', 'sms_reply', 'added', 1, 'existing', 0));
    v_listed := true;
  end if;

  -- and every record whose PRIMARY phone is the number gets the normal withdrawn consent (a consent entry is about the
  -- record's own primary address, app.consent_record_address)
  for v_record in
    select 'lead' as kind, l.id from public.leads l where l.organization_id = p_org and l.phone_e164 = v_phone
    union all
    select 'contact', c.id from public.contacts c where c.organization_id = p_org and c.phone_e164 = v_phone
    order by 1, 2
  loop
    if v_key then
      -- the record's own state for this address
      v_state := app.consent_state_of(p_org, 'sms', v_hash,
                                      case when v_record.kind = 'lead' then v_record.id end,
                                      case when v_record.kind = 'contact' then v_record.id end);
    else
      -- F5: no key = no hash to match by; the record is already out only when its latest sms entry made for THIS number
      -- (its address waiting in app.consent_pending_address) is an opt-out. Never judged by the record's other entries.
      select case when c.state in ('withdrawn', 'denied') then 'out' end into v_state
        from public.consents c
        join app.consent_pending_address pa on pa.consent_id = c.id and pa.organization_id = c.organization_id
       where c.organization_id = p_org and c.channel = 'sms' and c.state in ('granted', 'withdrawn', 'denied')
         and pa.kind = 'phone' and pa.value = v_phone
         and (case when v_record.kind = 'lead' then c.lead_id else c.contact_id end) = v_record.id
         and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)
       order by c.created_at desc, c.seq desc
       limit 1;
    end if;
    if v_state is distinct from 'out' and v_state is distinct from 'blocked' then
      insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method)
      values (p_org,
              case when v_record.kind = 'lead' then v_record.id end,
              case when v_record.kind = 'contact' then v_record.id end,
              'sms', 'withdrawn', 'unsubscribe', 'תשובת "הסר" ב-SMS');
      v_written := v_written + 1;
    end if;
    v_state := null;
  end loop;
  -- F2: contacts holding the number as a further phone (CON-01 contact_channels.value_e164) are protected by the blocklist
  -- entry above, which every sender judges by (app.consent_suppressed, across the business); a consent entry cannot name a
  -- further phone (it would opt out the contact's primary phone instead), so they are counted, not written
  select count(distinct ch.contact_id)::integer into v_extra
    from public.contact_channels ch
   where ch.organization_id = p_org and ch.kind = 'phone' and ch.value_e164 = v_phone
     and not exists (select 1 from public.contacts c
                      where c.organization_id = ch.organization_id and c.id = ch.contact_id and c.phone_e164 = v_phone);
  if v_written = 0 and not v_listed then
    return jsonb_build_object('status', 'already');
  end if;
  return jsonb_build_object('status', 'recorded', 'records', v_written, 'further_phone_contacts', v_extra,
                            'blocklisted', v_listed);
end;
$$;
revoke all on function public.sms_inbound_optout(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sms_inbound_optout(uuid, text, text) to service_role;
