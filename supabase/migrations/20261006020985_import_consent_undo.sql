-- =============================================================================
-- CNS-05 follow-up: undoing an import cancels the consents it recorded
-- =============================================================================
-- Owner, 26 October 2026 (DECISIONS.md, "הסכמה לדיוור בייבוא: פרטים", answer 1 (ג)): undoing an import writes a
-- cancelling entry for every consent the import recorded. The register stays append-only (CNS-02): nothing is deleted
-- or rewritten; the import's entries stay as history and a new entry says they no longer count.
--
-- * public.consents.import_job_id: the import that wrote an entry (server only; set by public.import_record_consents,
--   composite FK to import_jobs, "set null" when a job is gone; select grant only). Entries written before this
--   migration have none, so undoing their import does not cancel them (CNS-05, 020950, shipped the same day; check the
--   register for source 'import' entries without a job before relying on it).
-- * public.consents.cancels: on a cancelling entry, the id of the import entry it ends (composite FK to consents, one
--   cancelling entry per entry: unique index). Shape (constraint consents_cancel_shape): state 'unknown', source
--   'import', no address (hash_version 0, no hash, nothing pending), so it states nothing about any address. Written
--   only by the server (no insert grant; consents_prepare refuses it from a browser and checks the cancelled entry is an
--   import's 'granted' entry (or its conversion copy) of the same channel, hint consent:cancel). It takes the cancelled entry's record
--   and subject, also when the record is gone. method = "ביטול ייבוא"; recorded_by = the person who undid it.
-- * Why not a 'withdrawn' (or any opt-out): that would invent an opt-out the person never gave and lock the address
--   (only a public form or an owner's manual lift opens it). Why not a plain later 'unknown': the state of an address is
--   read by folding its entries in time order, so a later entry cannot restore what the state was before the import (a
--   form 'granted' before an import 'denied' must count again). So every reader of states skips a cancelled entry
--   altogether, as if it had never been written; entries before and after it count as before:
--     app.consent_state_of (the one rule of an address: app.consent_suppressed, app.consent_address_locked,
--     consents_prepare's locks, public.consent_record_blocks), the "cannot check" test of app.consent_suppressed, the
--     waiting-hash checks of app.consent_address_locked, public.consent_current (the card) and app.convert_consents
--     (LEAD-07: a cancelled entry and its cancelling entry are not carried to the contact), and
--     app.consent_follow_address (the latest entry of a record skips a cancelled one).
--   Bodies are those of 020970 / 020975 / 020950 with those lines added. The blocklist (CNS-06), erasure blocks and
--   opt-outs from any other source are untouched: an earlier opt-out still stands after the undo.
-- * Which entries: every 'granted' with this import_job_id (also on an update-mode job's record that the job did not
--   create), and the conversion copies of them (source 'import', copied_from = such an entry) on the contact a converted
--   imported lead became. FAIL-SAFE until the owner answers (independent review, 26 October 2026): an import's 'denied'
--   is NOT cancelled. Cancelling it could lift an opt-out (an update-mode job's or a skipped duplicate's 'denied' sits on
--   a record outside the import, and an earlier form 'granted' would count again), so an undo only ever removes
--   permission, never adds it. A copy of a copy (a merged lead's copy converted later) is not followed.
-- * Races: public.import_record_consents takes its job FOR SHARE, so the job cannot be finished (and then undone) while
--   a chunk is still writing; app.import_consents_cancel takes the leads and contacts holding the job's 'granted' entries
--   FOR SHARE (by id) before it reads the entries, so a conversion or merge of such a record either commits first (its
--   copy is then seen and cancelled) or waits for the undo (and then carries nothing cancelled). The job is locked first;
--   the records follow by id, but the undo's own update of its created records locks in scan order and merge_records
--   takes no job lock, so a rare cycle with a concurrent merge or a second update-mode undo ends in 40P01 (all or nothing).
-- * app.import_consents_cancel(org, job): definer, called by public.undo_import and public.undo_own_import right after
--   they mark the job undone (bodies of 020845 / 020010 plus that call; their rules, counts and hints unchanged; the
--   answer adds "consents": how many entries were cancelled, only when there were any, so its shape is otherwise unchanged). It acts only on the caller's own job of this business that
--   is undone, writes each entry once (a repeated call writes nothing) and logs one audit entry
--   (action import_consent_undo, entity import_jobs, the count of 'granted' entries only).
-- * app.import_record_worked (020845's body): the import's own consents no longer make an imported record "worked on",
--   so undo_own_import takes it to the bin like any untouched record (before this, every record that got a consent from
--   its own import was kept).
-- Every statement is safe to run twice.

alter table public.consents add column if not exists import_job_id uuid;
alter table public.consents add column if not exists cancels uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'consents_import_job_fk' and conrelid = 'public.consents'::regclass) then
    alter table public.consents add constraint consents_import_job_fk foreign key (organization_id, import_job_id)
      references public.import_jobs (organization_id, id) on delete set null (import_job_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'consents_cancels_fk' and conrelid = 'public.consents'::regclass) then
    alter table public.consents add constraint consents_cancels_fk foreign key (organization_id, cancels)
      references public.consents (organization_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'consents_import_job_source' and conrelid = 'public.consents'::regclass) then
    alter table public.consents add constraint consents_import_job_source check (import_job_id is null or source = 'import');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'consents_cancel_shape' and conrelid = 'public.consents'::regclass) then
    alter table public.consents add constraint consents_cancel_shape
      check (cancels is null or (state = 'unknown' and source = 'import' and hash_version = 0 and address_hash is null));
  end if;
end;
$$;

create index if not exists consents_import_job_idx on public.consents (organization_id, import_job_id) where import_job_id is not null;
create unique index if not exists consents_cancels_key on public.consents (organization_id, cancels) where cancels is not null;

comment on column public.consents.import_job_id is
  'CNS-05: the import that wrote this entry (server only), so undoing the import can cancel it';
comment on column public.consents.cancels is
  'CNS-05 undo: on a cancelling entry (state unknown, source import), the import entry it ends; both then count as never written';

-- readable like the rest of the entry (never written by a client: no insert grant)
grant select (import_job_id, cancels) on public.consents to authenticated;

-- ----------------------------------------------------------------------------
-- Cancel every consent an undone import recorded
-- ----------------------------------------------------------------------------
-- The caller's own job of this business, already marked undone by the undo in the same transaction. Returns the
-- number of entries cancelled now (0 when there is nothing left to cancel). Granted to authenticated because
-- public.undo_import is security invoker; schema app is not in the API.
create or replace function app.import_consents_cancel(p_org uuid, p_job uuid) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_entry record;
  v_granted integer := 0;
begin
  if auth.uid() is null or p_org is null or p_job is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  perform 1 from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'undone';
  if not found then
    raise exception 'not an undone import of this user' using errcode = '42501';
  end if;
  -- the records holding this job's 'granted' entries, before the entries are read: a conversion (LEAD-07 copy) or a
  -- merge of one of them updates or deletes that row, so it either committed already (its copy is read below, in a
  -- new snapshot) or waits until this undo commits (and then sees the cancelling entries). By id, after the job lock
  -- the caller holds (a rare cycle with a concurrent merge ends in 40P01, see the header).
  perform 1 from public.leads l
   where l.organization_id = p_org
     and l.id in (select c.lead_id from public.consents c
                   where c.organization_id = p_org and c.import_job_id = p_job and c.state = 'granted'
                     and c.lead_id is not null)
   order by l.id
     for share;
  perform 1 from public.contacts k
   where k.organization_id = p_org
     and k.id in (select c.contact_id from public.consents c
                   where c.organization_id = p_org and c.import_job_id = p_job and c.state = 'granted'
                     and c.contact_id is not null)
   order by k.id
     for share;
  for v_entry in
    select c.id, c.lead_id, c.contact_id, c.channel, c.state
      from public.consents c
     -- fail-safe (owner's answer pending): only 'granted' entries; an import's 'denied' stays in force
     where c.organization_id = p_org and c.cancels is null and c.source = 'import' and c.state = 'granted'
       and (c.import_job_id = p_job
            -- LEAD-07: the copy of such an entry on the contact the imported lead became
            or (c.copied_from is not null and exists (
                  select 1 from public.consents s
                   where s.organization_id = p_org and s.id = c.copied_from and s.import_job_id = p_job)))
       and not exists (select 1 from public.consents x where x.organization_id = p_org and x.cancels = c.id)
     order by c.created_at, c.seq
     for update of c
  loop
    insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method, import_job_id, cancels)
    values (p_org, v_entry.lead_id, v_entry.contact_id, v_entry.channel, 'unknown', 'import', 'ביטול ייבוא', p_job, v_entry.id)
    on conflict (organization_id, cancels) where cancels is not null do nothing;
    if found then
      v_granted := v_granted + 1;
    end if;
  end loop;
  if v_granted > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'import_consent_undo', 'import_jobs', p_job,
            jsonb_build_object('granted', v_granted));
  end if;
  return v_granted;
end;
$$;
revoke all on function app.import_consents_cancel(uuid, uuid) from public, anon;
grant execute on function app.import_consents_cancel(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- No edits (CNS-02): 0155's body; the two new columns never change (the job link may be cleared)
-- ----------------------------------------------------------------------------
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
     -- CNS-05 undo: which entry a cancelling entry ends, and the import that wrote an entry; the job link may only be
     -- cleared (the foreign key's "set null" when a job is gone)
     or new.cancels is distinct from old.cancels
     or (new.import_job_id is distinct from old.import_job_id and new.import_job_id is not null)
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

-- ----------------------------------------------------------------------------
-- consents_prepare: 020970's body; a cancelling entry (server only) takes its cancelled entry's subject
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
-- The state of an address: 020970's body; a cancelled import entry counts as never written
-- ----------------------------------------------------------------------------
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
-- Has this address opted out? 020970's body; a cancelled entry is not a missing hash
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
                and c.hash_version = 1 and c.state in ('withdrawn', 'denied')
                and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)) then
    return null;
  end if;
  return false;
end;
$$;
revoke all on function app.consent_suppressed(uuid, text, text) from public, anon, authenticated;
grant execute on function app.consent_suppressed(uuid, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The shared lock of the form and the import: 020970's body; cancelled entries skipped
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
         and c.address_hash is not null and c.hash_version = 1
         and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)) then
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
       and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)
       and p.kind = app.consent_address_kind(p_channel) and p.value = p_address);
end;
$$;
revoke all on function app.consent_address_locked(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The card's state per channel: 020975's body; cancelled and cancelling entries are not a state
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
     -- CNS-05 undo: neither a cancelling entry nor the import entry it cancelled is a state
     and c.cancels is null
     and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)
   order by c.channel, c.created_at desc, c.seq desc;
$$;
revoke all on function public.consent_current(uuid, text, uuid) from public, anon;
grant execute on function public.consent_current(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- LEAD-07: 020975's body; cancelled and cancelling entries are not carried
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
                 and r.cancels is null
                 and not exists (select 1 from public.consents cx where cx.organization_id = r.organization_id and cx.cancels = r.id)
               order by r.created_at desc, r.seq desc
               limit 1) latest on true
           where c.organization_id = new.organization_id and c.lead_id = new.id
             -- CNS-05 undo: a cancelled import entry and its cancelling entry are not carried
             and c.cancels is null
             and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)
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
-- An opt-out written without an address follows the new address: 015500's body; a cancelled entry is not the latest
-- ----------------------------------------------------------------------------
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
       -- CNS-05 undo: an import's entry that its undo cancelled counts as never written
       and not exists (select 1 from public.consents cx where cx.organization_id = c.organization_id and cx.cancels = c.id)
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

-- ----------------------------------------------------------------------------
-- The import's consents: 020950's body; the entry keeps its job, and the job is held FOR SHARE
-- ----------------------------------------------------------------------------
create or replace function public.import_record_consents(p_org uuid, p_job uuid, p_items jsonb) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_job record;
  v_item jsonb;
  v_out jsonb := '[]'::jsonb;
  v_result text;
  v_record uuid;
  v_channel text;
  v_state text;
  v_address text;
  v_lead uuid;
  v_contact uuid;
  v_ok boolean;
  v_method text;
  v_hint text;
begin
  if auth.uid() is null or p_org is null or p_job is null or not coalesce(app.can_import(p_org), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the caller's own running leads or contacts import in this business (the rule of app.guard_import_tag)
  select j.entity_type, j.duplicate_mode, j.consent_method, j.consent_note into v_job
    from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid() and j.status = 'running'
     and j.entity_type in ('lead', 'contact')
     -- CNS-05 undo: held until this call commits, so the job is not finished and undone while entries are still written
     for share;
  if not found then
    raise exception 'not a running import of this user' using errcode = '42501';
  end if;
  if v_job.consent_method is null then
    raise exception 'the import has no consent declaration' using errcode = 'P0001', hint = 'import_consent:undeclared';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be an array' using errcode = '22023', hint = 'import_consent:items';
  end if;
  if jsonb_array_length(p_items) > 1000 then
    raise exception 'too many consents in one call' using errcode = 'P0001', hint = 'import_consent:too_many';
  end if;
  v_method := left(app.import_consent_method_label(v_job.consent_method) || ': ' || v_job.consent_note, 500);

  for v_item in select e from jsonb_array_elements(p_items) as e loop
    v_result := null;
    v_record := null;
    v_ok := null;
    if jsonb_typeof(v_item) = 'object' then
      begin
        v_record := (v_item ->> 'record_id')::uuid;
      exception when others then
        v_record := null;
      end;
    end if;
    v_channel := case when jsonb_typeof(v_item) = 'object' then v_item ->> 'channel' end;
    v_state := case when jsonb_typeof(v_item) = 'object' then v_item ->> 'state' end;
    v_address := case when jsonb_typeof(v_item) = 'object' then nullif(btrim(v_item ->> 'address'), '') end;
    if v_record is null or v_channel is null or v_channel not in ('email', 'sms', 'whatsapp')
       or v_state is null or v_state not in ('granted', 'denied') then
      v_result := 'invalid';
    else
      if v_job.entity_type = 'lead' then
        v_lead := v_record;
        v_contact := null;
        select true into v_ok from public.leads l
         where l.organization_id = p_org and l.id = v_record and l.deleted_at is null
           and (l.import_job_id = p_job
                or ((v_job.duplicate_mode = 'update' or v_state = 'denied')
                    and app.can_edit_record(l.organization_id, l.owner_id, l.team_id)));
      else
        v_lead := null;
        v_contact := v_record;
        select true into v_ok from public.contacts c
         where c.organization_id = p_org and c.id = v_record and c.deleted_at is null
           and (c.import_job_id = p_job
                or ((v_job.duplicate_mode = 'update' or v_state = 'denied')
                    and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)));
      end if;
      v_address := case when v_channel = 'email' then lower(v_address) else app.normalize_phone(v_address) end;
      if not coalesce(v_ok, false) then
        v_result := 'refused';
      elsif v_address is null
            or app.consent_record_address(p_org, v_lead, v_contact, v_channel) is distinct from v_address then
        v_result := 'other_address';
      elsif v_state = 'granted' and app.consent_address_locked(p_org, v_lead, v_contact, v_channel, v_address) then
        v_result := 'locked';
      else
        begin
          -- the job is kept on the entry, so undoing the import can cancel it (server only)
          insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method, import_job_id)
          values (p_org, v_lead, v_contact, v_channel, v_state, 'import', v_method, p_job);
          v_result := 'written';
        exception when sqlstate 'P0001' then
          get stacked diagnostics v_hint = pg_exception_hint;
          -- the register's own lock (consents_prepare) agrees with the check above; never lifted
          if v_hint in ('consent:optout_locked', 'consent:erasure_block', 'consent:address_blocked') then
            v_result := 'locked';
          else
            raise;
          end if;
        end;
      end if;
    end if;
    v_out := v_out || to_jsonb(v_result);
  end loop;
  return v_out;
end;
$$;
revoke all on function public.import_record_consents(uuid, uuid, jsonb) from public, anon;
grant execute on function public.import_record_consents(uuid, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 020845's body; the import's own consents are not work on the record
-- ----------------------------------------------------------------------------
create or replace function app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamptz, p_job uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- RVW-36: an imported task is worked on when a checklist step was added after the import or any step is done
  if p_type = 'task' then
    return exists (select 1 from public.task_checklist_items x
                    where x.organization_id = p_org and x.task_id = p_id
                      and (x.created_at > p_since or x.done_at is not null))
        -- TASK-06 part B: a sub-task added under it (an import makes none)
        or exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- no other records are linked to an imported task; its own row and its steps are the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    -- CNS-05: the import's own consents are part of the import, not work on the record
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since
                    and x.import_job_id is distinct from p_job)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        -- ORD-01: an order is always made after the import
        or exists (select 1 from public.orders x where x.organization_id = p_org and p_id in (x.contact_id, x.delivery_contact_id))
        -- DOC-01: a document is always recorded after the import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.contact_id = p_id)
        -- PAY-01: a payment is always recorded after the import
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.contact_id = p_id)
        -- COL-05: a hold is always set after the import
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job));
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 020845's body; then the import's consents are cancelled
-- ----------------------------------------------------------------------------
create or replace function public.undo_import(p_org uuid, p_job uuid) returns jsonb
language plpgsql volatile security invoker
set search_path = ''
as $$
declare
  v_job public.import_jobs;
  v_table text;
  v_done integer := 0;
  v_n integer;
  v_left integer;
  v_movable integer;
  v_consents integer;
begin
  -- the caller's own import (RLS: import_jobs_update), locked so two undos do not run together
  select * into v_job from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job and j.created_by = auth.uid()
     for update;
  if not found then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if v_job.status not in ('done', 'failed') then
    raise exception 'the import is not finished or already undone' using errcode = '22023', hint = 'import_undo:status';
  end if;
  v_table := case v_job.entity_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                    when 'deal' then 'deals' when 'task' then 'tasks' end;
  if v_table is null then
    raise exception 'this import cannot be undone here' using errcode = '22023', hint = 'import_undo:type';
  end if;
  if v_job.created_at < now() - interval '7 days' then
    raise exception 'an import can be undone only in its first 7 days' using errcode = '22023', hint = 'import_undo:expired';
  end if;

  -- first, whether every live record of the import is the caller's to move to the recycle bin (app.can_delete_record,
  -- the rule guard_soft_delete applies): one they may edit but not delete would otherwise stop the update with a
  -- plain 42501, and one they cannot see at all is counted by app.import_rows_left
  -- TASK-06 part B: an imported task with a live sub-task is worked on (app.import_record_worked); undoing it would take
  -- the sub-tasks a person made to the bin with it, so the undo is refused and says why
  if v_table = 'tasks' then
    v_n := app.import_tasks_with_subtasks(p_org, p_job);
    if v_n > 0 then
      raise exception 'some imported tasks have sub-tasks' using errcode = 'P0001',
        hint = 'import_undo:subtasks', detail = v_n::text;
    end if;
  end if;

  v_left := app.import_rows_left(p_org, p_job);
  execute format(
    'select count(*)::int from public.%I t
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null
        and app.can_delete_record(t.organization_id, t.owner_id, t.team_id)', v_table)
    into v_movable using p_org, p_job;
  if coalesce(v_left, 0) > v_movable then
    raise exception 'some records of this import can no longer be changed by you' using errcode = 'P0001',
      hint = 'import_undo:left', detail = (v_left - v_movable)::text;
  end if;

  execute format(
    'update public.%I t set deleted_at = now()
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null', v_table)
    using p_org, p_job;
  get diagnostics v_done = row_count;

  if v_job.entity_type = 'contact' then
    -- the companies it made that no live contact uses (one from outside this import keeps it)
    update public.companies c set deleted_at = now()
     where c.organization_id = p_org and c.import_job_id = p_job and c.deleted_at is null
       -- one the caller may not delete stays (a company is never counted as left)
       and app.can_delete_record(c.organization_id, c.owner_id, c.team_id)
       and not exists (select 1 from public.contacts k
                        where k.organization_id = p_org and k.company_id = c.id and k.deleted_at is null);
    get diagnostics v_n = row_count;
    v_done := v_done + v_n;
  end if;

  -- a record RLS still kept from the update (it answers no error) stays: then nothing is undone
  v_left := app.import_rows_left(p_org, p_job);
  if coalesce(v_left, 0) > 0 then
    raise exception 'some records of this import can no longer be changed by you' using errcode = 'P0001',
      hint = 'import_undo:left', detail = v_left::text;
  end if;

  update public.import_jobs j set status = 'undone', undone_at = now()
   where j.organization_id = p_org and j.id = p_job;
  -- CNS-05 (owner, 26 October 2026): the import's consents are cancelled by new entries (append-only); fail-safe until
  -- the owner answers: its 'granted' entries only
  v_consents := app.import_consents_cancel(p_org, p_job);
  return jsonb_build_object('done', v_done)
         || case when v_consents > 0 then jsonb_build_object('consents', v_consents) else '{}'::jsonb end;
end;
$$;
revoke all on function public.undo_import(uuid, uuid) from public, anon;
grant execute on function public.undo_import(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 020010's body; then the import's consents are cancelled
-- ----------------------------------------------------------------------------
create or replace function public.undo_own_import(p_org uuid, p_job uuid) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_job public.import_jobs;
  v_table text;
  v_done integer := 0;
  v_kept integer := 0;
  v_n integer;
  v_consents integer;
begin
  select * into v_job from public.import_jobs j
   where j.organization_id = p_org and j.id = p_job
     for update;
  if not found or v_job.created_by is distinct from auth.uid() then
    raise exception 'import not found' using errcode = 'P0002';
  end if;
  if not app.has_grant(p_org, 'import') or not app.org_writable(p_org) then
    raise exception 'not allowed to undo this import' using errcode = '42501';
  end if;
  if v_job.status not in ('done', 'failed') then
    raise exception 'the import is not finished or already undone' using errcode = '22023', hint = 'import_undo:status';
  end if;
  v_table := case v_job.entity_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                    when 'deal' then 'deals' when 'task' then 'tasks' end;
  if v_table is null then
    raise exception 'this import cannot be undone here' using errcode = '22023', hint = 'import_undo:type';
  end if;
  if v_job.created_at < now() - interval '7 days' then
    raise exception 'an import can be undone only in its first 7 days' using errcode = '22023', hint = 'import_undo:expired';
  end if;

  execute format(
    'update public.%I t set deleted_at = now()
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null
        and t.updated_at = t.created_at
        and not app.import_record_worked($1, $3, t.id, t.created_at, $2)', v_table)
    using p_org, p_job, v_job.entity_type;
  get diagnostics v_done = row_count;
  execute format(
    'select count(*)::int from public.%I t
      where t.organization_id = $1 and t.import_job_id = $2 and t.deleted_at is null', v_table)
    into v_kept using p_org, p_job;

  if v_job.entity_type = 'contact' then
    update public.companies c set deleted_at = now()
     where c.organization_id = p_org and c.import_job_id = p_job and c.deleted_at is null
       and c.updated_at = c.created_at
       and not app.import_record_worked(p_org, 'company', c.id, c.created_at, p_job)
       -- no live contact points at it: one from outside this import, or one of this import that was
       -- kept above (changed or worked on); the contacts are decided first
       and not exists (select 1 from public.contacts k
                        where k.organization_id = p_org and k.company_id = c.id and k.deleted_at is null);
    get diagnostics v_n = row_count;
    v_done := v_done + v_n;
    select v_kept + count(*)::int into v_kept from public.companies c
     where c.organization_id = p_org and c.import_job_id = p_job and c.deleted_at is null;
  end if;

  update public.import_jobs j set status = 'undone', undone_at = now()
   where j.organization_id = p_org and j.id = p_job;
  -- CNS-05 (owner, 26 October 2026): the import's 'granted' entries are cancelled (fail-safe), also on a kept record
  v_consents := app.import_consents_cancel(p_org, p_job);
  return jsonb_build_object('done', v_done, 'kept', v_kept)
         || case when v_consents > 0 then jsonb_build_object('consents', v_consents) else '{}'::jsonb end;
end;
$$;
revoke all on function public.undo_own_import(uuid, uuid) from public, anon;
grant execute on function public.undo_own_import(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
