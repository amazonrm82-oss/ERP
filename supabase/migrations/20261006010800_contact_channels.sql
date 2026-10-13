-- =============================================================================
-- More phones and emails per contact (CON-01)
-- =============================================================================
-- A contact has one primary phone and one primary email, as before, in
-- contacts.phone / contacts.email (phone_e164 set by trigger), and any number of
-- further ones (up to 10 of each) in the new table public.contact_channels. Each
-- has a type: נייד / עבודה / בית / אחר for a phone, עבודה / אישי / אחר for an email.
--
-- Why the primary stays on the contact row and is not a row of contact_channels:
-- every part of the product that reads or writes a contact's phone and email
-- (lists, sorting, filters, inline edit, export, import, merge, conversion, the
-- lead form, automations, vCard, the call and WhatsApp buttons) keeps working
-- unchanged, and there is nothing to keep in step: a trigger that mirrored the
-- primary row into the contact columns and back would have to remove a channel
-- row whenever another path clears a contact's phone, which a migration applied
-- through the connector cannot hold. "Make primary" is a swap the app does in one
-- save (the contact's columns get the new primary, the old one becomes a row).
--
-- * contacts.phone_type / contacts.email_type: the type of the primary ones
--   (null = not said). A cleared phone or email clears its type (trigger).
--   Granted to clients for insert and update like the other contact columns (RVW-12).
-- * public.contact_channels: organization_id, contact_id (composite foreign key,
--   on delete cascade: the rows go with the contact when it is purged or merged
--   away; see "merge" below), kind phone | email, label (the type), value as typed
--   (an email lower-cased), value_e164 (a phone's normalized number, set by
--   trigger, never by a client), position.
--   Visibility and rights follow the contact: whoever may read the contact reads
--   its channels; whoever may edit it (and the organization is writable) adds,
--   changes and removes them, while it is not in the recycle bin.
--   A value appears once per contact; a browser write may not repeat the
--   contact's primary value; a browser insert may not add an 11th of a kind (taken
--   under an advisory lock per contact and kind). Rows already there are kept and
--   may still be changed (a merge may leave more than 10).
--   Another path may later set the contact's primary to a value that is also a
--   further one (a merge pick). The app then shows it once (card, form, vCard), and
--   the next save of the form removes the further copy; an import never writes such
--   a primary.
-- * Audit: a channel added, changed or removed is written to the audit log as a
--   change of the contact itself (entity contacts, fields extra_phone /
--   extra_email), so it shows in the contact's history and a privacy erasure of
--   the contact (audit_erase_record) covers it. Removal together with the contact
--   (purge, merge) is covered by the contact's own entry.
-- * Matching on every phone and email (spec: duplicates, search, repeat inquiries):
--   - public.intake_submit(): a repeat inquiry matches a contact by any of its
--     phones or emails (otherwise the definition of migration 0098, unchanged);
--   - global search (app.search_contacts): finds a contact by any of them;
--   - public.contact_channel_matches(org, phones, emails): live contacts whose
--     further phones (normalized) or emails match, for the app's duplicate checks
--     (import, new lead, merge candidates). Security invoker: RLS decides.
-- * Merge: until app.merge_move_links() moves channels (shared ground, a follow-up),
--   a merge of two contacts keeps the duplicate's phones and emails: when
--   merge_records() writes its "merged" timeline entry on the kept contact, trigger
--   activities_merge_contact_channels copies the duplicate's further phones and
--   emails, and its primary ones, onto the kept contact as further ones (values
--   it already has are skipped). The duplicate's own rows then go with it.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The type of the primary phone and email
-- ----------------------------------------------------------------------------
alter table public.contacts add column if not exists phone_type text;
alter table public.contacts add column if not exists email_type text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contacts_phone_type_check' and conrelid = 'public.contacts'::regclass) then
    alter table public.contacts add constraint contacts_phone_type_check
      check (phone_type in ('mobile', 'work', 'home', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_email_type_check' and conrelid = 'public.contacts'::regclass) then
    alter table public.contacts add constraint contacts_email_type_check
      check (email_type in ('work', 'home', 'other'));
  end if;
end;
$$;

grant insert (phone_type, email_type), update (phone_type, email_type) on public.contacts to authenticated;

-- a type without its value means nothing
create or replace function app.contact_primary_types() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.phone is null or btrim(new.phone) = '' then
    new.phone_type := null;
  end if;
  if new.email is null or btrim(new.email) = '' then
    new.email_type := null;
  end if;
  return new;
end;
$$;
revoke all on function app.contact_primary_types() from public, anon, authenticated;

create or replace trigger contacts_primary_types before insert or update of phone, email, phone_type, email_type on public.contacts
  for each row execute function app.contact_primary_types();

-- ----------------------------------------------------------------------------
-- Further phones and emails
-- ----------------------------------------------------------------------------
create table if not exists public.contact_channels (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id      uuid not null,
  kind            text not null,
  label           text not null default 'other',
  value           text not null,
  value_e164      text,
  position        integer not null default 0,
  created_by      uuid references auth.users (id) on delete set null,
  updated_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  constraint contact_channels_kind check (kind in ('phone', 'email')),
  constraint contact_channels_label check (
    (kind = 'phone' and label in ('mobile', 'work', 'home', 'other'))
    or (kind = 'email' and label in ('work', 'home', 'other'))),
  constraint contact_channels_value check (char_length(value) between 1 and 254),
  -- a phone has digits; an email looks like one and has no normalized number
  constraint contact_channels_phone check (kind <> 'phone' or value_e164 is not null),
  constraint contact_channels_email check (
    kind <> 'email' or (value_e164 is null and value like '_%@_%._%' and value !~ '[[:space:]]')),
  constraint contact_channels_position check (position between 0 and 1000)
);

-- the same number or address once per contact
create unique index if not exists contact_channels_once
  on public.contact_channels (organization_id, contact_id, kind, (coalesce(value_e164, value)));
create index if not exists contact_channels_contact_idx on public.contact_channels (organization_id, contact_id, kind, position);
-- matching (repeat inquiries, duplicates) and search
create index if not exists contact_channels_phone_idx on public.contact_channels (organization_id, value_e164) where value_e164 is not null;
create index if not exists contact_channels_email_idx on public.contact_channels (organization_id, value) where kind = 'email';
create index if not exists contact_channels_phone_trgm_idx on public.contact_channels
  using gin (value_e164 extensions.gin_trgm_ops) where value_e164 is not null;
create index if not exists contact_channels_email_trgm_idx on public.contact_channels
  using gin (app.search_norm(value) extensions.gin_trgm_ops) where kind = 'email';

alter table public.contact_channels enable row level security;
revoke all on public.contact_channels from anon, authenticated;
grant select, delete on public.contact_channels to authenticated;
grant insert (organization_id, contact_id, kind, label, value, position) on public.contact_channels to authenticated;
grant update (label, value, position) on public.contact_channels to authenticated;

do $$
begin
  -- whoever may read the contact (the sub-select runs under the contacts policies)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_channels' and policyname = 'contact_channels_select') then
    create policy contact_channels_select on public.contact_channels for select to authenticated
      using (exists (select 1 from public.contacts c
                      where c.organization_id = contact_channels.organization_id and c.id = contact_channels.contact_id));
  end if;
  -- whoever may edit the contact, in a writable organization, outside the recycle bin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_channels' and policyname = 'contact_channels_insert') then
    create policy contact_channels_insert on public.contact_channels for insert to authenticated
      with check (app.can_write(organization_id)
                  and exists (select 1 from public.contacts c
                               where c.organization_id = contact_channels.organization_id and c.id = contact_channels.contact_id
                                 and c.deleted_at is null
                                 and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_channels' and policyname = 'contact_channels_update') then
    create policy contact_channels_update on public.contact_channels for update to authenticated
      using (app.can_write(organization_id)
             and exists (select 1 from public.contacts c
                          where c.organization_id = contact_channels.organization_id and c.id = contact_channels.contact_id
                            and c.deleted_at is null
                            and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)))
      with check (app.can_write(organization_id)
                  and exists (select 1 from public.contacts c
                               where c.organization_id = contact_channels.organization_id and c.id = contact_channels.contact_id
                                 and c.deleted_at is null
                                 and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_channels' and policyname = 'contact_channels_delete') then
    create policy contact_channels_delete on public.contact_channels for delete to authenticated
      using (app.can_write(organization_id)
             and exists (select 1 from public.contacts c
                          where c.organization_id = contact_channels.organization_id and c.id = contact_channels.contact_id
                            and c.deleted_at is null
                            and app.can_edit_record(c.organization_id, c.owner_id, c.team_id)));
  end if;
end;
$$;

create or replace trigger contact_channels_touch before insert or update on public.contact_channels
  for each row execute function app.touch_row();

-- trimmed value, lower-cased email, normalized phone (a client cannot write value_e164)
create or replace function app.normalize_contact_channel() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.value := btrim(new.value);
  if new.kind = 'email' then
    new.value := lower(new.value);
    new.value_e164 := null;
  else
    new.value_e164 := app.normalize_phone(new.value);
  end if;
  return new;
end;
$$;
revoke all on function app.normalize_contact_channel() from public, anon, authenticated;

create or replace trigger contact_channels_normalize before insert or update on public.contact_channels
  for each row execute function app.normalize_contact_channel();

-- A person's write: not the contact's primary value again, and at most 10 of a kind.
-- Security invoker on purpose: current_user tells a browser write from a server one,
-- and the contact is read with the caller's rights (they may edit it, or the policy
-- refuses the row anyway).
create or replace function app.check_contact_channel() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_primary text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  select case when new.kind = 'email' then lower(btrim(c.email)) else c.phone_e164 end into v_primary
    from public.contacts c
   where c.organization_id = new.organization_id and c.id = new.contact_id;
  if v_primary is not null and v_primary = coalesce(new.value_e164, new.value) then
    raise exception 'this is already the primary value' using errcode = 'P0001', hint = 'contact_channel:primary';
  end if;
  if tg_op = 'INSERT' then
    -- one insert at a time per contact and kind, so two cannot both pass the count
    perform pg_advisory_xact_lock(hashtextextended(
      'contact_channels:' || new.organization_id::text || ':' || new.contact_id::text || ':' || new.kind, 0));
  end if;
  if tg_op = 'INSERT' and (
    select count(*) from public.contact_channels ch
     where ch.organization_id = new.organization_id and ch.contact_id = new.contact_id and ch.kind = new.kind
  ) >= 10 then
    raise exception 'too many phones or emails' using errcode = 'P0001', hint = 'contact_channel:max';
  end if;
  return new;
end;
$$;
revoke all on function app.check_contact_channel() from public, anon, authenticated;

-- after the normalize trigger (names fire in alphabetical order)
create or replace trigger contact_channels_payload_check before insert or update of value, kind on public.contact_channels
  for each row execute function app.check_contact_channel();

-- ----------------------------------------------------------------------------
-- Audit: a change of the contact
-- ----------------------------------------------------------------------------
create or replace function app.contact_channel_text(p_kind text, p_label text, p_value text) returns text
language sql immutable
set search_path = ''
as $$
  select p_value || ' (' || case
           when p_label = 'mobile' then 'נייד'
           when p_label = 'work' then 'עבודה'
           when p_label = 'home' and p_kind = 'email' then 'אישי'
           when p_label = 'home' then 'בית'
           else 'אחר' end || ')';
$$;
revoke all on function app.contact_channel_text(text, text, text) from public, anon, authenticated;

create or replace function app.audit_contact_channel() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_contact uuid;
  v_kind text;
  v_old text;
  v_new text;
begin
  if tg_op = 'DELETE' then
    v_org := old.organization_id;
    v_contact := old.contact_id;
    v_kind := old.kind;
  else
    v_org := new.organization_id;
    v_contact := new.contact_id;
    v_kind := new.kind;
  end if;
  -- gone together with the contact (purge, merge, the organization): the
  -- contact's own entry covers it
  if not exists (select 1 from public.contacts c where c.organization_id = v_org and c.id = v_contact) then
    return null;
  end if;
  if tg_op <> 'INSERT' then
    v_old := app.contact_channel_text(old.kind, old.label, old.value);
  end if;
  if tg_op <> 'DELETE' then
    v_new := app.contact_channel_text(new.kind, new.label, new.value);
  end if;
  -- a new position alone is not a change worth a line
  if v_old is not distinct from v_new then
    return null;
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (v_org, auth.uid(), 'update', 'contacts', v_contact,
          jsonb_build_object(case v_kind when 'phone' then 'extra_phone' else 'extra_email' end,
                             jsonb_build_object('old', to_jsonb(v_old), 'new', to_jsonb(v_new))));
  return null;
end;
$$;
revoke all on function app.audit_contact_channel() from public, anon, authenticated;

create or replace trigger contact_channels_audit after insert or update or delete on public.contact_channels
  for each row execute function app.audit_contact_channel();

-- ----------------------------------------------------------------------------
-- Merge: the duplicate's phones and emails stay with the kept contact
-- ----------------------------------------------------------------------------
-- merge_records() (security definer) writes a 'system' entry with metadata.merged_id
-- on the kept record after the picks and before the duplicate is removed. Clients
-- cannot write 'system' entries (0072); the function still checks both contacts.
create or replace function app.merge_contact_channels() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_keep public.contacts%rowtype;
  v_next integer;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  select * into v_keep from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id;
  if not found or v_merged = v_keep.id
     or not exists (select 1 from public.contacts m where m.organization_id = new.organization_id and m.id = v_merged) then
    return null;
  end if;
  select coalesce(max(ch.position), -1) + 1 into v_next
    from public.contact_channels ch where ch.organization_id = new.organization_id and ch.contact_id = v_keep.id;

  insert into public.contact_channels (organization_id, contact_id, kind, label, value, position)
  select new.organization_id, v_keep.id, x.kind, x.label, x.value, least(v_next + (row_number() over (order by x.ord, x.position))::integer - 1, 1000)
    from (
      select 0 as ord, 'phone' as kind, coalesce(m.phone_type, 'other') as label, btrim(m.phone) as value, 0 as position
        from public.contacts m
       where m.organization_id = new.organization_id and m.id = v_merged
         and m.phone_e164 is not null and char_length(btrim(m.phone)) between 1 and 254
      union all
      select 0, 'email', coalesce(m.email_type, 'other'), lower(btrim(m.email)), 1
        from public.contacts m
       where m.organization_id = new.organization_id and m.id = v_merged
         and m.email like '_%@_%._%' and m.email !~ '[[:space:]]' and char_length(m.email) <= 254
      union all
      select 1, ch.kind, ch.label, ch.value, ch.position
        from public.contact_channels ch
       where ch.organization_id = new.organization_id and ch.contact_id = v_merged
    ) x
   -- not the kept contact's own primary ones
   where not (x.kind = 'phone' and app.normalize_phone(x.value) is not distinct from v_keep.phone_e164)
     and not (x.kind = 'email' and x.value is not distinct from lower(btrim(v_keep.email)))
  on conflict do nothing;
  return null;
end;
$$;
revoke all on function app.merge_contact_channels() from public, anon, authenticated;

create or replace trigger activities_merge_contact_channels after insert on public.activities
  for each row
  when (new.type = 'system' and new.contact_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_contact_channels();

-- ----------------------------------------------------------------------------
-- Matching for the app's duplicate checks (import, new lead, merge candidates)
-- ----------------------------------------------------------------------------
-- Live contacts whose further phones (E.164) or emails match. Security invoker:
-- RLS decides what is found, as in public.import_find_duplicates().
create or replace function public.contact_channel_matches(p_org uuid, p_phones text[], p_emails text[])
returns table (contact_id uuid, kind text, value text)
language sql stable security invoker
set search_path = ''
as $$
  select ch.contact_id, ch.kind, coalesce(ch.value_e164, ch.value)
    from public.contact_channels ch
    join public.contacts c on c.organization_id = ch.organization_id and c.id = ch.contact_id
   where ch.organization_id = p_org and c.deleted_at is null
     and ((ch.value_e164 is not null and ch.value_e164 = any (coalesce(p_phones, '{}')))
          or (ch.kind = 'email' and ch.value = any (select lower(btrim(x)) from unnest(coalesce(p_emails, '{}')) x)))
   limit 5000;
$$;
revoke all on function public.contact_channel_matches(uuid, text[], text[]) from public, anon;
grant execute on function public.contact_channel_matches(uuid, text[], text[]) to authenticated;

-- ----------------------------------------------------------------------------
-- Global search: a contact is found by any of its phones and emails
-- ----------------------------------------------------------------------------
-- The conditions on the contact itself are those of migration 0017, unchanged, so
-- its indexes still serve them.
create or replace function app.search_contacts(p_org uuid, p_q text, p_like text, p_digits text, p_limit integer) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select c.id, c.full_name as title, coalesce(c.phone, c.email) as subtitle
      from public.contacts c
     where c.organization_id = p_org and c.deleted_at is null
       and c.id in (
         select c2.id from public.contacts c2
          where c2.organization_id = p_org and c2.deleted_at is null
            and (app.search_norm(coalesce(c2.full_name, '') || ' ' || coalesce(c2.email, '')) like p_like
                 or p_q operator(extensions.<%) app.search_norm(coalesce(c2.full_name, '') || ' ' || coalesce(c2.email, ''))
                 or (p_digits is not null and c2.phone_e164 like '%' || p_digits || '%'))
         union
         select ch.contact_id from public.contact_channels ch
          where ch.organization_id = p_org
            and ((p_digits is not null and ch.value_e164 is not null and ch.value_e164 like '%' || p_digits || '%')
                 or (ch.kind = 'email' and app.search_norm(ch.value) like p_like)))
     order by extensions.word_similarity(p_q, app.search_norm(coalesce(c.full_name, ''))) desc, c.created_at desc
     limit p_limit) x;
$$;

-- ----------------------------------------------------------------------------
-- Repeat inquiries: a form matches a contact by any of its phones and emails
-- ----------------------------------------------------------------------------
-- The definition of migration 0098 with one change, marked CON-01: the contact match.
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
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

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
    values (v_form.organization_id, v_form.id, 'spam', coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
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
        -- a field that is gone, switched off or picks a team member is not on the form
        continue when v_type is null or v_type = 'user';
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

  -- A repeat inquiry (same phone or email as a live lead, or as a contact)
  -- goes onto the existing record's timeline instead of creating a new lead.
  v_phone_e164 := app.normalize_phone(v_phone);
  select l.id, l.owner_id, l.converted_contact_id into v_lead_match, v_lead_owner, v_lead_contact
    from public.leads l
   where l.organization_id = v_form.organization_id and l.deleted_at is null
     and ((v_phone_e164 is not null and l.phone_e164 = v_phone_e164)
          or (v_email is not null and lower(l.email) = v_email))
   order by l.created_at desc
   limit 1;
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
        || case when v_custom <> '{}'::jsonb then jsonb_build_object('custom_fields', v_custom) else '{}'::jsonb end);
    v_owner := coalesce(v_lead_owner, v_contact_owner);
    if v_owner is not null then
      insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
      values (v_form.organization_id, v_owner, 'inquiry', 'פנייה חוזרת מלקוח קיים',
              case when v_lead_match is not null then 'lead' else 'contact' end,
              coalesce(v_lead_match, v_contact_match));
    end if;
    insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'duplicate', v_lead_match, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object(
      'status', 'duplicate',
      'lead_id', v_lead_match,
      'contact_id', coalesce(v_lead_contact, v_contact_match),
      'success_message', v_form.success_message,
      'redirect_url', v_form.redirect_url);
  end if;

  select s.id into v_status from public.lead_statuses s
   where s.organization_id = v_form.organization_id and s.kind = 'open'
   order by s.is_default desc, s.position
   limit 1;
  if v_status is null then
    raise exception 'the organization has no open lead status' using errcode = 'P0001';
  end if;

  if v_form.assign_mode = 'round_robin' then
    v_owner := app.next_lead_owner(v_form.organization_id, v_form.team_id);
  end if;
  if v_owner is null then
    select m.user_id into v_owner from public.memberships m
     where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
       and m.status = 'active' and m.role <> 'viewer';
  end if;

  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message,
                            campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid,
                            custom_fields)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_form.team_id,
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
          v_custom)
  returning id into v_lead;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;

revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;
