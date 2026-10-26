-- =============================================================================
-- CNS-06 answer 4: a short note on a blocklist entry, emptied with the person
-- =============================================================================
-- Owner's answer of 26 October 2026 (DECISIONS.md, "רשימת חסימה עסקית: פרטים", 4 (ב)): an entry may carry a free-text
-- note of up to 200 characters, and it is erased with the person.
-- * public.consent_blocklist.note: optional, 1..200 characters, written once when the entry is added. No client select
--   grant (the column grant of 020970 is unchanged): owners and admins read it through public.consent_blocklist_find.
--   app.consent_blocklist_guard (020970's body): a note is never changed afterwards, only emptied (by the server; clients
--   have no write grant at all).
-- * public.consent_blocklist_add_noted(org, channel, addresses, reason, note): 020970's consent_blocklist_add with the
--   note (hint consent_blocklist:note over 200 characters); the audit entry says only that a note was written
--   ('with_note'), never its text. public.consent_blocklist_add keeps its signature (old callers keep working) and calls
--   it with no note. A new name rather than a changed signature: a migration re-run (test 64) could not retire the old
--   signature twice.
-- * public.consent_blocklist_find (020970's body): each entry carries its note. consent_blocklist_summary is counts only
--   and unchanged.
-- * Erasure: app.audit_erase_core (020955's body, its latest) first calls app.consent_blocklist_erase_notes for a lead or
--   a contact, while the record's audit entries still hold its addresses: every email and phone the record ever had (the
--   deleted row, its audit history, a contact's further phones and emails of CON-01 from their extra_phone / extra_email
--   audit lines) and the addresses of its consents (their hashes, and the pending values written
--   without the key) are matched as the blocklist matches (the hash with consent_hash_key; an entry still waiting for its
--   hash by its stored value), and those entries' notes are emptied. The entries themselves stay (the block outlives the
--   person). Every path reaches it: audit_erase_request / audit_erase_record, a paused erasure completed by the backfill
--   (before the blocklist's own backfill, so a waiting entry is still matched by value), PRV-03's privacy_erase_person and
--   PRV-01's retention erasure.
--   Accepted: while the key is missing, a hashed entry cannot be compared and keeps its note (the key is never removed
--   once set; an erasure at the person's request waits for the key anyway).
-- Only adds a column and creates or replaces functions; safe to run twice.

alter table public.consent_blocklist add column if not exists note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'consent_blocklist_note'
                  and conrelid = 'public.consent_blocklist'::regclass) then
    alter table public.consent_blocklist add constraint consent_blocklist_note
      check (note is null or char_length(note) between 1 and 200);
  end if;
end;
$$;

comment on column public.consent_blocklist.note is
  'CNS-06: an optional note of up to 200 characters, set when added, emptied by a privacy erasure of the person; no client select grant';

-- ----------------------------------------------------------------------------
-- The facts never change: 020970's guard, and the note is only emptied
-- ----------------------------------------------------------------------------
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
     -- CNS-06 answer 4: the note is set when the entry is added; afterwards only emptied (a privacy erasure)
     or (new.note is distinct from old.note and new.note is not null)
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

-- ----------------------------------------------------------------------------
-- Adding addresses with an optional note: 020970's consent_blocklist_add, and the note
-- ----------------------------------------------------------------------------
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

-- the old call: the same, with no note
create or replace function public.consent_blocklist_add(p_org uuid, p_channel text, p_addresses text[], p_reason text)
returns jsonb
language sql security definer
set search_path = ''
as $$
  select public.consent_blocklist_add_noted(p_org, p_channel, p_addresses, p_reason, null);
$$;
revoke all on function public.consent_blocklist_add(uuid, text, text[], text) from public, anon;
grant execute on function public.consent_blocklist_add(uuid, text, text[], text) to authenticated;

-- ----------------------------------------------------------------------------
-- Looking up one exact address: 020970's body; each entry carries its note (owners and admins)
-- ----------------------------------------------------------------------------
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
                                          'removed_reason', b.removed_reason, 'note', b.note)
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
-- The notes of the blocklist entries of an erased person's addresses (called by app.audit_erase_core)
-- ----------------------------------------------------------------------------
-- p_row: the record's deleted row (its 'delete' audit entry). Returns how many notes were emptied.
create or replace function app.consent_blocklist_erase_notes(p_org uuid, p_type text, p_id uuid, p_row jsonb) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_subject text := case p_type when 'leads' then 'lead' when 'contacts' then 'contact' end;
  -- 'email:<lower-cased email>' and 'phone:<phone_e164>', as app.consent_blocklist_pending keeps them
  v_values text[];
  v_hashes text[];
  v_count integer;
begin
  if v_subject is null or p_org is null or p_id is null then
    return 0;
  end if;
  with raw as (
    -- the deleted row
    select 'email' as kind, p_row ->> 'email' as value
    union all select 'phone', p_row ->> 'phone_e164'
    union all select 'phone', p_row ->> 'phone'
    -- every value its audit entries hold: a whole row (insert, delete) or a change {old, new}
    union all
    select f.kind, case when jsonb_typeof(a.changes -> f.col) = 'string' then a.changes ->> f.col end
      from public.audit_log a
      cross join (values ('email', 'email'), ('phone', 'phone'), ('phone', 'phone_e164')) as f (kind, col)
     where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
    union all
    select f.kind, v.value
      from public.audit_log a
      cross join (values ('email', 'email'), ('phone', 'phone'), ('phone', 'phone_e164')) as f (kind, col)
      cross join lateral (values (a.changes -> f.col ->> 'old'), (a.changes -> f.col ->> 'new')) as v (value)
     where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
       and jsonb_typeof(a.changes -> f.col) = 'object'
    -- a contact's further phones and emails (CON-01): audited as extra_phone / extra_email changes {old, new}, each
    -- "<value> (<label>)" (app.contact_channel_text); the label in brackets at the end is cut off
    union all
    select f.kind, regexp_replace(v.value, ' \([^()]*\)$', '')
      from public.audit_log a
      cross join (values ('email', 'extra_email'), ('phone', 'extra_phone')) as f (kind, col)
      cross join lateral (values (a.changes -> f.col ->> 'old'), (a.changes -> f.col ->> 'new')) as v (value)
     where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
       and jsonb_typeof(a.changes -> f.col) = 'object'
    -- the addresses of its consents written without the key
    union all
    select p.kind, p.value
      from public.consents c
      join app.consent_pending_address p on p.consent_id = c.id
     where c.organization_id = p_org and c.subject_type = v_subject and c.subject_id = p_id and p.value is not null
  )
  select coalesce(array_agg(distinct n.kind || ':' || n.value), '{}')
    into v_values
    from (select r.kind,
                 case when r.kind = 'email' then nullif(lower(btrim(r.value)), '') else app.normalize_phone(r.value) end as value
            from raw r
           where nullif(btrim(r.value), '') is not null) n
   where n.value is not null;

  -- their hashes (with the key), and the hashes its consents hold
  select coalesce(array_agg(distinct h.hash), '{}')
    into v_hashes
    from (
      select app.consent_address_hash(p_org, split_part(v, ':', 1), substr(v, position(':' in v) + 1), 1::smallint) as hash
        from unnest(v_values) as v
       where app.consent_key_present()
      union all
      select c.address_hash
        from public.consents c
       where c.organization_id = p_org and c.subject_type = v_subject and c.subject_id = p_id
         and c.address_hash is not null and c.hash_version = 1
    ) h
   where h.hash is not null;

  update public.consent_blocklist b
     set note = null
   where b.organization_id = p_org and b.note is not null
     and ((b.address_hash is not null and b.hash_version = 1 and b.address_hash = any (v_hashes))
          or (b.address_hash is null and exists (
                select 1 from app.consent_blocklist_pending p
                 where p.entry_id = b.id and p.organization_id = p_org and p.value is not null
                   and (p.kind || ':' || p.value) = any (v_values))));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.consent_blocklist_erase_notes(uuid, text, uuid, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure: 020955's app.audit_erase_core, plus the blocklist notes above
-- ----------------------------------------------------------------------------
create or replace function app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := case p_type when 'leads' then 'lead_id' when 'contacts' then 'contact_id'
                            when 'companies' then 'company_id' when 'deals' then 'deal_id' end;
  v_exists boolean;
  v_row jsonb;
  v_child record;
  v_children text[] := '{}';
  v_count integer;
  v_more integer;
  -- RVW-45: the deals that were the contact's when it was purged
  v_deals uuid[] := '{}';
  v_payments uuid[] := '{}';
  -- CNS-06 answer 4: blocklist notes emptied
  v_notes integer := 0;
begin
  if v_col is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;

  -- the deleted row, for the form submissions below (before it is erased)
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;

  -- CNS-06 answer 4: the notes of blocklist entries of the person's addresses are emptied, while the record's audit
  -- entries still hold its addresses (they are erased below)
  if p_type in ('leads', 'contacts') then
    v_notes := app.consent_blocklist_erase_notes(p_org, p_type, p_id, v_row);
  end if;

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders', 'accounting_documents', 'payments', 'customer_holds') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
    union
    select 'activities', l.activity_id from app.activity_audit_links l
     where l.organization_id = p_org and l.record_id = p_id
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id); GAP-09: and their payment schedule
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('quote_lines', 'quote_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-07: a sent quote that was detached from the record keeps its number, date and amounts; its
  -- personal details are emptied, and its own entries are erased below with the rest. A draft that
  -- only named the record (a deal's quote naming a purged contact) is the deal's and is left alone.
  if p_type in ('contacts', 'deals') then
    for v_child in
      update public.quotes q
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר',
             -- QUO-11: the reason staff wrote when cancelling an accepted quote may name the customer
             cancel_reason = null
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- owner, 18 October 2026 (QUO-07): the free text of those quotes' lines goes too: quantity, price and amounts stay;
    -- a free line and a group heading get a neutral name; every description is emptied. Owner, 19 October 2026: a
    -- product line's name that was edited by hand goes too. "Edited by hand" in the data = the stored name differs
    -- (trimmed) from the product's current catalog name; such a line takes the catalog name (not personal), and a
    -- product that is gone leaves the neutral name. A product line still named as in the catalog keeps it. Payment
    -- steps, milestones and terms stay (owner). These lines' entries (the old text included) are erased below.
    for v_child in
      update public.quote_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
         and exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = l.quote_id and q.status <> 'draft')
      returning 'quote_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-11: the cancel entry of those quotes on the timeline loses its " · סיבה: …" part (the rest is number and author);
    -- the entries' audit history (the old body included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'quote_cancelled'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-09 (owner, 18 October 2026): the customer's decision on those quotes keeps what, when and the fingerprint of the
    -- version; the signer's name, ID, signature, IP, browser and reason go (the table is not audited)
    update public.quote_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%');
    -- RVW-42: the notices about those quotes: the title (it may name the customer) becomes "הצעת מחיר" after the notice's own
    -- words, the cancel reason leaves the body, and a "viewed" notice's body (the quote's title) is emptied
    update public.notifications n
       set title = case when n.type = 'quote' and n.title like '%: %'
                        then left(n.title, strpos(n.title, ': ') + 1) || 'הצעת מחיר' else n.title end,
           body = case when n.type = 'quote_viewed' then null
                       else nullif(regexp_replace(n.body, '( · )?סיבה: .*$', ''), '') end
     where n.organization_id = p_org and n.entity_type = 'quote'
       and n.entity_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
       and (n.type = 'quote_viewed' or (n.type = 'quote' and (n.title like '%: %' or n.body like '%סיבה: %')));
    -- QUO-06 (review H1, lead's choice until the owner answers): the stored PDF of those quotes holds the customer's name,
    -- details, notes and line texts, so it goes; its object follows through the orphan cleanup (app.orphan_files)
    perform app.quote_pdf_drop(p_org, array(select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%'));
  end if;

  -- ORD-01: an order that was detached from the record keeps its number, date, lines' amounts and totals; the customer's
  -- name, the shipping address and the notes go, and its lines' free text goes as for quotes (a product line takes the
  -- catalog name, a free line and a heading a neutral one, every description is emptied). A draft only loses the
  -- shipping address and the name it may have copied from the record. Its entries are erased below with the rest.
  if p_type in ('contacts', 'companies', 'deals') then
    perform set_config('app.order_server', 'on', true);
    for v_child in
      update public.orders o
         set customer_name = case when o.status <> 'draft' then null else o.customer_name end,
             shipping_address = null,
             notes = case when o.status <> 'draft' then null else o.notes end
       where o.organization_id = p_org
         and ((p_type = 'contacts' and o.former_contact_id = p_id) or (p_type = 'deals' and o.former_deal_id = p_id)
              or (p_type = 'companies' and o.former_company_id = p_id))
      returning 'orders'::text as entity_type, o.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- ORD-05: the customer's answer on those orders keeps what, when and the fingerprint of what was shown; the signer's
    -- name, ID, signature, IP, browser and reason go (the table is not audited), as for quotes (QUO-09)
    update public.order_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%');
    -- ORD-05b: the customer's decline reason goes from the timeline entry (its audit history is erased below) and from the notices
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'order_answer_rejected'
         and ac.metadata ->> 'order_id' = any (select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    update public.notifications n
       set body = nullif(regexp_replace(n.body, '( · )?סיבה: .*$', ''), '')
     where n.organization_id = p_org and n.entity_type = 'order'
       and n.entity_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
       and n.body like '%סיבה: %';
    for v_child in
      update public.order_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
         and exists (select 1 from public.orders o where o.organization_id = p_org and o.id = l.order_id and o.status <> 'draft')
      returning 'order_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.order_server', '', true);
  end if;
  -- DOC-01: a document that was ever on the record (by its entries, within the business) keeps its type, number, date, amount
  -- and state; a cancel reason (staff may have named the customer) becomes a neutral text; its entries are erased below
  -- RVW-45: a contact's deals at its purge, by the FK set-null entry on each deal (contact_id {old: <contact>, new: null})
  if p_type = 'contacts' then
    select coalesce(array_agg(distinct a.entity_id), '{}') into v_deals
      from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'deals' and a.action = 'update' and a.entity_id is not null
       and a.changes -> 'contact_id' ->> 'old' = p_id::text and a.changes -> 'contact_id' ->> 'new' is null;
  end if;
  if p_type in ('contacts', 'deals') then
    for v_child in
      select 'accounting_documents'::text as entity_type, d.id as entity_id
        from public.accounting_documents d
       where d.organization_id = p_org
         and d.id in (select a.entity_id from public.audit_log a
                       where a.organization_id = p_org and a.entity_type = 'accounting_documents' and a.entity_id is not null
                         and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                              or a.changes -> v_col ->> 'new' = p_id::text))
       union
       -- RVW-45: recorded on such a deal without a contact
       select 'accounting_documents'::text, d.id
         from public.accounting_documents d
        where d.organization_id = p_org and d.contact_id is null and d.deal_id = any (v_deals)
          -- recorded while the deal was still the contact's: not after an unlink of the contact from that deal
          and exists (select 1 from public.audit_log u
                        where u.organization_id = p_org and u.entity_type = 'deals' and u.entity_id = d.deal_id
                          and u.action = 'update' and u.changes -> 'contact_id' ->> 'old' = p_id::text
                          and u.changes -> 'contact_id' ->> 'new' is null and u.created_at >= d.created_at)
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.document_server', 'erase', true);
    update public.accounting_documents d
       set cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'
     where d.organization_id = p_org and d.status = 'cancelled'
       and d.cancel_reason is distinct from 'הסיבה נמחקה (מחיקת פרטיות)'
       and ('accounting_documents:' || d.id) = any (v_children);
    perform set_config('app.document_server', '', true);
  end if;
  -- PAY-01: a payment that was ever on the record (by its entries, within the business) keeps its amount, date, method and
  -- status; its reference and note go, a cancel reason becomes the neutral text, and its entries are erased below.
  if p_type in ('contacts', 'deals') then
    perform set_config('app.payment_server', 'erase', true);
    select coalesce(array_agg(pm.id), '{}') into v_payments
      from public.payments pm
     where pm.organization_id = p_org
       and pm.id in (select a.entity_id from public.audit_log a
                        where a.organization_id = p_org and a.entity_type = 'payments' and a.entity_id is not null
                          and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                               or a.changes -> v_col ->> 'new' = p_id::text)
                         union
                         -- RVW-45: recorded on such a deal without a contact
                         select p2.id from public.payments p2
                          where p2.organization_id = p_org and p2.contact_id is null and p2.deal_id = any (v_deals)
                            -- recorded while the deal was still the contact's (as for documents above)
                            and exists (select 1 from public.audit_log u
                                         where u.organization_id = p_org and u.entity_type = 'deals' and u.entity_id = p2.deal_id
                                           and u.action = 'update' and u.changes -> 'contact_id' ->> 'old' = p_id::text
                                           and u.changes -> 'contact_id' ->> 'new' is null and u.created_at >= p2.created_at));
    -- PAY-04: the cheque's due-date reminders lose its number (matched by the stored text, before the number is emptied)
    update public.notifications n
       set body = 'צ''ק · ' || app.payment_amount_text(pm.amount_agorot)
      from public.payments pm
     where pm.organization_id = p_org and pm.id = any (v_payments) and pm.cheque_number is not null
       and n.organization_id = p_org and n.type = 'payment' and n.title = 'צ''ק לפירעון היום'
       and ((n.entity_type = 'deal' and n.entity_id = pm.deal_id) or (n.entity_type = 'contact' and n.entity_id = pm.contact_id))
       and n.body = 'צ''ק ' || pm.cheque_number || ' · ' || app.payment_amount_text(pm.amount_agorot);
    for v_child in
      update public.payments pm
         set reference = null, note = null,
             -- PAY-04: the cheque's number, a foreign bank's name and the unbounce reason go too
             cheque_number = null, cheque_bank_name = null, cheque_unbounce_reason = null,
             cancel_reason = case when pm.status = 'cancelled' then 'הסיבה נמחקה (מחיקת פרטיות)' end
       where pm.organization_id = p_org and pm.id = any (v_payments)
      returning 'payments'::text as entity_type, pm.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.payment_server', '', true);
  end if;
  -- DOC-04: the cancel reason goes from the timeline entries of those documents and payments (their audit history is erased
  -- below with the rest)
  for v_child in
    update public.activities ac
       set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
     where ac.organization_id = p_org and ac.type = 'system'
       and ((ac.metadata ->> 'kind' = 'document_cancelled'
             and ('accounting_documents:' || (ac.metadata ->> 'document_id')) = any (v_children))
            or (ac.metadata ->> 'kind' = 'payment_cancelled'
             and ('payments:' || (ac.metadata ->> 'payment_id')) = any (v_children)))
       and ac.body like '% · סיבה: %'
    returning 'activities'::text as entity_type, ac.id as entity_id
  loop
    v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
  end loop;
  -- the lines of those orders (kept or gone) that are gone themselves: their entries carry order_id; ORD-04: and their
  -- payment steps, as for quotes (the steps of a kept order stay, like a quote's)
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('order_lines', 'order_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'order_id', a.changes -> 'order_id' ->> 'old') = any (
             select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- the files of those documents and payments, kept or gone: a file's name may carry the customer's name. The file and its
  -- object stay with the document or payment (a business record); every entry of it is erased. A kept file is found by its
  -- row; a removed one by its delete entry, which holds the row (an insert's entry holds no values)
  for v_child in
    select f.id as entity_id from public.files f
     where f.organization_id = p_org
       and (f.accounting_document_id::text = any (
              select substr(c, length('accounting_documents:') + 1) from unnest(v_children) c where c like 'accounting_documents:%')
            or f.payment_id::text = any (
              select substr(c, length('payments:') + 1) from unnest(v_children) c where c like 'payments:%'))
    union
    select a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'files' and a.entity_id is not null
       and (coalesce(a.changes ->> 'accounting_document_id', a.changes -> 'accounting_document_id' ->> 'old') = any (
              select substr(c, length('accounting_documents:') + 1) from unnest(v_children) c where c like 'accounting_documents:%')
            or coalesce(a.changes ->> 'payment_id', a.changes -> 'payment_id' ->> 'old') = any (
              select substr(c, length('payments:') + 1) from unnest(v_children) c where c like 'payments:%'))
  loop
    v_children := v_children || ('files:' || v_child.entity_id);
  end loop;
  -- their names too (review of 020640, low 2): a name such as "חשבונית מיכל לוי.pdf" becomes "מסמך <number>.pdf" or
  -- "תשלום <date>.pdf". The file and its object stay (a tax document); the extension is kept, the name was never a fact
  update public.files f
     set name = case when f.accounting_document_id is not null
                     then 'מסמך ' || coalesce((select d.number from public.accounting_documents d
                                                where d.organization_id = f.organization_id and d.id = f.accounting_document_id), '')
                     else 'תשלום ' || coalesce((select to_char(pm.paid_on, 'YYYY-MM-DD') from public.payments pm
                                                 where pm.organization_id = f.organization_id and pm.id = f.payment_id), '')
                end || coalesce(lower(substring(f.name from '(\.[A-Za-z0-9]{1,8})$')), '')
   where f.organization_id = p_org
     and ('files:' || f.id) = any (v_children)
     and (f.accounting_document_id is not null or f.payment_id is not null);

  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org
     and ((a.entity_type = p_type and a.entity_id = p_id) or (a.entity_type || ':' || a.entity_id) = any (v_children))
     and a.action <> 'erase'
     and a.changes is distinct from '{"erased": true}'::jsonb;
  get diagnostics v_count = row_count;

  -- the copy kept by a merge, on the record it was merged into
  update public.activities ac
     set metadata = ac.metadata - 'merged', body = 'מוזג עם רשומה כפולה (הפרטים נמחקו)'
   where ac.organization_id = p_org and ac.metadata ->> 'merged_id' = p_id::text and ac.metadata ? 'merged';
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  v_count := v_count + app.erase_submissions(p_org, v_row);

  -- CNS-02: its consent history keeps only the hash, the state and the time
  if p_type in ('leads', 'contacts') then
    update public.consents c set method = null, wording = null, recorded_by = null, lift_note = null
     where c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id
       and (c.method is not null or c.wording is not null or c.recorded_by is not null or c.lift_note is not null);
    get diagnostics v_more = row_count;
    v_count := v_count + v_more;
    -- an entry still waiting for its hash (written without the key): with the key there,
    -- it gets its hash first, so the opt-out keeps working; then the stored address is
    -- blanked. Without the key it stays unmatchable and keeps app.consent_suppressed() at
    -- "cannot check" for its channel (fail closed).
    if app.consent_key_present() then
      update public.consents c set address_hash = app.consent_pending_hash(c.id)
       where c.organization_id = p_org
         and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
         and c.subject_id = p_id and c.address_hash is null and c.hash_version = 1
         and app.consent_pending_hash(c.id) is not null;
    end if;
    update app.consent_pending_address p set value = null
      from public.consents c
     where c.id = p.consent_id and c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id and p.value is not null;
  end if;

  v_count := v_count + v_notes;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
