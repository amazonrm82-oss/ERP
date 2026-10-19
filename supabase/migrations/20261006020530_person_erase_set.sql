-- =============================================================================
-- PRV-03, part one (no deletes; applied as usual): what removing a person takes, and the confirmation window's preview
-- =============================================================================
-- Owner's answer of 19 October 2026, with the lead's decisions of the same day (DECISIONS.md "היקף מחיקת אדם"):
-- * The set: the lead or contact asked for, with every record conversion links to it (a lead's converted contact, and
--   every lead converted into that contact), records in the recycle bin included. A merged-away record is already gone
--   (its copy in the kept record's timeline is emptied by the erasure, app.audit_erase_core). Records of the same phone or
--   email ("linked by duplicate") are offered in the window, ticked by default and untickable; each one ticked joins the
--   set with its own conversion relatives. A match is not preselected when its address is shared by more than two records
--   outside the set, or when ticking it would also take conversion relatives that were not offered (review of PRV-03).
--   At most 200 are offered (the rest are removed one by one); a conversion family is ticked as one.
-- * Deleted: the leads and contacts, their further channels (cascade), their files (cascade, Storage objects through the
--   orphan cleanup) and their form inquiries; notes and the audit trail as in audit_erase_record; meetings stay with the
--   person's details cleared, and so do the notifications about those meetings. Deals and companies stay. A kept deal whose
--   name holds the person's first, last or full name (a substring after app.search_norm; a full name of two characters or
--   more, a single word of three or more) must get a new name; the suggestion is "עסקה" and the number of its accepted
--   quote, else "עסקה (לקוח נמחק)". Consent and opt-out hashes stay.
-- * Owners and admins of a writable business in a second-step session; a reason; one audit entry (part two).
--
-- Here (no deletes): the set, the offered matches, the kept deals and their names, the guard, and
-- public.privacy_erase_preview for the window, which also counts what goes by type. The deleting function,
-- public.privacy_erase_person, is here too; its DELETE statements live in one small helper,
-- app.person_erase_delete_rows, its own file pasted by the owner (20261006020535_person_erase.sql). The function here calls
-- it at run time, so both files must have run before the window works. Safe to run twice.

-- The lead or contact with the records conversion links to it (bin included)
create or replace function app.person_erase_set(p_org uuid, p_type text, p_id uuid)
returns table (record_type text, record_id uuid)
language sql stable security definer
set search_path = ''
as $$
  with seed_contact as (
    select c.id
      from public.contacts c
     where p_type = 'contacts' and c.organization_id = p_org and c.id = p_id
    union
    select l.converted_contact_id
      from public.leads l
     where p_type = 'leads' and l.organization_id = p_org and l.id = p_id and l.converted_contact_id is not null
  ),
  person_leads as (
    select l.id
      from public.leads l
     where p_type = 'leads' and l.organization_id = p_org and l.id = p_id
    union
    select l.id
      from public.leads l
     where l.organization_id = p_org and l.converted_contact_id in (select s.id from seed_contact s)
  )
  select 'leads'::text, l.id from person_leads l
  union all
  select 'contacts'::text, c.id
    from public.contacts c
   where c.organization_id = p_org and c.id in (select s.id from seed_contact s);
$$;
revoke all on function app.person_erase_set(uuid, text, uuid) from public, anon, authenticated, service_role;

-- Leads and contacts outside the set that share a phone or an email with it (primary or further channels; bin included).
-- `shared` is, over the addresses the record was found by, the most records outside the set that hold one of them: an
-- address many records share (an office line, a family email) is offered but not preselected.
create or replace function app.person_erase_matches(p_org uuid, p_leads uuid[], p_contacts uuid[])
returns table (record_type text, record_id uuid, via text, shared integer)
language sql stable security definer
set search_path = ''
as $$
  with addr as (
    select 'phone'::text as k, l.phone_e164 as v from public.leads l
     where l.organization_id = p_org and l.id = any (p_leads) and l.phone_e164 is not null
    union
    select 'phone', c.phone_e164 from public.contacts c
     where c.organization_id = p_org and c.id = any (p_contacts) and c.phone_e164 is not null
    union
    select 'phone', ch.value_e164 from public.contact_channels ch
     where ch.organization_id = p_org and ch.contact_id = any (p_contacts) and ch.kind = 'phone' and ch.value_e164 is not null
    union
    select 'email', lower(btrim(l.email)) from public.leads l
     where l.organization_id = p_org and l.id = any (p_leads) and nullif(btrim(l.email), '') is not null
    union
    select 'email', lower(btrim(c.email)) from public.contacts c
     where c.organization_id = p_org and c.id = any (p_contacts) and nullif(btrim(c.email), '') is not null
    union
    select 'email', lower(btrim(ch.value)) from public.contact_channels ch
     where ch.organization_id = p_org and ch.contact_id = any (p_contacts) and ch.kind = 'email' and nullif(btrim(ch.value), '') is not null
  ),
  holders as (
    select 'leads'::text as t, l.id, 'phone'::text as k, l.phone_e164 as v from public.leads l
     where l.organization_id = p_org and not (l.id = any (p_leads))
       and l.phone_e164 in (select a.v from addr a where a.k = 'phone')
    union
    select 'leads', l.id, 'email', lower(btrim(l.email)) from public.leads l
     where l.organization_id = p_org and not (l.id = any (p_leads))
       and lower(btrim(l.email)) in (select a.v from addr a where a.k = 'email')
    union
    select 'contacts', c.id, 'phone', c.phone_e164 from public.contacts c
     where c.organization_id = p_org and not (c.id = any (p_contacts))
       and c.phone_e164 in (select a.v from addr a where a.k = 'phone')
    union
    select 'contacts', c.id, 'email', lower(btrim(c.email)) from public.contacts c
     where c.organization_id = p_org and not (c.id = any (p_contacts))
       and lower(btrim(c.email)) in (select a.v from addr a where a.k = 'email')
    union
    select 'contacts', ch.contact_id, 'phone', ch.value_e164 from public.contact_channels ch
     where ch.organization_id = p_org and not (ch.contact_id = any (p_contacts)) and ch.kind = 'phone'
       and ch.value_e164 in (select a.v from addr a where a.k = 'phone')
    union
    select 'contacts', ch.contact_id, 'email', lower(btrim(ch.value)) from public.contact_channels ch
     where ch.organization_id = p_org and not (ch.contact_id = any (p_contacts)) and ch.kind = 'email'
       and lower(btrim(ch.value)) in (select a.v from addr a where a.k = 'email')
  ),
  counted as (
    -- holders is a set of (record, address), so this counts distinct records per address
    select h.t, h.id, h.k, count(*) over (partition by h.k, h.v) as n from holders h
  )
  select c.t, c.id, case when bool_or(c.k = 'phone') then 'phone' else 'email' end, max(c.n)::integer
    from counted c
   group by c.t, c.id;
$$;
revoke all on function app.person_erase_matches(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;

-- What the window offers: the first 200 matches in a fixed order, plus one more row when there are more (the window then
-- says so; the rest can be removed one by one). Read once per call, never once per match.
create or replace function app.person_erase_offered(p_org uuid, p_leads uuid[], p_contacts uuid[])
returns table (record_type text, record_id uuid, via text, shared integer)
language sql stable security definer
set search_path = ''
as $$
  select m.record_type, m.record_id, m.via, m.shared
    from app.person_erase_matches(p_org, p_leads, p_contacts) m
   order by m.record_type, m.record_id
   limit 201;
$$;
revoke all on function app.person_erase_offered(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;

-- The whole set: the person's own set, and the set of every offered match the window kept ticked. p_extra is a json array
-- of {"type": "leads"|"contacts", "id": uuid}, at most 200 items (hint person_erase:extra_max), a repeated item counted once;
-- anything that is not among the (at most 200) offered matches is refused (hint person_erase:extra).
create or replace function app.person_erase_full(p_org uuid, p_type text, p_id uuid, p_extra jsonb)
returns table (record_type text, record_id uuid)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_leads uuid[];
  v_contacts uuid[];
  v_item jsonb;
  v_extra_type text;
  v_extra_id uuid;
  v_all_leads uuid[];
  v_all_contacts uuid[];
  v_offer text[];
begin
  select coalesce(array_agg(s.record_id) filter (where s.record_type = 'leads'), '{}'),
         coalesce(array_agg(s.record_id) filter (where s.record_type = 'contacts'), '{}')
    into v_leads, v_contacts
    from app.person_erase_set(p_org, p_type, p_id) s;
  v_all_leads := v_leads;
  v_all_contacts := v_contacts;
  if p_extra is not null and jsonb_typeof(p_extra) <> 'array' then
    raise exception 'extra records are a list' using errcode = '22023', hint = 'person_erase:extra';
  end if;
  if jsonb_array_length(coalesce(p_extra, '[]'::jsonb)) > 200 then
    raise exception 'too many extra records' using errcode = '22023', hint = 'person_erase:extra_max';
  end if;
  -- the offer, read once
  select coalesce(array_agg(o.record_type || ':' || o.record_id::text), '{}') into v_offer
    from (select f.record_type, f.record_id from app.person_erase_offered(p_org, v_leads, v_contacts) f
           order by f.record_type, f.record_id limit 200) o;
  for v_item in select distinct e from jsonb_array_elements(coalesce(p_extra, '[]'::jsonb)) e loop
    v_extra_type := v_item ->> 'type';
    begin
      v_extra_id := (v_item ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'not an offered record' using errcode = '22023', hint = 'person_erase:extra';
    end;
    if v_extra_id is null or not ((coalesce(v_extra_type, '') || ':' || v_extra_id::text) = any (v_offer)) then
      raise exception 'not an offered record' using errcode = '22023', hint = 'person_erase:extra';
    end if;
    select v_all_leads || coalesce(array_agg(s.record_id) filter (where s.record_type = 'leads'), '{}'),
           v_all_contacts || coalesce(array_agg(s.record_id) filter (where s.record_type = 'contacts'), '{}')
      into v_all_leads, v_all_contacts
      from app.person_erase_set(p_org, v_extra_type, v_extra_id) s;
  end loop;
  return query
    select distinct 'leads'::text, u.id from unnest(v_all_leads) u(id)
    union
    select distinct 'contacts'::text, u.id from unnest(v_all_contacts) u(id);
end;
$$;
revoke all on function app.person_erase_full(uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;

-- The deals that stay: linked to the set's contacts (as the deal's contact or a further deal contact) or made by
-- converting one of its leads (bin included)
create or replace function app.person_erase_kept_deals(p_org uuid, p_leads uuid[], p_contacts uuid[])
returns table (deal_id uuid)
language sql stable security definer
set search_path = ''
as $$
  select d.id
    from public.deals d
   where d.organization_id = p_org
     and (d.contact_id = any (p_contacts)
          or d.id in (select dc.deal_id from public.deal_contacts dc
                       where dc.organization_id = p_org and dc.contact_id = any (p_contacts))
          or d.id in (select l.converted_deal_id from public.leads l
                       where l.organization_id = p_org and l.id = any (p_leads) and l.converted_deal_id is not null));
$$;
revoke all on function app.person_erase_kept_deals(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;

-- The person's names as search_norm folds them: a lead's full name and each of its words, a contact's first, last and full
-- name; a full name of two characters or more, a single word of three or more (a two-letter word would hit too many names)
create or replace function app.person_erase_name_tokens(p_org uuid, p_leads uuid[], p_contacts uuid[]) returns text[]
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct x.t), '{}')
    from (
      select app.search_norm(l.full_name) as t, 2 as m from public.leads l where l.organization_id = p_org and l.id = any (p_leads)
      union all
      select app.search_norm(w), 3 from public.leads l
        cross join lateral regexp_split_to_table(coalesce(l.full_name, ''), '[[:space:]]+') w
       where l.organization_id = p_org and l.id = any (p_leads)
      union all
      select app.search_norm(c.first_name), 3 from public.contacts c where c.organization_id = p_org and c.id = any (p_contacts)
      union all
      select app.search_norm(c.last_name), 3 from public.contacts c where c.organization_id = p_org and c.id = any (p_contacts)
      union all
      select app.search_norm(c.full_name), 2 from public.contacts c where c.organization_id = p_org and c.id = any (p_contacts)
    ) x
   where x.t is not null and char_length(x.t) >= x.m;
$$;
revoke all on function app.person_erase_name_tokens(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;

-- A deal name holds one of the person's names
create or replace function app.person_erase_name_hit(p_name text, p_tokens text[]) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from unnest(p_tokens) t where position(t in coalesce(app.search_norm(p_name), '')) > 0);
$$;
revoke all on function app.person_erase_name_hit(text, text[]) from public, anon, authenticated, service_role;

-- The suggested name of a kept deal: "עסקה" and the number of its accepted quote, else "עסקה (לקוח נמחק)"
create or replace function app.person_erase_deal_suggestion(p_org uuid, p_deal uuid) returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select 'עסקה ' || q.number_display from public.quotes q
                    where q.organization_id = p_org and q.deal_id = p_deal and q.status = 'accepted' and q.number_display is not null
                    order by q.sent_at desc nulls last, q.id
                    limit 1),
                  'עסקה (לקוח נמחק)');
$$;
revoke all on function app.person_erase_deal_suggestion(uuid, uuid) from public, anon, authenticated, service_role;

-- Who may remove a person: an owner or admin of a writable business, in a session that passed the second step
create or replace function app.person_erase_allowed(p_org uuid) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not app.is_admin(p_org) or not app.org_writable(p_org) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if app.session_aal() is distinct from 'aal2' then
    raise exception 'removing a person needs the second step' using errcode = 'P0001', hint = 'mfa:self_first';
  end if;
end;
$$;
revoke all on function app.person_erase_allowed(uuid) from public, anon, authenticated, service_role;

-- What the window shows before anything happens: the people, the offered matches (same phone or email), how many records of
-- each kind go, and the deals that stay with whether they must be renamed and the suggestion
create or replace function public.privacy_erase_preview(p_org uuid, p_type text, p_id uuid, p_extra jsonb default '[]'::jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_seed_leads uuid[];
  v_seed_contacts uuid[];
  v_leads uuid[];
  v_contacts uuid[];
  v_tokens text[];
  v_matches jsonb;
  v_truncated boolean;
begin
  perform app.person_erase_allowed(p_org);
  if p_type not in ('leads', 'contacts') then
    raise exception 'a lead or a contact' using errcode = '22023';
  end if;
  select coalesce(array_agg(s.record_id) filter (where s.record_type = 'leads'), '{}'),
         coalesce(array_agg(s.record_id) filter (where s.record_type = 'contacts'), '{}')
    into v_seed_leads, v_seed_contacts
    from app.person_erase_set(p_org, p_type, p_id) s;
  if not (p_id = any (case p_type when 'leads' then v_seed_leads else v_seed_contacts end)) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(f.record_id) filter (where f.record_type = 'leads'), '{}'),
         coalesce(array_agg(f.record_id) filter (where f.record_type = 'contacts'), '{}')
    into v_leads, v_contacts
    from app.person_erase_full(p_org, p_type, p_id, p_extra) f;
  v_tokens := app.person_erase_name_tokens(p_org, v_leads, v_contacts);
  with offer_all as materialized (
         select f.record_type, f.record_id, f.via, f.shared from app.person_erase_offered(p_org, v_seed_leads, v_seed_contacts) f
       ),
       offer as materialized (
         select a.* from offer_all a order by a.record_type, a.record_id limit 200
       ),
       fam as materialized (
         select o.record_type, o.record_id, r.record_type as st, r.record_id as sid
           from offer o cross join lateral app.person_erase_set(p_org, o.record_type, o.record_id) r
       )
  select coalesce((select jsonb_agg(jsonb_build_object(
                                  'type', x.record_type, 'id', x.record_id, 'via', x.via, 'shared', x.shared,
                                  'family', x.family, 'relatives', x.relatives, 'preselect', x.preselect,
                                  'name', case x.record_type
                                            when 'leads' then (select l.full_name from public.leads l where l.organization_id = p_org and l.id = x.record_id)
                                            else (select c.full_name from public.contacts c where c.organization_id = p_org and c.id = x.record_id) end)
                                order by x.record_type, x.record_id)
                           from (select p.*, bool_and(p.shared <= 2 and p.relatives = 0) over (partition by p.family) as preselect
                                   from (select o.record_type, o.record_id, o.via, o.shared,
                                                (select min(f.sid::text) from fam f where f.record_type = o.record_type and f.record_id = o.record_id) as family,
                                                (select count(*)::integer from fam f
                                                  where f.record_type = o.record_type and f.record_id = o.record_id
                                                    and not (f.sid = any (v_seed_leads || v_seed_contacts))
                                                    and not exists (select 1 from offer oo where oo.record_type = f.st and oo.record_id = f.sid)) as relatives
                                           from offer o) p) x), '[]'::jsonb),
         (select count(*) > 200 from offer_all)
    into v_matches, v_truncated;

  return jsonb_build_object(
    'people', jsonb_build_object(
      'leads', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.full_name, 'in_bin', l.deleted_at is not null) order by l.created_at, l.id)
                           from public.leads l where l.organization_id = p_org and l.id = any (v_leads)), '[]'::jsonb),
      'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.full_name, 'in_bin', c.deleted_at is not null) order by c.created_at, c.id)
                              from public.contacts c where c.organization_id = p_org and c.id = any (v_contacts)), '[]'::jsonb)),
    -- offered against the person's own set: at most 200 (matches_truncated says there are more). Records of one conversion
    -- family (a lead and the contact it became, and every lead converted into that contact) share `family` and are ticked
    -- together by the window. A family is preselected only when each of its addresses is shared by at most two records
    -- outside the set and ticking it takes no record that is not offered (`relatives`).
    'matches', v_matches,
    'matches_truncated', v_truncated,
    'counts', jsonb_build_object(
      'leads', cardinality(v_leads),
      'contacts', cardinality(v_contacts),
      'channels', (select count(*) from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = any (v_contacts)),
      'files', (select count(*) from public.files fi
                 where fi.organization_id = p_org and (fi.lead_id = any (v_leads) or fi.contact_id = any (v_contacts))),
      'inquiries', (select count(*) from public.form_submissions s where s.organization_id = p_org and s.lead_id = any (v_leads)),
      'meetings', (select count(*) from public.meetings m
                    where m.organization_id = p_org and (m.lead_id = any (v_leads) or m.contact_id = any (v_contacts))),
      'activities', (select count(*) from public.activities a
                      where a.organization_id = p_org and (a.lead_id = any (v_leads) or a.contact_id = any (v_contacts)))),
    'deals', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', d.id, 'name', d.name,
                                'must_rename', app.person_erase_name_hit(d.name, v_tokens),
                                'suggested', app.person_erase_deal_suggestion(p_org, d.id))
                              order by d.created_at, d.id)
                         from public.deals d
                        where d.organization_id = p_org
                          and d.id in (select k.deal_id from app.person_erase_kept_deals(p_org, v_leads, v_contacts) k)), '[]'::jsonb));
end;
$$;
revoke all on function public.privacy_erase_preview(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.privacy_erase_preview(uuid, text, uuid, jsonb) to authenticated;

-- =============================================================================
-- Removing the person (owners and admins of a writable business in a second-step session, app.person_erase_allowed)
-- =============================================================================
-- public.privacy_erase_person(org, type, id, extra, reason, deal_names, person_request) (definer; owners and admins of a
-- writable business in a second-step session, app.person_erase_allowed):
-- * the set is app.person_erase_full: the record, its conversion relatives, and every offered match of the same phone or
--   email the window kept ticked (`extra`, checked against the offer; hint person_erase:extra), records in the bin included;
--   read once, locked, read again (a record linked meanwhile refuses with 40001, hint person_erase:changed, to retry);
-- * a reason of 1..500 characters (hint person_erase:reason);
-- * kept deals: every deal whose name holds one of the person's names must be in `deal_names` ({deal id: new name}) with a
--   name of 1..200 characters that holds none of them (hint person_erase:deal_name); another kept deal may be renamed too;
--   any other id is refused;
-- * meetings linked to the set: titled "פגישה (לקוח נמחק)", description, location and outcome cleared, unlinked from the
--   lead or contact; the organizer, staff participants, time, type and status stay; their audit history is erased, and the
--   notifications about them (a booking's title names the customer) get the same title and no body;
-- * form inquiries of the set's leads are deleted, and the leads and contacts binned and deleted, by
--   app.person_erase_delete_rows (the one function that deletes; the owner's paste file 20261006020535). Their further
--   channels, files, followers and links go by cascade; files' Storage objects through the orphan cleanup; activities and tasks of the
--   record alone through app.purge_links. Then each is erased through public.audit_erase_request (notes, audit trail,
--   consents keep only their hashes), which may pause until the consent key exists;
-- * one audit entry, action person_erase, with no record id or name: the reason, whether the person asked, and the counts.
-- Answers the counts and whether an erasure paused.

create or replace function public.privacy_erase_person(p_org uuid, p_type text, p_id uuid, p_extra jsonb, p_reason text,
                                                       p_deal_names jsonb default '{}'::jsonb,
                                                       p_person_request boolean default true)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_leads uuid[];
  v_contacts uuid[];
  v_tokens text[];
  v_kept uuid[];
  v_deal record;
  v_key text;
  v_name text;
  v_meetings uuid[];
  v_id uuid;
  v_inquiries integer := 0;
  v_leads_n integer := 0;
  v_contacts_n integer := 0;
  v_renamed integer := 0;
  v_paused boolean := false;
  v_counts jsonb;
  v_deleted jsonb;
begin
  perform app.person_erase_allowed(p_org);
  if p_type not in ('leads', 'contacts') then
    raise exception 'a lead or a contact' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'a reason is required' using errcode = 'P0001', hint = 'person_erase:reason';
  end if;
  if p_deal_names is not null and jsonb_typeof(p_deal_names) <> 'object' then
    raise exception 'deal names are an object' using errcode = '22023', hint = 'person_erase:deal_name';
  end if;

  -- the set, read once and locked
  select coalesce(array_agg(f.record_id order by f.record_id) filter (where f.record_type = 'leads'), '{}'),
         coalesce(array_agg(f.record_id order by f.record_id) filter (where f.record_type = 'contacts'), '{}')
    into v_leads, v_contacts
    from app.person_erase_full(p_org, p_type, p_id, p_extra) f;
  if not (p_id = any (case p_type when 'leads' then v_leads else v_contacts end)) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform 1 from public.leads l where l.organization_id = p_org and l.id = any (v_leads) order by l.id for update;
  perform 1 from public.contacts c where c.organization_id = p_org and c.id = any (v_contacts) order by c.id for update;
  -- linked meanwhile: retry
  if exists (select 1 from app.person_erase_full(p_org, p_type, p_id, p_extra) f
              where not (f.record_id = any (v_leads || v_contacts))) then
    raise exception 'the records changed' using errcode = '40001', hint = 'person_erase:changed';
  end if;

  -- kept deals: a deal that holds the person's name must be renamed, to a name that does not
  v_tokens := app.person_erase_name_tokens(p_org, v_leads, v_contacts);
  select coalesce(array_agg(k.deal_id), '{}') into v_kept from app.person_erase_kept_deals(p_org, v_leads, v_contacts) k;
  for v_key in select jsonb_object_keys(coalesce(p_deal_names, '{}'::jsonb)) loop
    if v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not (v_key::uuid = any (v_kept)) then
      raise exception 'not a deal that stays' using errcode = '22023', hint = 'person_erase:deal_name';
    end if;
  end loop;
  for v_deal in select d.id, d.name from public.deals d where d.organization_id = p_org and d.id = any (v_kept) order by d.id for update loop
    v_name := nullif(btrim(coalesce(p_deal_names ->> v_deal.id::text, '')), '');
    if v_name is null then
      if app.person_erase_name_hit(v_deal.name, v_tokens) then
        raise exception 'the deal''s name holds the person''s name' using errcode = 'P0001', hint = 'person_erase:deal_name';
      end if;
      continue;
    end if;
    if char_length(v_name) > 200 or app.person_erase_name_hit(v_name, v_tokens) then
      raise exception 'not a usable deal name' using errcode = 'P0001', hint = 'person_erase:deal_name';
    end if;
    if v_name is distinct from v_deal.name then
      update public.deals d set name = v_name where d.organization_id = p_org and d.id = v_deal.id;
      v_renamed := v_renamed + 1;
    end if;
  end loop;

  -- meetings stay without the person's details
  with changed as (
    update public.meetings m
       set title = 'פגישה (לקוח נמחק)', description = null, location = null, outcome = null, lead_id = null, contact_id = null
     where m.organization_id = p_org and (m.lead_id = any (v_leads) or m.contact_id = any (v_contacts))
    returning m.id
  )
  select coalesce(array_agg(c.id), '{}') into v_meetings from changed c;
  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org and a.entity_type = 'meetings' and a.entity_id = any (v_meetings)
     and a.changes is distinct from '{"erased": true}'::jsonb;
  update public.notifications n set title = 'פגישה (לקוח נמחק)', body = null
   where n.organization_id = p_org and n.entity_type = 'meeting' and n.entity_id = any (v_meetings);

  v_counts := jsonb_build_object(
    'channels', (select count(*) from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = any (v_contacts)),
    'files', (select count(*) from public.files fi where fi.organization_id = p_org and (fi.lead_id = any (v_leads) or fi.contact_id = any (v_contacts))));

  -- the form inquiries of the person's leads, then the leads and contacts (binned, then deleted for good): the one helper
  -- that deletes rows, app.person_erase_delete_rows (20261006020535_person_erase.sql, pasted by the owner)
  v_deleted := app.person_erase_delete_rows(p_org, v_leads, v_contacts);
  v_inquiries := (v_deleted ->> 'inquiries')::integer;
  v_leads_n := (v_deleted ->> 'leads')::integer;
  v_contacts_n := (v_deleted ->> 'contacts')::integer;

  -- erased from the audit log
  foreach v_id in array v_leads loop
    if public.audit_erase_request(p_org, 'leads', v_id, coalesce(p_person_request, true)) = -1 then
      v_paused := true;
    end if;
  end loop;
  foreach v_id in array v_contacts loop
    if public.audit_erase_request(p_org, 'contacts', v_id, coalesce(p_person_request, true)) = -1 then
      v_paused := true;
    end if;
  end loop;

  v_counts := v_counts || jsonb_build_object('leads', v_leads_n, 'contacts', v_contacts_n, 'inquiries', v_inquiries,
                                             'meetings', cardinality(v_meetings), 'deals_renamed', v_renamed);
  -- the action itself: no record id or name, only why and how much
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'person_erase', 'person_erase', null,
          jsonb_build_object('reason', v_reason, 'person_request', coalesce(p_person_request, true), 'counts', v_counts));

  return v_counts || jsonb_build_object('paused', v_paused);
end;
$$;
revoke all on function public.privacy_erase_person(uuid, text, uuid, jsonb, text, jsonb, boolean) from public, anon;
grant execute on function public.privacy_erase_person(uuid, text, uuid, jsonb, text, jsonb, boolean) to authenticated;
