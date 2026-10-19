-- =============================================================================
-- Privacy erasure of a sent quote: hand-edited line names go too (QUO-07, GAP-09; owner, 19 October 2026)
-- =============================================================================
-- The owner's answer to the independent review's question: the names of quote lines that were edited by hand are
-- emptied; payment step names, milestones and the quote's terms are not.
-- * app.audit_erase_core (the body of 020370, its latest): in the block for a sent quote detached from an erased contact
--   or deal, the quote's cancel reason (QUO-11, staff free text) is emptied and its timeline entry loses " · סיבה: …"
--   (the entry's audit history is erased with the rest); and a product line whose name differs from its product's current catalog name (an edit by hand in the draft)
--   takes the catalog name; free lines and headings were already given a neutral name ("שורה" / "קבוצה"), and every
--   description was already emptied. Nothing else changes.
-- Safe to run twice.

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
