-- =============================================================================
-- SGN-02 follow-up, owner's answer (234) ב (10 November 2026): a person's erasure empties only the documents for signature
-- that are ON their record; on the documents of other records that merely name them, their values become "(נמחק)"
-- =============================================================================
-- Until now app.signature_documents_erase emptied every document whose `people` held the erased lead or contact (and every
-- document of a contact's deals at its purge): a company contract, or a deal's contract, lost its whole text, its signature and
-- its link because one person it named was erased. The owner's answer (234) ב:
-- * A document ON the erased record (a lead's or a contact's own document, detached by the purge: former_lead_id /
--   former_contact_id) is emptied as before (app.signature_documents_erase, now narrowed to those documents). A purged deal's or
--   company's own detached documents are emptied by that record's erasure, as before (review 2).
-- * A document on ANOTHER record that names the person (their id in `people`, or a document of a deal the contact was the
--   contact of when it was purged, RVW-45's v_deals) stays: status, link and dates unchanged, nothing cancelled or revoked.
--   app.signature_documents_erase_named replaces, in its text and title, the person's values with "(נמחק)":
--   - the distinctive ones: every full name the record held (and first + last name), phones (only values with 7 digits or
--     more, as typed and E.164), emails, ID number, address, billing address, birth date (DD.MM.YYYY and YYYY-MM-DD) and the
--     further phones and emails of CON-01; job title and a lead's company name are left out (too generic: they would rewrite the
--     company's own words). They are read from the deleted row and from the audit entries of the record, so
--     app.audit_erase_core calls this BEFORE it erases those entries;
--   - review (2): in a SIGNED document only values the person held at or before signed_at (the audit history up to then, and
--     for each column the value it had at signing: the "old" of its first change after, else the deleted row), and names of 3
--     characters or more, so a value held only later never rewrites what was signed;
--   - a first name or a last name alone only in a document of a deal the person was the contact of when it was sent (its
--     template filled them, {שם פרטי}) or when it was purged; elsewhere a lone first name is too likely to be someone else's word;
--   - each value as the fill put it in (app.document_literal: Markdown-escaped), as typed (spaces kept) and with spaces folded,
--     whole only: the characters just before and after must not be letters or digits (Latin, Hebrew, Arabic; a maqaf, geresh-free
--     punctuation and spaces are boundaries), so "דן" never cuts into "דני". Before a Hebrew value of 4 characters or more one
--     or two prefix letters that start the word are allowed ("לדנה כהן" -> "ל(נמחק)"; "ברון" is never "ב" + "רון"). Longer first.
--   The body gets the Markdown literal of "(נמחק)" (cleaned Markdown, read through NoteText and the PDF's parser), the title
--   the plain "(נמחק)"; never a silent cut: a body that would pass 30,000 characters takes the plain marker, and if it still
--   would, its end is cut at a line and a line "(המשך המסמך הוסר במחיקת פרטיות)" says so; a title over 120 becomes
--   "מסמך לחתימה (פרטים הוסרו)". The timeline entries of a document whose title changed are scrubbed the same way and their
--   audit entries erased; its "signed" notices take the new title.
-- * signature_documents.text_erased_at (server only, readable like the other columns): stamped once on any document whose text an
--   erasure changed (named or emptied). A signed document with it shows "פרטים אישיים הוסרו מהמסמך אחרי החתימה (מחיקת פרטיות)" on
--   the customer's page (public.signature_public answers document.text_erased), the staff screens and a PDF made again
--   (app.signature_pdf_source answers document.text_erased).
-- * The fingerprint: an unsigned document (sent, viewed, cancelled) gets the fingerprint of its new text, so the customer can
--   still read and sign what the page shows. A SIGNED document keeps content_sha256, on the document and on its signature: it is
--   the evidence of what was signed then; the text now differs from it by an erasure (text_erased_at says so).
-- * The signer: no column ties a signature to a contact (the signer types a name on the page). The safe reading: the erased
--   person is the signer of a signed named document when it is a document of a deal the person was the contact of at signed_at
--   (the deal's audit history) or at its purge, when the signature's name equals one of the person's full names (spaces and case
--   folded), or when the signature's ID number equals one of the person's ID numbers, both as held at signed_at. Then the signature loses name, ID number,
--   image, IP and browser, as before. Otherwise the signature is someone else's and stays.
-- * The signed PDF prints the text as it was, so it goes (app.signature_pdf_drop, the pasted 021213) whenever this erasure
--   changed the document's text or cleared its signer. Review (1): every candidate document's PDF advisory lock
--   ('signature_pdf:<id>', the lock app.signature_pdf_write takes) is taken before its row, and its open upload attempts are
--   handed to the orphan cleanup; app.signature_pdf_write (same signature) refuses, as `changed`, an attempt issued at or before
--   the document's text_erased_at. Delta review: a render that read the text before the erasure but asks for its path after it
--   is refused too: app.signature_pdf_source answers document.fingerprint, the fingerprint of the text as it is now
--   (app.signature_fingerprint; equal to content_sha256 until an erasure changes the text), the app passes it back as
--   p_fingerprint (the existing parameter, so no signature changes and no retired copies), and app.signature_pdf_write compares
--   it with the document's current text fingerprint instead of content_sha256. The PDF still prints signature.fingerprint, the
--   evidence of what was signed. So a render is kept only when it printed the text the document holds now. While the signer is not the erased
--   person, an owner or admin can make the PDF again from the stored text; it prints the original fingerprint and the line.
-- * Idempotent: a second run finds no value left to replace and no signer left to clear, so nothing changes and no PDF goes.
--   Every read and write is within the business (organization_id).
-- app.audit_erase_core is 021214's body with the one call added (and its count). public.signature_public and
-- app.signature_pdf_source are 021212's bodies with the one field added. Safe to run twice; no statement starts with drop; no
-- row removal here (the PDF's lives in the pasted 021213).

alter table public.signature_documents add column if not exists text_erased_at timestamptz;
grant select (text_erased_at) on public.signature_documents to authenticated;

-- a letter or a digit (ASCII; Hebrew letters, points and geresh; Arabic letters, marks and digits; any other alphanumeric): the
-- edges of a whole value. Hebrew and Arabic punctuation (maqaf, sof pasuq, Arabic comma, full stop) are boundaries.
create or replace function app.signature_word_char(p_char text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p_char, '') <> ''
     and (p_char ~ '^[0-9A-Za-z]$'
          or ascii(p_char) between 1488 and 1514
          or ascii(p_char) between 1425 and 1469
          or ascii(p_char) in (1471, 1473, 1474, 1476, 1477, 1479)
          or ascii(p_char) between 1519 and 1524
          or ascii(p_char) between 1568 and 1641
          or ascii(p_char) between 1646 and 1747
          or ascii(p_char) between 1749 and 1791
          or (ascii(p_char) > 127 and ascii(p_char) not between 1424 and 1791 and p_char ~ '^[[:alnum:]]$'))
$$;
revoke all on function app.signature_word_char(text) from public, anon, authenticated, service_role;

-- the text just before a value lets it count as whole: no letter or digit, or, before a Hebrew value of 4 characters or more, a
-- Hebrew prefix of one or two letters (ו ה ב כ ל מ ש) that itself starts a word. p_tail is the last three characters before it.
create or replace function app.signature_whole_before(p_tail text, p_needle text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_tail text := coalesce(p_tail, '');
  v_len integer := char_length(coalesce(p_tail, ''));
  v_prefix text := 'והבכלמש';
begin
  if v_len = 0 or not app.signature_word_char(right(v_tail, 1)) then
    return true;
  end if;
  if char_length(coalesce(p_needle, '')) < 4 or coalesce(ascii(left(p_needle, 1)), 0) not between 1488 and 1514
     or strpos(v_prefix, right(v_tail, 1)) = 0 then
    return false;
  end if;
  if v_len = 1 or not app.signature_word_char(substr(v_tail, v_len - 1, 1)) then
    return true;
  end if;
  return strpos(v_prefix, substr(v_tail, v_len - 1, 1)) > 0
     and (v_len = 2 or not app.signature_word_char(substr(v_tail, v_len - 2, 1)));
end;
$$;
revoke all on function app.signature_whole_before(text, text) from public, anon, authenticated, service_role;

-- every whole occurrence of each needle (2 characters or more, longer first) replaced; one split of the text per needle
create or replace function app.signature_scrub(p_text text, p_needles text[], p_with text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_out text := coalesce(p_text, '');
  v_needle text;
  v_parts text[];
  v_pieces text[];
  v_tail text;
  v_after text;
  v_count integer;
  i integer;
begin
  for v_needle in
    select n from unnest(coalesce(p_needles, '{}'::text[])) n
     where n is not null and char_length(n) >= 2
     group by n order by char_length(n) desc, n
  loop
    if v_out = '' or strpos(v_out, v_needle) = 0 then
      continue;
    end if;
    v_parts := string_to_array(v_out, v_needle);
    v_count := cardinality(v_parts);
    v_pieces := array[v_parts[1]];
    -- the last three characters written so far
    v_tail := right(v_parts[1], 3);
    for i in 2 .. v_count loop
      -- an empty part between two occurrences: the character after is the next occurrence's first
      v_after := case when v_parts[i] = '' and i < v_count then left(v_needle, 1) else left(v_parts[i], 1) end;
      if app.signature_whole_before(v_tail, v_needle) and not app.signature_word_char(v_after) then
        v_pieces := v_pieces || p_with;
        v_tail := right(v_tail || p_with, 3);
      else
        v_pieces := v_pieces || v_needle;
        v_tail := right(v_tail || v_needle, 3);
      end if;
      v_pieces := v_pieces || v_parts[i];
      v_tail := right(v_tail || v_parts[i], 3);
    end loop;
    v_out := array_to_string(v_pieces, '');
  end loop;
  return v_out;
end;
$$;
revoke all on function app.signature_scrub(text, text[], text) from public, anon, authenticated, service_role;

-- a name compared with a signer's name: invisible marks removed, spaces and case folded
create or replace function app.signature_name_key(p_name text) returns text
language sql immutable
set search_path = ''
as $$
  select nullif(lower(regexp_replace(btrim(app.document_strip_invisible(p_name)), '\s+', ' ', 'g')), '')
$$;
revoke all on function app.signature_name_key(text) from public, anon, authenticated, service_role;

-- the values a lead or a contact held, from its deleted row and its audit entries: {names, parts, details, ids}. With p_until,
-- only what it held at or before that time: the entries up to then, and for each column the value it had then (the "old" of
-- its first change after, else the deleted row, unchanged since).
create or replace function app.signature_person_values(p_org uuid, p_type text, p_id uuid, p_row jsonb, p_until timestamptz default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_cols text[] := array['full_name', 'first_name', 'last_name', 'phone', 'phone_e164', 'email', 'billing_tax_id',
                         'address_line', 'city', 'billing_address', 'birth_date'];
  v_at jsonb;
  v_snapshots jsonb[];
  v_names text[];
  v_parts text[];
  v_details text[];
  v_ids text[];
begin
  if p_org is null or p_id is null or p_type not in ('leads', 'contacts') then
    return jsonb_build_object('names', '[]'::jsonb, 'parts', '[]'::jsonb, 'details', '[]'::jsonb, 'ids', '[]'::jsonb);
  end if;
  if p_until is null then
    v_at := case when jsonb_typeof(p_row) = 'object' then p_row end;
  else
    -- the row as it was at p_until
    select jsonb_object_agg(c.col, case when e.found then e.old
                                        when jsonb_typeof(p_row) = 'object' then p_row -> c.col end)
      into v_at
      from unnest(v_cols) as c (col)
      left join lateral (
        select true as found, a.changes -> c.col -> 'old' as old
          from public.audit_log a
         where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
           and a.action not in ('insert', 'delete') and jsonb_typeof(a.changes -> c.col) = 'object'
           and a.created_at > p_until
         order by a.created_at, a.id
         limit 1) e on true;
  end if;
  -- whole rows: that row and the insert/delete snapshots (up to p_until)
  select coalesce(array_agg(s.snap), '{}') into v_snapshots
    from (select v_at as snap where v_at is not null
          union all
          select a.changes from public.audit_log a
           where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
             and a.action in ('insert', 'delete') and jsonb_typeof(a.changes) = 'object'
             and (p_until is null or a.created_at <= p_until)) s;

  with cols (kind, col) as (
    values ('name', 'full_name'), ('part', 'first_name'), ('part', 'last_name'),
           ('phone', 'phone'), ('phone', 'phone_e164'), ('detail', 'email'), ('id', 'billing_tax_id'),
           ('detail', 'address_line'), ('detail', 'billing_address'), ('birth', 'birth_date')),
  later as (
    -- extra phones and emails added after p_until were not held then
    select v.value
      from public.audit_log a
      cross join (values ('extra_email'), ('extra_phone')) as f (col)
      cross join lateral (values (a.changes -> f.col ->> 'new')) as v (value)
     where p_until is not null and a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
       and jsonb_typeof(a.changes -> f.col) = 'object' and a.created_at > p_until and v.value is not null
  ),
  raw as (
    -- a column of a whole row
    select c.kind, s.snap ->> c.col as value
      from unnest(v_snapshots) as s (snap) cross join cols c
     where jsonb_typeof(s.snap -> c.col) = 'string'
    -- first + last, and the address as the fill writes it, from one whole row
    union all
    select 'name', concat_ws(' ', nullif(btrim(s.snap ->> 'first_name'), ''), nullif(btrim(s.snap ->> 'last_name'), ''))
      from unnest(v_snapshots) as s (snap)
    union all
    select 'detail', concat_ws(', ', nullif(btrim(s.snap ->> 'address_line'), ''), nullif(btrim(s.snap ->> 'city'), ''))
      from unnest(v_snapshots) as s (snap)
     where nullif(btrim(s.snap ->> 'address_line'), '') is not null
    -- a change {old, new} (up to p_until)
    union all
    select c.kind, v.value
      from public.audit_log a
      cross join cols c
      cross join lateral (values (a.changes -> c.col ->> 'old'), (a.changes -> c.col ->> 'new')) as v (value)
     where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
       and jsonb_typeof(a.changes -> c.col) = 'object' and (p_until is null or a.created_at <= p_until)
    -- a value another entry holds as it is (up to p_until)
    union all
    select c.kind, a.changes ->> c.col
      from public.audit_log a
      cross join cols c
     where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
       and a.action not in ('insert', 'delete') and jsonb_typeof(a.changes -> c.col) = 'string'
       and (p_until is null or a.created_at <= p_until)
    -- a contact's further phones and emails (CON-01): "<value> (<label>)", the label cut off; with p_until, those held then
    union all
    select case when f.col = 'extra_phone' then 'phone' else 'detail' end, regexp_replace(v.value, ' \([^()]*\)$', '')
      from public.audit_log a
      cross join (values ('extra_email'), ('extra_phone')) as f (col)
      cross join lateral (values (a.changes -> f.col ->> 'old'), (a.changes -> f.col ->> 'new')) as v (value)
     where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id
       and jsonb_typeof(a.changes -> f.col) = 'object'
       and (p_until is null or a.created_at <= p_until or (v.value is not null and v.value not in (select l.value from later l)))
  ),
  clean as (
    -- as typed (trimmed), and with spaces folded
    select r.kind, x.value
      from raw r
      cross join lateral (values (btrim(app.document_strip_invisible(r.value))),
                                 (btrim(regexp_replace(app.document_strip_invisible(r.value), '\s+', ' ', 'g')))) as x (value)
     where r.value is not null
  ),
  kept as (
    select case when c.kind = 'birth' then 'detail' else c.kind end as kind, b.value
      from clean c
      cross join lateral (
        -- a birth date as stored (YYYY-MM-DD) and as the fill writes it (DD.MM.YYYY)
        select c.value as value where c.kind <> 'birth'
        union all
        select v.d from (values (left(c.value, 10)),
                                (to_char(to_date(left(c.value, 10), 'YYYY-MM-DD'), 'DD.MM.YYYY'))) as v (d)
         where c.kind = 'birth' and c.value ~ '^\d{4}-\d{2}-\d{2}') b
     -- a phone counts only with 7 digits or more and nothing but phone characters
     where c.kind <> 'phone'
        or (c.value ~ '^[0-9+() ./-]+$' and char_length(regexp_replace(c.value, '[^0-9]', '', 'g')) >= 7)
  )
  select coalesce(array_agg(distinct k.value) filter (where k.kind = 'name'), '{}'),
         coalesce(array_agg(distinct k.value) filter (where k.kind = 'part'), '{}'),
         coalesce(array_agg(distinct k.value) filter (where k.kind in ('detail', 'phone', 'id')), '{}'),
         coalesce(array_agg(distinct k.value) filter (where k.kind = 'id'), '{}')
    into v_names, v_parts, v_details, v_ids
    from kept k
   where char_length(k.value) >= 2;
  return jsonb_build_object('names', to_jsonb(v_names), 'parts', to_jsonb(v_parts), 'details', to_jsonb(v_details),
                            'ids', to_jsonb(v_ids));
end;
$$;
revoke all on function app.signature_person_values(uuid, text, uuid, jsonb, timestamptz) from public, anon, authenticated, service_role;

-- the deal's contact at a time: the "old" of its first contact change after it, else the deal's current contact (or, for a
-- purged deal, its deleted row's)
create or replace function app.signature_deal_contact_at(p_org uuid, p_deal uuid, p_at timestamptz) returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_found boolean := false;
  v_contact uuid;
begin
  if p_org is null or p_deal is null or p_at is null then
    return null;
  end if;
  select true, a.changes -> 'contact_id' -> 'old' into v_found, v_old
    from public.audit_log a
   where a.organization_id = p_org and a.entity_type = 'deals' and a.entity_id = p_deal
     and a.action not in ('insert', 'delete') and jsonb_typeof(a.changes -> 'contact_id') = 'object' and a.created_at > p_at
   order by a.created_at, a.id
   limit 1;
  if coalesce(v_found, false) then
    return case when jsonb_typeof(v_old) = 'string' then (v_old #>> '{}')::uuid end;
  end if;
  select d.contact_id into v_contact from public.deals d where d.organization_id = p_org and d.id = p_deal;
  if found then
    return v_contact;
  end if;
  select (a.changes ->> 'contact_id')::uuid into v_contact
    from public.audit_log a
   where a.organization_id = p_org and a.entity_type = 'deals' and a.entity_id = p_deal and a.action = 'delete'
   order by a.id desc
   limit 1;
  return v_contact;
end;
$$;
revoke all on function app.signature_deal_contact_at(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- a body with the person's values replaced, within 30,000 characters and never cut silently
create or replace function app.signature_scrubbed_body(p_body text, p_needles text[]) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_out text := app.signature_scrub(p_body, p_needles, app.document_literal('(נמחק)'));
  v_note text := E'\n(המשך המסמך הוסר במחיקת פרטיות)';
  v_cut integer;
begin
  if char_length(v_out) <= 30000 then
    return v_out;
  end if;
  v_out := app.signature_scrub(p_body, p_needles, '(נמחק)');
  if char_length(v_out) <= 30000 then
    return v_out;
  end if;
  -- still too long: the end is cut at the last line that fits, and a line says so
  v_out := left(v_out, 30000 - char_length(v_note));
  v_cut := char_length(v_out) - strpos(reverse(v_out), E'\n');
  if strpos(v_out, E'\n') > 0 then
    v_out := left(v_out, v_cut);
  end if;
  return v_out || v_note;
end;
$$;
revoke all on function app.signature_scrubbed_body(text, text[]) from public, anon, authenticated, service_role;

-- (234) ב: the documents of OTHER records that name the erased lead or contact keep everything but the person's values
create or replace function app.signature_documents_erase_named(p_org uuid, p_type text, p_id uuid, p_row jsonb, p_deals uuid[])
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_all jsonb;
  v_values jsonb;
  v_keys text[];
  v_ids text[];
  v_base text[];
  v_parts text[];
  v_needles text[];
  v_deals uuid[] := coalesce(p_deals, '{}'::uuid[]);
  v_candidates uuid[];
  v_id uuid;
  v_doc public.signature_documents;
  v_new public.signature_documents;
  v_deal uuid;
  v_fill_contact boolean;
  v_deal_signer boolean;
  v_signer boolean;
  v_changed boolean;
  v_record uuid;
  v_entries uuid[];
  v_drop uuid[] := '{}';
  v_attempt app.signature_pdf_attempts;
  v_count integer := 0;
  v_more integer;
begin
  if p_org is null or p_id is null or p_type not in ('leads', 'contacts') then
    return 0;
  end if;
  if p_type <> 'contacts' then
    v_deals := '{}';
  end if;
  -- everything the person ever held, for unsigned documents
  v_all := app.signature_person_values(p_org, p_type, p_id, p_row, null);

  select coalesce(array_agg(d.id order by d.id), '{}') into v_candidates
    from public.signature_documents d
   where d.organization_id = p_org and d.erased_at is null
     -- not ON the erased record: those are emptied by app.signature_documents_erase
     and case when p_type = 'leads' then d.lead_id is distinct from p_id and d.former_lead_id is distinct from p_id
              else d.contact_id is distinct from p_id and d.former_contact_id is distinct from p_id end
     and (p_id = any (d.people) or d.deal_id = any (v_deals) or d.former_deal_id = any (v_deals));

  foreach v_id in array v_candidates loop
    -- review (1): the lock app.signature_pdf_write takes, before the row (the same order), so no render is kept mid-erasure
    perform pg_advisory_xact_lock(hashtextextended('signature_pdf:' || v_id::text, 0));
    select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = v_id for update;
    if not found or v_doc.erased_at is not null then
      continue;
    end if;
    v_deal := coalesce(v_doc.deal_id, v_doc.former_deal_id);
    -- the deal's contact when the document was filled (sent), and when it was signed
    v_fill_contact := p_type = 'contacts' and v_deal is not null
                      and (v_deal = any (v_deals) or app.signature_deal_contact_at(p_org, v_deal, v_doc.sent_at) is not distinct from p_id);
    v_deal_signer := p_type = 'contacts' and v_deal is not null and v_doc.status = 'signed'
                     and (v_deal = any (v_deals) or app.signature_deal_contact_at(p_org, v_deal, v_doc.signed_at) is not distinct from p_id);

    -- review (2): a signed document only by what the person held when it was signed, names of 3 characters or more
    v_values := case when v_doc.status = 'signed' then app.signature_person_values(p_org, p_type, p_id, p_row, v_doc.signed_at)
                     else v_all end;
    -- delta review: the signer is matched by the names and ID numbers the person held when it was signed, so a later rename
    -- to a third party's name never clears that party's signature
    select coalesce(array_agg(distinct app.signature_name_key(s.x)) filter (where app.signature_name_key(s.x) is not null), '{}')
      into v_keys from jsonb_array_elements_text(v_values -> 'names') s (x);
    select coalesce(array_agg(distinct regexp_replace(s.x, '[^0-9]', '', 'g')), '{}')
      into v_ids from jsonb_array_elements_text(v_values -> 'ids') s (x);
    select coalesce(array_agg(distinct v.y), '{}') into v_base
      from (select x from jsonb_array_elements_text(v_values -> 'names') x
             where v_doc.status <> 'signed' or char_length(x) >= 3
            union all select x from jsonb_array_elements_text(v_values -> 'details') x) s
      cross join lateral (values (s.x), (app.document_literal(s.x))) as v (y);
    select coalesce(array_agg(distinct v.y), '{}') into v_parts
      from jsonb_array_elements_text(v_values -> 'parts') s (x)
      cross join lateral (values (s.x), (app.document_literal(s.x))) as v (y)
     where v_doc.status <> 'signed' or char_length(s.x) >= 3;
    v_needles := v_base || case when v_fill_contact then v_parts else '{}'::text[] end;

    v_new := v_doc;
    v_new.body := app.signature_scrubbed_body(v_doc.body, v_needles);
    v_new.title := btrim(app.signature_scrub(v_doc.title, v_needles, '(נמחק)'));
    if v_new.title = '' or char_length(v_new.title) > 120 then
      v_new.title := 'מסמך לחתימה (פרטים הוסרו)';
    end if;
    v_changed := v_new.body is distinct from v_doc.body or v_new.title is distinct from v_doc.title;
    v_record := coalesce(v_doc.lead_id, v_doc.contact_id, v_doc.company_id, v_doc.deal_id, v_doc.former_lead_id,
                         v_doc.former_contact_id, v_doc.former_company_id, v_doc.former_deal_id);

    if v_changed then
      -- an unsigned document is signed on what the page shows now; a signed one keeps the evidence of what was signed
      update public.signature_documents d
         set body = v_new.body, title = v_new.title, text_erased_at = coalesce(d.text_erased_at, now()),
             content_sha256 = case when d.status = 'signed' then d.content_sha256 else app.signature_fingerprint(v_new) end
       where d.organization_id = p_org and d.id = v_doc.id;
      v_count := v_count + 1;
      if v_new.title is distinct from v_doc.title then
        -- the timeline entries carry the title; their audit entries (which held it) are erased
        with changed as (
          update public.activities a set body = app.signature_scrub(a.body, v_needles, '(נמחק)')
           where a.organization_id = p_org and a.type = 'system'
             and a.metadata ->> 'kind' in ('signature_sent', 'signature_signed', 'signature_cancelled')
             and a.metadata ->> 'signature_document_id' = v_doc.id::text
             and a.body is distinct from app.signature_scrub(a.body, v_needles, '(נמחק)')
          returning a.id)
        select coalesce(array_agg(c.id), '{}') into v_entries from changed c;
        v_count := v_count + cardinality(v_entries);
        update public.audit_log al set changes = '{"erased": true}'::jsonb
         where al.organization_id = p_org and al.entity_type = 'activities' and al.entity_id = any (v_entries)
           and al.changes is distinct from '{"erased": true}'::jsonb;
        -- the "signed" notices carried the title only
        update public.notifications n set body = v_new.title
         where n.organization_id = p_org and n.type = 'system' and n.title = 'מסמך נחתם בקישור'
           and n.entity_id = v_record and n.body = v_doc.title;
        get diagnostics v_more = row_count;
        v_count := v_count + v_more;
      end if;
    end if;

    -- the signer, by the safe reading of the header
    v_signer := false;
    if v_doc.status = 'signed' then
      v_signer := exists (select 1 from public.signature_signatures s
                           where s.organization_id = p_org and s.document_id = v_doc.id and s.erased_at is null
                             and (v_deal_signer
                                  or app.signature_name_key(s.signer_name) = any (v_keys)
                                  or (s.signer_id_number is not null
                                      and regexp_replace(s.signer_id_number, '[^0-9]', '', 'g') = any (v_ids))));
    end if;
    if v_signer then
      update public.signature_signatures s
         set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
             erased_at = coalesce(s.erased_at, now())
       where s.organization_id = p_org and s.document_id = v_doc.id;
      v_count := v_count + 1;
    end if;

    if v_changed or v_signer then
      v_drop := v_drop || v_doc.id;
    end if;
  end loop;

  -- review (1): an upload in flight is handed to the orphan cleanup and never kept
  for v_attempt in
    select * from app.signature_pdf_attempts a
     where a.organization_id = p_org and a.document_id = any (v_drop) and a.done_at is null
  loop
    perform app.quote_pdf_abandon(p_org, v_attempt.storage_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = v_attempt.storage_path;
  end loop;
  -- the signed PDFs printed the text and the signer as they were
  perform app.signature_pdf_drop(p_org, v_drop);
  return v_count;
end;
$$;
revoke all on function app.signature_documents_erase_named(uuid, text, uuid, jsonb, uuid[]) from public, anon, authenticated, service_role;

-- (234) ב: the documents ON the erased record, emptied as before
create or replace function app.signature_documents_erase(p_org uuid, p_type text, p_id uuid, p_deals uuid[]) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_docs uuid[];
  v_titles text[];
  v_records uuid[];
  v_entries uuid[];
  v_count integer := 0;
  v_more integer;
  v_attempt app.signature_pdf_attempts;
begin
  if p_org is null or p_id is null or p_type not in ('leads', 'contacts', 'deals', 'companies') then
    return 0;
  end if;
  select coalesce(array_agg(d.id), '{}'), coalesce(array_agg(distinct d.title), '{}'),
         coalesce(array_agg(distinct coalesce(d.lead_id, d.contact_id, d.company_id, d.deal_id, d.former_lead_id,
                                              d.former_contact_id, d.former_company_id, d.former_deal_id)), '{}')
    into v_docs, v_titles, v_records
    from public.signature_documents d
   where d.organization_id = p_org
     and case p_type
           -- (234) ב: only the person's own documents (detached by the purge); the documents of other records that name
           -- them were handled by app.signature_documents_erase_named before the audit entries were erased. p_deals is kept
           -- in the signature and no longer read here.
           when 'leads' then d.former_lead_id = p_id or d.lead_id = p_id
           when 'contacts' then d.former_contact_id = p_id or d.contact_id = p_id
           -- review 2 (10 November 2026): an erased deal or company empties its own detached documents, as its quote and
           -- order decisions are emptied
           when 'deals' then d.former_deal_id = p_id
           else d.former_company_id = p_id
         end;
  if cardinality(v_docs) = 0 then
    return 0;
  end if;
  -- (234) ב review (1): each document's PDF lock (app.signature_pdf_write's), and no upload in flight is kept
  perform pg_advisory_xact_lock(hashtextextended('signature_pdf:' || s.x::text, 0))
     from (select x from unnest(v_docs) x order by x) s;
  for v_attempt in
    select * from app.signature_pdf_attempts a
     where a.organization_id = p_org and a.document_id = any (v_docs) and a.done_at is null
  loop
    perform app.quote_pdf_abandon(p_org, v_attempt.storage_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = v_attempt.storage_path;
  end loop;

  update public.signature_documents d
     set body = 'המסמך נמחק (מחיקת פרטיות)', title = 'מסמך לחתימה (נמחק)', erased_at = coalesce(d.erased_at, now()),
         text_erased_at = coalesce(d.text_erased_at, now())
   where d.organization_id = p_org and d.id = any (v_docs)
     and (d.erased_at is null or d.body <> 'המסמך נמחק (מחיקת פרטיות)');
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;
  -- the link answers not found from now on
  update app.signature_links l set token_hash = null where l.organization_id = p_org and l.document_id = any (v_docs);

  update public.signature_signatures s
     set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
         erased_at = coalesce(s.erased_at, now())
   where s.organization_id = p_org and s.document_id = any (v_docs)
     and (s.erased_at is null or s.signer_name is not null or s.signer_id_number is not null or s.signature_image is not null
          or s.ip is not null or s.user_agent is not null);
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  -- the timeline entries keep their kind, with a neutral body; their audit entries (which held the title) are erased
  with changed as (
    update public.activities a
       set body = case a.metadata ->> 'kind'
                    when 'signature_sent' then 'נשלח מסמך לחתימה (הפרטים נמחקו)'
                    when 'signature_signed' then 'הלקוח חתם על המסמך (הפרטים נמחקו)'
                    else 'בוטל מסמך לחתימה (הפרטים נמחקו)' end
     where a.organization_id = p_org and a.type = 'system'
       and a.metadata ->> 'kind' in ('signature_sent', 'signature_signed', 'signature_cancelled')
       and a.metadata ->> 'signature_document_id' = any (v_docs::text[])
    returning a.id)
  select coalesce(array_agg(c.id), '{}') into v_entries from changed c;
  v_count := v_count + cardinality(v_entries);
  update public.audit_log al set changes = '{"erased": true}'::jsonb
   where al.organization_id = p_org and al.entity_type = 'activities' and al.entity_id = any (v_entries)
     and al.changes is distinct from '{"erased": true}'::jsonb;

  -- the "signed" notices carried the title only
  update public.notifications n set body = 'מסמך לחתימה (הפרטים נמחקו)'
   where n.organization_id = p_org and n.type = 'system' and n.title = 'מסמך נחתם בקישור'
     and n.entity_id = any (v_records) and n.body = any (v_titles);
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  -- an upload in flight finds no source any more (signature_pdf_source answers null for an erased document)
  perform app.signature_pdf_drop(p_org, v_docs);
  return v_count;
end;
$$;
revoke all on function app.signature_documents_erase(uuid, text, uuid, uuid[]) from public, anon, authenticated, service_role;

-- 021212's app.signature_pdf_source with document.text_erased
create or replace function app.signature_pdf_source(p_doc public.signature_documents) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_sig public.signature_signatures;
  v_org public.organizations;
  v_settings public.org_document_settings;
begin
  if p_doc.status <> 'signed' or p_doc.erased_at is not null then
    return null;
  end if;
  select * into v_sig from public.signature_signatures s
   where s.organization_id = p_doc.organization_id and s.document_id = p_doc.id and s.erased_at is null;
  if not found then
    return null;
  end if;
  select * into v_org from public.organizations o where o.id = p_doc.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = p_doc.organization_id;
  return jsonb_build_object(
    -- (234) ב: a signed document whose text an erasure changed prints the line saying so
    'document', jsonb_build_object('title', p_doc.title, 'body', p_doc.body, 'sent_at', p_doc.sent_at,
                                   'text_erased', p_doc.text_erased_at is not null,
                                   -- delta review: the text as it is now, passed back as p_fingerprint
                                   'fingerprint', app.signature_fingerprint(p_doc)),
    'business', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'tax_id', v_settings.tax_id,
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), '')),
      'email', v_settings.email),
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'signature', jsonb_build_object(
      'signer_name', v_sig.signer_name,
      'id_number', v_sig.signer_id_number,
      'kind', v_sig.signature_kind,
      'image', case when v_sig.signature_kind = 'drawn' then v_sig.signature_image end,
      'signed_at', v_sig.signed_at,
      'time_zone', app.intake_zone(v_org.timezone),
      'wording_version', v_sig.wording_version,
      -- review 5: the registered text of that version (null for a version not registered)
      'wording', (select w.wording from app.signature_wording_versions w where w.version = v_sig.wording_version),
      'fingerprint', v_sig.content_sha256));
end;
$$;
revoke all on function app.signature_pdf_source(public.signature_documents) from public, anon, authenticated, service_role;

-- 021212's app.signature_pdf_write with the stale-render refusal
create or replace function app.signature_pdf_write(p_doc_id uuid, p_org uuid, p_path text, p_size bigint, p_sha256 text,
                                                   p_fingerprint text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents;
  v_file public.files;
  v_attempt app.signature_pdf_attempts;
  v_obj record;
  v_id uuid;
  v_path text;
  v_day text;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size < 1 or p_size > 26214400 then
    raise exception 'invalid PDF details' using errcode = '22023', hint = 'signature_pdf:invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('signature_pdf:' || p_doc_id::text, 0));
  select * into v_doc from public.signature_documents d where d.organization_id = p_org and d.id = p_doc_id;
  if not found or v_doc.status <> 'signed' or app.signature_pdf_source(v_doc) is null then
    raise exception 'a signed PDF is made for a signed document' using errcode = 'P0001', hint = 'signature_pdf:not_signed';
  end if;
  -- (234) ב delta review: the render must have printed the text the document holds now (its current fingerprint equals
  -- content_sha256 until an erasure changes the text; a caller that passes the signature's fingerprint still works then)
  if p_fingerprint is distinct from app.signature_fingerprint(v_doc) then
    perform app.signature_pdf_abandon(p_org, p_doc_id, p_path);
    return jsonb_build_object('status', 'changed');
  end if;

  select * into v_file from public.files f where f.organization_id = p_org and f.signature_document_id = p_doc_id;
  if found then
    -- kept once: another attempt's path is not the file
    if p_path is distinct from v_file.storage_path then
      perform app.signature_pdf_abandon(p_org, p_doc_id, p_path);
    end if;
    return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
  end if;

  if p_path is null then
    -- earlier attempts that never finished are left to the orphan cleanup
    for v_attempt in
      select * from app.signature_pdf_attempts a
       where a.document_id = p_doc_id and a.done_at is null and a.created_at < now() - interval '10 minutes'
    loop
      perform app.quote_pdf_abandon(p_org, v_attempt.storage_path);
      update app.signature_pdf_attempts a set done_at = now() where a.storage_path = v_attempt.storage_path;
    end loop;
    v_path := p_org::text || '/' || gen_random_uuid()::text;
    insert into app.signature_pdf_attempts (storage_path, organization_id, document_id) values (v_path, p_org, p_doc_id);
    return jsonb_build_object('status', 'upload', 'path', v_path);
  end if;

  select * into v_attempt from app.signature_pdf_attempts a
   where a.storage_path = p_path and a.document_id = p_doc_id and a.organization_id = p_org and a.done_at is null;
  if not found then
    raise exception 'not a path of this document' using errcode = '22023', hint = 'signature_pdf:invalid';
  end if;
  -- (234) ב review (1): an upload issued before an erasure changed the text is never kept (the render printed the old text)
  if v_doc.text_erased_at is not null and v_attempt.created_at <= v_doc.text_erased_at then
    perform app.quote_pdf_abandon(p_org, p_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = p_path;
    return jsonb_build_object('status', 'changed');
  end if;
  select * into v_obj from app.record_file_object(p_path);
  if not coalesce(v_obj.present, false) then
    return jsonb_build_object('status', 'upload', 'path', p_path);
  end if;
  if v_obj.size is distinct from p_size or v_obj.mimetype is distinct from 'application/pdf' then
    perform app.quote_pdf_abandon(p_org, p_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = p_path;
    raise exception 'the uploaded object is not the stated PDF' using errcode = '22023', hint = 'signature_pdf:invalid';
  end if;

  -- the row's path is <org>/<id> (files_before_insert), so the id is the attempt's
  v_id := substr(p_path, length(p_org::text) + 2)::uuid;
  v_day := to_char(v_doc.signed_at at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)), 'YYYY-MM-DD');
  insert into public.files (id, organization_id, signature_document_id, name, mime_type, size_bytes, sha256)
  values (v_id, p_org, p_doc_id, 'מסמך חתום ' || v_day || '.pdf', 'application/pdf', p_size, p_sha256)
  returning * into v_file;
  update public.files f set upload_checked_at = now() where f.organization_id = p_org and f.id = v_file.id;
  update app.signature_pdf_attempts a set done_at = now() where a.storage_path = p_path;
  -- any other unfinished attempt of the document is not needed any more
  for v_attempt in
    select * from app.signature_pdf_attempts a where a.document_id = p_doc_id and a.done_at is null
  loop
    perform app.quote_pdf_abandon(p_org, v_attempt.storage_path);
    update app.signature_pdf_attempts a set done_at = now() where a.storage_path = v_attempt.storage_path;
  end loop;
  return jsonb_build_object('status', 'stored', 'file_id', v_file.id);
end;
$$;
revoke all on function app.signature_pdf_write(uuid, uuid, text, bigint, text, text) from public, anon, authenticated, service_role;

-- 021212's public.signature_public with document.text_erased
create or replace function public.signature_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_doc public.signature_documents := app.signature_token_document(p_token);
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_org public.organizations;
  v_settings public.org_document_settings;
  v_phone text;
  v_built_with boolean;
  v_expired boolean;
begin
  -- 120 views per link in 10 minutes, counted first
  update app.signature_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.document_id = v_doc.id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 60 views per sender in 10 minutes (keyed IP hash, scope "signature", scoped to this document)
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.signature_link_sender(v_doc.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.signature_link_view_counts as vc (document_id, bucket, window_start, views)
    values (v_doc.id, v_bucket, now(), 1)
    on conflict (document_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select * into v_org from public.organizations o where o.id = v_doc.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_doc.organization_id;
  v_phone := coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), ''));
  v_expired := v_doc.status in ('sent', 'viewed') and v_doc.expires_at is not null and v_doc.expires_at <= now();

  if v_doc.status = 'cancelled' or v_expired then
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', case when v_doc.status = 'cancelled' then 'cancelled' else 'expired' end,
      'title', v_doc.title,
      'business', v_org.name,
      'logo', v_org.logo_path,
      'color', v_org.brand_color,
      'phone', v_phone));
  end if;

  -- the first view of a document that waits for its signature
  if v_doc.status = 'sent' then
    update public.signature_documents d set status = 'viewed', viewed_at = now()
     where d.organization_id = v_doc.organization_id and d.id = v_doc.id and d.status = 'sent'
    returning * into v_doc;
  end if;

  begin
    v_built_with := coalesce(app.show_built_with(v_doc.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'document', jsonb_build_object(
      'title', v_doc.title,
      'body', v_doc.body,
      'status', v_doc.status,
      'sent_at', v_doc.sent_at,
      'signed_at', v_doc.signed_at,
      'expires_at', v_doc.expires_at,
      -- (234) ב: a signed document whose text an erasure changed says so on the page
      'text_erased', v_doc.status = 'signed' and v_doc.text_erased_at is not null),
    'business', jsonb_build_object('name', v_org.name, 'phone', v_phone),
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    -- review 6: the page writes its dates in the business's zone
    'time_zone', app.intake_zone(v_org.timezone),
    'built_with', v_built_with,
    -- what a signature must name, while the document waits for one
    'fingerprint', case when v_doc.status in ('sent', 'viewed') then v_doc.content_sha256 end);
end;
$$;
revoke all on function public.signature_public(text, text) from public, anon, authenticated;
grant execute on function public.signature_public(text, text) to service_role;

-- 021214's body with the call to app.signature_documents_erase_named added (before the audit entries are erased)
CREATE OR REPLACE FUNCTION app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- SGN-02 (234) ב: the documents of other records that name the person
  v_named integer := 0;
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
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders', 'accounting_documents', 'payments', 'customer_holds', 'punch_cards') and a.entity_id is not null
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
    -- QUO-08 (owner, 1 November 2026): the customer's questions on those quotes keep only that a question was asked; the
    -- entries' audit history (the text included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = 'שאלה מהלקוח על הצעת מחיר' || coalesce(' ' || (ac.metadata ->> 'number'), '') || ' (הטקסט נמחק)'
       where ac.organization_id = p_org and ac.type = 'system' and ac.metadata ->> 'kind' = 'quote_question'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
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
                       -- QUO-08: a question's text leaves the body like a decline reason
                       else nullif(regexp_replace(n.body, '( · )?(סיבה|שאלה): .*$', ''), '') end
     where n.organization_id = p_org and n.entity_type = 'quote'
       and n.entity_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
       and (n.type = 'quote_viewed' or (n.type = 'quote' and (n.title like '%: %' or n.body like '%סיבה: %' or n.body like '%שאלה: %')));
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
    -- ORD-05 PDF: the stored PDF of those orders holds the customer's name, details, notes and line texts, so it goes (as a
    -- quote's, QUO-06 answer (2) א); its object follows through the orphan cleanup (app.orphan_files)
    perform app.order_pdf_drop(p_org, array(select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%'));
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
  -- GAP-12: and a company's opening balances (the only document a company carries)
  if p_type in ('contacts', 'deals', 'companies') then
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
    -- DOC-02: the lines of those documents keep their numbers; a line's text (staff may have typed the customer's name)
    -- becomes the neutral text, and every entry of the lines (their insert and this update) is erased below with the rest
    for v_child in
      select 'accounting_document_lines'::text as entity_type, l.id as entity_id from public.accounting_document_lines l
       where l.organization_id = p_org
         and l.document_id = any (array(select substr(c, 22)::uuid from unnest(v_children) c where c like 'accounting_documents:%'))
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    update public.accounting_document_lines l set description = 'הפריט נמחק (מחיקת פרטיות)'
     where l.organization_id = p_org and l.description is distinct from 'הפריט נמחק (מחיקת פרטיות)'
       and l.document_id = any (array(select substr(c, 22)::uuid from unnest(v_children) c where c like 'accounting_documents:%'));
    perform set_config('app.document_server', '', true);
    -- COL-03: the payment promises of those documents keep their date; the collection note (staff may have named the customer)
    -- is emptied, and every entry of them (a removed one's too, by its delete entry) is erased below with the rest
    for v_child in
      select 'payment_promises'::text as entity_type, pp.id as entity_id from public.payment_promises pp
       where pp.organization_id = p_org and ('accounting_documents:' || pp.document_id) = any (v_children)
      union
      select 'payment_promises', a.entity_id from public.audit_log a
       where a.organization_id = p_org and a.entity_type = 'payment_promises' and a.entity_id is not null
         and ('accounting_documents:' || coalesce(a.changes ->> 'document_id', a.changes -> 'document_id' ->> 'old')) = any (v_children)
      union
      -- a customer promise of the erased contact or company (gone with it by cascade at the purge): its entries
      select 'payment_promises', a.entity_id from public.audit_log a
       where p_type in ('contacts', 'companies')
         and a.organization_id = p_org and a.entity_type = 'payment_promises' and a.entity_id is not null
         and coalesce(a.changes ->> v_col, a.changes -> v_col ->> 'old') = p_id::text
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    update public.payment_promises pp set note = null
     where pp.organization_id = p_org and pp.note is not null and ('accounting_documents:' || pp.document_id) = any (v_children);
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

  -- PKG-01 (owner (87) ב): a card transferred or merged away from the person keeps its numbers; its free text and the
  -- entries that name the person go (app.punch_cards_erase; PKG-02 adds the entries of the cards' used entries)
  if p_type = 'contacts' then
    v_children := v_children || app.punch_cards_erase(p_org, p_id, v_children);
  end if;

  -- SGN-02 (234) ב: the documents of OTHER records that name the person keep everything but the person's values, read from
  -- the record's audit entries, so before they are erased
  if p_type in ('leads', 'contacts') then
    v_named := app.signature_documents_erase_named(p_org, p_type, p_id, v_row, v_deals);
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

  -- SGN-02: the person's own detached documents for signature ((234) ב), and a deal's or a company's own detached documents
  -- (review 2), emptied
  v_count := v_count + app.signature_documents_erase(p_org, p_type, p_id, v_deals);

  v_count := v_count + v_notes;
  v_count := v_count + v_named;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$function$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
