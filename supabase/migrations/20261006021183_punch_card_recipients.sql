-- =============================================================================
-- PKG-06: a payer and a separate service recipient (משלם ומקבל שירות נפרדים)
-- =============================================================================
-- "הורה משלם וילד משתתף, חברה משלמת ועובד מקבל. המסמך יוצא למשלם, והפגישות והכרטיסייה רשומות על מקבל השירות. נשען על
-- CON-06" (SPEC-ADDITIONS, wave 3). Owner's answers of 9 November 2026 (DECISIONS.md, questions 149-151):
-- (149) א a service recipient PER punch card line of a quote or an order (each line its own; a parent buying two cards for
--       two children is the normal case). The document and the money stay on the payer (the quote's / order's contact or
--       company); the card opens on the recipient. punch_card_transfer stays as the correction after opening.
-- (150) ג the recipient is a contact linked to the payer by a CON-06 relation (public.contact_relations, either direction),
--       or an employee of the paying company (a contact whose company is the document's company, or a CON-05
--       contact_companies link to it). The seller adds the relation, or a new contact, from the line (app side).
-- (151) ג with a default: the customer's punch card messages (PKG-03) go to the recipient AND to the payer when the payer is
--       not the recipient; a business may choose "payer only" (punch_card_alert_settings.notices_to = 'payer'); a recipient
--       with no channel the message can go by = the payer only. The rep's notice is unchanged (the holder's owner).
--
-- * quote_lines.recipient_contact_id, order_lines.recipient_contact_id: nullable, composite FK to contacts, on delete set
--   null of the column; column grants. Trigger *_lines_recipient (definer, app.document_line_recipient; outsider guard
--   first): only a punch card product line takes one (hint punch_recipient:line); the contact must be live and read by the
--   person (punch_recipient:contact) and linked to the payer (punch_recipient:not_linked, app.punch_recipient_linked); it
--   changes only while the document is a draft (quote:frozen / order:frozen), for every writer but the foreign key's own
--   set-null and the merge (transaction setting app.punch_recipient_server = 'on'). A null recipient = the payer.
--   Copies: a quote version (QUO-12, app.quote_version_copy) and an order made from a quote take the recipient of the line
--   at the same position with the same product (the rule of PRD-09's bundle copy), only while it is still linked to the
--   payer; quote_duplicate (redefined from 021136, plus the recipient) copies it on the same terms. A draft whose customer
--   changes drops recipients no longer linked to the new payer (quotes_punch_recipients / orders_punch_recipients).
--   app.order_lines_check (020595's body) lets the recipient's set-null through on a numbered order, like a price list's.
-- * punch_cards.payer_contact_id, payer_company_id (server only, composite FKs set null): set by the automatic opening when
--   the card's holder is a line's recipient other than the payer; null = the holder is the payer. Indexed.
-- * app.punch_cards_auto_open (021164's body): each line's cards open on its live recipient, else on the payer as before; a
--   payer gone or in the bin still lets a live recipient's cards open. It answers `holders` {contact: count};
--   app.punch_cards_note writes the one timeline entry per payment on each holder.
-- * public.punch_card_recipient_options(org, kind, doc) (definer, a member who edits the draft): the contacts the person
--   reads that may be the recipient of that document's lines (the payer first), at most 200.
-- * app.send_punch_card_alerts (021178's body): the customer's message goes to app.punch_card_notice_targets (151).
-- * Merge (app.merge_punch_recipients on the `merged` entry), erasure (app.punch_cards_erase, 021168's body: the person's
--   id leaves the log entries of cards they paid for and of lines that named them), sample data (app.sample_untouched) and
--   import undo (app.import_record_worked), both 021165's bodies: a recipient on a line, or a card paid, is real work.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The recipient on the document lines
-- ----------------------------------------------------------------------------
alter table public.quote_lines add column if not exists recipient_contact_id uuid;
alter table public.order_lines add column if not exists recipient_contact_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quote_lines_recipient_fk' and conrelid = 'public.quote_lines'::regclass) then
    alter table public.quote_lines add constraint quote_lines_recipient_fk foreign key (organization_id, recipient_contact_id)
      references public.contacts (organization_id, id) on delete set null (recipient_contact_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_lines_recipient_fk' and conrelid = 'public.order_lines'::regclass) then
    alter table public.order_lines add constraint order_lines_recipient_fk foreign key (organization_id, recipient_contact_id)
      references public.contacts (organization_id, id) on delete set null (recipient_contact_id);
  end if;
end;
$$;
create index if not exists quote_lines_recipient_idx on public.quote_lines (organization_id, recipient_contact_id);
create index if not exists order_lines_recipient_idx on public.order_lines (organization_id, recipient_contact_id);

grant insert (recipient_contact_id), update (recipient_contact_id) on public.quote_lines to authenticated;
grant insert (recipient_contact_id), update (recipient_contact_id) on public.order_lines to authenticated;

-- The payer on the card (server only: no client write grant on punch_cards at all)
alter table public.punch_cards add column if not exists payer_contact_id uuid;
alter table public.punch_cards add column if not exists payer_company_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'punch_cards_payer_contact_fk' and conrelid = 'public.punch_cards'::regclass) then
    alter table public.punch_cards add constraint punch_cards_payer_contact_fk foreign key (organization_id, payer_contact_id)
      references public.contacts (organization_id, id) on delete set null (payer_contact_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'punch_cards_payer_company_fk' and conrelid = 'public.punch_cards'::regclass) then
    alter table public.punch_cards add constraint punch_cards_payer_company_fk foreign key (organization_id, payer_company_id)
      references public.companies (organization_id, id) on delete set null (payer_company_id);
  end if;
end;
$$;
create index if not exists punch_cards_payer_contact_idx on public.punch_cards (organization_id, payer_contact_id);
create index if not exists punch_cards_payer_company_idx on public.punch_cards (organization_id, payer_company_id);

-- (151) who gets the customer's message: the recipient and the payer (default), or the payer only
alter table public.punch_card_alert_settings add column if not exists notices_to text not null default 'both';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'punch_card_alert_settings_notices_to_check'
                   and conrelid = 'public.punch_card_alert_settings'::regclass) then
    alter table public.punch_card_alert_settings add constraint punch_card_alert_settings_notices_to_check
      check (notices_to in ('both', 'payer'));
  end if;
end;
$$;
grant insert (notices_to), update (notices_to) on public.punch_card_alert_settings to authenticated;

-- ----------------------------------------------------------------------------
-- (150) ג the rule: who may be the recipient of a payer's line
-- ----------------------------------------------------------------------------
-- The payer contact itself; a contact linked to it by a CON-06 relation in either direction; an employee of the paying
-- company (contacts.company_id, or a CON-05 link). Liveness and reading are the callers' (definer; no grants).
create or replace function app.punch_recipient_linked(p_org uuid, p_payer_contact uuid, p_payer_company uuid, p_recipient uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(p_recipient is not null and (
    p_recipient = p_payer_contact
    or (p_payer_contact is not null and exists (
          select 1 from public.contact_relations r
           where r.organization_id = p_org
             and ((r.contact_id = p_payer_contact and r.related_contact_id = p_recipient)
                  or (r.contact_id = p_recipient and r.related_contact_id = p_payer_contact))))
    or (p_payer_company is not null and (
          exists (select 1 from public.contacts c
                   where c.organization_id = p_org and c.id = p_recipient and c.company_id = p_payer_company)
          or exists (select 1 from public.contact_companies cc
                      where cc.organization_id = p_org and cc.contact_id = p_recipient and cc.company_id = p_payer_company)))
  ), false)
$$;
revoke all on function app.punch_recipient_linked(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- A live contact of the business that may be the recipient (p_reader: the person writing must read it too)
create or replace function app.punch_recipient_ok(p_org uuid, p_payer_contact uuid, p_payer_company uuid, p_recipient uuid, p_reader boolean)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
           case when p_reader then app.punch_card_contact_ok(p_org, p_recipient)
                else exists (select 1 from public.contacts c
                              where c.organization_id = p_org and c.id = p_recipient and c.deleted_at is null) end, false)
     and app.punch_recipient_linked(p_org, p_payer_contact, p_payer_company, p_recipient)
$$;
revoke all on function app.punch_recipient_ok(uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The line trigger (one function for both tables; the document id read from the row's json, so no branch reads a column
-- the firing table lacks)
-- ----------------------------------------------------------------------------
create or replace function app.document_line_recipient() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote boolean := tg_table_name = 'quote_lines';
  v_doc uuid := coalesce(to_jsonb(new) ->> 'quote_id', to_jsonb(new) ->> 'order_id')::uuid;
  v_status text;
  v_contact uuid;
  v_company uuid;
  v_previous uuid;
  v_source text;
  v_from_quote uuid;
  v_copied uuid;
  v_kind text;
begin
  if tg_op = 'UPDATE' and new.recipient_contact_id is not distinct from old.recipient_contact_id then
    return new;
  end if;
  -- the foreign key's own set-null (a contact purged), and this migration's follow trigger, a level below the statement
  if tg_op = 'UPDATE' and new.recipient_contact_id is null and pg_trigger_depth() > 1 then
    return new;
  end if;
  -- the merge moves a duplicate's lines to the kept contact (app.merge_punch_recipients)
  if coalesce(current_setting('app.punch_recipient_server', true), '') = 'on' then
    return new;
  end if;
  -- outsider guard: RLS refuses (42501) a person who is not a member
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return new;
  end if;
  if v_quote then
    select q.status, q.contact_id, q.company_id, q.previous_id into v_status, v_contact, v_company, v_previous
      from public.quotes q where q.organization_id = new.organization_id and q.id = v_doc;
  else
    select o.status, o.contact_id, o.company_id, o.source, o.quote_id into v_status, v_contact, v_company, v_source, v_from_quote
      from public.orders o where o.organization_id = new.organization_id and o.id = v_doc;
  end if;

  if tg_op = 'INSERT' and new.recipient_contact_id is null then
    -- a copy: a quote version (QUO-12) or an order made from a quote takes the recipient of the line at the same place
    -- with the same product, while it is still linked to the payer
    if new.product_id is null then
      return new;
    end if;
    if v_quote and v_previous is not null and coalesce(current_setting('app.quote_version_copy', true), '') = v_doc::text then
      select l.recipient_contact_id into v_copied from public.quote_lines l
       where l.organization_id = new.organization_id and l.quote_id = v_previous
         and l.position = new.position and l.product_id = new.product_id and l.recipient_contact_id is not null
       order by l.id limit 1;
    elsif not v_quote and v_source = 'quote' and v_from_quote is not null then
      select l.recipient_contact_id into v_copied from public.quote_lines l
       where l.organization_id = new.organization_id and l.quote_id = v_from_quote
         and l.position = new.position and l.product_id = new.product_id and l.recipient_contact_id is not null
       order by l.id limit 1;
    end if;
    if v_copied is not null and app.punch_recipient_ok(new.organization_id, v_contact, v_company, v_copied, false) then
      new.recipient_contact_id := v_copied;
    end if;
    return new;
  end if;

  -- a recipient is set or changed: only on a draft, for every writer
  if v_status is distinct from 'draft' then
    if v_quote then
      raise exception 'a sent quote does not change' using errcode = 'P0001', hint = 'quote:frozen';
    end if;
    raise exception 'a numbered order does not change' using errcode = 'P0001', hint = 'order:frozen';
  end if;
  if new.recipient_contact_id is null then
    return new;
  end if;
  if new.product_id is not null then
    select p.kind into v_kind from public.products p where p.organization_id = new.organization_id and p.id = new.product_id;
  end if;
  if v_kind is distinct from 'punch_card' then
    raise exception 'only a punch card line has a service recipient' using errcode = 'P0001', hint = 'punch_recipient:line';
  end if;
  if not coalesce(case when auth.uid() is not null then app.punch_card_contact_ok(new.organization_id, new.recipient_contact_id)
                       else exists (select 1 from public.contacts c where c.organization_id = new.organization_id
                                       and c.id = new.recipient_contact_id and c.deleted_at is null) end, false) then
    raise exception 'the contact is not available' using errcode = 'P0001', hint = 'punch_recipient:contact';
  end if;
  if not app.punch_recipient_linked(new.organization_id, v_contact, v_company, new.recipient_contact_id) then
    raise exception 'the recipient is not linked to the payer' using errcode = 'P0001', hint = 'punch_recipient:not_linked';
  end if;
  return new;
end;
$$;
revoke all on function app.document_line_recipient() from public, anon, authenticated, service_role;

create or replace trigger quote_lines_recipient before insert or update on public.quote_lines
  for each row execute function app.document_line_recipient();
create or replace trigger order_lines_recipient before insert or update on public.order_lines
  for each row execute function app.document_line_recipient();

-- A draft whose customer changes keeps only recipients still linked to the new payer (an update a level below the
-- statement: the line trigger lets the set-null through)
create or replace function app.document_recipients_follow() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'draft' then
    return null;
  end if;
  if tg_table_name = 'quotes' then
    update public.quote_lines l set recipient_contact_id = null
     where l.organization_id = new.organization_id and l.quote_id = new.id and l.recipient_contact_id is not null
       and not app.punch_recipient_linked(new.organization_id, new.contact_id, new.company_id, l.recipient_contact_id);
  else
    update public.order_lines l set recipient_contact_id = null
     where l.organization_id = new.organization_id and l.order_id = new.id and l.recipient_contact_id is not null
       and not app.punch_recipient_linked(new.organization_id, new.contact_id, new.company_id, l.recipient_contact_id);
  end if;
  return null;
end;
$$;
revoke all on function app.document_recipients_follow() from public, anon, authenticated, service_role;

-- Review finding 1: the link is judged again when the document stops changing (a quote sent, an order numbered), for every
-- writer: a recipient in the bin or unreadable (punch_recipient:contact), or no longer linked to the payer (the relation
-- removed, the employee gone; punch_recipient:not_linked), is refused and the seller fixes the line. Once sent or numbered the document is the record; a later change of a relation moves nothing.
create or replace function app.document_send_recipients() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
begin
  for v_recipient in
    select l.recipient_contact_id from public.quote_lines l
     where tg_table_name = 'quotes' and l.organization_id = new.organization_id and l.quote_id = new.id
       and l.recipient_contact_id is not null
    union
    select l.recipient_contact_id from public.order_lines l
     where tg_table_name = 'orders' and l.organization_id = new.organization_id and l.order_id = new.id
       and l.recipient_contact_id is not null
  loop
    -- re-review LOW 1: a recipient in the bin (or, for a person, one they do not read) is the contact's problem, not the link's
    if not coalesce(case when auth.uid() is not null then app.punch_card_contact_ok(new.organization_id, v_recipient)
                         else exists (select 1 from public.contacts c where c.organization_id = new.organization_id
                                         and c.id = v_recipient and c.deleted_at is null) end, false) then
      raise exception 'the contact is not available' using errcode = 'P0001', hint = 'punch_recipient:contact';
    end if;
    if not app.punch_recipient_linked(new.organization_id, new.contact_id, new.company_id, v_recipient) then
      raise exception 'the recipient is not linked to the payer' using errcode = 'P0001', hint = 'punch_recipient:not_linked';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function app.document_send_recipients() from public, anon, authenticated, service_role;

create or replace trigger quotes_punch_recipients_send before update of status on public.quotes
  for each row when (old.status = 'draft' and new.status = 'sent')
  execute function app.document_send_recipients();
create or replace trigger orders_punch_recipients_send before update of status on public.orders
  for each row when (old.status = 'draft' and new.status not in ('draft', 'cancelled'))
  execute function app.document_send_recipients();

create or replace trigger quotes_punch_recipients after update of contact_id, company_id on public.quotes
  for each row when (new.contact_id is distinct from old.contact_id or new.company_id is distinct from old.company_id)
  execute function app.document_recipients_follow();
create or replace trigger orders_punch_recipients after update of contact_id, company_id on public.orders
  for each row when (new.contact_id is distinct from old.contact_id or new.company_id is distinct from old.company_id)
  execute function app.document_recipients_follow();

-- ----------------------------------------------------------------------------
-- The choice on the line: who may be the recipient of this draft's punch card lines
-- ----------------------------------------------------------------------------
-- Definer: a member who may edit the draft (a draft only, with the punch_cards key); only contacts the person reads (app.punch_card_contact_ok), live, linked to the
-- payer by the one rule above; the payer first, then by name. `how`: payer | relation | employee.
create or replace function public.punch_card_recipient_options(p_org uuid, p_kind text, p_doc uuid)
returns table (contact_id uuid, name text, how text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_contact uuid;
  v_company uuid;
  v_ok boolean := false;
begin
  if p_kind = 'quote' then
    select q.contact_id, q.company_id, q.status = 'draft' and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)
      into v_contact, v_company, v_ok
      from public.quotes q where q.organization_id = p_org and q.id = p_doc;
  elsif p_kind = 'order' then
    select o.contact_id, o.company_id, o.status = 'draft' and app.order_editable(o.organization_id, o.deal_id, o.contact_id, o.company_id)
      into v_contact, v_company, v_ok
      from public.orders o where o.organization_id = p_org and o.id = p_doc;
  end if;
  -- review finding 4: a draft the person edits, in a business whose plan holds punch cards
  if not coalesce(v_ok, false) or not app.is_member(p_org) or not app.org_has_feature(p_org, 'punch_cards') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  return query
    select c.id, btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')),
           case when c.id = v_contact then 'payer'
                when v_company is not null and (c.company_id = v_company
                     or exists (select 1 from public.contact_companies cc
                                 where cc.organization_id = p_org and cc.contact_id = c.id and cc.company_id = v_company))
                  then 'employee'
                else 'relation' end
      from public.contacts c
     where c.organization_id = p_org and c.deleted_at is null
       and (c.id = v_contact
            or (v_contact is not null and c.id in (select r.related_contact_id from public.contact_relations r
                                                   where r.organization_id = p_org and r.contact_id = v_contact
                                                   union
                                                   select r.contact_id from public.contact_relations r
                                                   where r.organization_id = p_org and r.related_contact_id = v_contact))
            or (v_company is not null and (c.company_id = v_company
                 or c.id in (select cc.contact_id from public.contact_companies cc
                              where cc.organization_id = p_org and cc.company_id = v_company))))
       and app.punch_card_contact_ok(p_org, c.id)
     order by (c.id = v_contact) desc, lower(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))), c.id
     limit 200;
end;
$$;
revoke all on function public.punch_card_recipient_options(uuid, text, uuid) from public, anon;
grant execute on function public.punch_card_recipient_options(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Merge: lines naming the duplicate and cards it paid for go to the kept contact (after app.merge_punch_cards by name); a
-- company merge moves the cards the duplicate company paid for
-- ----------------------------------------------------------------------------
create or replace function app.merge_punch_recipients() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_before text := coalesce(current_setting('app.punch_recipient_server', true), '');
  v_order_before text := coalesce(current_setting('app.order_server', true), '');
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  -- review finding 6: a company merge moves the cards the duplicate company paid for
  if new.contact_id is null and new.company_id is not null and v_merged <> new.company_id then
    update public.punch_cards c set payer_company_id = new.company_id
     where c.organization_id = new.organization_id and c.payer_company_id = v_merged;
    return null;
  end if;
  if new.contact_id is null or v_merged = new.contact_id then
    return null;
  end if;
  perform set_config('app.punch_recipient_server', 'on', true);
  perform set_config('app.order_server', 'on', true);
  update public.quote_lines l set recipient_contact_id = new.contact_id
   where l.organization_id = new.organization_id and l.recipient_contact_id = v_merged;
  update public.order_lines l set recipient_contact_id = new.contact_id
   where l.organization_id = new.organization_id and l.recipient_contact_id = v_merged;
  perform set_config('app.punch_recipient_server', v_before, true);
  perform set_config('app.order_server', v_order_before, true);
  -- a card the duplicate paid for: the kept contact paid; when it now holds the card itself, it is no separate payer
  update public.punch_cards c
     set payer_contact_id = case when c.contact_id = new.contact_id then null else new.contact_id end
   where c.organization_id = new.organization_id and c.payer_contact_id = v_merged;
  -- a card the kept contact paid for that the duplicate held came to it with the merge (app.merge_punch_cards)
  update public.punch_cards c set payer_contact_id = null
   where c.organization_id = new.organization_id and c.contact_id = new.contact_id and c.payer_contact_id = new.contact_id;
  return null;
end;
$$;
revoke all on function app.merge_punch_recipients() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_punch_recipients after insert on public.activities
  for each row
  when (new.type = 'system' and (new.contact_id is not null or new.company_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_punch_recipients();

-- ----------------------------------------------------------------------------
-- (151) who gets a card's customer message: the holder (the recipient) and the payer, or the payer only
-- ----------------------------------------------------------------------------
-- The payer counts only while it is a live contact other than the holder. 'payer' (the business's choice) = the payer
-- only; otherwise the holder, and the payer beside it; a holder with no channel the message can go by = the payer only.
create or replace function app.punch_card_notice_targets(p_org uuid, p_card uuid, p_kind text) returns uuid[]
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_holder uuid;
  v_payer uuid;
  v_paid_by_other boolean;
  v_to text;
begin
  select c.contact_id,
         case when c.payer_contact_id is distinct from c.contact_id
                   and exists (select 1 from public.contacts p where p.organization_id = c.organization_id
                                  and p.id = c.payer_contact_id and p.deleted_at is null)
              then c.payer_contact_id end,
         (c.payer_contact_id is not null and c.payer_contact_id is distinct from c.contact_id) or c.payer_company_id is not null
    into v_holder, v_payer, v_paid_by_other
    from public.punch_cards c where c.organization_id = p_org and c.id = p_card;
  if v_holder is null then
    return '{}';
  end if;
  select s.notices_to into v_to from public.punch_card_alert_settings s where s.organization_id = p_org;
  -- review finding 3: "payer only" on a card someone else paid for never falls back to the holder: no live payer contact
  -- (a company paid, or the payer is gone) = no message
  if coalesce(v_to, 'both') = 'payer' and v_paid_by_other then
    return case when v_payer is null then '{}'::uuid[] else array[v_payer] end;
  end if;
  if v_payer is null then
    return array[v_holder];
  end if;
  if exists (select 1 from app.punch_card_notice_template(p_org, v_holder, p_kind)) then
    return array[v_holder, v_payer];
  end if;
  return array[v_payer];
end;
$$;
revoke all on function app.punch_card_notice_targets(uuid, uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.order_lines_check: the body of 020595, plus the recipient's set-null (like a price list's)
-- ----------------------------------------------------------------------------
create or replace function app.order_lines_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_kind text;
  v_active boolean;
  v_archived timestamptz;
  v_billing text;
  v_unit text;
  v_totals jsonb;
  v_person boolean := auth.uid() is not null and coalesce(current_setting('app.order_server', true), '') <> 'on';
begin
  -- a price list was deleted (on delete set null of price_list_id): the line keeps its price and the list's name, whatever
  -- the order's state; nothing else changes
  -- (fired from the foreign key's own action, a level below the statement; a person's own update of the column alone is
  -- judged below like any other)
  if tg_op = 'UPDATE' and old.price_list_id is not null and new.price_list_id is null and pg_trigger_depth() > 1
     and (to_jsonb(new) - 'price_list_id' - 'updated_at') = (to_jsonb(old) - 'price_list_id' - 'updated_at') then
    return new;
  end if;
  -- PKG-06: a service recipient removed (on delete set null of recipient_contact_id, or a draft's customer changed):
  -- nothing else changes, whatever the order's state
  if tg_op = 'UPDATE' and old.recipient_contact_id is not null and new.recipient_contact_id is null and pg_trigger_depth() > 1
     and (to_jsonb(new) - 'recipient_contact_id' - 'updated_at') = (to_jsonb(old) - 'recipient_contact_id' - 'updated_at') then
    return new;
  end if;
  select * into v_order from public.orders o where o.organization_id = new.organization_id and o.id = new.order_id;
  -- outsider guard: RLS refuses (42501) a person who may not edit the order
  if v_person and (not found or not app.order_editable(v_order.organization_id, v_order.deal_id, v_order.contact_id, v_order.company_id)) then
    return new;
  end if;
  -- a numbered order's lines are as they were numbered (owner (2)), for every writer but the server's copy
  if v_person and v_order.status <> 'draft' then
    raise exception 'the lines of a numbered order cannot change' using errcode = 'P0001', hint = 'order:frozen';
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('order_lines:' || new.order_id::text, 0));
    if (select count(*) from public.order_lines l
         where l.organization_id = new.organization_id and l.order_id = new.order_id) >= 200 then
      raise exception 'at most 200 lines in an order' using errcode = 'P0001', hint = 'order_lines:max';
    end if;
    if v_person then
      -- a free line is priced by hand; a product line's price source is the person's claim (PL-03, as on deal lines:
      -- the product's price, a price list's, or typed); a list's name always comes from the list itself below
      if new.product_id is null then
        new.price_source := 'manual';
      end if;
      new.price_list_name := null;
      if new.product_id is not null then
        if not app.org_has_feature(new.organization_id, 'products') then
          raise exception 'products are not in this plan' using errcode = 'P0001', hint = 'feature:products';
        end if;
        select p.vat_kind, p.is_active, p.archived_at, p.billing, u.name
          into v_kind, v_active, v_archived, v_billing, v_unit
          from public.products p
          left join public.product_units u on u.organization_id = p.organization_id and u.id = p.unit_id
         where p.organization_id = new.organization_id and p.id = new.product_id;
        if found then
          if not v_active or v_archived is not null then
            raise exception 'the product cannot be offered' using errcode = 'P0001', hint = 'order_lines:product';
          end if;
          new.vat_exempt := v_kind <> 'taxable';
          new.billing := v_billing;
          new.unit_name := v_unit;
        end if;
      else
        new.unit_name := null;
      end if;
    end if;
  else
    new.organization_id := old.organization_id;
    new.order_id := old.order_id;
    new.kind := old.kind;
    new.product_id := old.product_id;
    new.unit_name := old.unit_name;
    if old.product_id is null then
      new.price_source := 'manual';
    end if;
    if old.product_id is not null then
      new.vat_exempt := old.vat_exempt;
      new.billing := old.billing;
    end if;
  end if;

  -- the price list that set the price (PL-03); its name is kept with the line
  if new.price_source <> 'price_list' then
    if new.price_list_id is not null and v_person then
      raise exception 'only a price from a price list names a list' using errcode = 'P0001', hint = 'order_lines:price_list';
    end if;
    new.price_list_id := null;
    new.price_list_name := null;
  elsif new.price_list_id is not null
        and (tg_op = 'INSERT' or new.price_list_id is distinct from old.price_list_id) then
    if v_person and not app.org_has_feature(new.organization_id, 'price_lists') then
      raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
    end if;
    select l.name into new.price_list_name from public.price_lists l
     where l.organization_id = new.organization_id and l.id = new.price_list_id;
  elsif not v_person then
    -- a server copy (from a quote or a deal) keeps the list's name it was given, even when the list is gone
    null;
  elsif tg_op = 'INSERT' or old.price_source <> 'price_list' or (old.price_list_id is not null and new.price_list_id is null) then
    -- a person names the list with a list price, on insert and on update alike (a line whose list was deleted keeps its
    -- source and the list's name below)
    raise exception 'a price from a price list names the list' using errcode = 'P0001', hint = 'order_lines:price_list';
  else
    -- unchanged, or its list was removed (on delete set null): the line keeps the name it was priced by
    new.price_list_name := old.price_list_name;
  end if;

  if new.kind = 'group' then
    new.vat_exempt := false;
    new.billing := 'one_time';
    new.total_agorot := 0;
    return new;
  end if;

  if v_person and (new.discount_bp is not null or new.discount_agorot is not null)
     and (tg_op = 'INSERT' or new.discount_bp is distinct from old.discount_bp or new.discount_agorot is distinct from old.discount_agorot)
     and not app.org_has_feature(new.organization_id, 'discounts') then
    raise exception 'discounts are not in this plan' using errcode = 'P0001', hint = 'feature:discounts';
  end if;

  v_totals := app.document_totals(
    jsonb_build_array(jsonb_build_object(
      'quantity', new.quantity,
      'unit_price_agorot', new.unit_price_agorot,
      'discount_bp', new.discount_bp,
      'discount_agorot', new.discount_agorot,
      'vat_exempt', new.vat_exempt)),
    0, coalesce(v_order.prices_include_vat, false));
  new.total_agorot := (v_totals #>> '{lines,0,total_agorot}')::bigint;
  return new;
end;
$$;
revoke all on function app.order_lines_check() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- public.quote_duplicate: the body of 021136, plus the line's service recipient
-- ----------------------------------------------------------------------------
create or replace function public.quote_duplicate(p_org uuid, p_quote uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_new uuid;
  v_today date;
  v_valid date;
  v_line public.quote_lines;
  v_skipped jsonb := '[]'::jsonb;
  v_skipped_lines jsonb := '[]'::jsonb;
  v_discounts boolean;
  v_dropped boolean := false;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;

  select (now() at time zone app.intake_zone(o.timezone))::date into v_today
    from public.organizations o where o.id = p_org;
  -- the original's validity span, from today
  v_valid := case when v_quote.valid_until is null then null else v_today + (v_quote.valid_until - v_quote.quote_date) end;

  v_discounts := app.org_has_feature(p_org, 'discounts');
  v_dropped := not v_discounts and (v_quote.discount_bp is not null or v_quote.discount_agorot is not null);

  insert into public.quotes (organization_id, title, deal_id, contact_id, company_id, valid_until, prices_include_vat,
                             no_vat_reason, no_vat_note, discount_bp, discount_agorot, notes, terms, currency)
  values (p_org, left('עותק של ' || v_quote.title, 200), v_quote.deal_id, v_quote.contact_id, v_quote.company_id, v_valid,
          v_quote.prices_include_vat, v_quote.no_vat_reason, v_quote.no_vat_note,
          case when v_discounts then v_quote.discount_bp end, case when v_discounts then v_quote.discount_agorot end,
          v_quote.notes, v_quote.terms, v_quote.currency)
  returning id into v_new;
  -- a new quote takes the business's VAT mode; the copy keeps the original's, before any line is added
  update public.quotes q set prices_include_vat = v_quote.prices_include_vat
   where q.organization_id = p_org and q.id = v_new and q.prices_include_vat is distinct from v_quote.prices_include_vat;

  for v_line in
    select * from public.quote_lines l where l.organization_id = p_org and l.quote_id = p_quote order by l.position, l.id
  loop
    begin
      insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity,
                                      unit_price_agorot, discount_bp, discount_agorot, vat_exempt, billing, is_optional,
                                      optional_selected, price_source, price_list_id, currency, bundle_display,
                                      recipient_contact_id)
      values (p_org, v_new, v_line.position, v_line.kind, v_line.product_id, v_line.name, v_line.description, v_line.quantity,
              v_line.unit_price_agorot, v_line.discount_bp, v_line.discount_agorot, v_line.vat_exempt, v_line.billing,
              v_line.is_optional, v_line.optional_selected, v_line.price_source, v_line.price_list_id, v_line.currency,
              -- PRD-09: a bundle keeps its display choice; its parts are taken from the catalog again (a new quote)
              v_line.bundle_display,
              -- PKG-06: the service recipient, while the person reads it and it is still linked to the payer
              case when v_line.recipient_contact_id is not null
                        and app.punch_recipient_ok(p_org, v_quote.contact_id, v_quote.company_id, v_line.recipient_contact_id, true)
                   then v_line.recipient_contact_id end);
    exception when sqlstate 'P0001' or integrity_constraint_violation or insufficient_privilege then
      -- the rules refuse this line today (quote_lines_check: P0001; a constraint or a foreign key: class 23; RLS: 42501):
      -- leave it out and name it. Anything else is not a refusal and fails the whole copy.
      v_skipped := v_skipped || to_jsonb(v_line.name);
      -- QUO-15 (owner, 19 October 2026): the screen offers to add an item line as a free line, read again by its id
      v_skipped_lines := v_skipped_lines || jsonb_build_array(jsonb_build_object('id', v_line.id, 'name', v_line.name, 'kind', v_line.kind));
    end;
  end loop;

  insert into public.quote_payment_steps (organization_id, quote_id, position, name, percent_bp, due_date, milestone)
  select s.organization_id, v_new, s.position, s.name, s.percent_bp, s.due_date, s.milestone
    from public.quote_payment_steps s
   where s.organization_id = p_org and s.quote_id = p_quote
   order by s.position, s.id;

  return jsonb_build_object('quote', v_new, 'skipped', v_skipped, 'skipped_lines', v_skipped_lines, 'discount_dropped', v_dropped);
end;
$$;
revoke all on function public.quote_duplicate(uuid, uuid) from public, anon;
grant execute on function public.quote_duplicate(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- app.punch_cards_auto_open: the body of 021164; each line's cards on its live recipient, the payer kept on the card
-- ----------------------------------------------------------------------------
create or replace function app.punch_cards_auto_open(p_org uuid, p_payment uuid, p_order uuid, p_quote uuid, p_source text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_pay record;
  v_contact uuid;
  v_doc_contact uuid;
  -- PKG-06: the document's company, the holder of a line's cards, and the cards opened per holder
  v_doc_company uuid;
  v_holder uuid;
  v_holders jsonb := '{}'::jsonb;
  -- review finding 2: a line whose recipient is in the bin waits (no card on the payer); the opening is tried again
  v_waiting boolean := false;
  v_number text;
  v_status text;
  -- second review, finding 1: the order's own quote, a scalar (a record filled from quotes has no quote_id)
  v_order_quote uuid;
  v_chain uuid[] := '{}';
  v_line record;
  v_target integer;
  v_have integer;
  v_unit integer;
  v_price bigint;
  v_room bigint;
  v_card uuid;
  v_opened integer := 0;
  v_rate integer;
  v_includes boolean;
  v_prices bigint[];
  v_none constant jsonb := jsonb_build_object('opened', 0);
begin
  if p_payment is null or (p_order is null and p_quote is null)
     or not app.org_has_feature(p_org, 'punch_cards') or not app.org_writable(p_org) then
    return v_none;
  end if;
  -- the payment first, then the order's / chain's keys (the order every caller keeps)
  select pm.id, pm.contact_id, pm.status, pm.order_id, pm.advance_order_id, pm.advance_quote_id into v_pay from public.payments pm
   where pm.organization_id = p_org and pm.id = p_payment for update;
  if not found or v_pay.status not in ('recorded', 'confirmed') then
    return v_none;
  end if;
  -- fifth review, finding 1: a linked payment opens only on the order or quote it is linked to NOW (an owner/admin may move
  -- or remove an advance's link after the payment was recorded; a retry must never open on the old one). An allocation's
  -- reach is its counted allocations (app.punch_cards_room).
  if p_source = 'link'
     and not coalesce((p_order is not null and (p_order = v_pay.order_id or p_order = v_pay.advance_order_id))
                      or (p_order is null and p_quote is not null and p_quote = v_pay.advance_quote_id), false) then
    return v_none;
  end if;
  perform app.punch_card_lock_keys(app.punch_card_keys(p_org, p_order, p_quote));
  if p_order is not null then
    select o.contact_id, o.company_id, o.number_display, o.status, o.quote_id, o.vat_rate_bp, o.prices_include_vat
      into v_doc_contact, v_doc_company, v_number, v_status, v_order_quote, v_rate, v_includes
      from public.orders o where o.organization_id = p_org and o.id = p_order;
    if not found or v_status in ('draft', 'cancelled') then
      return v_none;
    end if;
    if v_order_quote is not null then
      v_chain := app.punch_quote_chain(p_org, v_order_quote);
    end if;
  else
    select q.contact_id, q.company_id, q.number_display, q.status, q.vat_rate_bp, q.prices_include_vat
      into v_doc_contact, v_doc_company, v_number, v_status, v_rate, v_includes
      from public.quotes q where q.organization_id = p_org and q.id = p_quote;
    -- owner (95) ב: only an accepted quote opens cards (a payment made before the acceptance opens them at the acceptance)
    if not found or v_status <> 'accepted' then
      return v_none;
    end if;
    v_chain := app.punch_quote_chain(p_org, p_quote);
    if exists (select 1 from public.orders o where o.organization_id = p_org and o.quote_id = any (v_chain)) then
      return v_none;
    end if;
  end if;
  -- the payer; PKG-06: a line with a live service recipient opens on the recipient, so a payer gone or in the bin
  -- still lets those lines open (the others wait, as before)
  v_contact := coalesce(v_pay.contact_id, v_doc_contact);
  if v_contact is not null
     and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = v_contact and c.deleted_at is null) then
    v_contact := null;
  end if;
  if v_contact is null
     and not exists (select 1 from public.order_lines l
                      where p_order is not null and l.organization_id = p_org and l.order_id = p_order and l.recipient_contact_id is not null)
     and not exists (select 1 from public.quote_lines l
                      where p_order is null and l.organization_id = p_org and l.quote_id = p_quote and l.recipient_contact_id is not null) then
    return v_none;
  end if;
  v_room := app.punch_cards_room(p_org, p_payment, p_order, p_quote, p_source);
  for v_line in
    select l.id, l.product_id, l.quantity, l.total_agorot, l.position, l.vat_exempt, p.name, p.punch_entries, p.punch_validity_count, p.punch_validity_unit,
           l.recipient_contact_id as recipient
      from public.order_lines l
      join public.products p on p.organization_id = l.organization_id and p.id = l.product_id
     where p_order is not null and l.organization_id = p_org and l.order_id = p_order
       and p.kind = 'punch_card' and p.punch_entries is not null
    union all
    select l.id, l.product_id, l.quantity, l.total_agorot, l.position, l.vat_exempt, p.name, p.punch_entries, p.punch_validity_count, p.punch_validity_unit,
           l.recipient_contact_id as recipient
      from public.quote_lines l
      join public.products p on p.organization_id = l.organization_id and p.id = l.product_id
     where p_order is null and l.organization_id = p_org and l.quote_id = p_quote and l.kind = 'item'
       and (not l.is_optional or l.optional_selected)
       and p.kind = 'punch_card' and p.punch_entries is not null
     order by 5, 1
  loop
    v_target := least(20, floor(v_line.quantity)::integer);
    if v_target < 1 then
      continue;
    end if;
    -- PKG-06 (149) א: the line's service recipient holds its cards, else the payer. A recipient in the bin (review finding
    -- 2): the line waits, never opens on the payer; the retry path opens it after a restore (or gives up after 3 days)
    if v_line.recipient is not null then
      if not exists (select 1 from public.contacts c where c.organization_id = p_org and c.id = v_line.recipient
                        and c.deleted_at is null) then
        v_waiting := true;
        continue;
      end if;
      v_holder := v_line.recipient;
    else
      v_holder := v_contact;
    end if;
    if v_holder is null then
      continue;
    end if;
    -- owner (93) ב, third review finding 3: each unit's price with VAT, its exact share of what the document charges
    v_prices := app.punch_line_unit_prices(p_org, case when p_order is not null then 'order' else 'quote' end,
                                           coalesce(p_order, p_quote), v_line.id);
    -- the cards this line, and the chain's lines of the same product at the same position, opened already
    v_have := (select count(*) from public.punch_cards c
                where c.organization_id = p_org
                  and (c.order_line_id = case when p_order is not null then v_line.id end
                       or c.quote_line_id = case when p_order is null then v_line.id end))
            + (select count(*) from public.punch_cards c
                join public.quote_lines ql on ql.organization_id = c.organization_id and ql.id = c.quote_line_id
               where c.organization_id = p_org and ql.quote_id = any (v_chain) and ql.product_id = v_line.product_id
                 and ql.position = v_line.position and ql.id <> v_line.id
                 -- third review, finding 2: only OTHER quotes of the chain (a quote's own lines are counted above)
                 and ql.quote_id is distinct from p_quote);
    while v_have < v_target loop
      -- the line's next free unit
      select min(n) into v_unit from generate_series(1, 20) n
       where not exists (select 1 from public.punch_cards c
                          where c.organization_id = p_org and c.unit_no = n
                            and (c.order_line_id = case when p_order is not null then v_line.id end
                                 or c.quote_line_id = case when p_order is null then v_line.id end));
      if v_unit is null or v_unit > coalesce(cardinality(v_prices), 0) then
        exit;
      end if;
      v_price := v_prices[v_unit];
      if v_room < v_price or not app.punch_card_payment_room(p_org, p_payment, v_price) then
        exit;
      end if;
      v_card := null;
      if p_order is not null then
        insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, validity_count, validity_unit,
                                        status, payment_id, activated_at, activated_by, expires_on, price_agorot, order_line_id, unit_no,
                                        payer_contact_id, payer_company_id)
        values (p_org, v_holder, v_line.product_id, v_line.name, v_line.punch_entries, v_line.punch_validity_count,
                v_line.punch_validity_unit, 'active', p_payment, now(), auth.uid(),
                app.punch_card_expires_on(app.punch_card_today(p_org), v_line.punch_validity_count, v_line.punch_validity_unit),
                v_price, v_line.id, v_unit,
                case when v_holder is distinct from v_contact then v_contact end,
                case when v_holder is distinct from v_contact then v_doc_company end)
        on conflict (organization_id, order_line_id, unit_no) where order_line_id is not null do nothing
        returning id into v_card;
      else
        insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, validity_count, validity_unit,
                                        status, payment_id, activated_at, activated_by, expires_on, price_agorot, quote_line_id, unit_no,
                                        payer_contact_id, payer_company_id)
        values (p_org, v_holder, v_line.product_id, v_line.name, v_line.punch_entries, v_line.punch_validity_count,
                v_line.punch_validity_unit, 'active', p_payment, now(), auth.uid(),
                app.punch_card_expires_on(app.punch_card_today(p_org), v_line.punch_validity_count, v_line.punch_validity_unit),
                v_price, v_line.id, v_unit,
                case when v_holder is distinct from v_contact then v_contact end,
                case when v_holder is distinct from v_contact then v_doc_company end)
        on conflict (organization_id, quote_line_id, unit_no) where quote_line_id is not null do nothing
        returning id into v_card;
      end if;
      v_have := v_have + 1;
      if v_card is null then
        continue;
      end if;
      v_room := v_room - v_price;
      v_opened := v_opened + 1;
      v_holders := jsonb_set(v_holders, array[v_holder::text], to_jsonb(coalesce((v_holders ->> v_holder::text)::integer, 0) + 1));
    end loop;
  end loop;
  -- owner (94) ב: the caller writes one timeline entry per payment, naming the documents
  -- a waiting line is kept for the retry job (app.retry_punch_card_openings); inside a retry (app.punch_card_retry_one sets
  -- app.punch_card_retrying) the retried row itself keeps waiting, so nothing is recorded here
  if v_waiting and coalesce(current_setting('app.punch_card_retrying', true), '') <> 'on' then
    perform app.punch_card_retry_record(p_org, 'open', p_payment, p_order, case when p_order is null then p_quote end, null,
                                        p_source, '55000');
  end if;
  return jsonb_build_object('opened', v_opened, 'contact', v_contact, 'holders', v_holders, 'waiting', v_waiting,
                            'label', case when p_order is not null then 'הזמנה ' else 'הצעה ' end || coalesce(v_number, ''));
end;
$$;
revoke all on function app.punch_cards_auto_open(uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- app.punch_cards_note: the body of 021164; one entry per payment on each holder
create or replace function app.punch_cards_note(p_org uuid, p_payment uuid, p_results jsonb) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  for v_row in
    -- PKG-06: an answer with `holders` names each holder and its count; an older one its one contact
    select h.contact, sum(h.opened) as opened, string_agg(distinct h.label, ', ') as labels
      from (select coalesce(x.key, r ->> 'contact')::uuid as contact,
                   coalesce(x.value::integer, (r ->> 'opened')::integer) as opened, r ->> 'label' as label
              from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r
              left join lateral jsonb_each_text(case when jsonb_typeof(r -> 'holders') = 'object' then r -> 'holders' end) x on true) h
     where coalesce(h.opened, 0) > 0 and h.contact is not null
     group by 1
  loop
    insert into public.activities (organization_id, type, body, contact_id, created_by, metadata)
    values (p_org, 'system',
            case when v_row.opened = 1 then 'נפתחה כרטיסייה אוטומטית מתשלום על ' || v_row.labels
                 else 'נפתחו ' || v_row.opened || ' כרטיסיות אוטומטית מתשלום על ' || v_row.labels end,
            v_row.contact, null,
            jsonb_build_object('kind', 'punch_card_opened', 'payment_id', p_payment, 'count', v_row.opened));
  end loop;
end;
$$;
revoke all on function app.punch_cards_note(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- app.punch_card_retry_one: the body of 021164. A try that leaves a line waiting for its recipient (in the bin) never fails:
-- what it opened stays, and it says so in the transaction-local setting app.punch_card_retry_waiting = 'on', so
-- app.retry_punch_card_openings keeps the row pending with its backoff (re-review MEDIUM). While it runs,
-- app.punch_card_retrying = 'on' tells app.punch_cards_auto_open not to record a second waiting row.
create or replace function app.punch_card_retry_one(p_org uuid, p_kind text, p_payment uuid, p_order uuid, p_quote uuid,
                                                    p_source text) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_more uuid[];
  v_key bigint;
  v_pay record;
  v_results jsonb;
  v_opened integer := 0;
  -- PKG-06 (review finding 2): a line waits for its recipient to leave the bin
  v_waiting boolean := false;
begin
  if p_kind = 'quote' then
    select coalesce(array_agg(distinct x.id), '{}') into v_ids from app.punch_quote_payments(p_org, p_quote) x;
  else
    v_ids := array[p_payment];
  end if;
  perform 1 from public.payments pm where pm.organization_id = p_org and pm.id = any (v_ids) order by pm.id for update nowait;
  if p_kind = 'void_sync' then
    perform app.punch_cards_void_sync(p_org, p_payment);
    return null;
  end if;
  for v_key in select distinct k from unnest(app.punch_card_keys(p_org, p_order, p_quote)) k order by k loop
    if not pg_try_advisory_xact_lock(v_key) then
      raise exception 'a punch card key is held elsewhere' using errcode = '55P03';
    end if;
  end loop;
  perform set_config('app.punch_card_retrying', 'on', true);
  if p_kind = 'quote' then
    -- a payment that reached the quote meanwhile: locked after the key, never waited for (as app.quotes_punch_cards)
    select coalesce(array_agg(distinct x.id), '{}') into v_more from app.punch_quote_payments(p_org, p_quote) x
     where not (x.id = any (v_ids));
    perform 1 from public.payments pm where pm.organization_id = p_org and pm.id = any (v_more) order by pm.id for update nowait;
    for v_pay in select x.id, x.source from app.punch_quote_payments(p_org, p_quote) x order by 1, 2 loop
      v_results := jsonb_build_array(app.punch_cards_auto_open(p_org, v_pay.id, null, p_quote, v_pay.source));
      perform app.punch_cards_note(p_org, v_pay.id, v_results);
      v_opened := v_opened + coalesce((v_results -> 0 ->> 'opened')::integer, 0);
      v_waiting := v_waiting or coalesce((v_results -> 0 ->> 'waiting')::boolean, false);
    end loop;
    perform set_config('app.punch_card_retrying', '', true);
    if v_waiting then
      perform set_config('app.punch_card_retry_waiting', 'on', true);
    end if;
    return v_opened;
  end if;
  v_results := jsonb_build_array(app.punch_cards_auto_open(p_org, p_payment, p_order, p_quote, p_source));
  perform app.punch_cards_note(p_org, p_payment, v_results);
  perform set_config('app.punch_card_retrying', '', true);
  -- the row keeps waiting (backoff, then given up after 3 days with the notice) while a recipient is in the bin
  if coalesce((v_results -> 0 ->> 'waiting')::boolean, false) then
    perform set_config('app.punch_card_retry_waiting', 'on', true);
  end if;
  return coalesce((v_results -> 0 ->> 'opened')::integer, 0);
end;
$$;
revoke all on function app.punch_card_retry_one(uuid, text, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;

-- app.retry_punch_card_openings: the body of 021164; a try that leaves a line waiting for its recipient keeps its row
-- pending (attempts + 1, the usual backoff, given up after the same window) and keeps what it opened (re-review MEDIUM)
create or replace function app.retry_punch_card_openings(p_per_org integer default 20, p_limit integer default 100) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_row record;
  v_state text;
  v_done integer := 0;
  v_opened integer;
  v_timeout text := current_setting('lock_timeout');
begin
  -- a lock the openers take without nowait (a card row in app.punch_cards_void_sync) is never waited for long
  perform set_config('lock_timeout', '2s', true);
  for v_id in
    select r.id
      from (select r.id, r.next_try_at,
                   row_number() over (partition by r.organization_id order by r.next_try_at, r.id) as n
              from app.punch_card_retries r
             where r.done_at is null and r.given_up_at is null and r.next_try_at <= now()) r
     where r.n <= greatest(coalesce(p_per_org, 20), 1)
     order by r.n, r.next_try_at, r.id
     limit greatest(coalesce(p_limit, 100), 1)
  loop
    -- an overlapping run took it, or it ended meanwhile
    select r.* into v_row from app.punch_card_retries r
     where r.id = v_id and r.done_at is null and r.given_up_at is null
     for update skip locked;
    if not found then
      continue;
    end if;
    if not app.org_writable(v_row.organization_id) then
      -- fifth review, finding 2: the window holds whatever the business's state; a card never opens weeks later
      if now() >= v_row.created_at + app.punch_card_retry_window() then
        update app.punch_card_retries set given_up_at = now() where id = v_row.id;
        raise warning 'retry_punch_card_openings: retry % of organization % given up (not writable)', v_row.id, v_row.organization_id;
        perform app.punch_card_retry_event_end(v_row.id);
      else
        update app.punch_card_retries set next_try_at = least(now() + interval '1 hour', v_row.created_at + app.punch_card_retry_window())
         where id = v_row.id;
      end if;
      continue;
    end if;
    -- re-review N3: the business lost the plan key: nothing to open, closed silently (as the openers' key-off path)
    if v_row.kind <> 'void_sync' and not app.org_has_feature(v_row.organization_id, 'punch_cards') then
      update app.punch_card_retries set done_at = now() where id = v_row.id;
      v_done := v_done + 1;
      -- final review, F2: a sibling given up earlier is still told (this row itself adds no notice)
      perform app.punch_card_retry_event_end(v_row.id);
      continue;
    end if;
    begin
      perform set_config('app.punch_card_retry_waiting', '', true);
      v_opened := app.punch_card_retry_one(v_row.organization_id, v_row.kind, v_row.payment_id, v_row.order_id, v_row.quote_id, v_row.source);
      if coalesce(current_setting('app.punch_card_retry_waiting', true), '') = 'on' then
        -- PKG-06 (re-review MEDIUM): a line waits for its recipient to leave the bin. What this try opened stays; the row
        -- stays pending, counted as a try, with the usual backoff and the same give-up rule as a failed try
        perform set_config('app.punch_card_retry_waiting', '', true);
        if now() + app.punch_card_retry_delay(v_row.attempts + 1) > v_row.created_at + app.punch_card_retry_window() then
          update app.punch_card_retries
             set attempts = attempts + 1, last_sqlstate = '55000', given_up_at = now(),
                 opened = coalesce(opened, 0) + v_opened
           where id = v_row.id;
          raise warning 'retry_punch_card_openings: retry % of organization % given up (55000)', v_row.id, v_row.organization_id;
          perform app.punch_card_retry_event_end(v_row.id);
        else
          -- third review: the cards this waiting try opened are counted, so a later try that opens nothing is no "empty" end
          update app.punch_card_retries
             set attempts = attempts + 1, last_sqlstate = '55000', next_try_at = now() + app.punch_card_retry_delay(v_row.attempts + 1),
                 opened = coalesce(opened, 0) + v_opened
           where id = v_row.id;
        end if;
      else
        -- third review: the count adds to what earlier (waiting) tries opened; a row that ends done has no last failure
        update app.punch_card_retries
           set attempts = attempts + 1, done_at = now(), opened = coalesce(opened, 0) + v_opened, last_sqlstate = null
         where id = v_row.id;
        v_done := v_done + 1;
        -- fifth review, finding 4 and re-review N2: owners were told the system would try again; the event's end is told
        -- once (app.punch_card_retry_event_end)
        perform app.punch_card_retry_event_end(v_row.id);
      end if;
    exception when others then
      v_state := sqlstate;
      if now() + app.punch_card_retry_delay(v_row.attempts + 1) > v_row.created_at + app.punch_card_retry_window() then
        update app.punch_card_retries
           set attempts = attempts + 1, last_sqlstate = v_state, given_up_at = now()
         where id = v_row.id;
        raise warning 'retry_punch_card_openings: retry % of organization % given up (%)', v_row.id, v_row.organization_id, v_state;
        perform app.punch_card_retry_event_end(v_row.id);
      else
        update app.punch_card_retries
           set attempts = attempts + 1, last_sqlstate = v_state, next_try_at = now() + app.punch_card_retry_delay(v_row.attempts + 1)
         where id = v_row.id;
      end if;
    end;
  end loop;
  perform set_config('lock_timeout', v_timeout, true);
  return v_done;
end;
$$;
revoke all on function app.retry_punch_card_openings(integer, integer) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.send_punch_card_alerts: the body of 021178; (151) the customer's message to app.punch_card_notice_targets
-- ----------------------------------------------------------------------------
create or replace function app.send_punch_card_alerts(p_orgs uuid[] default null) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_org uuid;
  v_rep uuid;
  v_kind text;
  v_template uuid;
  v_channel text;
  v_problem text;
  v_job uuid;
  v_event_day date;
  -- PKG-06 (151): the contacts the customer's message goes to
  v_target uuid;
  v_first_job uuid;
  v_done integer := 0;
  v_served uuid[] := '{}'::uuid[];
begin
  -- (140) a business that lost the key starts afresh when it gains it again
  update app.punch_card_alert_orgs a set active = false
   where a.active and (p_orgs is null or a.organization_id = any (p_orgs))
     and not coalesce(app.org_has_feature(a.organization_id, 'punch_cards'), false);

  -- (140)/(141) a business seen with the key for the first time (release, an upgrade): its templates while it has none,
  -- and every card that already meets an alert marked done without a notice
  for v_org in
    select o.id from public.organizations o
     where (p_orgs is null or o.id = any (p_orgs))
       and o.deleted_at is null
       and app.org_has_feature(o.id, 'punch_cards')
       and not exists (select 1 from app.punch_card_alert_orgs a where a.organization_id = o.id and a.active)
     order by o.id
  loop
    begin
      perform app.seed_punch_card_message_templates(v_org);
    exception when others then
      raise warning 'crm-punch-card-alerts: templates not seeded for business % (SQLSTATE %)', v_org, sqlstate;
    end;
    begin
      perform app.punch_card_alert_baseline(v_org);
      insert into app.punch_card_alert_orgs (organization_id, active, started_at, seed_tried_on)
      values (v_org, true, now(), current_date)
      on conflict (organization_id) do update set active = true, started_at = excluded.started_at,
                                                  seed_tried_on = excluded.seed_tried_on;
    exception when others then
      raise warning 'crm-punch-card-alerts: business % not started (SQLSTATE %)', v_org, sqlstate;
    end;
  end loop;

  -- (141, review finding 5; re-review finding 4) a started business with a mark never seeded (the cap was in the way) is
  -- tried again, at most once a day
  for v_org in
    select a.organization_id from app.punch_card_alert_orgs a
     where a.active and (p_orgs is null or a.organization_id = any (p_orgs))
       and a.seed_tried_on is distinct from current_date
       and (select count(*) from app.punch_card_template_seeds s where s.organization_id = a.organization_id) < 2
       and app.org_has_feature(a.organization_id, 'punch_cards')
     order by a.seed_tried_on nulls first, a.organization_id
     limit 200
  loop
    update app.punch_card_alert_orgs a set seed_tried_on = current_date where a.organization_id = v_org;
    begin
      perform app.seed_punch_card_message_templates(v_org);
    exception when others then
      raise warning 'crm-punch-card-alerts: templates not seeded for business % (SQLSTATE %)', v_org, sqlstate;
    end;
  end loop;

  -- the rep's notices
  for v_row in
    select z.* from (
      select c.*, tn.served_at,
             -- a card that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by c.organization_id order by c.last_attempt_at nulls first, c.expires_on nulls last, c.card_id, c.kind) as n
        from app.punch_card_alert_candidates(p_orgs) c
        join app.punch_card_alert_orgs a on a.organization_id = c.organization_id and a.active
        left join app.punch_card_alert_turns tn on tn.organization_id = c.organization_id
       where c.writable and c.after_eight
    ) z
     where z.n <= app.punch_card_alert_per_org()
     -- businesses take turns: every business's first card, then every business's second, ...; among businesses, the one
     -- served longest ago first, so a business with many cards never blocks another
     order by z.n, z.served_at nulls first, z.organization_id, z.last_attempt_at nulls first, z.card_id, z.kind
     limit app.punch_card_alert_limit()
  loop
    v_rep := null;
    if not (v_row.organization_id = any (v_served)) then
      v_served := v_served || v_row.organization_id;
    end if;
    begin
      -- the contact's owner while an active full-seat member who is not a viewer
      select m.user_id into v_rep
        from public.contacts ct
        join public.memberships m
          on m.organization_id = ct.organization_id and m.user_id = ct.owner_id
         and m.status = 'active' and m.role <> 'viewer' and m.seat_type = 'full'
       where ct.organization_id = v_row.organization_id and ct.id = v_row.contact_id;

      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      select v_row.organization_id, r.user_id, 'punch_card',
             app.punch_card_alert_title(v_row.kind, v_row.remaining, v_row.expires_on - v_row.today),
             app.punch_card_alert_body(v_row.name, v_row.remaining, v_row.entries_total, v_row.expires_on),
             'contact', v_row.contact_id
        from (select v_rep as user_id where v_rep is not null
              union all
              -- else every active owner and admin
              select m.user_id from public.memberships m
               where v_rep is null and m.organization_id = v_row.organization_id and m.status = 'active'
                 and m.role in ('owner', 'admin')) r;

      -- PKG-03 (127)-(129): the customer's side waits beside it, while the business sends customer messages
      if v_row.customer_messages then
        insert into app.punch_card_customer_notices (organization_id, card_id, kind)
        values (v_row.organization_id, v_row.card_id, v_row.kind)
        on conflict (card_id, kind) do nothing;
      end if;

      insert into app.punch_card_alerts_sent (organization_id, card_id, kind, done_at)
      values (v_row.organization_id, v_row.card_id, v_row.kind, now())
      on conflict (card_id, kind) do update set done_at = excluded.done_at;
      v_done := v_done + 1;
    exception when others then
      -- tried again on a later run, after the fresh ones; skipped after 3 failures. One redacted line: card id and SQLSTATE
      insert into app.punch_card_alerts_sent (organization_id, card_id, kind, failures, last_attempt_at)
      values (v_row.organization_id, v_row.card_id, v_row.kind, 1, now())
      on conflict (card_id, kind)
        do update set failures = app.punch_card_alerts_sent.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-punch-card-alerts: card % (%) failed (SQLSTATE %)%', v_row.card_id, v_row.kind, sqlstate,
        case when coalesce((select s.failures from app.punch_card_alerts_sent s
                             where s.card_id = v_row.card_id and s.kind = v_row.kind), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;

  -- waiting customer rows that can never be sent are closed with a reason, no message (re-review finding 3)
  update app.punch_card_customer_notices w
     set done_at = now(),
         closed_reason = case
           when c.id is null or c.status <> 'active' then 'card_inactive'
           when c.expires_on is not null
                and c.expires_on < (now() at time zone app.intake_zone(o.timezone))::date then 'card_expired'
           when ct.id is null or ct.deleted_at is not null then 'contact_gone'
           else 'messages_off'
         end
    from public.organizations o
    left join public.punch_card_alert_settings st on st.organization_id = o.id
    left join public.punch_cards c on c.organization_id = o.id
    left join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
   where o.id = w.organization_id and c.id = w.card_id
     and w.done_at is null
     and (p_orgs is null or w.organization_id = any (p_orgs))
     and (c.status <> 'active'
          or (c.expires_on is not null and c.expires_on < (now() at time zone app.intake_zone(o.timezone))::date)
          or ct.id is null or ct.deleted_at is not null
          or not coalesce(st.customer_messages, false));

  -- the customer's messages: one card at a time, the message its waiting rows call for now
  for v_row in
    with waiting as (
      select w.organization_id, w.card_id,
             bool_or(w.kind = 'expiry' and w.done_at is null and w.failures < 3) as expiry_waits,
             bool_or(w.kind = 'low' and w.done_at is null and w.failures < 3) as low_waits,
             max(w.last_attempt_at) as last_attempt_at
        from app.punch_card_customer_notices w
       where (p_orgs is null or w.organization_id = any (p_orgs))
         and w.done_at is null and w.failures < 3
       group by w.organization_id, w.card_id
    ),
    judged as (
      select w.*, c.contact_id, c.expires_on, s.low_entries, og.zone, og.today,
             c.entries_total - (select count(*) from public.punch_card_uses u
                                 where u.organization_id = c.organization_id and u.card_id = c.id
                                   and u.returned_at is null)::integer as remaining,
             (select count(*) from public.punch_card_uses u
               where u.organization_id = c.organization_id and u.card_id = c.id and u.returned_at is null)::integer as used
        from waiting w
        join app.punch_card_alert_orgs a on a.organization_id = w.organization_id and a.active
        join public.punch_card_alert_settings s on s.organization_id = w.organization_id and s.customer_messages
        join public.punch_cards c on c.organization_id = w.organization_id and c.id = w.card_id and c.status = 'active'
        join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id and ct.deleted_at is null
        cross join lateral (
          select app.intake_zone(o.timezone) as zone, (now() at time zone app.intake_zone(o.timezone))::date as today,
                 (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00' as after_eight
            from public.organizations o where o.id = w.organization_id
        ) og
       where og.after_eight and app.org_writable(w.organization_id) and app.org_has_feature(w.organization_id, 'punch_cards')
         and (c.expires_on is null or c.expires_on >= og.today)
    ),
    chosen as (
      select j.*,
             case
               when j.expiry_waits and j.remaining > 0 then 'expiry'
               -- (148) ב after the first use that leaves the card at or under the number
               when j.low_waits and j.used > 0 and j.low_entries > 0 and j.remaining <= j.low_entries then 'low'
             end as send_kind,
             row_number() over (partition by j.organization_id order by j.last_attempt_at nulls first, j.card_id) as n
        from judged j
    )
    select * from chosen
     where send_kind is not null and n <= app.punch_card_alert_per_org()
     order by n, organization_id, card_id
     limit app.punch_card_alert_limit()
  loop
    v_kind := v_row.send_kind;
    v_template := null;
    v_channel := null;
    v_problem := null;
    v_job := null;
    begin
      v_first_job := null;
      -- PKG-06 (151) ג: the holder (the service recipient) and the payer beside it, or the payer only
      foreach v_target in array app.punch_card_notice_targets(v_row.organization_id, v_row.card_id, v_kind) loop
      v_template := null;
      v_channel := null;
      v_problem := null;
      v_job := null;
      select nt.template_id, nt.channel into v_template, v_channel
        from app.punch_card_notice_template(v_row.organization_id, v_target, v_kind) nt;
      if v_template is not null then
        v_problem := app.message_template_sendable(v_row.organization_id, v_template);
        if v_problem is null then
          -- review finding 1: every message ends; held past its event (no provider for the channel, a pause) it is
          -- cancelled instead of going out stale: the end of the card's last day, else of the day 7 days from today
          -- (re-review finding 2) a few-left message ends at least(the last day, today + 7); least() skips a null
          v_event_day := case when v_kind = 'expiry' then v_row.expires_on
                              else least(v_row.expires_on, v_row.today + 7) end;
          -- THE FUTURE SENDER of a punch_card_notice MUST re-read the card by punch_card_id, scoped to the job's
          -- business AND its contact_id, and send nothing unless the card is still active and held by that contact,
          -- or paid for by it (PKG-06: punch_cards.payer_contact_id)
          -- (a card cancelled, transferred or merged away since the job was queued says nothing true any more); it
          -- fills {כניסות} with app.punch_card_entries_text / punchEntriesText and {תאריך} with the card's expires_on
          v_job := app.enqueue_job(
            v_row.organization_id, 'message.send',
            jsonb_build_object('channel', v_channel, 'contact_id', v_target, 'message_type', 'punch_card_notice',
                               'template_id', v_template, 'punch_card_id', v_row.card_id,
                               'event_at', to_char(((v_event_day + 1)::timestamp at time zone v_row.zone) at time zone 'UTC',
                                                   'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
        else
          -- the template cannot be sent as it is: the owners and admins are told (once a template and reason a day)
          perform app.message_send_refused(v_row.organization_id, v_template, v_problem);
        end if;
      end if;
      v_first_job := coalesce(v_first_job, v_job);
      end loop;
      update app.punch_card_customer_notices w set done_at = now(), job_id = v_first_job
       where w.card_id = v_row.card_id and w.kind = v_kind;
      -- the expiry message covers a few-left one only while that one is due itself (re-review finding 1); one still
      -- waiting for its first use stays waiting
      if v_kind = 'expiry' and v_row.used > 0 and v_row.low_entries > 0 and v_row.remaining <= v_row.low_entries then
        update app.punch_card_customer_notices w set done_at = now(), covered = true
         where w.card_id = v_row.card_id and w.kind = 'low' and w.done_at is null;
      end if;
    exception when others then
      update app.punch_card_customer_notices w set failures = w.failures + 1, last_attempt_at = now()
       where w.card_id = v_row.card_id and w.kind = v_kind;
      raise warning 'crm-punch-card-alerts: customer message for card % (%) failed (SQLSTATE %)', v_row.card_id, v_kind, sqlstate;
    end;
  end loop;

  -- the businesses served in this run go to the back of the line
  insert into app.punch_card_alert_turns (organization_id, served_at)
  select o, clock_timestamp() from unnest(v_served) o
  on conflict (organization_id) do update set served_at = excluded.served_at;
  return v_done;
end;
$$;
revoke all on function app.send_punch_card_alerts(uuid[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.punch_cards_erase: the body of 021168, plus the payer's and the recipient's id in the log
-- ----------------------------------------------------------------------------
create or replace function app.punch_cards_erase(p_org uuid, p_contact uuid, p_children text[]) returns text[]
language plpgsql security definer
set search_path = ''
as $$
declare
  v_card record;
  v_periods tstzrange[];
  v_unknown boolean;
  v_zero constant text := '00000000-0000-0000-0000-000000000000';
  v_gone text[];
  v_more text[] := '{}';
begin
  for v_card in
    select c.id, c.created_at, c.cancelled_at, c.holder_history from public.punch_cards c
     where c.organization_id = p_org and p_contact = any (c.former_contact_ids)
     order by c.id
     for update
  loop
    v_periods := app.punch_card_holder_periods(v_card.created_at, v_card.holder_history, p_contact);
    v_unknown := cardinality(v_periods) = 0;
    update public.punch_cards c
       set cancel_reason = case when c.cancel_reason is not null
                                 and (v_unknown or app.punch_card_in_periods(c.cancelled_at, v_periods))
                                then 'הסיבה נמחקה (מחיקת פרטיות)' else c.cancel_reason end,
           former_contact_ids = array_remove(c.former_contact_ids, p_contact),
           holder_history = (select coalesce(jsonb_agg(case when x.e ->> 'contact' = p_contact::text then x.e - 'contact' else x.e end
                                                       order by x.o), '[]'::jsonb)
                               from jsonb_array_elements(c.holder_history) with ordinality as x(e, o))
     where c.organization_id = p_org and c.id = v_card.id;
    update public.punch_card_uses u set return_reason = 'הנימוק נמחק (מחיקת פרטיות)'
     where u.organization_id = p_org and u.card_id = v_card.id and u.return_reason is not null
       and (v_unknown or app.punch_card_in_periods(u.returned_at, v_periods));
    if not v_unknown then
      update public.audit_log a set changes = '{"erased": true}'::jsonb
       where a.organization_id = p_org and a.action <> 'erase' and a.changes is distinct from '{"erased": true}'::jsonb
         and app.punch_card_in_periods(a.created_at, v_periods)
         and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
              or (a.entity_type = 'punch_card_uses'
                  and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
    end if;
    update public.audit_log a set changes = replace(a.changes::text, p_contact::text, v_zero)::jsonb
     where a.organization_id = p_org and a.action <> 'erase' and strpos(a.changes::text, p_contact::text) > 0
       and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
            or (a.entity_type = 'punch_card_uses'
                and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
    -- the log entries this erasure just wrote keep the old reasons: they go too
    update public.audit_log a set changes = '{"erased": true}'::jsonb
     where a.organization_id = p_org and a.created_at = now() and a.action = 'update'
       and (a.changes ? 'cancel_reason' or a.changes ? 'return_reason')
       and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
            or (a.entity_type = 'punch_card_uses'
                and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
  end loop;
  -- PKG-06: the person's id leaves the log entries of the cards they paid for and of the document lines that named them
  -- as the service recipient (the foreign keys emptied the columns when the person was purged)
  update public.audit_log a set changes = replace(a.changes::text, p_contact::text, v_zero)::jsonb
   where a.organization_id = p_org and a.entity_type in ('punch_cards', 'quote_lines', 'order_lines')
     and a.action <> 'erase' and strpos(a.changes::text, p_contact::text) > 0;
  -- the used entries of the person's gone cards (their delete entries carry card_id)
  v_gone := array(select substr(c, length('punch_cards:') + 1) from unnest(p_children) c where c like 'punch_cards:%');
  if cardinality(v_gone) > 0 then
    select coalesce(array_agg(distinct 'punch_card_uses:' || a.entity_id), '{}') into v_more
      from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'punch_card_uses' and a.entity_id is not null
       and coalesce(a.changes ->> 'card_id', a.changes -> 'card_id' ->> 'old') = any (v_gone)
       and not exists (select 1 from public.punch_card_uses u where u.organization_id = p_org and u.id = a.entity_id);
  end if;
  return v_more;
end;
$$;
revoke all on function app.punch_cards_erase(uuid, uuid, text[]) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.sample_untouched and app.import_record_worked: the bodies of 021165, plus a recipient on a line or a card paid
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    -- TASK-06: a sample task a person gave steps to is real work
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id)
       -- TASK-06 part B: a sub-task a person added under it (sample data makes none)
       and not exists (select 1 from public.tasks c where c.organization_id = p_org and c.parent_task_id = p_id);
  end if;
  -- notes, files and meetings are never sample data
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task, or one a person gave steps to (TASK-06; removing the record would
  -- take such a task with it)
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and (not app.sample_pristine($1, ''task'', t.id)
                          or exists (select 1 from public.task_checklist_items i
                                      where i.organization_id = t.organization_id and i.task_id = t.id)))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id)
       -- MSG-03: sample data sends no messages; one sent or received is real
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- ORD-01: sample data makes no orders; one made is real work
       and not exists (select 1 from public.orders od where od.organization_id = p_org and p_id in (od.contact_id, od.delivery_contact_id))
       -- DOC-01: sample data records no documents; one recorded is real work
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.contact_id = p_id)
       -- PAY-01: sample data records no payments; one recorded is real work
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.contact_id = p_id)
       -- COL-05: sample data holds nobody; a hold set is real work
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- RVW-64 (COL-03): sample data makes no payment promises; one recorded on the customer is real work
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.contact_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id)
       -- MSG-03
       and not exists (select 1 from public.messages ms where ms.organization_id = p_org and ms.contact_id = p_id)
       -- PKG-01: sample data opens no punch cards; one opened is real work (the card would go with the contact)
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.contact_id = p_id)
       -- PKG-06: named as the service recipient of a line, or the payer of a card
       and not exists (select 1 from public.quote_lines ql where ql.organization_id = p_org and ql.recipient_contact_id = p_id)
       and not exists (select 1 from public.order_lines ol where ol.organization_id = p_org and ol.recipient_contact_id = p_id)
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.payer_contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.company_id = p_id)
       -- COL-05
       and not exists (select 1 from public.customer_holds ch where ch.organization_id = p_org and ch.company_id = p_id)
       -- RVW-64 (COL-03): a payment promise on the company, or on one of its own documents (an opening balance)
       and not exists (select 1 from public.payment_promises pp where pp.organization_id = p_org and pp.company_id = p_id)
       and not exists (select 1 from public.payment_promises pp
                         join public.accounting_documents ad on ad.organization_id = pp.organization_id and ad.id = pp.document_id
                        where pp.organization_id = p_org and ad.company_id = p_id)
       -- PKG-06: the company paid for a card someone else holds
       and not exists (select 1 from public.punch_cards pc where pc.organization_id = p_org and pc.payer_company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.deal_id = p_id)
       -- DOC-01
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.deal_id = p_id)
       -- PAY-01
       and not exists (select 1 from public.payments pm where pm.organization_id = p_org and pm.deal_id = p_id);
  end if;
end;
$$;

revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamp with time zone, p_job uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3
                                          and not (x.type = ''import_note'' and coalesce(x.metadata ->> ''import_job_id'' = $4::text, false))
                                          -- GAP-12: the timeline entries of the opening balances of this import
                                          -- (null-safe like the line above: a system entry without a kind stays work)
                                          and not coalesce(x.type = ''system'' and x.metadata ->> ''kind'' in (''document_recorded'', ''document_cancelled'')
                                                   and exists (select 1 from public.accounting_documents ad
                                                                where ad.organization_id = $1 and ad.id::text = x.metadata ->> ''document_id''
                                                                  and ad.import_job_id = $4), false))
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3
                                          -- COL-04: the reminder task of a document of this import (an opening balance)
                                          and not coalesce(exists (select 1 from public.accounting_documents ad
                                                                    where ad.organization_id = $1 and ad.id = x.collection_document_id
                                                                      and ad.import_job_id = $4), false))
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since, p_job;
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
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.contact_id = p_id
                     -- GAP-12: the job's own opening balance is part of the import
                     and x.import_job_id is distinct from p_job)
        -- PAY-01: a payment is always recorded after the import
        or exists (select 1 from public.payments x where x.organization_id = p_org and x.contact_id = p_id)
        -- COL-05: a hold is always set after the import
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.contact_id = p_id)
        -- RVW-64 (COL-03): a payment promise is always recorded after the import: on the customer, or on one of its
        -- documents (the job's own opening balance included, which the document line above leaves out)
        or exists (select 1 from public.payment_promises x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.payment_promises x
                     join public.accounting_documents ad on ad.organization_id = x.organization_id and ad.id = x.document_id
                    where x.organization_id = p_org and ad.contact_id = p_id)
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
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- PKG-01 (review finding 7): a punch card opened for it (the card would go with the contact)
        or exists (select 1 from public.punch_cards x where x.organization_id = p_org and x.contact_id = p_id)
        -- PKG-06: named as the service recipient of a line, or the payer of a card
        or exists (select 1 from public.quote_lines x where x.organization_id = p_org and x.recipient_contact_id = p_id)
        or exists (select 1 from public.order_lines x where x.organization_id = p_org and x.recipient_contact_id = p_id)
        or exists (select 1 from public.punch_cards x where x.organization_id = p_org and x.payer_contact_id = p_id);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.customer_holds x where x.organization_id = p_org and x.company_id = p_id)
        -- RVW-64 (COL-03): a payment promise on the company, or on one of its documents (its opening balance included)
        or exists (select 1 from public.payment_promises x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.payment_promises x
                     join public.accounting_documents ad on ad.organization_id = x.organization_id and ad.id = x.document_id
                    where x.organization_id = p_org and ad.company_id = p_id)
        -- GAP-12: a company's opening balance recorded outside this import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
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
$function$
;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
