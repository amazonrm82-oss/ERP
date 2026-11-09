-- =============================================================================
-- PKG-06, owner's answers (168) ב and (173) ב (9 November 2026): a merge that makes the payer the card's holder makes the
-- purchase the payer's own, also when the card came to the recipient by a transfer
-- =============================================================================
-- A card opened for a recipient R on a document that P paid for (punch_cards.payer_contact_id = P). When R (the duplicate)
-- is merged into P (the kept contact), app.merge_punch_cards moves the card to P and closes R's holding in holder_history
-- ({contact: R, until: merge}); app.merge_punch_recipients (021185) then cleared payer_contact_id and opened_for_other_payer.
-- PKG-01's export rule (src/features/punch-cards/export.ts) shows a card's purchase (payment id, price, the lines, who opened
-- and activated it) only to the person who held it from its creation, so P's export left the purchase out although P paid.
--
-- * punch_cards.payer_holder_id (server only, composite FK to contacts, on delete set null of the column): the contact a
--   merge made both the payer and the holder of the card. Set by app.merge_punch_recipients for every card the kept contact
--   holds and paid for after the merge, whichever side was the duplicate (R into P, or a payer duplicate into its holder);
--   moved by a later merge of that contact. The export shows the purchase to that contact as their own (owner (173) ב: also
--   when the card reached R by a transfer from X before), and to no one else: every other person's export (X, the first
--   holder; Y, a later holder after a transfer) sees the card as "opened from another customer's document", without the
--   purchase.
-- * The duplicate R is the kept contact now: its entries in holder_history name the kept contact (owner (168) ב: R's uses and
--   cancel reasons are P's, and a later erasure of P reaches R's period), and R leaves former_contact_ids (review 3: an
--   erasure of R's record afterwards would otherwise find the card with no period of its own and erase every reason on it).
--   An earlier holder X's entries are untouched, so X's own erasure still reaches X's period.
-- * opened_for_other_payer is cleared (the transaction-local app.punch_payer_merge, 021185) only for a card whose history,
--   after the rewrite, names no one but the kept contact; a card someone else held (X) keeps the mark, so X's export never
--   gets the purchase, also once P is purged and payer_holder_id is emptied.
-- Transfers (public.punch_card_transfer) are unchanged.
--
-- Redefined from its latest body: app.merge_punch_recipients (021185). Cards merged before this migration keep their
-- history (none on the hosted project: no line names a recipient there, checked by the lead on 9 November 2026).
-- Every statement is safe to run twice. No drop statement and no row removal.

alter table public.punch_cards add column if not exists payer_holder_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'punch_cards_payer_holder_fk' and conrelid = 'public.punch_cards'::regclass) then
    alter table public.punch_cards add constraint punch_cards_payer_holder_fk foreign key (organization_id, payer_holder_id)
      references public.contacts (organization_id, id) on delete set null (payer_holder_id);
  end if;
end;
$$;
create index if not exists punch_cards_payer_holder_idx on public.punch_cards (organization_id, payer_holder_id);

create or replace function app.merge_punch_recipients() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_before text := coalesce(current_setting('app.punch_recipient_server', true), '');
  v_order_before text := coalesce(current_setting('app.order_server', true), '');
  v_payer_before text := coalesce(current_setting('app.punch_payer_merge', true), '');
  v_cards uuid[];
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

  -- a card the duplicate paid for that someone else holds: the kept contact paid (the mark stays, payer still set)
  update public.punch_cards c set payer_contact_id = new.contact_id
   where c.organization_id = new.organization_id and c.payer_contact_id = v_merged and c.contact_id <> new.contact_id;
  -- a card the duplicate held as the payer through an earlier merge: the kept contact is that payer now
  update public.punch_cards c set payer_holder_id = new.contact_id
   where c.organization_id = new.organization_id and c.payer_holder_id = v_merged;

  -- 021189 (owner (168) ב, (173) ב): the cards the kept contact now holds and paid for (the duplicate held them, or paid for
  -- them); app.merge_punch_cards already moved the duplicate's cards here
  select coalesce(array_agg(c.id order by c.id), '{}') into v_cards
    from public.punch_cards c
   where c.organization_id = new.organization_id and c.contact_id = new.contact_id
     and c.payer_contact_id in (v_merged, new.contact_id);
  if cardinality(v_cards) = 0 then
    return null;
  end if;
  -- the duplicate is the kept contact: its holding entries name the kept contact, and it is no former holder (review 3);
  -- the payer is still set here, so the mark is not touched
  update public.punch_cards c
     set former_contact_ids = array_remove(c.former_contact_ids, v_merged),
         holder_history = (select coalesce(jsonb_agg(case when x.e ->> 'contact' = v_merged::text
                                                          then jsonb_set(x.e, '{contact}', to_jsonb(new.contact_id::text))
                                                          else x.e end
                                                     order by x.o), '[]'::jsonb)
                             from jsonb_array_elements(c.holder_history) with ordinality as x(e, o))
   where c.organization_id = new.organization_id and c.id = any (v_cards);
  -- held by no one but the kept contact: its own purchase from the start, the mark goes (021185's setting)
  perform set_config('app.punch_payer_merge', 'on', true);
  update public.punch_cards c set payer_contact_id = null, payer_holder_id = new.contact_id
   where c.organization_id = new.organization_id and c.id = any (v_cards)
     and not exists (select 1 from jsonb_array_elements(c.holder_history) x(e)
                      where coalesce(x.e ->> 'contact', '') <> new.contact_id::text);
  perform set_config('app.punch_payer_merge', v_payer_before, true);
  -- someone else (X) held it before: the purchase is the kept contact's (payer_holder_id), and the mark stays for X
  perform set_config('app.punch_payer_merge', '', true);
  update public.punch_cards c set payer_contact_id = null, payer_holder_id = new.contact_id
   where c.organization_id = new.organization_id and c.id = any (v_cards) and c.payer_contact_id is not null;
  perform set_config('app.punch_payer_merge', v_payer_before, true);
  return null;
end;
$$;
revoke all on function app.merge_punch_recipients() from public, anon, authenticated, service_role;
