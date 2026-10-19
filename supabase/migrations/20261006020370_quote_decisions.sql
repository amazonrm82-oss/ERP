-- QUO-09: the customer accepts and signs, or declines, a quote on its page (owner, 18 October 2026, answer 18).
--
-- * public.quote_decisions: one decision per quote, written only by public.quote_public_decide (no client writes) and read
--   only by owners and admins (RLS). An acceptance keeps the signer's full name, an optional Israeli ID, the signature (drawn
--   PNG or typed name), the version of the checkbox wording (DRAFT until the lawyer edits it), the SHA-256 fingerprint of the
--   version signed, and the full IP address and browser (owner: a signature is evidence). A refusal keeps an optional
--   reason. Not audited (the quote's status change is), so the IP lives in this row only; a privacy erasure empties the
--   personal fields with the quote's (app.audit_erase_core).
-- * public.quote_public_decide(token, ...) is quote_public's sibling in the approved secret-link pattern: service_role only,
--   it checks the token like quote_public and does only this. It decides on the version the page shows (QUO-12: an old
--   link shows the newest sent version that has a link of its own, so the customer acts on what they see; acting on the
--   original instead would let a superseded price be accepted). The page sends the fingerprint it showed; a different one
--   answers 'changed' (a newer version or an erasure came in between) and nothing is decided. Attempts count in the link's
--   view window and in their own window of 10 per 10 minutes; every outcome is an answer, never an error, so the counts stay.
-- * The decision is once: the quote moves to accepted or rejected (QUO-16's trigger writes the timeline entry), after which
--   it is locked (QUO-12 refuses a version, the page shows the outcome).
-- * public.quote_public_version(token) gives the page the number and fingerprint of the version it shows; quote_public is
--   not redefined here. app.quote_shown_version mirrors QUO-12's rule inside quote_public (020345; keep the two in step).
-- * Accept and reject notify the quote's owner (an active member) with the existing kind `quote`; no amounts.

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.quote_decisions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  quote_id           uuid not null,
  decision           text not null check (decision in ('accepted', 'rejected')),
  decided_at         timestamptz not null default now(),
  signer_name        text check (signer_name is null or char_length(btrim(signer_name)) between 2 and 120),
  signer_id_number   text check (signer_id_number is null or app.valid_israeli_id(signer_id_number)),
  signature_kind     text check (signature_kind in ('drawn', 'typed')),
  signature_image    text check (signature_image is null
                                 or (char_length(signature_image) <= 300000 and signature_image ~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$')),
  wording_version    text check (wording_version is null or char_length(wording_version) <= 40),
  content_sha256     text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  ip                 text check (ip is null or char_length(ip) <= 64),
  user_agent         text check (user_agent is null or char_length(user_agent) <= 500),
  decline_reason     text check (decline_reason is null or char_length(decline_reason) <= 1000),
  -- set when a privacy erasure emptied the personal fields (the shape below no longer holds then)
  erased_at          timestamptz,
  created_at         timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, quote_id),
  constraint quote_decisions_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade,
  -- an acceptance carries its signature; a refusal none
  constraint quote_decisions_shape check (
    erased_at is not null
    or (decision = 'accepted' and signer_name is not null and signature_kind is not null and wording_version is not null
       and (signature_kind = 'typed' or signature_image is not null) and decline_reason is null)
    or (decision = 'rejected' and signature_kind is null and signature_image is null and signer_id_number is null))
);

alter table public.quote_decisions enable row level security;
revoke all on public.quote_decisions from anon, authenticated;
grant select on public.quote_decisions to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_decisions' and policyname = 'quote_decisions_select') then
    -- owner, 18 October 2026: shown only to owners and admins
    create policy quote_decisions_select on public.quote_decisions for select to authenticated
      using (app.is_admin(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The version a link shows, and its fingerprint
-- ----------------------------------------------------------------------------
-- QUO-12's rule as quote_public applies it (020345, keep the two in step): the newest version in the chain that is open and
-- has a working link of its own, else the quote
create or replace function app.quote_shown_version(p_quote public.quotes) returns public.quotes
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_shown public.quotes := p_quote;
  v_next public.quotes := p_quote;
  v_steps integer := 0;
begin
  loop
    select * into v_next from public.quotes q
     where q.organization_id = v_next.organization_id and q.previous_id = v_next.id;
    exit when not found;
    v_steps := v_steps + 1;
    exit when v_steps > 100;
    if app.quote_link_open(v_next)
       and exists (select 1 from app.quote_links l
                    where l.organization_id = v_next.organization_id and l.quote_id = v_next.id and l.token_hash is not null) then
      v_shown := v_next;
    end if;
  end loop;
  return v_shown;
end;
$$;
revoke all on function app.quote_shown_version(public.quotes) from public, anon, authenticated, service_role;

-- The SHA-256 of what the customer is shown: the document's stored fields, lines and payment schedule, as jsonb text
create or replace function app.quote_fingerprint(p_quote public.quotes) returns text
language sql stable security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'number', p_quote.number_display,
    'title', p_quote.title,
    'customer', jsonb_build_array(p_quote.customer_name, p_quote.customer_contact_name),
    'dates', jsonb_build_array(p_quote.quote_date, p_quote.valid_until, p_quote.sent_at),
    'vat', jsonb_build_array(p_quote.prices_include_vat, p_quote.no_vat_reason, p_quote.no_vat_note, p_quote.vat_rate_bp),
    'discount', jsonb_build_array(p_quote.discount_bp, p_quote.discount_agorot),
    'totals', jsonb_build_array(p_quote.subtotal_agorot, p_quote.discount_total_agorot, p_quote.net_total_agorot,
                                p_quote.vat_agorot, p_quote.total_agorot, p_quote.currency),
    'texts', jsonb_build_array(p_quote.notes, p_quote.terms),
    'lines', coalesce((select jsonb_agg(jsonb_build_array(l.position, l.kind, l.name, l.description, l.unit_name, l.quantity,
                                                          l.unit_price_agorot, l.discount_bp, l.discount_agorot, l.vat_exempt,
                                                          l.billing, l.is_optional, l.optional_selected, l.total_agorot)
                                      order by l.position, l.id)
                         from public.quote_lines l
                        where l.organization_id = p_quote.organization_id and l.quote_id = p_quote.id), '[]'::jsonb),
    'schedule', coalesce((select jsonb_agg(jsonb_build_array(s.position, s.name, s.percent_bp, s.due_date, s.milestone)
                                         order by s.position, s.id)
                            from public.quote_payment_steps s
                           where s.organization_id = p_quote.organization_id and s.quote_id = p_quote.id), '[]'::jsonb)
  )::text, 'UTF8')), 'hex');
$$;
revoke all on function app.quote_fingerprint(public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Deciding
-- ----------------------------------------------------------------------------
alter table app.quote_links add column if not exists decide_window_started_at timestamptz;
alter table app.quote_links add column if not exists decide_count integer not null default 0;

create or replace function public.quote_public_decide(
  p_token text, p_decision text, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false,
  p_decline_reason text default null, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_views integer;
  v_tries integer;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_reason text := nullif(btrim(coalesce(p_decline_reason, '')), '');
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_open(v_quote)
     or not app.org_public_pages_open(v_quote.organization_id)
     or not app.org_has_feature(v_quote.organization_id, 'quotes') then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- counted first, in the link's view window and in a window of its own (10 tries in 10 minutes)
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count, l.decide_count into v_views, v_tries;
  if v_views > 120 or v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- the version the page shows (QUO-12), locked against a second decision in parallel
  v_quote := app.quote_shown_version(v_quote);
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id for update;
  if v_quote.status not in ('sent', 'viewed') then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  if p_fingerprint is distinct from app.quote_fingerprint(v_quote) then
    return jsonb_build_object('status', 'changed');
  end if;

  if p_decision = 'accepted' then
    if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
       or coalesce(p_wording_version, '') !~ '^[a-z0-9-]{1,40}$'
       or p_signature_kind not in ('drawn', 'typed')
       or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                           or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
       or (v_id is not null and not app.valid_israeli_id(v_id)) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                        signature_image, wording_version, content_sha256, ip, user_agent)
    values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
            case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500));
  elsif p_decision = 'rejected' then
    if (v_reason is not null and char_length(v_reason) > 1000) or (v_name is not null and char_length(v_name) not between 2 and 120) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, content_sha256, ip, user_agent, decline_reason)
    values (v_quote.organization_id, v_quote.id, 'rejected', v_name, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), v_reason);
  else
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.quotes q set status = p_decision
   where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  -- the quote's owner hears of it (kind `quote`, coordinator 18 October 2026): number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, v_quote.owner_id, 'quote',
         left(case when p_decision = 'accepted' then 'הצעת מחיר אושרה: ' else 'הצעת מחיר נדחתה: ' end || v_quote.title, 200),
         case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end,
         'quote', v_quote.id
   where v_quote.owner_id is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = v_quote.organization_id and m.user_id = v_quote.owner_id and m.status = 'active');
  return jsonb_build_object('status', p_decision);
end;
$$;
revoke all on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The version the customer's page shows, for the decision panel
-- ----------------------------------------------------------------------------
-- public.quote_public is left as it is (QUO-10 redefines it; coordinator, 18 October 2026). The page calls this right after
-- it and offers the decision only when the number here equals the number it drew, so the fingerprint it posts belongs to
-- the version on screen (a sent version is frozen, and every sent version has its own number). It checks the token like
-- quote_public and reads the link's view window without counting (the page load was counted by quote_public); an open
-- quote answers {number, fingerprint}, any other {number, fingerprint: null}. Nothing else, no ids.
create or replace function public.quote_public_version(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_open(v_quote)
     or not app.org_public_pages_open(v_quote.organization_id)
     or not app.org_has_feature(v_quote.organization_id, 'quotes') then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_link.window_started_at > now() - interval '10 minutes' and v_link.window_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_quote := app.quote_shown_version(v_quote);
  return jsonb_build_object(
    'number', v_quote.number_display,
    'fingerprint', case when v_quote.status in ('sent', 'viewed') then app.quote_fingerprint(v_quote) end);
end;
$$;
revoke all on function public.quote_public_version(text) from public, anon, authenticated;
grant execute on function public.quote_public_version(text) to service_role;

-- ----------------------------------------------------------------------------
-- Privacy erasure: the body of 020320 with the decisions of the erased quotes emptied
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

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes') and a.entity_id is not null
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
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר'
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- owner, 18 October 2026 (QUO-07): the free text of those quotes' lines goes too. A line keeps its product's name
    -- (catalog, not personal), quantity, price and amounts; a free line and a group heading get a neutral name; every
    -- description is emptied. These lines' entries (the old text included) are erased below with the rest.
    for v_child in
      update public.quote_lines l
         set description = null,
             name = case when l.product_id is not null then l.name when l.kind = 'group' then 'קבוצה' else 'שורה' end
       where l.organization_id = p_org
         and l.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
         and exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = l.quote_id and q.status <> 'draft')
      returning 'quote_lines'::text as entity_type, l.id as entity_id
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
  end if;

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

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;
