-- =============================================================================
-- CNS-09 + CNS-10: the customer's unsubscribe link and public preferences page (owner's answer (225) א, 10 November 2026)
-- =============================================================================
-- A new use of the service key under CLAUDE.md hard rule 5, in the approved pattern for public secret-link pages (the
-- conditions of the quote page): the server routes call ONE security definer for reading and ONE for writing, both granted
-- to service_role only; no table is reached directly; the secret link is kept as its SHA-256 only; rate limits; one "not
-- found" rule; the page shows only the channels and the current choice (never a name, phone or email; of the business only
-- its display name, logo and colour); every change is an ordinary consent entry.
--
-- * The link (app.consent_preference_links, schema app, RLS on, no grants): ONE per customer (a lead or a contact) and
--   channel (email | sms | whatsapp). It points at its ACTIVE token. Every token ever made is kept in
--   app.consent_preference_tokens (SHA-256 of the token, the channel and the HMAC hash of the address the link was made for,
--   app.consent_address_hash with consent_hash_key; never the address). A new token replaces the active one (staff on
--   request, or the sender for each message):
--   - the ACTIVE token opens the full preferences page (CNS-10): its own channel, on or off, and "remove me from every
--     channel" (review 1: a link sent on one channel never turns ANOTHER channel on, and the page never tells which other
--     channels the business holds an address for);
--   - an earlier token (an older message, a replaced link) still unsubscribes its own channel and address (CNS-09: an
--     unsubscribe link in an old email must keep working), and nothing else: it never shows other channels and never
--     turns a channel on.
--   A purged or merged-away record leaves its link (lead_id / contact_id set null): its tokens still unsubscribe the address
--   they were made for. A token is made only while consent_hash_key is set (no key = no link, and marketing sends nothing
--   without the key anyway: CLAUDE.md "Consent hash key"). app.consent_preference_tokens.address_hash is an HMAC with
--   consent_hash_key too (review 4): replacing that key needs these hashes recomputed as well (CLAUDE.md "Consent hash
--   key"), or old links would unsubscribe an address no sender matches any more.
--   A sent message's token cannot be reused for the next message: only its SHA-256 is kept, so each mint makes a new token
--   row (review 3; accepted, a row of ids and two hashes per message).
-- * The one "not found" rule (app.consent_preference_find): a token of the right shape that is known, of a business that
--   exists and is not deleted. Anything else answers P0002. A suspended, read-only or cancelled business still records an
--   unsubscribe (an opt-out is never refused); turning a channel ON needs a writable business.
-- * Limits, counted after the token lookup and before anything is read (as the quote page, owner (41) ב): 120 calls per link
--   in 10 minutes, then 60 per sender (the server's keyed IP hash, scope 'preferences', re-scoped per link by
--   app.consent_preference_sender; 1,024 reused buckets per link in app.consent_preference_view_counts, no hash kept). Page
--   views, the unsubscribe confirmation and both writes share them. Then {rate_limited: true}. The route also takes the
--   shared not-found limit of the secret-link pages (OPS-02) before calling.
-- * Reading: public.consent_preferences_public(token, ip_hash) answers {business, brand {logo, color}, built_with,
--   channel, full: bool, channels: [{channel, state: in|out|unknown, can_turn_on}]} with ONE row, the token's own channel
--   (review 1). State of the token's address across the business (app.consent_state_of on the hash, organization-wide):
--   listed / blocked / out = 'out'; in = 'in'; nothing = 'unknown'. can_turn_on = active token, writable business, live
--   record whose CURRENT primary address for the channel hashes to the token's address_hash, not locked
--   (app.consent_address_locked) and not suppressed (app.consent_suppressed false).
-- * Writing: public.consent_preferences_submit(token, mode, choices, ip_hash):
--   - mode 'unsubscribe' (the confirmation page and RFC 8058 one-click): the token's channel, off. Always answers
--     {status:'done'} (or rate_limited).
--   - mode 'preferences' (the page's form): choices = [{channel, on: bool}] (at most 3); only the token's own channel is
--     judged, any other channel answers 'refused' (review 1); answers {status:'saved', results: [{channel, result:
--     saved|unchanged|refused}]}.
--   - mode 'unsubscribe_all' (the page's "הסרה מכל הערוצים"): the token's channel off on the token's address, and, for the
--     active token of a live record, every other channel off on the record's current primary address (removal is the safe
--     side). Always {status:'done'}; the answer never says which channels had an address.
--   - Lock order (review 5, the purge's order: the record, then the rows that reference it): the link and its token are read
--     without a lock; then FOR KEY SHARE on the record (lead or contact), then the link's counter row (the limit), then the
--     blocklist's business advisory lock, then the consent insert. The mint takes the record FOR KEY SHARE before the link.
--   - OFF (owner (208) ב, every unsubscribe is recorded, also for an address no record holds any more): the address hash
--     joins the business's blocklist (CNS-06 public.consent_blocklist, kind by the channel, the channel itself, reason
--     'unsubscribe_link' = "בקשת הסרה בקישור", a reason only the server writes; under the blocklist's business lock; no
--     second active entry on the channel or 'all'; one audit entry without an actor, counts only), and the record the token
--     belongs to, while its current primary address for the channel is that address, gets the ordinary withdrawn consent
--     (source 'unsubscribe', method "קישור הסרה" for the one-click page; source 'preferences', method "דף העדפות" for the
--     page), unless its own state for the address is already out or blocked. Entries made by an SMS reply ('sms_reply') or a
--     link ('unsubscribe_link') do not count against the owners' 100,000 active entries (consent_blocklist_add_noted below).
--     Owner (229) א: always, as an SMS reply. Owner (230) ב: such an entry stops MARKETING only (app.consent_listed and
--     app.consent_suppressed count it); app.consent_service_blocked (redefined below) leaves out entries with reason
--     'unsubscribe_link', so service messages keep going (rule 73); an erasure and every other blocklist entry still stop them.
--   - ON: only where can_turn_on holds when written (judged again): a 'granted' consent through the normal path, source
--     'preferences', method "דף העדפות", with the DRAFT wording and its version (app.preference_consent_wording /
--     app.preference_consent_version = 'prefs-draft-1', mirrored by src/features/preferences/model.ts). An opt-out, an
--     erasure block, a manual or SMS-reply blocklist entry, or an opt-out from any other source is never lifted here: such
--     a channel answers 'refused', one neutral answer. Owner (231) ב: the person's OWN unsubscribe is lifted: when
--     app.consent_preference_relist_ok holds (every opt-out of the address since it was last 'in' is source 'preferences' or
--     the link's 'unsubscribe' / "קישור הסרה"; no erasure block; every active blocklist entry of the address is an
--     unsubscribe-link entry of that channel; nothing waiting for its hash), the page marks those entries removed (reason
--     'resubscribed', server only, audited as counts) and writes the 'granted'; app.consent_register_state lets a
--     'preferences' grant lift an 'out' (never 'blocked'), and app.consent_prepare lets that server write pass an 'out' lock.
--     app.consent_state_of keeps its signature and answers; its loop moved into app.consent_register_state.
-- * Retention (owner (233) ב): tokens and their address hashes are deleted 24 months after they were made, by
--   app.purge_old_preference_tokens (its delete lives in the next migration, _consent_preference_tokens_purge.sql, pasted
--   by hand: the connector refuses a "delete" here). pg_cron 'crm-preference-token-purge' (04:35 UTC) calls the wrapper
--   app.run_preference_token_purge(), which does nothing while the pasted function is missing, so this file applies alone.
-- * Staff: public.consent_preference_link_create(org, kind, id, channel) (definer, authenticated): owners and admins of a
--   writable business, a live record of the business that has an address for the channel; a new token replaces the active
--   one; one audit entry 'consent_link' on the record ({channel, link: 'created'}, never the token). Answers the token.
-- * The future sender: public.consent_preference_link_for_job(job, lease) (service_role only) mints the link a message
--   carries in {קישור הסרה} (MSG-02's marketingEnvelope adds that line to every marketing message), only for the holder of
--   the job's LIVE lease of a message.send job, for the job's own customer (payload lead_id | contact_id) and channel, while
--   the record is live and has an address. It replaces the active link (an older message's token keeps unsubscribing).
--   A job of a SERVICE type (app.service_message_types) is refused ('service_type', review 3): the unsubscribe link is
--   for marketing; a job without a type is marketing (CNS-07).
--   Answers {token} or {refused: reason}. NO ROUTE CALLS IT YET: no real provider exists; it gets its own "In use" line in
--   CLAUDE.md hard rule 5 when the sender lands. The queue's md5-pinned functions (test 284) are NOT changed.
-- No row is deleted here. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- Closed lists: the consent source 'preferences', the blocklist's server-only reason 'unsubscribe_link'
-- ----------------------------------------------------------------------------
alter table public.consents drop constraint if exists consents_source;
alter table public.consents add constraint consents_source check (source in ('form', 'manual', 'import', 'api', 'unsubscribe', 'erasure', 'preferences'));

alter table public.consent_blocklist drop constraint if exists consent_blocklist_reason;
alter table public.consent_blocklist add constraint consent_blocklist_reason check (reason in ('person_request', 'complaint', 'legal', 'not_the_person', 'other', 'sms_reply', 'unsubscribe_link'));

-- ----------------------------------------------------------------------------
-- Delta review 1: an unsubscribe link's entry never swallows a stronger one. The blocklist keeps ONE active entry per address
-- and channel (index consent_blocklist_active_key), so a stronger entry on the same channel (an owner's, an SMS reply's)
-- first marks the link's entry removed with the server-only reason 'superseded'; when that stronger entry is removed later
-- and nothing else holds the address on the channel, public.consent_blocklist_remove brings the person's own unsubscribe
-- back as a new link entry (removal is the safe side; an owner's removal never re-opens the person's own unsubscribe).
-- ----------------------------------------------------------------------------
alter table public.consent_blocklist drop constraint if exists consent_blocklist_removed_reason;
alter table public.consent_blocklist add constraint consent_blocklist_removed_reason check (removed_reason in ('added_by_mistake', 'person_consented', 'other', 'resubscribed', 'superseded'));

create or replace function app.consent_blocklist_supersede_link(p_org uuid, p_kind text, p_channel text, p_hash text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_hash is null then
    return;
  end if;
  update public.consent_blocklist b
     set removed_at = now(), removed_reason = 'superseded', removed_by = null
   where b.organization_id = p_org and b.removed_at is null and b.reason = 'unsubscribe_link'
     and b.kind = p_kind and b.channel = p_channel and b.address_hash = p_hash;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    -- counts only (delta review 2, low): which address is never written
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, null, 'consent_blocklist_remove', 'consent_blocklist', null,
            jsonb_build_object('channel', p_channel, 'reason', 'unsubscribe_link', 'removed_reason', 'superseded', 'removed', v_n));
  end if;
end;
$$;
revoke all on function app.consent_blocklist_supersede_link(uuid, text, text, text) from public, anon, authenticated, service_role;

-- 021203's consent_blocklist_add_noted with two changes: link unsubscribes are left out of the 100,000 cap too, and an
-- unsubscribe link's entry never makes the owner's entry "existing" (delta review 1; consent_blocklist_add is its wrapper)
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
  -- SMS-03 review (5), CNS-09: entries an SMS reply or an unsubscribe link added are not counted against the owners' 100,000
  if (select count(*) from public.consent_blocklist b
       where b.organization_id = p_org and b.removed_at is null and b.reason not in ('sms_reply', 'unsubscribe_link'))
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
    -- delta review 1: an unsubscribe link's entry (marketing only, lifted by the person's own re-subscribe) never counts as
    -- "already listed": the owner's stronger entry is stored beside it
    if exists (
      select 1 from public.consent_blocklist b
       where b.organization_id = p_org and b.removed_at is null and b.kind = v_kind and b.channel in ('all', p_channel)
         and b.reason <> 'unsubscribe_link'
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
    -- delta review 1: the stronger entry takes the place of the link's own on the same channel
    perform app.consent_blocklist_supersede_link(p_org, v_kind, p_channel, v_hash);
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

-- 020970's consent_blocklist_remove with one addition (delta review 1): removing a stronger entry brings back the link entry
-- it superseded (the person's own unsubscribe stays), while nothing else holds the address on that channel
create or replace function public.consent_blocklist_remove(p_org uuid, p_id uuid, p_reason text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) or not coalesce(app.org_writable(p_org), false) then
    raise exception 'owners and admins only' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('added_by_mistake', 'person_consented', 'other') then
    raise exception 'pick a reason' using errcode = 'P0001', hint = 'consent_blocklist:removed_reason';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('consent_blocklist:' || p_org::text, 0));
  update public.consent_blocklist b
     set removed_at = now(), removed_by = auth.uid(), removed_reason = p_reason
   where b.organization_id = p_org and b.id = p_id and b.removed_at is null
  returning b.kind, b.channel, b.reason, b.address_hash into v_row;
  if not found then
    raise exception 'no such entry' using errcode = 'P0001', hint = 'consent_blocklist:gone';
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'consent_blocklist_remove', 'consent_blocklist', p_id,
          jsonb_build_object('kind', v_row.kind, 'channel', v_row.channel, 'reason', v_row.reason, 'removed_reason', p_reason));
  if v_row.reason <> 'unsubscribe_link' and v_row.address_hash is not null
     and not exists (select 1 from public.consent_blocklist b
                      where b.organization_id = p_org and b.removed_at is null and b.kind = v_row.kind
                        and b.channel = v_row.channel and b.address_hash = v_row.address_hash)
     and (select l.removed_reason from public.consent_blocklist l
           where l.organization_id = p_org and l.reason = 'unsubscribe_link' and l.kind = v_row.kind
             and l.channel = v_row.channel and l.address_hash = v_row.address_hash
           order by l.created_at desc, l.id desc limit 1) = 'superseded' then
    insert into public.consent_blocklist (organization_id, kind, channel, address_hash, reason, added_by)
    values (p_org, v_row.kind, v_row.channel, v_row.address_hash, 'unsubscribe_link', null);
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, null, 'consent_blocklist_add', 'consent_blocklist', null,
            jsonb_build_object('channel', v_row.channel, 'reason', 'unsubscribe_link', 'added', 1, 'existing', 0));
  end if;
end;
$$;
revoke all on function public.consent_blocklist_remove(uuid, uuid, text) from public, anon;
grant execute on function public.consent_blocklist_remove(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 020970's consent_blocklist_backfill (not redefined since) with one change (delta review 2-2): a waiting entry that is not
-- a link's own supersedes an active link entry of the same address and channel instead of being closed as a repeat
-- ----------------------------------------------------------------------------
create or replace function app.consent_blocklist_backfill() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_row record;
  v_hash text;
begin
  if not app.consent_key_present() then
    return 0;
  end if;
  for v_row in
    select b.id, p.organization_id, p.kind, p.value, b.channel, b.reason
      from public.consent_blocklist b
      join app.consent_blocklist_pending p on p.entry_id = b.id
     where b.address_hash is null and p.value is not null
  loop
    -- one entry at a time: a failing row is left waiting for the next run and never stops the others
    begin
      v_hash := app.consent_address_hash(v_row.organization_id, v_row.kind, v_row.value, 1::smallint);
      continue when v_hash is null;
      -- delta review 2-2: a waiting entry that is not a link's own takes the place of a link entry of the same address and
      -- channel (the stronger entry is kept, the link's is marked 'superseded' and comes back if it is removed)
      if v_row.reason <> 'unsubscribe_link' then
        perform app.consent_blocklist_supersede_link(v_row.organization_id, v_row.kind, v_row.channel, v_hash);
      end if;
      if exists (select 1 from public.consent_blocklist k
                  where k.organization_id = v_row.organization_id and k.removed_at is null and k.address_hash = v_hash
                    and (k.kind, k.channel) = (select b.kind, b.channel from public.consent_blocklist b where b.id = v_row.id)) then
        -- the same address was listed again with the key meanwhile: this waiting entry is a repeat, so it is closed
        update public.consent_blocklist set removed_at = now(), removed_reason = 'other'
         where id = v_row.id and removed_at is null;
      end if;
      update public.consent_blocklist set address_hash = v_hash where id = v_row.id and address_hash is null;
      update app.consent_blocklist_pending set value = null where entry_id = v_row.id;
      v_count := v_count + 1;
    exception when others then
      raise warning 'consent blocklist backfill: entry % left waiting (%)', v_row.id, sqlstate;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function app.consent_blocklist_backfill() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 021203's sms_inbound_optout with one change (delta review 1): an unsubscribe link's entry never makes the SMS reply's
-- entry "already listed"
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

  -- (208) ב: the number joins the blocklist (channel sms), unless an active entry on sms or all already holds it; an
  -- unsubscribe link's entry does not count (delta review 1: the SMS reply's entry also stops service messages, rule 209 ב)
  if not exists (
    select 1 from public.consent_blocklist b
     where b.organization_id = p_org and b.removed_at is null and b.kind = 'phone' and b.channel in ('all', 'sms')
       and b.reason <> 'unsubscribe_link'
       and ((v_hash is not null and b.address_hash = v_hash)
            or (b.address_hash is null and exists (select 1 from app.consent_blocklist_pending p
                                                    where p.entry_id = b.id and p.value = v_phone)))) then
    v_id := gen_random_uuid();
    if v_hash is null then
      -- no key: the number waits (schema app, no API access) until the backfill hashes it
      insert into app.consent_blocklist_pending (entry_id, organization_id, kind, value) values (v_id, p_org, 'phone', v_phone);
    end if;
    -- delta review 1: the reply's entry takes the place of a link's own on sms
    perform app.consent_blocklist_supersede_link(p_org, 'phone', 'sms', v_hash);
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

-- ----------------------------------------------------------------------------
-- The DRAFT wording a "turn on" on the page records (mirrored by PREFERENCES_CONSENT_WORDING / _VERSION)
-- ----------------------------------------------------------------------------
create or replace function app.preference_consent_wording() returns text
language sql immutable set search_path = '' as $$
  select 'בחרתי בדף ההעדפות לקבל מהעסק הודעות שיווקיות בערוץ הזה. אפשר להפסיק בכל עת באותו דף או בקישור ההסרה שבכל הודעה.'::text
$$;
revoke all on function app.preference_consent_wording() from public, anon, authenticated;

create or replace function app.preference_consent_version() returns text
language sql immutable set search_path = '' as $$ select 'prefs-draft-1'::text $$;
revoke all on function app.preference_consent_version() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The links and their tokens (schema app, no grants)
-- ----------------------------------------------------------------------------
create table if not exists app.consent_preference_links (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  lead_id            uuid,
  contact_id         uuid,
  channel            text not null,
  -- the active token's SHA-256 (opens the full page)
  token_hash         text not null,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  window_started_at  timestamptz,
  window_count       integer not null default 0,
  constraint consent_preference_links_channel check (channel in ('email', 'sms', 'whatsapp')),
  -- one record while it lives; none after a purge or a merge (its tokens still unsubscribe)
  constraint consent_preference_links_subject check (num_nonnulls(lead_id, contact_id) <= 1),
  constraint consent_preference_links_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete set null (lead_id),
  constraint consent_preference_links_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete set null (contact_id)
);
create unique index if not exists consent_preference_links_lead_once
  on app.consent_preference_links (organization_id, lead_id, channel) where lead_id is not null;
create unique index if not exists consent_preference_links_contact_once
  on app.consent_preference_links (organization_id, contact_id, channel) where contact_id is not null;
create index if not exists consent_preference_links_org_idx on app.consent_preference_links (organization_id);
alter table app.consent_preference_links enable row level security;
revoke all on app.consent_preference_links from public, anon, authenticated, service_role;

create table if not exists app.consent_preference_tokens (
  token_hash       text primary key,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  link_id          uuid not null references app.consent_preference_links (id) on delete cascade,
  channel          text not null,
  -- HMAC-SHA256 of the address the token was made for (consent_hash_key, hash version 1); never the address
  address_hash     text not null,
  created_at       timestamptz not null default now(),
  constraint consent_preference_tokens_channel check (channel in ('email', 'sms', 'whatsapp')),
  constraint consent_preference_tokens_hash_shape check (token_hash ~ '^[0-9a-f]{64}$')
);
create index if not exists consent_preference_tokens_link_idx on app.consent_preference_tokens (link_id);
create index if not exists consent_preference_tokens_org_idx on app.consent_preference_tokens (organization_id);
alter table app.consent_preference_tokens enable row level security;
revoke all on app.consent_preference_tokens from public, anon, authenticated, service_role;

-- Calls per sender: a fixed set of counters per link (1,024 buckets picked by the scoped keyed IP hash), each counting its
-- 10-minute window and reused by the next one (an update, never a delete). No hash is stored.
create table if not exists app.consent_preference_view_counts (
  link_id       uuid not null references app.consent_preference_links (id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  views         integer not null,
  primary key (link_id, bucket)
);
alter table app.consent_preference_view_counts enable row level security;
revoke all on app.consent_preference_view_counts from public, anon, authenticated, service_role;

-- The sender, scoped to one link: nothing matches across links or businesses
create or replace function app.consent_preference_sender(p_link uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_link is null then null
              else encode(sha256(convert_to('preferences:' || p_link::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.consent_preference_sender(uuid, text) from public, anon, authenticated, service_role;

-- The record is live: a lead or a contact of the business, not in the recycle bin
create or replace function app.consent_preference_record_live(p_org uuid, p_lead uuid, p_contact uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_lead is not null then exists (select 1 from public.leads l
                                          where l.organization_id = p_org and l.id = p_lead and l.deleted_at is null)
    when p_contact is not null then exists (select 1 from public.contacts c
                                             where c.organization_id = p_org and c.id = p_contact and c.deleted_at is null)
    else false end
$$;
revoke all on function app.consent_preference_record_live(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Review 5: the first lock of a write, in the purge's order (the record before the rows that reference it): FOR KEY SHARE
-- on the lead or contact, so a purge running at the same time waits for us (or we wait for it) instead of meeting us in a
-- deadlock over the link row it sets to null. Nothing is locked when the link has no record any more.
create or replace function app.consent_preference_lock_record(p_org uuid, p_lead uuid, p_contact uuid) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_lead is not null then
    perform 1 from public.leads l where l.organization_id = p_org and l.id = p_lead for key share;
  elsif p_contact is not null then
    perform 1 from public.contacts c where c.organization_id = p_org and c.id = p_contact for key share;
  end if;
end;
$$;
revoke all on function app.consent_preference_lock_record(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Making a token (staff and the sender share it). Needs the key and an address; replaces the active token.
-- ----------------------------------------------------------------------------
create or replace function app.consent_preference_mint(p_org uuid, p_lead uuid, p_contact uuid, p_channel text, p_actor uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_address text;
  v_hash text;
  v_token text;
  v_token_hash text;
  v_link uuid;
begin
  if p_channel is null or p_channel not in ('email', 'sms', 'whatsapp') or num_nonnulls(p_lead, p_contact) <> 1 then
    raise exception 'name one record and a channel' using errcode = '22023';
  end if;
  -- lock order (review 5): the record first, then the link row
  perform app.consent_preference_lock_record(p_org, p_lead, p_contact);
  if not app.consent_preference_record_live(p_org, p_lead, p_contact) then
    raise exception 'the record is not live' using errcode = 'P0001', hint = 'consent_link:deleted';
  end if;
  v_address := app.consent_record_address(p_org, p_lead, p_contact, p_channel);
  if v_address is null then
    raise exception 'the record has no address for this channel' using errcode = 'P0001', hint = 'consent_link:no_address';
  end if;
  if not app.consent_key_present() then
    raise exception 'consent hash key is missing' using errcode = 'P0001', hint = 'consent_link:no_key';
  end if;
  v_hash := app.consent_address_hash(p_org, app.consent_address_kind(p_channel), v_address, 1::smallint);
  if v_hash is null then
    raise exception 'consent hash key is missing' using errcode = 'P0001', hint = 'consent_link:no_key';
  end if;

  -- 48 random bytes from three UUIDs, base64url: 64 characters
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  v_token_hash := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');

  -- one link per record and channel: two mints at once make one row
  perform pg_advisory_xact_lock(hashtextextended('consent_preference:' || p_org::text || ':' || coalesce(p_lead, p_contact)::text
                                                 || ':' || p_channel, 0));
  select l.id into v_link from app.consent_preference_links l
   where l.organization_id = p_org and l.channel = p_channel
     and ((p_lead is not null and l.lead_id = p_lead) or (p_contact is not null and l.contact_id = p_contact))
   for update;
  if v_link is null then
    insert into app.consent_preference_links (organization_id, lead_id, contact_id, channel, token_hash, created_by, created_at)
    values (p_org, p_lead, p_contact, p_channel, v_token_hash, p_actor, now())
    returning id into v_link;
  else
    update app.consent_preference_links l
       set token_hash = v_token_hash, created_by = p_actor, created_at = now()
     where l.id = v_link;
  end if;
  insert into app.consent_preference_tokens (token_hash, organization_id, link_id, channel, address_hash, created_at)
  values (v_token_hash, p_org, v_link, p_channel, v_hash, now());
  return v_token;
end;
$$;
revoke all on function app.consent_preference_mint(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Staff: copy a fresh link from the record's consent card (owners and admins)
-- ----------------------------------------------------------------------------
create or replace function public.consent_preference_link_create(p_org uuid, p_kind text, p_id uuid, p_channel text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text;
  v_lead uuid := case when p_kind = 'lead' then p_id end;
  v_contact uuid := case when p_kind = 'contact' then p_id end;
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) then
    raise exception 'owners and admins only' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'contact') or p_id is null then
    raise exception 'name a lead or a contact' using errcode = '22023';
  end if;
  if not coalesce(app.org_writable(p_org), false) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  -- a record of this business only (an outsider learns nothing: the admin check above already refused them)
  if (v_lead is not null and not exists (select 1 from public.leads l where l.organization_id = p_org and l.id = v_lead))
     or (v_contact is not null and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = v_contact)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_token := app.consent_preference_mint(p_org, v_lead, v_contact, p_channel, auth.uid());
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'consent_link', case when v_lead is not null then 'leads' else 'contacts' end, p_id,
          jsonb_build_object('channel', p_channel, 'link', 'created'));
  return v_token;
end;
$$;
revoke all on function public.consent_preference_link_create(uuid, text, uuid, text) from public, anon;
grant execute on function public.consent_preference_link_create(uuid, text, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- The future sender: the link of a message.send job's customer and channel, for the job's live lease only
-- ----------------------------------------------------------------------------
create or replace function public.consent_preference_link_for_job(p_job uuid, p_lease uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job app.jobs;
  v_lead uuid;
  v_contact uuid;
  v_channel text;
  v_token text;
  v_hint text;
begin
  select * into v_job from app.jobs j where j.id = p_job for share;
  if v_job.id is null or v_job.kind <> 'message.send' or v_job.status <> 'running' or p_lease is null
     or v_job.lease_id is distinct from p_lease or v_job.locked_until <= now() then
    return jsonb_build_object('refused', 'stale');
  end if;
  v_channel := v_job.payload ->> 'channel';
  v_lead := case when (v_job.payload ->> 'lead_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_job.payload ->> 'lead_id')::uuid end;
  v_contact := case when (v_job.payload ->> 'contact_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (v_job.payload ->> 'contact_id')::uuid end;
  if v_channel is null or v_channel not in ('email', 'sms', 'whatsapp') or num_nonnulls(v_lead, v_contact) <> 1 then
    return jsonb_build_object('refused', 'no_customer');
  end if;
  -- review 3: the unsubscribe link belongs to marketing; a service type carries none (no type = marketing, CNS-07)
  if (v_job.payload ->> 'message_type') = any (app.service_message_types()) then
    return jsonb_build_object('refused', 'service_type');
  end if;
  if not app.org_public_pages_open(v_job.organization_id) then
    return jsonb_build_object('refused', 'business');
  end if;
  begin
    v_token := app.consent_preference_mint(v_job.organization_id, v_lead, v_contact, v_channel, null);
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_hint = pg_exception_hint;
    return jsonb_build_object('refused', case v_hint when 'consent_link:no_key' then 'no_key'
                                                     when 'consent_link:no_address' then 'no_address'
                                                     else 'record' end);
  end;
  return jsonb_build_object('token', v_token);
end;
$$;
revoke all on function public.consent_preference_link_for_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.consent_preference_link_for_job(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- The one "not found" rule, and the shared limits
-- ----------------------------------------------------------------------------
create or replace function app.consent_preference_find(p_token text) returns app.consent_preference_tokens
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row app.consent_preference_tokens;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'preferences not found' using errcode = 'P0002';
  end if;
  select * into v_row from app.consent_preference_tokens t where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if v_row.token_hash is null or not exists (select 1 from public.organizations o
                                              where o.id = v_row.organization_id and o.deleted_at is null) then
    raise exception 'preferences not found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;
revoke all on function app.consent_preference_find(text) from public, anon, authenticated, service_role;

-- true = within the limits (one call counted)
create or replace function app.consent_preference_count(p_link uuid, p_ip_hash text) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_bucket integer;
  v_views integer;
begin
  -- 120 calls per link in 10 minutes; one row update before anything is read, so the limit holds under parallel load
  update app.consent_preference_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.id = p_link
  returning l.window_count into v_count;
  if v_count is null or v_count > 120 then
    return false;
  end if;
  -- FXS-11: 60 calls per sender in 10 minutes, by the server's keyed IP hash scoped to this link
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.consent_preference_sender(p_link, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.consent_preference_view_counts as vc (link_id, bucket, window_start, views)
    values (p_link, v_bucket, now(), 1)
    on conflict (link_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return false;
    end if;
  end if;
  return true;
end;
$$;
revoke all on function app.consent_preference_count(uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Owner (230) ב: an unsubscribe-link entry of the blocklist stops MARKETING only (consent_listed / consent_suppressed keep
-- counting it); service messages keep going (rule 73). A privacy erasure and every other blocklist entry still stop them.
-- The register (consents) is read by ONE loop, app.consent_register_state; app.consent_state_of puts the list in front.
-- ----------------------------------------------------------------------------
-- 020985's consent_state_of loop, with one addition (owner (231) ב, delta review 2): the walk also keeps the "own
-- unsubscribe" tally: since the address was last 'in', was every opt-out the person's own (source 'preferences', or source
-- 'unsubscribe' with this file's link method "קישור הסרה")? A 'preferences' grant ends an 'out' only while that holds (never an
-- erasure block). Every other source keeps its exact earlier answer. app.consent_preference_relist_ok reads the same walk, so
-- the write check and the read rule never drift.
create or replace function app.consent_register_walk(p_org uuid, p_channel text, p_hash text, p_lead uuid, p_contact uuid,
                                                     out o_state text, out o_own boolean)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_entry record;
  v_block boolean := false;
  v_own_entry boolean;
begin
  o_own := false;
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
      v_own_entry := v_entry.source = 'preferences' or (v_entry.source = 'unsubscribe' and v_entry.method = 'קישור הסרה');
      -- the tally starts at the first opt-out after an 'in' (or the first entry) and stays true only while every one is own
      o_own := case when o_state = 'out' then o_own and v_own_entry else v_own_entry end;
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
    elsif not v_block and v_entry.source = 'preferences' and o_own then
      o_state := 'in';
    end if;
  end loop;
  if o_state = 'out' and v_block then
    o_state := 'blocked';
    o_own := false;
  elsif o_state is distinct from 'out' then
    o_own := false;
  end if;
end;
$$;
revoke all on function app.consent_register_walk(uuid, text, text, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.consent_register_state(p_org uuid, p_channel text, p_hash text, p_lead uuid, p_contact uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select w.o_state from app.consent_register_walk(p_org, p_channel, p_hash, p_lead, p_contact) w
$$;
revoke all on function app.consent_register_state(uuid, text, text, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function app.consent_state_of(p_org uuid, p_channel text, p_hash text, p_lead uuid, p_contact uuid)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
begin
  -- a signed-in person reads states of their own organizations only (server paths have no user)
  if auth.uid() is not null and not app.is_member(p_org) then
    return null;
  end if;
  if p_hash is null and p_lead is null and p_contact is null then
    return null;
  end if;
  -- CNS-06: the business's blocklist wins over every consent, for the organization-wide question
  if p_hash is not null and p_lead is null and p_contact is null and app.consent_listed(p_org, p_channel, p_hash, null) then
    return 'listed';
  end if;
  -- CNS-05 undo: cancelled entries count as never written (in app.consent_register_state)
  return app.consent_register_state(p_org, p_channel, p_hash, p_lead, p_contact);
end;
$$;
revoke all on function app.consent_state_of(uuid, text, text, uuid, uuid) from public, anon;
grant execute on function app.consent_state_of(uuid, text, text, uuid, uuid) to authenticated, service_role;

-- 021153's consent_service_blocked: the blocklist part leaves out entries an unsubscribe link wrote (reason 'unsubscribe_link')
create or replace function app.consent_service_blocked(p_org uuid, p_channel text, p_value text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_value text;
  v_hash text;
begin
  if p_org is null or p_channel is null or p_channel not in ('email', 'sms', 'whatsapp', 'phone') then
    return null;
  end if;
  v_kind := app.consent_address_kind(p_channel);
  v_value := case when v_kind = 'email' then nullif(lower(btrim(p_value)), '') else app.normalize_phone(p_value) end;
  if v_value is null then
    return null;
  end if;
  if not app.consent_key_present() then
    raise warning 'consent hash key (app.settings consent_hash_key) is missing: blocks cannot be checked, nothing is sent';
    return null;
  end if;
  v_hash := app.consent_address_hash(p_org, v_kind, v_value);
  if v_hash is null then
    return null;
  end if;
  -- the blocklist (CNS-06), every entry but an unsubscribe link's (owner (230) ב); an entry still waiting for its hash is
  -- matched by its stored address (the rule of app.consent_listed)
  if exists (
    select 1 from public.consent_blocklist b
     where b.organization_id = p_org and b.removed_at is null and b.reason <> 'unsubscribe_link'
       and b.kind = v_kind and b.channel in ('all', p_channel)
       and ((b.address_hash = v_hash and b.hash_version = 1)
            or (b.address_hash is null and exists (
                  select 1 from app.consent_blocklist_pending p
                   where p.entry_id = b.id and p.organization_id = p_org and p.value = v_value)))) then
    return true;
  end if;
  -- a privacy erasure's do-not-contact
  if app.consent_register_state(p_org, p_channel, v_hash, null, null) = 'blocked' then
    return true;
  end if;
  -- an opt-out still waiting for its hash might be this address's erasure: cannot tell, so cannot send (fail closed, the
  -- rule of app.consent_suppressed)
  if exists (select 1 from public.consents c
              where c.organization_id = p_org and c.channel = p_channel and c.address_hash is null
                and c.hash_version = 1 and c.state in ('withdrawn', 'denied')
                and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)) then
    return null;
  end if;
  return false;
end;
$$;
revoke all on function app.consent_service_blocked(uuid, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- consents_prepare: 020985's body; one change (owner (231) ב): a server write of a 'preferences' grant passes an 'out' lock
-- (never 'listed' or 'blocked': the page removes its own blocklist entry first; an erasure is never lifted here)
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
      if new.source = 'preferences' and current_user not in ('authenticated', 'anon') and new.copied_from is null
         and new.lift_method is null and v_lock = 'out' then
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
-- Owner (231) ב: may the page lift this address's opt-out? Only when every opt-out since the address was last 'in' is its
-- OWN unsubscribe (source 'preferences', or source 'unsubscribe' with this file's link method), no erasure block, and every
-- active blocklist entry of the address on the channel (or 'all') is an unsubscribe-link entry of that very channel. Any
-- entry still waiting for its hash on the channel (opt-out or blocklist) = cannot tell = no (fail closed).
-- ----------------------------------------------------------------------------
create or replace function app.consent_preference_relist_ok(p_org uuid, p_channel text, p_hash text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_kind text := app.consent_address_kind(p_channel);
  v_state text;
  v_own boolean;
begin
  if p_hash is null or not app.consent_key_present() then
    return false;
  end if;
  if exists (select 1 from public.consent_blocklist b
              where b.organization_id = p_org and b.removed_at is null and b.kind = v_kind and b.channel in ('all', p_channel)
                and (b.address_hash is null
                     or (b.address_hash = p_hash and (b.reason <> 'unsubscribe_link' or b.channel <> p_channel)))) then
    return false;
  end if;
  if exists (select 1 from public.consents c
              where c.organization_id = p_org and c.channel = p_channel and c.address_hash is null
                and c.hash_version = 1 and c.state in ('withdrawn', 'denied')
                and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)) then
    return false;
  end if;
  -- the register's one walk (app.consent_register_walk): 'out' only through the person's own unsubscribes, or nothing in the
  -- register but the person's own blocklist entry; an erasure ('blocked') never
  select w.o_state, w.o_own into v_state, v_own from app.consent_register_walk(p_org, p_channel, p_hash, null, null) w;
  return (v_state = 'out' and v_own) or v_state is null;
end;
$$;
revoke all on function app.consent_preference_relist_ok(uuid, text, text) from public, anon, authenticated, service_role;

-- the server-only removal reasons 'resubscribed' (owner (231) ב) and 'superseded' are in the constraint above

-- ----------------------------------------------------------------------------
-- The channels a token reaches, each with the address hash it is judged on. Only the token's own row (own = true) is ever
-- shown or turned on (review 1); the other rows serve only "remove me from every channel" on the active token.
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
begin
  select * into v_link from app.consent_preference_links l where l.id = p_token.link_id;
  v_live := app.consent_preference_record_live(p_token.organization_id, v_link.lead_id, v_link.contact_id);
  -- the full page: the link's active token, of a record that still lives
  v_full := v_link.token_hash = p_token.token_hash and v_live;
  v_writable := coalesce(app.org_writable(p_token.organization_id), false);
  v_key := app.consent_key_present();
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
    if v_ch = p_token.channel and v_full and v_writable and v_address is not null and state = 'unknown' then
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

-- ----------------------------------------------------------------------------
-- An unsubscribe: the blocklist (always), then the record's ordinary withdrawn consent (while it holds that address)
-- ----------------------------------------------------------------------------
create or replace function app.consent_preference_withdraw(p_org uuid, p_link uuid, p_channel text, p_hash text,
                                                           p_source text, p_method text)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.consent_preference_links;
  v_kind text := app.consent_address_kind(p_channel);
  v_current text;
  v_state text;
  v_wrote boolean := false;
  v_same text;
begin
  if p_hash is null or p_source not in ('unsubscribe', 'preferences') then
    return false;
  end if;
  -- the blocklist's own business lock (consent_blocklist_add_noted and sms_inbound_optout take the same)
  perform pg_advisory_xact_lock(hashtextextended('consent_blocklist:' || p_org::text, 0));
  -- delta review 2-1: the person's own unsubscribe is always kept, whatever else holds the address. One active entry per
  -- address and channel (consent_blocklist_active_key): an entry on 'all' leaves the link's own channel free, so the link's
  -- entry goes there; a stronger entry on the same channel gets the link's entry beside it already marked 'superseded', so
  -- public.consent_blocklist_remove brings it back when that entry is removed; a link entry already active = nothing new.
  select b.reason into v_same from public.consent_blocklist b
   where b.organization_id = p_org and b.removed_at is null and b.kind = v_kind and b.channel = p_channel
     and b.address_hash = p_hash
   limit 1;
  if v_same is null then
    insert into public.consent_blocklist (organization_id, kind, channel, address_hash, reason, added_by)
    values (p_org, v_kind, p_channel, p_hash, 'unsubscribe_link', null);
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, null, 'consent_blocklist_add', 'consent_blocklist', null,
            jsonb_build_object('channel', p_channel, 'reason', 'unsubscribe_link', 'added', 1, 'existing', 0));
    v_wrote := true;
  elsif v_same <> 'unsubscribe_link'
        and (select l.removed_reason is distinct from 'superseded' from public.consent_blocklist l
              where l.organization_id = p_org and l.reason = 'unsubscribe_link' and l.kind = v_kind
                and l.channel = p_channel and l.address_hash = p_hash
              order by l.created_at desc, l.id desc limit 1) is distinct from false then
    insert into public.consent_blocklist (organization_id, kind, channel, address_hash, reason, added_by,
                                          removed_at, removed_reason)
    values (p_org, v_kind, p_channel, p_hash, 'unsubscribe_link', null, now(), 'superseded');
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, null, 'consent_blocklist_add', 'consent_blocklist', null,
            jsonb_build_object('channel', p_channel, 'reason', 'unsubscribe_link', 'added', 0, 'existing', 1, 'superseded', 1));
    v_wrote := true;
  end if;

  select * into v_link from app.consent_preference_links l where l.id = p_link and l.organization_id = p_org;
  if num_nonnulls(v_link.lead_id, v_link.contact_id) = 1 then
    -- the record's current primary address for the channel must be this one (a consent entry is about it); recycle bin too
    v_current := app.consent_record_address(p_org, v_link.lead_id, v_link.contact_id, p_channel);
    if v_current is not null
       and app.consent_address_hash(p_org, v_kind, v_current, 1::smallint) is not distinct from p_hash then
      v_state := app.consent_state_of(p_org, p_channel, p_hash, v_link.lead_id, v_link.contact_id);
      if v_state is distinct from 'out' and v_state is distinct from 'blocked' then
        insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method)
        values (p_org, v_link.lead_id, v_link.contact_id, p_channel, 'withdrawn', p_source, p_method);
        v_wrote := true;
      end if;
    end if;
  end if;
  return v_wrote;
end;
$$;
revoke all on function app.consent_preference_withdraw(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The page's ONE read (service_role only)
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
    'channels', v_channels);
end;
$$;
revoke all on function public.consent_preferences_public(text, text) from public, anon, authenticated;
grant execute on function public.consent_preferences_public(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The page's ONE write (service_role only): the one-click unsubscribe, "remove me from every channel", or the page's choice
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

  if p_mode = 'unsubscribe' then
    -- the token's own channel and address, whatever the record holds now (an opt-out is always recorded)
    perform app.consent_preference_withdraw(v_token.organization_id, v_token.link_id, v_token.channel, v_token.address_hash,
                                            'unsubscribe', 'קישור הסרה');
    return jsonb_build_object('status', 'done');
  end if;

  if p_mode = 'unsubscribe_all' then
    -- the token's own channel on the token's address; for the active token of a live record also every other channel on the
    -- record's current address (app.consent_preference_channels gives the other rows only then). Removal is the safe side.
    for v_row in select * from app.consent_preference_channels(v_token) loop
      perform app.consent_preference_withdraw(v_token.organization_id, v_token.link_id, v_row.channel, v_row.address_hash,
                                              'preferences', 'דף העדפות: הסרה מכל הערוצים');
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
                                         'preferences', 'דף העדפות') then
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
          if not app.consent_preference_relist_ok(v_token.organization_id, v_ch, v_row.address_hash) then
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
        end if;
        insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method, wording, wording_version)
        values (v_token.organization_id, v_link.lead_id, v_link.contact_id, v_ch, 'granted', 'preferences', 'דף העדפות',
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

-- ----------------------------------------------------------------------------
-- Retention (owner (233) ב): the nightly wrapper; the purge itself is in _consent_preference_tokens_purge.sql (pasted)
-- ----------------------------------------------------------------------------
create or replace function app.run_preference_token_purge() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer := 0;
begin
  if to_regprocedure('app.purge_old_preference_tokens(integer)') is null then
    return 0;
  end if;
  execute 'select app.purge_old_preference_tokens($1)' into v_n using 5000;
  return coalesce(v_n, 0);
end;
$$;
revoke all on function app.run_preference_token_purge() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-preference-token-purge', '35 4 * * *', 'select app.run_preference_token_purge();');
  end if;
end;
$$;

notify pgrst, 'reload schema';
