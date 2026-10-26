-- =============================================================================
-- CNS-06: the business's do-not-market list (blocklist of phones and emails)
-- =============================================================================
-- SPEC-ADDITIONS 12 (CNS-06): phones and addresses that never get marketing, even when they are imported again; when
-- a person is erased under the privacy law, the block is kept as a hash only. Privacy: open on every plan (no plan key).
--
-- * public.consent_blocklist: one row per listed address and channel. kind phone | email, channel all | email | sms |
--   whatsapp | phone ('all' = every channel of that kind; an email entry is 'all' or 'email'). The address itself is
--   NEVER stored: address_hash is the register's HMAC (app.consent_address_hash with consent_hash_key, the
--   organization id in the input, the same normalization: phone_e164, lower-cased email), so an entry matches the
--   consents of that address and nothing else, and no client may select it (column grants). While the key is missing
--   the normalized address waits in app.consent_blocklist_pending (schema app, no API access) and the hourly consent
--   backfill (app.consent_backfill_hashes, crm-consent-backfill) hashes it and blanks the value, as for consents.
-- * Who and why: added_by (from the session), created_at and a reason from a closed list (DRAFT wording, mirrored by
--   src/features/consent-blocklist/model.ts). There is no free text on purpose: an entry holds a hash and codes only,
--   so a privacy erasure has nothing to erase in it, and the block outlives the person (the hash is all that is kept).
-- * Owners and admins of a writable business add (public.consent_blocklist_add: one channel, up to 500 pasted
--   addresses a call, 100,000 active entries per business, hint consent_blocklist:max) and remove
--   (public.consent_blocklist_remove: never deleted; removed_at / removed_by / a removal reason from a closed list,
--   then the entry stops counting). Both write the audit log (actions consent_blocklist_add / consent_blocklist_remove,
--   counts, channel and codes; never an address or a hash). Clients have no insert, update or delete grant.
--   public.consent_blocklist_find (an exact address -> its entries and whether a privacy erasure blocked it) and
--   public.consent_blocklist_summary (counts) feed the settings page. Plain addresses are never listed.
-- * The rule is read in one place, app.consent_state_of(): for an address hash with no record filter (how
--   app.consent_suppressed, app.consent_address_locked and consents_prepare's organization-wide lock ask), an active
--   entry answers 'listed' before the register is read, whatever the consents say. So:
--     app.consent_suppressed   -> true (marketing never sends; CNS-07);
--     app.consent_address_locked -> true (a public-form tick, CAP-07, and an import 'granted', CNS-05, never lift it;
--                                 without the key: a pending entry of that address, or any hashed entry of the
--                                 channel, locks: fail closed);
--     consents_prepare         -> a person's 'granted' (even an owner's manual lift) is refused: hint
--                                 consent:blocklisted for owners and admins, the neutral consent:address_blocked for
--                                 others (the list is not theirs to see).
--   A record's own state (a call with a record) is the register only, as before.
-- * The record's card (CNS-03) asks public.consent_record_blocks(org, kind, id): for the record's OWN current address
--   only, per channel, 'listed' (owners and admins) or 'blocked' (everyone else; the same neutral word also covers an
--   opt-out or erasure of that address elsewhere in the business, which consents_prepare already tells them as
--   consent:address_blocked). Whoever may read the record asks; nothing about any other address is answered, so the
--   list cannot be enumerated beyond trying addresses on a record one by one. A sender never judges by a record's
--   state: app.consent_suppressed is the only answer for marketing.
-- * Accepted (LOW-4 of the review): while the key is missing an added address waits in plain text in schema app (no
--   API access) until the backfill hashes it and blanks the value, exactly like the register's pending addresses.
-- * A privacy erasure (audit_erase_request, PRV-03) is unchanged and agrees with the list: its do-not-contact marks
--   stay in the register (source 'erasure', a hash only), the list holds hashes and codes only, and neither is ever
--   removed by an erasure. The settings search shows both for an address.
-- Every statement is safe to run twice.

create table if not exists public.consent_blocklist (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null,
  channel         text not null,
  address_hash    text,
  -- as consents.hash_version: 1 = HMAC-SHA256 with consent_hash_key (null hash while the key is missing)
  hash_version    smallint not null default 1,
  reason          text not null,
  added_by        uuid default auth.uid() references auth.users (id) on delete set null,
  removed_at      timestamptz,
  removed_by      uuid references auth.users (id) on delete set null,
  removed_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint consent_blocklist_kind check (kind in ('phone', 'email')),
  constraint consent_blocklist_channel check (channel in ('all', 'email', 'sms', 'whatsapp', 'phone')),
  constraint consent_blocklist_channel_kind check (
    (kind = 'email' and channel in ('all', 'email')) or (kind = 'phone' and channel in ('all', 'sms', 'whatsapp', 'phone'))),
  constraint consent_blocklist_reason check (reason in ('person_request', 'complaint', 'legal', 'not_the_person', 'other')),
  constraint consent_blocklist_removed_reason check (removed_reason in ('added_by_mistake', 'person_consented', 'other')),
  constraint consent_blocklist_removed_shape check ((removed_at is null) = (removed_reason is null)),
  constraint consent_blocklist_hash_version check (hash_version = 1)
);

comment on table public.consent_blocklist is
  'CNS-06: addresses that never get marketing (hash only, never the address); owners and admins add and remove through functions';

-- one active entry per address and channel
create unique index if not exists consent_blocklist_active_key
  on public.consent_blocklist (organization_id, kind, channel, address_hash)
  where removed_at is null and address_hash is not null;
create index if not exists consent_blocklist_hash_idx on public.consent_blocklist (organization_id, address_hash)
  where removed_at is null;
create index if not exists consent_blocklist_org_idx on public.consent_blocklist (organization_id, created_at);

alter table public.consent_blocklist enable row level security;
revoke all on public.consent_blocklist from anon, authenticated;
-- every column but the hash; no write grant at all (the functions below write)
grant select (id, organization_id, kind, channel, reason, added_by, removed_at, removed_by, removed_reason, created_at, updated_at)
  on public.consent_blocklist to authenticated;

do $$
begin
  -- owners and admins of the business
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'consent_blocklist' and policyname = 'consent_blocklist_select') then
    create policy consent_blocklist_select on public.consent_blocklist for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

create or replace trigger consent_blocklist_touch before update on public.consent_blocklist
  for each row execute function app.touch_row();

-- the facts never change: only the removal is written once, and the hash is filled once by the backfill
create or replace function app.consent_blocklist_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.kind is distinct from old.kind
     or new.channel is distinct from old.channel
     or new.hash_version is distinct from old.hash_version
     or (old.address_hash is not null and new.address_hash is distinct from old.address_hash)
     or new.reason is distinct from old.reason
     or (new.added_by is distinct from old.added_by and new.added_by is not null)
     or new.created_at is distinct from old.created_at
     or (old.removed_at is not null and (new.removed_at is distinct from old.removed_at
                                         or new.removed_reason is distinct from old.removed_reason
                                         or (new.removed_by is distinct from old.removed_by and new.removed_by is not null)))
  then
    raise exception 'a blocklist entry cannot be changed' using errcode = 'P0001', hint = 'consent_blocklist:append_only';
  end if;
  return new;
end;
$$;
revoke all on function app.consent_blocklist_guard() from public, anon, authenticated;

create or replace trigger consent_blocklist_guard before update on public.consent_blocklist
  for each row execute function app.consent_blocklist_guard();

-- ----------------------------------------------------------------------------
-- The address of an entry written without the key (until the backfill)
-- ----------------------------------------------------------------------------
create table if not exists app.consent_blocklist_pending (
  entry_id        uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null,
  value           text,
  created_at      timestamptz not null default now(),
  constraint consent_blocklist_pending_kind check (kind in ('phone', 'email'))
);
create index if not exists consent_blocklist_pending_org_idx on app.consent_blocklist_pending (organization_id);
alter table app.consent_blocklist_pending enable row level security;
revoke all on app.consent_blocklist_pending from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Is this address listed for this channel? (one rule; server only)
-- ----------------------------------------------------------------------------
-- An active entry of the business for the address's kind, for this channel or for every channel, matched by its hash,
-- or (an entry still waiting for its hash) by its stored address: compared with p_value, or hashed now and compared
-- with p_hash when the key is there. p_value is the normalized address (phone_e164, lower-cased email).
create or replace function app.consent_listed(p_org uuid, p_channel text, p_hash text, p_value text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (auth.uid() is null or app.is_member(p_org)) and exists (
    select 1 from public.consent_blocklist b
     where b.organization_id = p_org and b.removed_at is null
       and b.kind = app.consent_address_kind(p_channel)
       and b.channel in ('all', p_channel)
       and (
         (p_hash is not null and b.address_hash = p_hash and b.hash_version = 1)
         or (b.address_hash is null and exists (
               select 1 from app.consent_blocklist_pending p
                where p.entry_id = b.id and p.organization_id = p_org and p.value is not null
                  and (p.value = p_value
                       or (p_hash is not null and app.consent_address_hash(p_org, p.kind, p.value, 1::smallint) = p_hash))))));
$$;
revoke all on function app.consent_listed(uuid, text, text, text) from public, anon;
-- consents_prepare is security invoker (current_user tells a browser write); schema app is not in the API, and a
-- signed-in person gets answers about their own businesses only (the line above)
grant execute on function app.consent_listed(uuid, text, text, text) to authenticated, service_role;

-- an active entry of this channel that only a hash could match (fail closed while the key is missing)
create or replace function app.consent_listed_unchecked(p_org uuid, p_channel text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (auth.uid() is null or app.is_member(p_org)) and exists (
    select 1 from public.consent_blocklist b
     where b.organization_id = p_org and b.removed_at is null and b.address_hash is not null
       and b.kind = app.consent_address_kind(p_channel) and b.channel in ('all', p_channel));
$$;
revoke all on function app.consent_listed_unchecked(uuid, text) from public, anon;
grant execute on function app.consent_listed_unchecked(uuid, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The state of an address: the list first, then the register (0155's body below the new lines)
-- ----------------------------------------------------------------------------
-- Returns 'listed' (CNS-06) for an address hash asked without a record (the organization-wide question) when the
-- address is on the business's blocklist for the channel; otherwise 'in', 'out', 'blocked' or null as before.
create or replace function app.consent_state_of(p_org uuid, p_channel text, p_hash text, p_lead uuid, p_contact uuid)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_entry record;
  v_state text;
  v_block boolean := false;
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
  for v_entry in
    select c.state, c.source, c.lift_method
      from public.consents c
     where c.organization_id = p_org and c.channel = p_channel
       and c.state in ('granted', 'withdrawn', 'denied')
       and case when p_hash is not null then c.address_hash = p_hash and c.hash_version = 1
                                                 -- with a record too: that record's entries for this address only
                                                 and (p_lead is null or c.lead_id = p_lead)
                                                 and (p_contact is null or c.contact_id = p_contact)
                when p_lead is not null then c.lead_id = p_lead
                else c.contact_id = p_contact end
     order by c.created_at, c.seq
  loop
    if v_entry.state in ('withdrawn', 'denied') then
      v_state := 'out';
      if v_entry.source = 'erasure' then
        v_block := true;
      end if;
    elsif v_state is null or v_state = 'in' then
      v_state := 'in';
    elsif v_entry.source = 'form' then
      v_state := 'in';
      v_block := false;
    elsif not v_block and v_entry.lift_method is not null then
      v_state := 'in';
    end if;
  end loop;
  return case when v_state = 'out' and v_block then 'blocked' else v_state end;
end;
$$;
revoke all on function app.consent_state_of(uuid, text, text, uuid, uuid) from public, anon;
grant execute on function app.consent_state_of(uuid, text, text, uuid, uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Has this address opted out of this channel? 0155's body; a listed address is suppressed (CNS-06, CNS-07)
-- ----------------------------------------------------------------------------
create or replace function app.consent_suppressed(p_org uuid, p_channel text, p_value text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_value text;
  v_hash text;
  v_state text;
begin
  if p_channel is null or p_channel not in ('email', 'sms', 'whatsapp', 'phone') then
    return null;
  end if;
  v_kind := app.consent_address_kind(p_channel);
  v_value := case when v_kind = 'email' then nullif(lower(btrim(p_value)), '') else app.normalize_phone(p_value) end;
  if v_value is null then
    return null;
  end if;
  if not app.consent_key_present() then
    raise warning 'consent hash key (app.settings consent_hash_key) is missing: opt-outs cannot be checked, marketing must not send';
    return null;
  end if;
  v_hash := app.consent_address_hash(p_org, v_kind, v_value);
  if v_hash is null then
    return null;
  end if;
  v_state := app.consent_state_of(p_org, p_channel, v_hash, null, null);
  if v_state in ('out', 'blocked', 'listed') then
    return true;
  end if;
  if exists (select 1 from public.consents c
              where c.organization_id = p_org and c.channel = p_channel and c.address_hash is null
                and c.hash_version = 1 and c.state in ('withdrawn', 'denied')) then
    return null;
  end if;
  return false;
end;
$$;
revoke all on function app.consent_suppressed(uuid, text, text) from public, anon, authenticated;
grant execute on function app.consent_suppressed(uuid, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The shared lock of the public form (CAP-07) and the import (CNS-05): 020950's body, and the blocklist
-- ----------------------------------------------------------------------------
create or replace function app.consent_address_locked(p_org uuid, p_lead uuid, p_contact uuid, p_channel text, p_address text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_state text;
begin
  v_hash := app.consent_address_hash(p_org, app.consent_address_kind(p_channel), p_address, 1::smallint);
  if v_hash is not null then
    -- 'listed' (CNS-06) comes first from the organization-wide question
    v_state := app.consent_state_of(p_org, p_channel, v_hash, null, null);
  else
    v_state := app.consent_state_of(p_org, p_channel, null, p_lead, p_contact);
    if v_state is distinct from 'out' and v_state is distinct from 'blocked' and exists (
      select 1 from public.consents c
       where c.organization_id = p_org and c.channel = p_channel and c.state in ('withdrawn', 'denied')
         and c.address_hash is not null and c.hash_version = 1) then
      v_state := 'out';
    end if;
    -- CNS-06 without the key: an entry still waiting for its hash, by its address; any hashed entry of the channel
    -- cannot be compared, so it locks (fail closed)
    if app.consent_listed(p_org, p_channel, null, p_address) or app.consent_listed_unchecked(p_org, p_channel) then
      v_state := 'listed';
    end if;
  end if;
  if v_state in ('out', 'blocked', 'listed') then
    return true;
  end if;
  -- entries still waiting for their hash, by the address they were written for
  return exists (
    select 1 from public.consents c
      join app.consent_pending_address p on p.consent_id = c.id
     where c.organization_id = p_org and c.channel = p_channel and c.state in ('withdrawn', 'denied')
       and c.address_hash is null and p.organization_id = p_org
       and p.kind = app.consent_address_kind(p_channel) and p.value = p_address);
end;
$$;
revoke all on function app.consent_address_locked(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Hashes of blocklist entries written without the key (called by the hourly consent backfill)
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
    select b.id, p.organization_id, p.kind, p.value
      from public.consent_blocklist b
      join app.consent_blocklist_pending p on p.entry_id = b.id
     where b.address_hash is null and p.value is not null
  loop
    -- one entry at a time: a failing row is left waiting for the next run and never stops the others
    begin
      v_hash := app.consent_address_hash(v_row.organization_id, v_row.kind, v_row.value, 1::smallint);
      continue when v_hash is null;
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
-- consents_prepare: 0155's body; a 'listed' address refuses a person's 'granted' (CNS-06)
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
begin
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
      -- CNS-06: a listed address is never opened by a consent, not even an owner's manual lift
      if v_lock = 'listed' then
        raise exception 'the address is on the business''s blocklist' using errcode = 'P0001', hint = 'consent:blocklisted';
      elsif v_lock = 'blocked' then
        raise exception 'the person asked to be erased' using errcode = 'P0001', hint = 'consent:erasure_block';
      elsif v_lock = 'out' and new.lift_method is null then
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
-- The hourly consent backfill: 0155's body, and the blocklist's waiting entries (CNS-06)
-- ----------------------------------------------------------------------------
create or replace function app.consent_backfill_hashes() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_more integer;
begin
  if not app.consent_key_present() then
    return 0;
  end if;
  update public.consents c
     set address_hash = app.consent_address_hash(p.organization_id, p.kind, p.value, 1::smallint)
    from app.consent_pending_address p
   where p.consent_id = c.id and p.value is not null
     and c.address_hash is null and c.hash_version = 1;
  get diagnostics v_count = row_count;
  -- a copy whose source has its hash by now takes it (a copy can be left without a value)
  update public.consents c
     set address_hash = s.address_hash
    from public.consents s
   where s.id = c.copied_from and s.organization_id = c.organization_id
     and c.address_hash is null and c.hash_version = 1
     and s.address_hash is not null and s.hash_version = 1;
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;
  update app.consent_pending_address p
     set value = null
    from public.consents c
   where c.id = p.consent_id and c.address_hash is not null and p.value is not null;
  -- privacy erasures paused while the key was missing (app.complete_pending_erasures)
  perform app.complete_pending_erasures();
  -- CNS-06: blocklist entries written while the key was missing (after the erasures: a bad entry never holds them up)
  v_count := v_count + app.consent_blocklist_backfill();
  return v_count;
end;
$$;
revoke all on function app.consent_backfill_hashes() from public, anon, authenticated;
grant execute on function app.consent_backfill_hashes() to service_role;

-- ----------------------------------------------------------------------------
-- Adding addresses (owners and admins of a writable business)
-- ----------------------------------------------------------------------------
-- p_channel: all | email | sms | whatsapp | phone. p_addresses: up to 500 typed or pasted values; a value with '@' is an
-- email (trimmed, lower-cased), anything else a phone (app.normalize_phone). A value that is not valid, or of the wrong
-- kind for the channel, is skipped and its position (1-based) returned under "invalid"; an empty value is ignored.
-- An address already listed for this channel (or for every channel) is counted under "existing". Returns
-- {added, existing, invalid: [positions]}. One audit entry per call: counts, channel and reason, never an address.
create or replace function public.consent_blocklist_add(p_org uuid, p_channel text, p_addresses text[], p_reason text)
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
  if coalesce(cardinality(p_addresses), 0) = 0 then
    raise exception 'no address' using errcode = 'P0001', hint = 'consent_blocklist:empty';
  end if;
  if cardinality(p_addresses) > 500 then
    raise exception 'too many addresses in one call' using errcode = 'P0001', hint = 'consent_blocklist:too_many';
  end if;
  -- one writer per business at a time (the active-entry count and the repeat check)
  perform pg_advisory_xact_lock(hashtextextended('consent_blocklist:' || p_org::text, 0));
  if (select count(*) from public.consent_blocklist b where b.organization_id = p_org and b.removed_at is null)
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
    insert into public.consent_blocklist (id, organization_id, kind, channel, address_hash, reason, added_by)
    values (v_id, p_org, v_kind, p_channel, v_hash, p_reason, auth.uid());
    v_added := v_added + 1;
  end loop;

  if v_added > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'consent_blocklist_add', 'consent_blocklist', null,
            jsonb_build_object('channel', p_channel, 'reason', p_reason, 'added', v_added, 'existing', v_existing));
  end if;
  return jsonb_build_object('added', v_added, 'existing', v_existing, 'invalid', to_jsonb(v_invalid));
end;
$$;
revoke all on function public.consent_blocklist_add(uuid, text, text[], text) from public, anon;
grant execute on function public.consent_blocklist_add(uuid, text, text[], text) to authenticated;

-- ----------------------------------------------------------------------------
-- Removing an entry: never deleted; marked removed with a reason, audited (owners and admins of a writable business)
-- ----------------------------------------------------------------------------
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
  update public.consent_blocklist b
     set removed_at = now(), removed_by = auth.uid(), removed_reason = p_reason
   where b.organization_id = p_org and b.id = p_id and b.removed_at is null
  returning b.kind, b.channel, b.reason into v_row;
  if not found then
    raise exception 'no such entry' using errcode = 'P0001', hint = 'consent_blocklist:gone';
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'consent_blocklist_remove', 'consent_blocklist', p_id,
          jsonb_build_object('kind', v_row.kind, 'channel', v_row.channel, 'reason', v_row.reason, 'removed_reason', p_reason));
end;
$$;
revoke all on function public.consent_blocklist_remove(uuid, uuid, text) from public, anon;
grant execute on function public.consent_blocklist_remove(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Looking up one exact address (owners and admins): its entries, and whether a privacy erasure blocked it
-- ----------------------------------------------------------------------------
-- {valid: false} for a value that is neither an email nor a phone. Otherwise {valid, kind, checked, entries, erasure}:
-- checked = false while the key is missing and hashed entries exist that cannot be compared (the answer is partial);
-- entries = this address's entries, active first then newest (no address, no hash); erasure = the register holds a
-- do-not-contact mark of a privacy erasure for this address (source 'erasure', any channel of its kind).
create or replace function public.consent_blocklist_find(p_org uuid, p_address text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_item text := nullif(btrim(p_address), '');
  v_kind text;
  v_value text;
  v_hash text;
  v_key boolean;
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) then
    raise exception 'owners and admins only' using errcode = '42501';
  end if;
  if v_item is null then
    return jsonb_build_object('valid', false);
  end if;
  if position('@' in v_item) > 0 then
    v_kind := 'email';
    v_value := lower(v_item);
    if v_value !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      v_value := null;
    end if;
  else
    v_kind := 'phone';
    v_value := app.normalize_phone(v_item);
  end if;
  if v_value is null then
    return jsonb_build_object('valid', false);
  end if;
  v_key := app.consent_key_present();
  v_hash := case when v_key then app.consent_address_hash(p_org, v_kind, v_value, 1::smallint) end;
  return jsonb_build_object(
    'valid', true,
    'kind', v_kind,
    'checked', v_hash is not null or not exists (
      select 1 from public.consent_blocklist b where b.organization_id = p_org and b.kind = v_kind and b.address_hash is not null),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'channel', b.channel, 'reason', b.reason, 'added_by', b.added_by,
                                          'created_at', b.created_at, 'removed_at', b.removed_at, 'removed_by', b.removed_by,
                                          'removed_reason', b.removed_reason)
                       order by b.removed_at is not null, b.created_at desc)
        from public.consent_blocklist b
       where b.organization_id = p_org and b.kind = v_kind
         and ((v_hash is not null and b.address_hash = v_hash)
              or (b.address_hash is null and exists (select 1 from app.consent_blocklist_pending p
                                                      where p.entry_id = b.id and p.value = v_value)))), '[]'::jsonb),
    'erasure', exists (
      select 1 from public.consents c
        left join app.consent_pending_address p on p.consent_id = c.id
       where c.organization_id = p_org and c.source = 'erasure' and app.consent_address_kind(c.channel) = v_kind
         and ((v_hash is not null and c.address_hash = v_hash and c.hash_version = 1)
              or (c.address_hash is null and p.value = v_value))));
end;
$$;
revoke all on function public.consent_blocklist_find(uuid, text) from public, anon;
grant execute on function public.consent_blocklist_find(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Counts for the settings page (owners and admins)
-- ----------------------------------------------------------------------------
create or replace function public.consent_blocklist_summary(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_org is null or not coalesce(app.is_admin(p_org), false) then
    raise exception 'owners and admins only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'key_present', app.consent_key_present(),
    'active', (select count(*) from public.consent_blocklist b where b.organization_id = p_org and b.removed_at is null),
    'by_channel', coalesce((
      select jsonb_object_agg(t.channel, t.n)
        from (select b.channel, count(*) as n from public.consent_blocklist b
               where b.organization_id = p_org and b.removed_at is null group by b.channel) t), '{}'::jsonb),
    'waiting_hash', (select count(*) from public.consent_blocklist b
                      where b.organization_id = p_org and b.removed_at is null and b.address_hash is null),
    'removed', (select count(*) from public.consent_blocklist b where b.organization_id = p_org and b.removed_at is not null));
end;
$$;
revoke all on function public.consent_blocklist_summary(uuid) from public, anon;
grant execute on function public.consent_blocklist_summary(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The record's card: is the record's own address blocked for marketing? (CNS-03 card, CNS-06)
-- ----------------------------------------------------------------------------
-- Whoever may read the lead or contact (app.can_read_record; a deputy's extra reads are not covered and get nothing).
-- One row per channel the record has an address for and that is blocked: block = 'listed' for owners and admins (the
-- address is on the business's blocklist for that channel), 'blocked' for everyone else, and for everyone when the
-- organization-wide register state of the address is an opt-out or an erasure block (app.consent_state_of by hash).
-- Without the key only waiting blocklist entries and the record's own entries can be compared; nothing else is said.
create or replace function public.consent_record_blocks(p_org uuid, p_kind text, p_id uuid)
returns table (channel text, block text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_team uuid;
  v_email text;
  v_phone text;
  v_admin boolean;
  v_channel text;
  v_value text;
  v_hash text;
  v_state text;
  v_listed boolean;
  v_key boolean;
begin
  if auth.uid() is null or p_org is null or p_id is null or not coalesce(app.is_member(p_org), false) then
    return;
  end if;
  if p_kind = 'lead' then
    select l.owner_id, l.team_id, nullif(lower(btrim(l.email)), ''), l.phone_e164 into v_owner, v_team, v_email, v_phone
      from public.leads l where l.organization_id = p_org and l.id = p_id;
  elsif p_kind = 'contact' then
    select c.owner_id, c.team_id, nullif(lower(btrim(c.email)), ''), c.phone_e164 into v_owner, v_team, v_email, v_phone
      from public.contacts c where c.organization_id = p_org and c.id = p_id;
  else
    return;
  end if;
  if not found or not coalesce(app.can_read_record(p_org, v_owner, v_team), false) then
    return;
  end if;
  v_admin := coalesce(app.is_admin(p_org), false);
  v_key := app.consent_key_present();
  foreach v_channel in array array['email', 'sms', 'whatsapp', 'phone'] loop
    v_value := case when v_channel = 'email' then v_email else v_phone end;
    continue when v_value is null;
    v_hash := case when v_key then app.consent_address_hash(p_org, app.consent_address_kind(v_channel), v_value, 1::smallint) end;
    v_listed := app.consent_listed(p_org, v_channel, v_hash, v_value);
    v_state := case when v_hash is not null then app.consent_state_of(p_org, v_channel, v_hash, null, null) end;
    if v_listed then
      channel := v_channel;
      block := case when v_admin then 'listed' else 'blocked' end;
      return next;
    elsif v_state in ('out', 'blocked') then
      channel := v_channel;
      block := 'blocked';
      return next;
    end if;
  end loop;
end;
$$;
revoke all on function public.consent_record_blocks(uuid, text, uuid) from public, anon;
grant execute on function public.consent_record_blocks(uuid, text, uuid) to authenticated;

notify pgrst, 'reload schema';
