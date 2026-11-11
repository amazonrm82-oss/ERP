-- =============================================================================
-- CNS-10: owner's answer (254) ב, 11 November 2026 (replaces the lead's interim choice of 021221, review M1)
-- =============================================================================
-- * A link a person on the staff copied (app.consent_preference_links.created_by set, its ACTIVE token, within the 7 days of
--   app.consent_preference_staff_closed) may also turn on a channel that was never consented ('unknown'): the token's own
--   channel only, while the record's current address is the token's (the existing rule of app.consent_preference_channels),
--   in a writable business, and while nothing blocks the address (app.consent_address_locked false and
--   app.consent_suppressed false: no opt-out, no blocklist entry, no erasure of it across the business). It writes 'granted',
--   source 'preferences_staff_link', method "דף העדפות", the page's wording and version. An 'out' is turned on by it under
--   plain app.consent_preference_relist_ok, as by a message link: never over a manual, SMS-reply or owner blocklist entry,
--   another opt-out (manual, an SMS reply, an import's denial) or a privacy erasure (rule 231). 021221's extra condition
--   (the run of own opt-outs began from an 'in', o_had_in) is dropped everywhere.
-- * The link a message carries (created_by null) is tightened: it only unsubscribes and re-subscribes in the same channel. It
--   no longer turns on an 'unknown' channel; re-subscribing an 'out' under relist_ok stays.
-- * Readers: app.consent_register_walk_full reads a 'preferences_staff_link' grant exactly as a 'preferences' one (021210):
--   it ends an 'out' only while every opt-out since the last 'in' was the person's own, never over an erasure. Its o_had_in
--   output is still computed (OUT columns cannot change without a drop) but no rule reads it any more.
--   app.consent_prepare lets a server write of 'preferences_staff_link' pass an 'out' lock under plain relist_ok; on
--   'unknown' nothing changes (no lock to pass; 'listed' and 'blocked' are refused as always).
--   public.consent_preferences_submit judges the 'unknown' turn-on again under the blocklist's business lock by the rule
--   can_turn_on read, and an 'out' by relist_ok alone.
-- * app.consent_preference_staff_relist_ok (021221) has no caller left; it stays defined, unchanged (no drop statements).
-- * Accepted consequence: a staff link's grant that followed an import's consent no longer depends on that import, so undoing
--   the import (which cancels only the import's own 'granted') leaves the person's later grant through the staff link in
--   force. Under (254) ב that grant stands on its own: the person ticked it on the record's own address.
-- Every function keeps its signature, grants and settings; each body is 021221's with only the lines named here. No row is
-- changed. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The register's walk: 021221's body; a 'preferences_staff_link' grant is read as a 'preferences' one
-- ----------------------------------------------------------------------------
create or replace function app.consent_register_walk_full(p_org uuid, p_channel text, p_hash text, p_lead uuid, p_contact uuid,
                                                          out o_state text, out o_own boolean, out o_had_in boolean)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_entry record;
  v_block boolean := false;
  v_own_entry boolean;
begin
  o_own := false;
  o_had_in := false;
  if p_hash is null and p_lead is null and p_contact is null then
    return;
  end if;
  for v_entry in
    select c.state, c.source, c.method, c.lift_method
      from public.consents c
     where c.organization_id = p_org and c.channel = p_channel
       and c.state in ('granted', 'withdrawn', 'denied')
       -- CNS-05 undo: an import's entry that its undo cancelled counts as never written
       and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)
       and case when p_hash is not null then c.address_hash = p_hash and c.hash_version = 1
                                                 -- with a record too: that record's entries for this address only
                                                 and (p_lead is null or c.lead_id = p_lead)
                                                 and (p_contact is null or c.contact_id = p_contact)
                when p_lead is not null then c.lead_id = p_lead
                else c.contact_id = p_contact end
     order by c.created_at, c.seq
  loop
    if v_entry.state in ('withdrawn', 'denied') then
      v_own_entry := v_entry.source in ('preferences', 'preferences_staff_link') or (v_entry.source = 'unsubscribe' and v_entry.method = 'קישור הסרה');
      -- the tally starts at the first opt-out after an 'in' (or the first entry) and stays true only while every one is own
      o_own := case when o_state = 'out' then o_own and v_own_entry else v_own_entry end;
      -- a new run of opt-outs: did it start from an 'in'?
      if o_state is distinct from 'out' then
        o_had_in := o_state is not distinct from 'in';
      end if;
      o_state := 'out';
      if v_entry.source = 'erasure' then
        v_block := true;
      end if;
    elsif o_state is null or o_state = 'in' then
      o_state := 'in';
    elsif v_entry.source = 'form' then
      o_state := 'in';
      v_block := false;
    elsif not v_block and v_entry.lift_method is not null then
      o_state := 'in';
    -- owner (254) ב: a staff link's grant is read exactly as the page's ('preferences', 021210): it ends a run of opt-outs
    -- only while every one since the last 'in' was the person's own, never over an erasure
    elsif not v_block and v_entry.source in ('preferences', 'preferences_staff_link') and o_own then
      o_state := 'in';
    end if;
  end loop;
  if o_state = 'out' and v_block then
    o_state := 'blocked';
    o_own := false;
    o_had_in := false;
  elsif o_state is distinct from 'out' then
    o_own := false;
    o_had_in := false;
  end if;
end;
$$;
revoke all on function app.consent_register_walk_full(uuid, text, text, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- consents_prepare: 021221's body; a server write of 'preferences_staff_link' passes an 'out' lock under plain relist_ok
-- ----------------------------------------------------------------------------
create or replace function app.consent_prepare() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_found boolean;
  v_address text;
  v_source_version smallint;
  v_source_time timestamptz;
  v_linkless boolean := false;
  v_lock text;
  v_own text;
  v_cancelled record;
  v_own_relist boolean := false;
begin
  -- CNS-05 undo: an entry that cancels an import's entry (written only by app.import_consents_cancel). It is about no
  -- address (version 0, no hash, nothing pending) and states nothing ('unknown'); it belongs to the cancelled entry's
  -- subject, also when that record is gone by now. No lock applies: it lifts and adds nothing.
  if new.cancels is not null then
    if current_user in ('authenticated', 'anon') then
      raise exception 'not permitted' using errcode = '42501';
    end if;
    select c.subject_type, c.subject_id, c.lead_id, c.contact_id, c.channel, c.state, c.source, c.cancels as cancels,
           c.import_job_id, c.copied_from
      into v_cancelled
      from public.consents c
     where c.organization_id = new.organization_id and c.id = new.cancels;
    -- only an import's 'granted' (written by an import job, or the conversion copy of one); never a 'denied' (fail-safe)
    if not found or v_cancelled.source <> 'import' or v_cancelled.state <> 'granted'
       or (v_cancelled.import_job_id is null and v_cancelled.copied_from is null)
       or v_cancelled.cancels is not null or v_cancelled.channel <> new.channel then
      raise exception 'only an import''s consent is cancelled, by undoing the import' using errcode = 'P0001', hint = 'consent:cancel';
    end if;
    new.subject_type := v_cancelled.subject_type;
    new.subject_id := v_cancelled.subject_id;
    new.lead_id := v_cancelled.lead_id;
    new.contact_id := v_cancelled.contact_id;
    new.state := 'unknown';
    new.source := 'import';
    new.address_hash := null;
    new.hash_version := 0;
    new.copied_from := null;
    new.wording := null;
    new.lift_method := null;
    new.lift_note := null;
    new.method := nullif(btrim(new.method), '');
    new.created_at := now();
    return new;
  end if;
  if num_nonnulls(new.lead_id, new.contact_id) = 0 and current_user not in ('authenticated', 'anon')
     and new.source = 'erasure' and new.state = 'withdrawn' then
    -- a paused privacy erasure marks a record that is gone: only a server write, only
    -- "withdrawn" with source 'erasure'. A copy takes its source's subject; otherwise the
    -- writer names the subject and has stored the address first (pending, by this row's id).
    if new.copied_from is not null then
      select c.subject_type, c.subject_id into new.subject_type, new.subject_id
        from public.consents c
       where c.organization_id = new.organization_id and c.id = new.copied_from;
      if not found then
        raise exception 'the copied consent is not in this organization' using errcode = 'P0001', hint = 'consent:copy';
      end if;
    elsif new.subject_type is null or new.subject_id is null then
      raise exception 'a consent belongs to one lead or one contact' using errcode = 'P0001', hint = 'consent:subject';
    else
      v_linkless := true;
    end if;
  elsif num_nonnulls(new.lead_id, new.contact_id) <> 1 then
    raise exception 'a consent belongs to one lead or one contact' using errcode = 'P0001', hint = 'consent:subject';
  else
    new.subject_type := case when new.lead_id is not null then 'lead' else 'contact' end;
    new.subject_id := coalesce(new.lead_id, new.contact_id);
  end if;
  new.wording := nullif(btrim(new.wording), '');
  new.method := nullif(btrim(new.method), '');
  if current_user in ('authenticated', 'anon') then
    new.created_at := now();
    new.recorded_by := auth.uid();
    new.copied_from := null;
    new.hash_version := 1;
    new.address_hash := null;
  end if;

  if new.lead_id is not null then
    select true into v_found from public.leads l where l.organization_id = new.organization_id and l.id = new.lead_id;
  else
    select true into v_found from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id;
  end if;
  v_address := app.consent_record_address(new.organization_id, new.lead_id, new.contact_id, new.channel);
  if new.copied_from is not null then
    select c.hash_version, c.created_at into v_source_version, v_source_time
      from public.consents c
     where c.organization_id = new.organization_id and c.id = new.copied_from;
    if not found then
      raise exception 'the copied consent is not in this organization' using errcode = 'P0001', hint = 'consent:copy';
    end if;
    -- a copy keeps its source's time (never ahead); a paused erasure's mark is new now
    new.created_at := case when new.source = 'erasure' then now() else least(v_source_time, now()) end;
  elsif current_user not in ('authenticated', 'anon') then
    -- a server writer may backdate, never date ahead: a future 'granted' would beat every
    -- later opt-out. A copy keeps its source's time.
    new.created_at := least(coalesce(new.created_at, now()), now());
  end if;
  if v_linkless then
    -- the address stored for this row by the writer (null hash while the key is missing)
    new.hash_version := 1;
    new.address_hash := app.consent_pending_hash(new.id);
  elsif v_source_version = 1 then
    -- a server copy (LEAD-07, merge) takes the hash of the entry it copies, also a null
    -- one (made without the key; its pending address is copied by consents_q_pending)
    select c.address_hash, c.hash_version into new.address_hash, new.hash_version
      from public.consents c
     where c.organization_id = new.organization_id and c.id = new.copied_from;
  elsif v_address is null then
    -- no address for the channel: an entry that matches nobody
    new.address_hash := null;
    new.hash_version := 0;
  else
    -- never a hash supplied by the writer; null while the key is missing (the address
    -- is then kept by the trigger consents_q_pending until the backfill). Also a copy of
    -- an entry made without an address (version 0): hashed from the record's address now.
    new.hash_version := 1;
    new.address_hash := app.consent_address_hash(new.organization_id, app.consent_address_kind(new.channel), v_address, 1::smallint);
  end if;

  -- An opt-out is lifted only by the person's own new consent in a public form, or (not
  -- after an erasure at the person's request) by an owner's or admin's manual lift with
  -- its method and note; checked by address hash across the organization (by the record
  -- itself while the key is missing). Copies are not new consents.
  -- This refusal is a message for the user. The rule itself is applied when the state is
  -- read (app.consent_state_of(), used by app.consent_suppressed()): an entry that slips
  -- past here (written without the key, or by a server path) still lifts nothing.
  -- A browser write is checked only when the caller can read the record (they may see its
  -- consents anyway); otherwise the policy refuses it, so the answer tells nothing about
  -- another organization's people or a record hidden from the caller. A viewer who reads
  -- the record gets the explanation (owner's rule), then the policy would refuse it too.
  new.lift_note := nullif(btrim(new.lift_note), '');
  if current_user not in ('authenticated', 'anon') or coalesce(v_found, false) then
    if new.lift_method is not null then
      if current_user not in ('authenticated', 'anon') or not app.is_admin(new.organization_id) then
        raise exception 'only an owner or admin may lift an opt-out' using errcode = 'P0001', hint = 'consent:lift_admin';
      end if;
      if new.lift_note is null then
        raise exception 'a lift needs its method and a note' using errcode = 'P0001', hint = 'consent:lift_note';
      end if;
    elsif new.lift_note is not null then
      raise exception 'a lift needs its method and a note' using errcode = 'P0001', hint = 'consent:lift_note';
    end if;
    if new.state = 'granted' and new.source <> 'form' and new.copied_from is null then
      v_lock := app.consent_state_of(new.organization_id, new.channel, new.address_hash,
                                     case when new.address_hash is null then new.lead_id end,
                                     case when new.address_hash is null then new.contact_id end);
      -- CNS-06 without the key (no hash, so consent_state_of could not ask the list): a waiting entry of this address,
      -- or any hashed entry of the channel that cannot be compared, locks (fail closed, as app.consent_address_locked)
      if new.address_hash is null and v_address is not null
         and (app.consent_listed(new.organization_id, new.channel, null, v_address)
              or app.consent_listed_unchecked(new.organization_id, new.channel)) then
        v_lock := 'listed';
      end if;
      -- v_lock null means no lock (no entry for this address, or no answer: outside the
      -- organization; a future server path running with a non-member auth.uid() would get no
      -- lock here, and the read-time rule in app.consent_suppressed() still applies).
      -- The record's own state counts only its entries for this same address (by record only
      -- while the key is missing), so an old opt-out under an earlier address proves nothing.
      -- Someone who is not an owner or admin learns only what this record shows: when the lock
      -- comes from another record with the same address (maybe hidden from them, purged or
      -- erased), one neutral answer, so trying a phone tells nothing about other records.
      -- The message comes from the record's OWN state only (its entries for this address):
      -- own 'out' -> optout_locked, own 'blocked' -> erasure_block, otherwise address_blocked,
      -- whatever the organization-wide lock is, so nothing is learned about other records.
      if v_lock in ('out', 'blocked', 'listed') and current_user in ('authenticated', 'anon')
         and not app.is_admin(new.organization_id) then
        v_own := app.consent_state_of(new.organization_id, new.channel, new.address_hash, new.lead_id, new.contact_id);
        if v_own = 'blocked' then
          raise exception 'the person asked to be erased' using errcode = 'P0001', hint = 'consent:erasure_block';
        elsif v_own = 'out' then
          raise exception 'the person opted out' using errcode = 'P0001', hint = 'consent:optout_locked';
        end if;
        raise exception 'this address is blocked' using errcode = 'P0001', hint = 'consent:address_blocked';
      end if;
      -- CNS-10 (owner (231) ב, delta review 2): the preferences page's re-subscribe passes an 'out' lock only as a server write
      -- of source 'preferences' whose address the register's walk proves was opted out only by the person's own unsubscribes
      -- (app.consent_preference_relist_ok); judged in its own IF so a person's write never reaches the server-only check
      if new.source in ('preferences', 'preferences_staff_link') and current_user not in ('authenticated', 'anon') and new.copied_from is null
         and new.lift_method is null and v_lock = 'out' then
        -- owner (254) ב: both sources by the same rule (021221's o_had_in condition on the staff source is gone)
        v_own_relist := coalesce(app.consent_preference_relist_ok(new.organization_id, new.channel, new.address_hash), false);
      end if;
      -- CNS-06: a listed address is never opened by a consent, not even an owner's manual lift
      if v_lock = 'listed' then
        raise exception 'the address is on the business''s blocklist' using errcode = 'P0001', hint = 'consent:blocklisted';
      elsif v_lock = 'blocked' then
        raise exception 'the person asked to be erased' using errcode = 'P0001', hint = 'consent:erasure_block';
      elsif v_lock = 'out' and new.lift_method is null and not v_own_relist then
        raise exception 'the person opted out' using errcode = 'P0001', hint = 'consent:optout_locked';
      elsif v_lock is distinct from 'out' and new.lift_method is not null then
        -- nothing to lift: no audit entry for nothing
        raise exception 'nothing to lift' using errcode = 'P0001', hint = 'consent:lift_nothing';
      end if;
    end if;
  end if;

  if current_user in ('authenticated', 'anon') and coalesce(v_found, false) then
    if new.source = 'manual' and new.method is null then
      raise exception 'say how the consent was given' using errcode = 'P0001', hint = 'consent:method';
    end if;
    if v_address is null then
      raise exception 'the record has no address for this channel' using errcode = 'P0001', hint = 'consent:no_address';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.consent_prepare() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The channels a token reaches: 021221's body; 'unknown' only for a staff link, 'out' by relist_ok for both
-- ----------------------------------------------------------------------------
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
  v_staff_closed boolean;
  v_staff boolean;
begin
  select * into v_link from app.consent_preference_links l where l.id = p_token.link_id;
  v_live := app.consent_preference_record_live(p_token.organization_id, v_link.lead_id, v_link.contact_id);
  -- the full page: the link's active token, of a record that still lives
  v_full := v_link.token_hash = p_token.token_hash and v_live;
  v_writable := coalesce(app.org_writable(p_token.organization_id), false);
  v_key := app.consent_key_present();
  -- owner (250) ב: a link whose active token a person on the staff copied (consent_preference_link_create sets created_by;
  -- the sender's mint clears it) turns its own channel on, under every rule below, for 7 days from that token's creation;
  -- after that it only unsubscribes, like an older link (app.consent_preference_staff_closed). Owner (254) ב: within the 7
  -- days it may also give a first consent on a channel never consented ('unknown'), on the record's current address only;
  -- the link a message carries (created_by null) only unsubscribes and re-subscribes ('out' under relist_ok), never 'unknown'
  v_staff_closed := v_full and app.consent_preference_staff_closed(p_token);
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
    if v_staff_closed then
      can_turn_on := false;
    elsif v_ch = p_token.channel and v_full and v_writable and v_address is not null and state = 'unknown' and v_staff then
      v_locked := app.consent_address_locked(p_token.organization_id, v_link.lead_id, v_link.contact_id, v_ch, v_address);
      v_suppressed := app.consent_suppressed(p_token.organization_id, v_ch, v_address);
      can_turn_on := not coalesce(v_locked, true) and v_suppressed is not distinct from false;
    elsif v_ch = p_token.channel and v_full and v_writable and v_address is not null and state = 'out' then
      -- owner (231) ב, (254) ב: only the person's own unsubscribe of this address is lifted here, by either link (fail closed)
      can_turn_on := coalesce(app.consent_preference_relist_ok(p_token.organization_id, v_ch, v_hash), false);
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

-- ----------------------------------------------------------------------------
-- The page's ONE write: 021221's body; the 'unknown' turn-on judged again under the blocklist lock
-- ----------------------------------------------------------------------------
create or replace function public.consent_preferences_submit(p_token text, p_mode text, p_choices jsonb default null,
                                                             p_ip_hash text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token app.consent_preference_tokens;
  v_link app.consent_preference_links;
  v_item jsonb;
  v_on boolean;
  v_ch text;
  v_row record;
  v_results jsonb := '[]'::jsonb;
  v_result text;
  v_seen text[] := '{}';
  v_removed integer;
  v_source text;
begin
  v_token := app.consent_preference_find(p_token);
  if p_mode is null or p_mode not in ('unsubscribe', 'unsubscribe_all', 'preferences') then
    raise exception 'unknown mode' using errcode = '22023';
  end if;
  if p_mode = 'preferences' and (p_choices is null or jsonb_typeof(p_choices) <> 'array'
                                 or jsonb_array_length(p_choices) not between 1 and 3) then
    raise exception 'bad choices' using errcode = '22023';
  end if;
  -- lock order (review 5, the purge's order): the link read without a lock, then the record FOR KEY SHARE, then the
  -- link's counter row (the limit), then the blocklist's business lock (in withdraw), then the consent insert
  select * into v_link from app.consent_preference_links l where l.id = v_token.link_id;
  perform app.consent_preference_lock_record(v_token.organization_id, v_link.lead_id, v_link.contact_id);
  if not app.consent_preference_count(v_token.link_id, p_ip_hash) then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- owner (250) ב: every consent written through the active token of a link a person on the staff copied carries source
  -- 'preferences_staff_link' (who copied it and when is the link's 'consent_link' audit entry); every other token keeps
  -- its sources
  v_source := case when v_link.token_hash = v_token.token_hash and v_link.created_by is not null then 'preferences_staff_link' end;

  if p_mode = 'unsubscribe' then
    -- the token's own channel and address, whatever the record holds now (an opt-out is always recorded)
    perform app.consent_preference_withdraw(v_token.organization_id, v_token.link_id, v_token.channel, v_token.address_hash,
                                            coalesce(v_source, 'unsubscribe'), 'קישור הסרה');
    return jsonb_build_object('status', 'done');
  end if;

  if p_mode = 'unsubscribe_all' then
    -- the token's own channel on the token's address; for the active token of a live record also every other channel on the
    -- record's current address (app.consent_preference_channels gives the other rows only then). Removal is the safe side.
    for v_row in select * from app.consent_preference_channels(v_token) loop
      perform app.consent_preference_withdraw(v_token.organization_id, v_token.link_id, v_row.channel, v_row.address_hash,
                                              coalesce(v_source, 'preferences'), 'דף העדפות: הסרה מכל הערוצים');
    end loop;
    return jsonb_build_object('status', 'done');
  end if;

  for v_item in select * from jsonb_array_elements(p_choices) loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'on') <> 'boolean'
       or jsonb_typeof(v_item -> 'channel') <> 'string' then
      raise exception 'bad choices' using errcode = '22023';
    end if;
    v_ch := v_item ->> 'channel';
    v_on := (v_item ->> 'on')::boolean;
    if v_ch = any (v_seen) then
      raise exception 'bad choices' using errcode = '22023';
    end if;
    v_seen := v_seen || v_ch;
    -- judged again now: only the token's own channel (review 1)
    select * into v_row from app.consent_preference_channels(v_token) c where c.channel = v_ch and c.own;
    if not found then
      v_result := 'refused';
    elsif not v_on then
      if app.consent_preference_withdraw(v_token.organization_id, v_token.link_id, v_ch, v_row.address_hash,
                                         coalesce(v_source, 'preferences'), 'דף העדפות') then
        v_result := 'saved';
      else
        v_result := 'unchanged';
      end if;
    elsif v_row.state = 'in' then
      v_result := 'unchanged';
    elsif not v_row.can_turn_on then
      -- an opt-out, an erasure block, the blocklist, a replaced link, a record gone or a read-only business: one answer
      v_result := 'refused';
    else
      begin
        if v_row.state = 'out' then
          -- owner (231) ב: the person's own unsubscribe-link entries of this address and channel are marked removed (never
          -- deleted; any other entry made app.consent_preference_relist_ok answer no), under the blocklist's business lock
          perform pg_advisory_xact_lock(hashtextextended('consent_blocklist:' || v_token.organization_id::text, 0));
          if not coalesce(app.consent_preference_relist_ok(v_token.organization_id, v_ch, v_row.address_hash), false) then
            raise exception 'not the person''s own unsubscribe' using errcode = 'P0001', hint = 'consent:address_blocked';
          end if;
          with removed as (
            update public.consent_blocklist b
               set removed_at = now(), removed_reason = 'resubscribed', removed_by = null
             where b.organization_id = v_token.organization_id and b.removed_at is null and b.reason = 'unsubscribe_link'
               and b.channel = v_ch and b.kind = app.consent_address_kind(v_ch) and b.address_hash = v_row.address_hash
            returning b.id)
          select count(*) into v_removed from removed;
          if v_removed > 0 then
            insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
            values (v_token.organization_id, null, 'consent_blocklist_remove', 'consent_blocklist', null,
                    jsonb_build_object('channel', v_ch, 'reason', 'resubscribed', 'removed', v_removed));
          end if;
        else
          -- owner (254) ב: a first consent ('unknown'; app.consent_preference_channels gives it only to a staff link within its
          -- 7 days). Judged again under the blocklist's business lock by the rule can_turn_on read: no opt-out, erasure block or
          -- blocklist entry of the address across the business (app.consent_address_locked), and marketing not suppressed
          -- (app.consent_suppressed false only; null = cannot check = refused). An entry committed meanwhile is seen here
          perform pg_advisory_xact_lock(hashtextextended('consent_blocklist:' || v_token.organization_id::text, 0));
          if v_source is null or v_row.address is null
             or coalesce(app.consent_address_locked(v_token.organization_id, v_link.lead_id, v_link.contact_id, v_ch, v_row.address), true)
             or app.consent_suppressed(v_token.organization_id, v_ch, v_row.address) is distinct from false then
            raise exception 'the address is not free' using errcode = 'P0001', hint = 'consent:address_blocked';
          end if;
        end if;
        insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method, wording, wording_version)
        values (v_token.organization_id, v_link.lead_id, v_link.contact_id, v_ch, 'granted', coalesce(v_source, 'preferences'), 'דף העדפות',
                app.preference_consent_wording(), app.preference_consent_version());
        v_result := 'saved';
      exception when sqlstate 'P0001' then
        -- app.consent_prepare refused it (a lock that appeared meanwhile): the same neutral answer
        v_result := 'refused';
      end;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object('channel', v_ch, 'result', v_result));
  end loop;
  return jsonb_build_object('status', 'saved', 'results', v_results);
end;
$$;
revoke all on function public.consent_preferences_submit(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.consent_preferences_submit(text, text, jsonb, text) to service_role;

notify pgrst, 'reload schema';
