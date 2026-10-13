-- =============================================================================
-- Marketing consent per lead and contact, per channel (CNS-01, CNS-02, CNS-03)
-- =============================================================================
-- The consent register has to exist before the system sends one marketing
-- message (SPEC-ADDITIONS 12). This migration holds the register only; the
-- public form box (CNS-04), the import column (CNS-05), the blocklist (CNS-06)
-- and the server-side send check (CNS-07) come later and write or read the same table.
--
-- * public.consents: one row per recorded change. A lead or a contact
--   (lead_id / contact_id, exactly one when written), a channel
--   (email | sms | whatsapp | phone), a state (granted | denied | withdrawn |
--   unknown), the source (form | manual | import | api | unsubscribe), the
--   wording the person agreed to, how it was given (method; required for a
--   manual entry, CNS-03), who recorded it (recorded_by, from the session) and
--   when (created_at, from the server). seq orders rows that share a timestamp.
-- * Append-only (CNS-02). Clients may select and insert, never update or delete
--   (no grants). The current state of a record and channel is its latest row
--   (public.consent_current(), security invoker). A guard trigger also stops
--   server code from rewriting a row: the facts (channel, state, source, time,
--   hash, organization) never change; the free texts and recorded_by may only be
--   emptied (privacy erasure); the record link may move (a merge) or be cleared.
-- * address_hash: HMAC-SHA256 (owner's decision, 13 October 2026) keyed with the
--   secret app.settings 'consent_hash_key' (filled in by the owner per
--   environment; never by a migration or by code) over the organization id, the
--   kind (phone | email) and the record's normalized address at the time
--   (phone_e164 for sms, whatsapp and phone; the lower-cased email for email).
--   Set by trigger, never by a client, and no client may select it (column
--   grants). The same number gives different hashes in two organizations.
--   Without the key the hash is null, which means "cannot check": the consent is
--   still recorded on the record (an opt-out is always accepted), a warning is
--   logged, and a future marketing send must refuse (CNS-07); there is no
--   fallback to a plain hash. Meanwhile the normalized address the entry was
--   written for waits in app.consent_pending_address (plain text, no API access),
--   and pg_cron crm-consent-backfill (hourly, app.consent_backfill_hashes()) hashes
--   that stored address once the key is there and blanks it. Until then
--   app.consent_suppressed() answers null (cannot check) for that channel in that
--   organization. An entry written when the record had no address for the
--   channel gets hash_version 0 and matches nobody.
--   app.consent_key_present() tells platform health whether the key is set.
--   A consent is for an address: when the record's phone or email changes later,
--   consent_current() says the latest row is not for the current address
--   (current_address = false; null = cannot check). The hash is what remains of
--   a person after a privacy erasure (CNS-02); app.consent_suppressed() matches
--   an opt-out by address even after the record is gone (CNS-06, CNS-07).
-- * The history outlives the record: the composite foreign keys are
--   "on delete set null (lead_id)" / "(contact_id)", so a purge leaves the rows
--   with their hash, state and time. subject_type / subject_id keep the id of
--   the record they were written for (no foreign key, set by trigger), so the
--   privacy erasure (public.audit_erase_record) can find them afterwards. Rows
--   whose record is gone are visible to nobody through the API.
-- * Rights follow the record: whoever may read the lead or contact reads its
--   consents; whoever may edit it (in a writable organization, outside the
--   recycle bin) records a new one. From the browser only source 'manual'; the
--   other sources are written by server code (intake, import, unsubscribe).
-- * A browser entry needs an address for the channel (hint consent:no_address)
--   and, being manual, a method (hint consent:method).
-- * Not audited separately (the table is its own history: who, when, what) and
--   not an automation event.
-- Every statement is safe to run twice.

create table if not exists public.consents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  seq             bigint generated always as identity,
  lead_id         uuid,
  contact_id      uuid,
  subject_type    text not null,
  subject_id      uuid not null,
  channel         text not null,
  state           text not null,
  source          text not null,
  wording         text,
  method          text,
  address_hash    text,
  -- how address_hash was made: 1 = HMAC-SHA256 with consent_hash_key (null while the key
  -- is missing, filled by the backfill); 0 = the record had no address for the channel;
  -- a new key or method gets the next number, and comparisons use each row's own version
  hash_version    smallint not null default 1,
  -- a copy made by the lead's conversion (LEAD-07): the id of the lead's entry
  copied_from     uuid,
  -- an owner's or admin's manual lift of an opt-out (owner, 13 October 2026): how the person
  -- asked again (closed list, wording a DRAFT until the lawyer approves) and a short note
  lift_method     text,
  lift_note       text,
  recorded_by     uuid default auth.uid() references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete set null (lead_id),
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete set null (contact_id),
  constraint consents_one_subject check (num_nonnulls(lead_id, contact_id) <= 1),
  constraint consents_subject_type check (subject_type in ('lead', 'contact')),
  constraint consents_channel check (channel in ('email', 'sms', 'whatsapp', 'phone')),
  constraint consents_state check (state in ('granted', 'denied', 'withdrawn', 'unknown')),
  constraint consents_source check (source in ('form', 'manual', 'import', 'api', 'unsubscribe', 'erasure')),
  constraint consents_wording_length check (char_length(wording) <= 2000),
  constraint consents_method_length check (char_length(method) <= 500),
  -- "unknown" is what no entry means; a person never records it
  constraint consents_manual_known check (source <> 'manual' or state <> 'unknown'),
  -- a paused privacy erasure only ever marks "do not contact"
  constraint consents_erasure_withdrawn check (source <> 'erasure' or state = 'withdrawn'),
  constraint consents_lift_method check (lift_method in ('signed_form', 'written_message', 'recorded_call')),
  constraint consents_lift_manual check (lift_method is null or (state = 'granted' and source = 'manual')),
  constraint consents_lift_note check (lift_note is null or (lift_method is not null and char_length(lift_note) <= 500)),
  -- 0 = no address for the channel when it was written (matches nobody), 1 = HMAC-SHA256
  constraint consents_hash_version check (hash_version in (0, 1) and (hash_version = 1 or address_hash is null))
);

create index if not exists consents_lead_idx on public.consents (organization_id, lead_id, channel, seq) where lead_id is not null;
create index if not exists consents_contact_idx on public.consents (organization_id, contact_id, channel, seq) where contact_id is not null;
create index if not exists consents_subject_idx on public.consents (organization_id, subject_type, subject_id);
create index if not exists consents_hash_idx on public.consents (organization_id, address_hash) where address_hash is not null;

alter table public.consents enable row level security;
revoke all on public.consents from anon, authenticated;
-- every column but the hash (and its version): the hash of an address is not shown to anyone
grant select (id, organization_id, seq, lead_id, contact_id, subject_type, subject_id, channel, state, source,
              wording, method, copied_from, lift_method, lift_note, recorded_by, created_at) on public.consents to authenticated;
grant insert (organization_id, lead_id, contact_id, channel, state, source, wording, method, lift_method, lift_note) on public.consents to authenticated;

do $$
begin
  -- whoever may read the lead or contact (the sub-selects run under their policies)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'consents' and policyname = 'consents_select') then
    create policy consents_select on public.consents for select to authenticated
      using (app.is_member(organization_id)
             and ((lead_id is not null and exists (select 1 from public.leads l
                                                    where l.organization_id = consents.organization_id and l.id = consents.lead_id))
                  or (contact_id is not null and exists (select 1 from public.contacts c
                                                          where c.organization_id = consents.organization_id and c.id = consents.contact_id))));
  end if;
  -- whoever may edit the record, in a writable organization, outside the recycle bin; a manual entry only
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'consents' and policyname = 'consents_insert') then
    create policy consents_insert on public.consents for insert to authenticated
      with check (app.can_write(organization_id)
                  and source = 'manual'
                  and ((lead_id is not null and contact_id is null
                        and exists (select 1 from public.leads l
                                     where l.organization_id = consents.organization_id and l.id = consents.lead_id
                                       and l.deleted_at is null
                                       and app.can_edit_record(l.organization_id, l.owner_id, l.team_id)))
                       or (contact_id is not null and lead_id is null
                           and exists (select 1 from public.contacts c
                                        where c.organization_id = consents.organization_id and c.id = consents.contact_id
                                          and c.deleted_at is null
                                          and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)))));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The hash of an address (CNS-02, CNS-06)
-- ----------------------------------------------------------------------------
-- p_kind: 'phone' (an E.164 number) or 'email' (trimmed and lower-cased here).
-- HMAC-SHA256 with the secret app.settings 'consent_hash_key' over
-- '<organization id>:<kind>:<value>', as hex. Null when the key is missing (or the
-- value is empty): callers treat null as "cannot check", never as "no match".
-- Security definer to read the key (app.settings has no grants); the key never
-- leaves this function. A new key or method: a new version here and in
-- consents_hash_version; rows keep the version they were made with.
create extension if not exists pgcrypto with schema extensions;

create or replace function app.consent_address_hash(p_org uuid, p_kind text, p_value text, p_version smallint default 1) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_org is null or nullif(btrim(p_value), '') is null or p_version is distinct from 1 then
    return null;
  end if;
  -- a signed-in person gets hashes of their own organizations only (server paths have no user)
  if auth.uid() is not null and not app.is_member(p_org) then
    return null;
  end if;
  select nullif(s.value, '') into v_key from app.settings s where s.key = 'consent_hash_key';
  if v_key is null then
    -- owner's rule: a clear error is logged (never the key itself)
    raise warning 'consent hash key (app.settings consent_hash_key) is missing: consent hashes cannot be made, marketing must not send';
    return null;
  end if;
  return encode(extensions.hmac(
           convert_to(p_org::text || ':' || p_kind || ':' || case when p_kind = 'email' then lower(btrim(p_value)) else btrim(p_value) end, 'UTF8'),
           convert_to(v_key, 'UTF8'),
           'sha256'), 'hex');
end;
$$;
revoke all on function app.consent_address_hash(uuid, text, text, smallint) from public, anon;
grant execute on function app.consent_address_hash(uuid, text, text, smallint) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Is the hash key there? (platform health, CNS-07 senders; server only)
-- ----------------------------------------------------------------------------
create or replace function app.consent_key_present() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.settings s where s.key = 'consent_hash_key' and s.value <> '');
$$;
revoke all on function app.consent_key_present() from public, anon, authenticated;
grant execute on function app.consent_key_present() to service_role;

-- platform health: opt-outs per channel of an organization whose hash is still missing
-- (they keep app.consent_suppressed() at "cannot check" for that channel)
create or replace function app.consent_unhashed_count(p_org uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(t.channel, t.n), '{}'::jsonb)
    from (select c.channel, count(*) as n
            from public.consents c
           where c.organization_id = p_org and c.address_hash is null and c.hash_version = 1
             and c.state in ('withdrawn', 'denied')
           group by c.channel) t;
$$;
revoke all on function app.consent_unhashed_count(uuid) from public, anon, authenticated;
grant execute on function app.consent_unhashed_count(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Has this address opted out of this channel? (CNS-06, CNS-07; server only)
-- ----------------------------------------------------------------------------
-- p_value is normalized here the way stored hashes are made (app.normalize_phone for
-- sms, whatsapp and phone; trimmed lower case for email). Fails closed:
--   true  = the latest granted / withdrawn / denied entry of the organization for the
--           channel and this address (whatever record, also purged or erased ones) is
--           withdrawn or denied ('unknown', e.g. from an import, lifts nothing);
--   null  = cannot check: no key (a warning is logged), an unknown channel, a value that
--           cannot be normalized, or an opt-out of the channel in the organization whose
--           hash is still missing (version 1, it might be this address; one whose pending
--           address was blanked by a privacy erasure stays so for good: fail closed);
--           a sender must refuse;
--   false = every relevant entry is hashed and none of them is an opt-out of this address.
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
  if v_state in ('out', 'blocked') then
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
-- Fill hashes that are missing because the key was missing (cron, hourly)
-- ----------------------------------------------------------------------------
-- Hashes the address each entry was written for (app.consent_pending_address),
-- never the record's address of today, also for entries whose record is gone; then
-- blanks the stored address. Nothing to do while the key is missing. An entry whose
-- pending address was blanked by an erasure stays null. Returns the count.
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
  return v_count;
end;
$$;
revoke all on function app.consent_backfill_hashes() from public, anon, authenticated;
grant execute on function app.consent_backfill_hashes() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-consent-backfill', '17 * * * *', 'select app.consent_backfill_hashes();');
  end if;
end;
$$;

create or replace function app.consent_address_kind(p_channel text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_channel = 'email' then 'email' else 'phone' end;
$$;
revoke all on function app.consent_address_kind(text) from public, anon;
grant execute on function app.consent_address_kind(text) to authenticated, service_role;

-- the record's current address for a channel, read with the caller's rights
-- (null when the record has none, or the caller may not read it)
create or replace function app.consent_record_address(p_org uuid, p_lead uuid, p_contact uuid, p_channel text) returns text
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_value text;
begin
  if p_lead is not null then
    select case when p_channel = 'email' then lower(btrim(l.email)) else l.phone_e164 end into v_value
      from public.leads l where l.organization_id = p_org and l.id = p_lead;
  elsif p_contact is not null then
    select case when p_channel = 'email' then lower(btrim(c.email)) else c.phone_e164 end into v_value
      from public.contacts c where c.organization_id = p_org and c.id = p_contact;
  end if;
  return nullif(v_value, '');
end;
$$;
revoke all on function app.consent_record_address(uuid, uuid, uuid, text) from public, anon;
grant execute on function app.consent_record_address(uuid, uuid, uuid, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The state of an address on a channel (owner's rules, 13 October 2026)
-- ----------------------------------------------------------------------------
-- Entries of the organization for the channel and the address hash (or, with no
-- hash, those of one record), granted / withdrawn / denied only, oldest first:
--   withdrawn or denied            -> 'out'; from an erasure at the person's request
--                                     (source 'erasure') -> 'blocked';
--   granted with nothing to lift   -> 'in';
--   granted after 'out'/'blocked'  -> lifts only when the person gave it in a public
--                                     form (source 'form'); after 'out' also an owner's
--                                     or admin's manual lift (lift_method); anything
--                                     else (a member's mark, an import, an automation)
--                                     lifts nothing.
-- Returns 'in', 'out', 'blocked', or null when there is no such entry. A word only.
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

-- every manual lift goes to the audit log: who, when, channel, method and note
create or replace function app.consent_audit_lift() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.lift_method is not null then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (new.organization_id, auth.uid(), 'consent_lift',
            case new.subject_type when 'lead' then 'leads' else 'contacts' end, new.subject_id,
            jsonb_build_object('channel', new.channel, 'lift_method', new.lift_method, 'lift_note', new.lift_note));
  end if;
  return null;
end;
$$;
revoke all on function app.consent_audit_lift() from public, anon, authenticated;

create or replace trigger consents_audit_lift after insert on public.consents
  for each row execute function app.consent_audit_lift();

-- ----------------------------------------------------------------------------
-- A new row: subject, hash, time and the browser's rules
-- ----------------------------------------------------------------------------
-- Security invoker on purpose: the record is read with the caller's rights, and
-- current_user tells a browser write from a server one. A record the caller may
-- not read gives no address, and the insert policy then refuses the row.
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
      if v_lock in ('out', 'blocked') and current_user in ('authenticated', 'anon')
         and not app.is_admin(new.organization_id) then
        v_own := app.consent_state_of(new.organization_id, new.channel, new.address_hash, new.lead_id, new.contact_id);
        if v_own = 'blocked' then
          raise exception 'the person asked to be erased' using errcode = 'P0001', hint = 'consent:erasure_block';
        elsif v_own = 'out' then
          raise exception 'the person opted out' using errcode = 'P0001', hint = 'consent:optout_locked';
        end if;
        raise exception 'this address is blocked' using errcode = 'P0001', hint = 'consent:address_blocked';
      end if;
      if v_lock = 'blocked' then
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

create or replace trigger consents_prepare before insert on public.consents
  for each row execute function app.consent_prepare();

-- ----------------------------------------------------------------------------
-- The address of an entry written without the key (until the backfill)
-- ----------------------------------------------------------------------------
-- When consent_hash_key is missing, an entry is written with a null hash. The
-- normalized address it was written for (the record's phone_e164 or lower-cased
-- email at that moment, or for a copy the address of the entry it copies) is kept
-- here, in plain text, only until app.consent_backfill_hashes() hashes it once the
-- key is there; the backfill then blanks the value (no deletes). A privacy erasure
-- blanks it too, and such an entry stays unmatchable, so app.consent_suppressed()
-- fails closed for its channel. Schema app: RLS on, no policies, no grants.
create table if not exists app.consent_pending_address (
  consent_id      uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null,
  value           text,
  created_at      timestamptz not null default now(),
  constraint consent_pending_address_kind check (kind in ('phone', 'email'))
);
alter table app.consent_pending_address enable row level security;
revoke all on app.consent_pending_address from public, anon, authenticated;

-- Before insert, right after consents_prepare (triggers fire in name order), so it sees
-- the row as hashed: an entry with a null version-1 hash keeps its address here. A
-- before trigger may write it: the row's id is set (column default) and a failing
-- insert rolls this write back with it. A copy of a version-1 entry keeps its source's
-- address; any other entry the record's address now (the one consents_prepare used).
create or replace function app.consent_keep_pending() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_value text;
  v_kind text := app.consent_address_kind(new.channel);
begin
  if new.address_hash is not null or new.hash_version <> 1 then
    return new;
  end if;
  if new.copied_from is not null
     and exists (select 1 from public.consents s where s.id = new.copied_from and s.hash_version = 1) then
    select p.value into v_value from app.consent_pending_address p where p.consent_id = new.copied_from;
  else
    v_value := app.consent_record_address(new.organization_id, new.lead_id, new.contact_id, new.channel);
  end if;
  insert into app.consent_pending_address (consent_id, organization_id, kind, value)
  values (new.id, new.organization_id, v_kind, v_value)
  on conflict (consent_id) do nothing;
  return new;
end;
$$;
revoke all on function app.consent_keep_pending() from public, anon, authenticated;

create or replace trigger consents_q_pending before insert on public.consents
  for each row execute function app.consent_keep_pending();

-- the hash of an entry's pending address (null when there is none or no key); for the guard
create or replace function app.consent_pending_hash(p_consent uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select app.consent_address_hash(p.organization_id, p.kind, p.value, 1::smallint)
    from app.consent_pending_address p
   where p.consent_id = p_consent and p.value is not null;
$$;
revoke all on function app.consent_pending_hash(uuid) from public, anon, authenticated;
grant execute on function app.consent_pending_hash(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- No edits (CNS-02)
-- ----------------------------------------------------------------------------
-- Clients have no update grant at all. This stops server code too: the facts
-- never change; the free texts and recorded_by may only be emptied (privacy
-- erasure); the record link may move to another record (a merge) or be cleared
-- (the record is purged; the foreign key's "set null"), and subject_id follows a move.
create or replace function app.consent_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_fill boolean := false;
begin
  -- the one repair allowed: a hash missing because the key was missing is filled in by
  -- the server with the hash of the address the entry was written for (kept in
  -- the pending address table), also when the record is gone by now
  if old.address_hash is null and new.address_hash is not null and old.hash_version = 1
     and current_user not in ('authenticated', 'anon')
     and new.lead_id is not distinct from old.lead_id
     and new.contact_id is not distinct from old.contact_id then
    v_fill := new.address_hash is not distinct from app.consent_pending_hash(old.id)
      -- a copy may take its source's hash once the source has one
      or (old.copied_from is not null and new.address_hash is not distinct from (
            select s.address_hash from public.consents s
             where s.id = old.copied_from and s.organization_id = old.organization_id and s.hash_version = 1));
  end if;
  if new.organization_id is distinct from old.organization_id
     or new.seq is distinct from old.seq
     or new.channel is distinct from old.channel
     or new.state is distinct from old.state
     or new.source is distinct from old.source
     or (new.address_hash is distinct from old.address_hash and not coalesce(v_fill, false))
     or new.hash_version is distinct from old.hash_version
     or new.copied_from is distinct from old.copied_from
     or new.created_at is distinct from old.created_at
     or new.subject_type is distinct from old.subject_type
     or (new.wording is distinct from old.wording and new.wording is not null)
     or (new.method is distinct from old.method and new.method is not null)
     or new.lift_method is distinct from old.lift_method
     or (new.lift_note is distinct from old.lift_note and new.lift_note is not null)
     or (new.recorded_by is distinct from old.recorded_by and new.recorded_by is not null)
     or (old.lead_id is null and new.lead_id is not null)
     or (old.contact_id is null and new.contact_id is not null)
  then
    raise exception 'consent history cannot be changed' using errcode = 'P0001', hint = 'consent:append_only';
  end if;
  if coalesce(new.lead_id, new.contact_id) is not null then
    new.subject_id := coalesce(new.lead_id, new.contact_id);
  elsif new.subject_id is distinct from old.subject_id then
    raise exception 'consent history cannot be changed' using errcode = 'P0001', hint = 'consent:append_only';
  end if;
  return new;
end;
$$;
revoke all on function app.consent_guard() from public, anon, authenticated;

create or replace trigger consents_guard before update on public.consents
  for each row execute function app.consent_guard();

-- ----------------------------------------------------------------------------
-- Is an entry for the record's address of today? (a boolean; the hash never leaves)
-- ----------------------------------------------------------------------------
-- Security definer because clients may not read address_hash. Null for an entry
-- whose record is gone or that the caller may not read.
create or replace function app.consent_is_current(p_id uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_lead uuid;
  v_contact uuid;
  v_channel text;
  v_hash text;
  v_version smallint;
  v_owner uuid;
  v_team uuid;
  v_address text;
begin
  select c.organization_id, c.lead_id, c.contact_id, c.channel, c.address_hash, c.hash_version
    into v_org, v_lead, v_contact, v_channel, v_hash, v_version
    from public.consents c where c.id = p_id;
  if not found then
    return null;
  end if;
  if v_lead is not null then
    select l.owner_id, l.team_id, case when v_channel = 'email' then lower(btrim(l.email)) else l.phone_e164 end
      into v_owner, v_team, v_address
      from public.leads l where l.organization_id = v_org and l.id = v_lead;
  elsif v_contact is not null then
    select c.owner_id, c.team_id, case when v_channel = 'email' then lower(btrim(c.email)) else c.phone_e164 end
      into v_owner, v_team, v_address
      from public.contacts c where c.organization_id = v_org and c.id = v_contact;
  else
    return null;
  end if;
  if not found or not coalesce(app.can_read_record(v_org, v_owner, v_team), false) then
    return null;
  end if;
  -- null = cannot check (no key when the entry or this check was made)
  -- an entry made without an address is for no address of today
  if v_version = 0 then
    return false;
  end if;
  if v_hash is null or not app.consent_key_present() then
    return null;
  end if;
  return v_hash is not distinct from app.consent_address_hash(v_org, app.consent_address_kind(v_channel), nullif(v_address, ''), v_version);
end;
$$;
revoke all on function app.consent_is_current(uuid) from public, anon;
grant execute on function app.consent_is_current(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The current state of a record, per channel (CNS-01, CNS-03)
-- ----------------------------------------------------------------------------
-- Security invoker: RLS decides, so a record the caller may not read gives no
-- rows. One row per channel that has any entry (a channel without one is
-- "unknown"). current_address: the latest entry was written for the record's
-- address of today (false when the phone or email changed since, or is gone;
-- null when it cannot be checked: no hash key). The
-- latest is by the time the consent was given (a copy keeps its time, LEAD-07), then seq.
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
   order by c.channel, c.created_at desc, c.seq desc;
$$;
revoke all on function public.consent_current(uuid, text, uuid) from public, anon;
grant execute on function public.consent_current(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- An opt-out written when the record had no address covers the address it gets
-- ----------------------------------------------------------------------------
-- When a lead's or contact's email or phone changes and the record's latest entry
-- (granted / withdrawn / denied) for an affected channel is a version-0 withdrawn or
-- denied, the server adds a copy for the new address: same state, source, texts and
-- time, copied_from = that entry, hashed from the record's address now (or kept
-- pending while the key is missing). It only ever adds suppression: a version-0
-- 'granted' adds nothing.
create or replace function app.consent_follow_address() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text := tg_argv[0];
  v_channels text[] := '{}';
  v_channel text;
  v_entry record;
begin
  if new.email is distinct from old.email and nullif(btrim(new.email), '') is not null then
    v_channels := v_channels || 'email'::text;
  end if;
  if new.phone_e164 is distinct from old.phone_e164 and new.phone_e164 is not null then
    v_channels := v_channels || array['sms', 'whatsapp', 'phone'];
  end if;
  foreach v_channel in array v_channels loop
    select c.* into v_entry
      from public.consents c
     where c.organization_id = new.organization_id and c.channel = v_channel
       and ((v_kind = 'lead' and c.lead_id = new.id) or (v_kind = 'contact' and c.contact_id = new.id))
       and c.state in ('granted', 'withdrawn', 'denied')
     order by c.created_at desc, c.seq desc
     limit 1;
    if found and v_entry.hash_version = 0 and v_entry.state in ('withdrawn', 'denied') then
      insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, wording, method,
                                   copied_from, recorded_by, created_at)
      values (new.organization_id,
              case when v_kind = 'lead' then new.id end, case when v_kind = 'contact' then new.id end,
              v_channel, v_entry.state, v_entry.source, v_entry.wording, v_entry.method,
              v_entry.id, v_entry.recorded_by, v_entry.created_at);
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function app.consent_follow_address() from public, anon, authenticated;

create or replace trigger leads_consent_follow_address after update of email, phone, phone_e164 on public.leads
  for each row execute function app.consent_follow_address('lead');
create or replace trigger contacts_consent_follow_address after update of email, phone, phone_e164 on public.contacts
  for each row execute function app.consent_follow_address('contact');
