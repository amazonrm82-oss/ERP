-- =============================================================================
-- CAL-13: a held meeting makes a draft order of the meeting type's service (owner 9 November 2026, answers (152) א, (153) ג)
-- =============================================================================
-- (152) א: what a held meeting makes is an ORDER draft (public.orders, source manual, status draft) with one line of the
-- meeting type's product (meeting_types.product_id, CAL-08); the invoice is issued from the order through a provider later.
-- (153) ג: a business setting chooses automatic or button, default button:
--   org_document_settings.meeting_order_draft  'button' | 'auto' (owners/admins of a writable business, column grants;
--   audited with the row, like quote_accept_deal).
--
-- The one rule, app.meeting_order_draft_refusal(org, meeting): null = a draft may be made now, else the reason:
--   not_found          no such meeting in the business
--   exists             a draft was already made from this meeting (told first, also after the meeting left "held")
--   not_held           the meeting is not "held" (blocks are never held)
--   feature_orders     the plan has no `orders`
--   module_off         the business has orders switched off (org_modules.orders_enabled): the order would be hidden
--   feature_products   the plan has no `products`
--   not_writable       the business is read-only, suspended, cancelled or deleted
--   no_contact         the meeting has no contact (the order is on the meeting's contact)
--   contact_gone       the meeting's contact is in the recycle bin
--   no_type            the meeting has no meeting type
--   no_product         the meeting type has no linked product
--   product_unavailable the product is archived or not active (not offerable)
--   punch_card         a punch card covered the meeting (a live public.punch_card_uses row for it, PKG-02)
-- Both paths go through app.meeting_order_draft_make, which takes a per-meeting lock and judges the rule again under it, so
-- neither path makes two. The link lives in app.meeting_order_drafts (one row per meeting, cascades with the meeting and
-- with the order). Owner (169) א: "once" holds while the order made from the meeting exists, also after it was numbered
-- or cancelled (a numbered order is never deleted); only deleting the draft frees the meeting. A meeting that later
-- leaves "held" keeps its draft (lead's choice). Owner (170) א: the button stays in automatic mode as a fallback, shown
-- only while no order from the meeting exists.
--
-- The order, written through the server branch of app.orders_check / app.order_lines_check:
--   * button: the person's session is kept, so the order's and the line's audit entries name the presser; the
--     transaction-local app.order_server = 'on' is set around the two inserts and put back (also on the error path). An
--     empty owner is kept by the narrow trigger orders_check_meeting_owner (orders_check fills auth.uid() otherwise);
--   * automatic: the session is put aside around the inserts, as AUT-02's create_quote does (the audit has no actor);
--   * customer = the meeting's contact (orders_check fills its company); the meeting's deal is attached only while it is
--     live and its contact is the meeting's contact, and on the button path only when the caller may edit that deal too
--     (an order with a deal follows the deal's rights, app.order_editable);
--   * owner = the meeting's organizer while an active member who is not a viewer (app.automation_member) AND who reads the
--     order's parent (app.user_can_read_record on the deal when attached, else the contact); else none;
--   * VAT mode = the business's prices_include_vat (what a person's new draft gets); created_by = the actor;
--   * one line: the product's name, quantity 1, priced by PL-03 exactly as app.convert_requested_product and AUT-02 price a
--     product line (the customer's price list: the contact's own, that contact's company's, the order's company's; the
--     tier with the largest min_quantity not above 1; a fixed price with its own VAT mode or a discount by
--     app.price_list_discounted), carried into the order's VAT mode by app.product_line_price at the order's own rate
--     (app.org_document_vat_rate of the business's today, 0 when unknown, as orders_check counts it). On the button path a
--     company or contact the caller cannot read counts as no list (as the app's read). The line's VAT exemption, billing and
--     unit come from the product, as order_lines_check sets them for a person; the 200-line cap, the price list's name, the
--     bundle snapshot and the line total come from the line triggers themselves.
--
-- Paths:
--   * automatic: trigger meetings_zz_order_draft (AFTER insert or update of status, named to fire after
--     meetings_punch_card_use so a card's use is already written) while the setting is 'auto'; inside an exception block,
--     so a meeting's write never fails because of the draft (a failure is one warning line with the meeting id). Owner
--     (171) ב: when the person who marked the meeting held may not edit its live contact (the button's rule,
--     app.meeting_order_draft_forbidden), no draft is made; that person gets one `system` notice per meeting (no customer
--     name; app.meeting_order_draft_notices), and someone with the right makes it with the button. A write with no session
--     (auth.uid() null: imports, automations, booking flows) still makes the draft as the server (lead's choice);
--   * button: public.meeting_order_draft_create(org, meeting) (definer, authenticated): a non-member or a meeting the caller
--     may not see (app.meeting_order_draft_meeting_readable, the meetings_select rule) answers not_found; a caller who may
--     not edit the meeting's live contact answers not_permitted before any other reason; then the rule; answers
--     {ok, order_id} or {ok:false, reason, order_id?} (a made draft's id only to someone who reads it); works in both settings;
--   * screen state: public.meeting_order_draft_states(org, meetings[]) (definer, authenticated, at most 200 ids, members
--     only): an entry only for a meeting the caller may see that is held or has a draft: the made order's id (only when
--     the caller reads the order's deal, else its contact) and the reason, not_permitted first as the button answers.
-- Only adds a column, two tables, functions and two triggers. Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- The setting
-- ----------------------------------------------------------------------------
alter table public.org_document_settings add column if not exists meeting_order_draft text not null default 'button';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'org_document_settings_meeting_order_draft_check'
                  and conrelid = 'public.org_document_settings'::regclass) then
    alter table public.org_document_settings add constraint org_document_settings_meeting_order_draft_check
      check (meeting_order_draft in ('button', 'auto'));
  end if;
end;
$$;

grant select (meeting_order_draft) on public.org_document_settings to authenticated;
grant insert (meeting_order_draft) on public.org_document_settings to authenticated;
grant update (meeting_order_draft) on public.org_document_settings to authenticated;

-- ----------------------------------------------------------------------------
-- The link: one draft per meeting (server only)
-- ----------------------------------------------------------------------------
create table if not exists app.meeting_order_drafts (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id      uuid not null,
  order_id        uuid not null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  primary key (organization_id, meeting_id),
  constraint meeting_order_drafts_meeting_fk foreign key (organization_id, meeting_id)
    references public.meetings (organization_id, id) on delete cascade,
  constraint meeting_order_drafts_order_fk foreign key (organization_id, order_id)
    references public.orders (organization_id, id) on delete cascade
);
create index if not exists meeting_order_drafts_order_idx on app.meeting_order_drafts (organization_id, order_id);
alter table app.meeting_order_drafts enable row level security;
revoke all on app.meeting_order_drafts from public, anon, authenticated, service_role;

-- owner (171) ב: the one notice per meeting to a person whose "held" made no draft for lack of the right (server only)
create table if not exists app.meeting_order_draft_notices (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id      uuid not null,
  user_id         uuid,
  created_at      timestamptz not null default now(),
  primary key (organization_id, meeting_id),
  constraint meeting_order_draft_notices_meeting_fk foreign key (organization_id, meeting_id)
    references public.meetings (organization_id, id) on delete cascade
);
alter table app.meeting_order_draft_notices enable row level security;
revoke all on app.meeting_order_draft_notices from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rule
-- ----------------------------------------------------------------------------
create or replace function app.meeting_order_draft_refusal(p_org uuid, p_meeting uuid) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings;
  v_product uuid;
begin
  select * into v_meeting from public.meetings m where m.organization_id = p_org and m.id = p_meeting;
  if not found then
    return 'not_found';
  end if;
  -- a draft already made is told first, whatever the meeting's status now (it keeps its draft)
  if exists (select 1 from app.meeting_order_drafts d where d.organization_id = p_org and d.meeting_id = p_meeting) then
    return 'exists';
  end if;
  if v_meeting.status <> 'held' or v_meeting.is_block then
    return 'not_held';
  end if;
  if not app.org_has_feature(p_org, 'orders') then
    return 'feature_orders';
  end if;
  if not coalesce((select mo.orders_enabled from public.org_modules mo where mo.organization_id = p_org), false) then
    return 'module_off';
  end if;
  if not app.org_has_feature(p_org, 'products') then
    return 'feature_products';
  end if;
  if not app.org_writable(p_org) then
    return 'not_writable';
  end if;
  if v_meeting.contact_id is null then
    return 'no_contact';
  end if;
  if not exists (select 1 from public.contacts c
                  where c.organization_id = p_org and c.id = v_meeting.contact_id and c.deleted_at is null) then
    return 'contact_gone';
  end if;
  if v_meeting.meeting_type_id is null then
    return 'no_type';
  end if;
  select t.product_id into v_product from public.meeting_types t
   where t.organization_id = p_org and t.id = v_meeting.meeting_type_id;
  if v_product is null then
    return 'no_product';
  end if;
  if not exists (select 1 from public.products p
                  where p.organization_id = p_org and p.id = v_product and p.is_active and p.archived_at is null) then
    return 'product_unavailable';
  end if;
  if exists (select 1 from public.punch_card_uses u
              where u.organization_id = p_org and u.meeting_id = p_meeting and u.returned_at is null) then
    return 'punch_card';
  end if;
  return null;
end;
$$;
revoke all on function app.meeting_order_draft_refusal(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The settings the make function changes, put back (also on its error path)
-- ----------------------------------------------------------------------------
create or replace function app.meeting_order_draft_restore(p_person boolean, p_server text, p_no_owner text,
                                                           p_claims text, p_claim_sub text) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_person then
    perform set_config('app.order_server', coalesce(p_server, ''), true);
    perform set_config('app.meeting_order_no_owner', coalesce(p_no_owner, ''), true);
  else
    if p_claims is not null then
      perform set_config('request.jwt.claims', p_claims, true);
    end if;
    if p_claim_sub is not null then
      perform set_config('request.jwt.claim.sub', p_claim_sub, true);
    end if;
  end if;
end;
$$;
revoke all on function app.meeting_order_draft_restore(boolean, text, text, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The button's draft with no usable organizer keeps an empty owner. orders_check (BEFORE INSERT, earlier by name) fills an
-- empty owner with auth.uid(); this trigger, named to fire right after it, empties it again only for the one order id the
-- make function names in the transaction-local app.meeting_order_no_owner, and only inside a definer (current_user is not
-- authenticated), so a person who sets the setting on their own insert changes nothing.
-- ----------------------------------------------------------------------------
create or replace function app.orders_check_meeting_owner() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated'
     and coalesce(current_setting('app.meeting_order_no_owner', true), '') = new.id::text then
    new.owner_id := null;
  end if;
  return new;
end;
$$;
revoke all on function app.orders_check_meeting_owner() from public, anon, authenticated, service_role;

create or replace trigger orders_check_meeting_owner before insert on public.orders
  for each row execute function app.orders_check_meeting_owner();

-- ----------------------------------------------------------------------------
-- Making the draft (both paths). p_person: the button (the caller's rights decide the deal and the price list reads).
-- ----------------------------------------------------------------------------
create or replace function app.meeting_order_draft_make(p_org uuid, p_meeting uuid, p_person boolean) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_actor        uuid := auth.uid();
  v_reason       text;
  v_meeting      public.meetings;
  v_deal         uuid;
  v_owner        uuid;
  v_mode         boolean;
  v_day          date;
  v_rate         integer;
  v_product      public.products;
  v_unit         text;
  v_price        bigint;
  v_includes     boolean;
  v_contact_list uuid;
  v_contact_co   uuid;
  v_company      uuid;
  v_list         uuid;
  v_tier_price   bigint;
  v_tier_bp      integer;
  v_tier_incl    boolean;
  v_source       text := 'product';
  v_list_used    uuid;
  v_order        uuid;
  v_claims       text;
  v_claim_sub    text;
  v_server       text;
  v_no_owner     text;
begin
  perform pg_advisory_xact_lock(hashtextextended('meeting_order_draft:' || p_meeting::text, 0));
  v_reason := app.meeting_order_draft_refusal(p_org, p_meeting);
  if v_reason is not null then
    return jsonb_strip_nulls(jsonb_build_object('ok', false, 'reason', v_reason,
                              'order_id', (select d.order_id from app.meeting_order_drafts d
                                            where d.organization_id = p_org and d.meeting_id = p_meeting)));
  end if;
  select * into v_meeting from public.meetings m where m.organization_id = p_org and m.id = p_meeting;
  if p_person and not app.quote_editable(p_org, null, v_meeting.contact_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_permitted');
  end if;

  -- the meeting's deal, only while live and on the same contact (and, for a person, one they may edit)
  select d.id into v_deal from public.deals d
   where d.organization_id = p_org and d.id = v_meeting.deal_id and d.deleted_at is null
     and d.contact_id = v_meeting.contact_id
     and (not p_person or app.quote_editable(p_org, d.id, null));

  -- the organizer, while an active non-viewer member who reads the order's parent (the deal when attached, else the contact)
  v_owner := app.automation_member(p_org, v_meeting.owner_id);
  if v_owner is not null and not coalesce((
       select app.user_can_read_record(p_org, v_owner, r.owner_id, r.team_id)
         from (select d.owner_id, d.team_id from public.deals d where d.organization_id = p_org and d.id = v_deal
               union all
               select c.owner_id, c.team_id from public.contacts c
                where c.organization_id = p_org and c.id = v_meeting.contact_id and v_deal is null) r
        limit 1), false) then
    v_owner := null;
  end if;
  v_mode := coalesce((select s.prices_include_vat from public.org_document_settings s where s.organization_id = p_org), false);
  v_day := (now() at time zone app.intake_zone((select o.timezone from public.organizations o where o.id = p_org)))::date;
  v_rate := coalesce(app.org_document_vat_rate(p_org, v_day), 0);

  select p.* into v_product from public.products p
    join public.meeting_types t on t.organization_id = p.organization_id and t.product_id = p.id
   where t.organization_id = p_org and t.id = v_meeting.meeting_type_id;
  select u.name into v_unit from public.product_units u
   where u.organization_id = p_org and u.id = v_product.unit_id;
  v_price := v_product.price_agorot;
  v_includes := v_product.vat_kind = 'taxable' and v_product.price_includes_vat;

  -- PL-03: the customer's price list (the order's company is the deal's, else the contact's, as orders_check sets it)
  if app.org_has_feature(p_org, 'price_lists') then
    select c.price_list_id, c.company_id into v_contact_list, v_contact_co
      from public.contacts c
     where c.organization_id = p_org and c.id = v_meeting.contact_id
       and (not p_person or app.can_read_record(c.organization_id, c.owner_id, c.team_id));
    v_company := coalesce((select d.company_id from public.deals d where d.organization_id = p_org and d.id = v_deal),
                          (select c.company_id from public.contacts c where c.organization_id = p_org and c.id = v_meeting.contact_id));
    select l.id into v_list
      from (values (1, v_contact_list),
                   (2, (select co.price_list_id from public.companies co
                         where co.organization_id = p_org and co.id = v_contact_co
                           and (not p_person or app.can_read_record(co.organization_id, co.owner_id, co.team_id)))),
                   (3, (select co.price_list_id from public.companies co
                         where co.organization_id = p_org and co.id = v_company
                           and (not p_person or app.can_read_record(co.organization_id, co.owner_id, co.team_id)))))
           as o(n, list_id)
      join public.price_lists l on l.organization_id = p_org and l.id = o.list_id
     where l.is_active
       and (l.valid_from is null or l.valid_from <= v_day)
       and (l.valid_to is null or l.valid_to >= v_day)
     order by o.n
     limit 1;
    if v_list is not null then
      select t.price_agorot, t.discount_bp, t.price_includes_vat into v_tier_price, v_tier_bp, v_tier_incl
        from public.price_list_lines t
       where t.organization_id = p_org and t.price_list_id = v_list and t.product_id = v_product.id
         and t.min_quantity <= 1
       order by t.min_quantity desc, t.id
       limit 1;
      if found then
        if v_tier_price is not null then
          v_price := v_tier_price;
          v_includes := v_product.vat_kind = 'taxable' and v_tier_incl;
          v_source := 'price_list';
          v_list_used := v_list;
        elsif v_tier_bp is not null then
          v_price := app.price_list_discounted(v_price, v_tier_bp);
          v_source := 'price_list';
          v_list_used := v_list;
        end if;
      end if;
    end if;
  end if;
  v_price := app.product_line_price(v_price, v_includes, v_product.vat_kind, v_mode, v_rate);

  -- written by the server's branch of the order triggers. The button keeps the person's session (the audit names them as
  -- the actor) and sets the transaction-local app.order_server for the two inserts; an empty owner is kept by the narrow
  -- trigger orders_check_meeting_owner below (orders_check fills auth.uid() into an empty owner otherwise). The automatic
  -- path puts the session aside instead, as AUT-02's create_quote does. Every setting is always put back.
  v_order := gen_random_uuid();
  v_server := current_setting('app.order_server', true);
  v_no_owner := current_setting('app.meeting_order_no_owner', true);
  if p_person then
    perform set_config('app.order_server', 'on', true);
    if v_owner is null then
      perform set_config('app.meeting_order_no_owner', v_order::text, true);
    end if;
  else
    v_claims := current_setting('request.jwt.claims', true);
    v_claim_sub := current_setting('request.jwt.claim.sub', true);
    if v_claims is not null then
      perform set_config('request.jwt.claims', '', true);
    end if;
    if v_claim_sub is not null then
      perform set_config('request.jwt.claim.sub', '', true);
    end if;
  end if;
  begin
    insert into public.orders (id, organization_id, status, source, deal_id, contact_id, owner_id, created_by,
                               prices_include_vat, currency)
    values (v_order, p_org, 'draft', 'manual', v_deal, v_meeting.contact_id, v_owner, v_actor, v_mode, 'ILS');
    insert into public.order_lines (organization_id, order_id, position, kind, product_id, name, quantity, unit_price_agorot,
                                    vat_exempt, billing, price_source, price_list_id, currency, unit_name)
    values (p_org, v_order, 1, 'item', v_product.id, left(btrim(v_product.name), 300), 1, v_price,
            v_product.vat_kind <> 'taxable', coalesce(v_product.billing, 'one_time'), v_source, v_list_used, 'ILS', v_unit);
    insert into app.meeting_order_drafts (organization_id, meeting_id, order_id, created_by)
    values (p_org, p_meeting, v_order, v_actor);
  exception when others then
    perform app.meeting_order_draft_restore(p_person, v_server, v_no_owner, v_claims, v_claim_sub);
    raise;
  end;
  perform app.meeting_order_draft_restore(p_person, v_server, v_no_owner, v_claims, v_claim_sub);
  return jsonb_build_object('ok', true, 'order_id', v_order);
end;
$$;
revoke all on function app.meeting_order_draft_make(uuid, uuid, boolean) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The automatic path
-- ----------------------------------------------------------------------------
create or replace function app.meetings_order_draft() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard: the meeting's write already passed its policies; a non-member session makes nothing
  if auth.uid() is not null and not app.is_member(new.organization_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'held' then
    return null;
  end if;
  if coalesce((select s.meeting_order_draft from public.org_document_settings s
                where s.organization_id = new.organization_id), 'button') <> 'auto' then
    return null;
  end if;
  begin
    -- owner (171) ב: a person who may not edit the meeting's contact (the button's rule) gets no draft, only one notice
    -- per meeting while a draft could otherwise be made; someone with the right makes it with the button. A write with no
    -- session (auth.uid() null: imports, automations, booking flows) makes the draft as the server (lead's choice).
    if auth.uid() is not null and app.meeting_order_draft_forbidden(new) then
      if app.meeting_order_draft_refusal(new.organization_id, new.id) is null then
        insert into app.meeting_order_draft_notices (organization_id, meeting_id, user_id)
        values (new.organization_id, new.id, auth.uid())
        on conflict (organization_id, meeting_id) do nothing;
        if found then
          insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
          values (new.organization_id, auth.uid(), 'system', 'לא נוצרה טיוטת הזמנה מהפגישה',
                  'אין לך הרשאה על הלקוח של הפגישה. מי שיש לו הרשאה יכול ליצור אותה מהפגישה.', 'meeting', new.id);
        end if;
      end if;
      return null;
    end if;
    perform app.meeting_order_draft_make(new.organization_id, new.id, false);
  exception when others then
    -- the meeting's write never fails because of the draft
    raise warning 'meeting order draft not made for meeting %: %', new.id, sqlstate;
  end;
  return null;
end;
$$;
revoke all on function app.meetings_order_draft() from public, anon, authenticated, service_role;

create or replace trigger meetings_zz_order_draft after insert or update of status on public.meetings
  for each row
  when (new.status = 'held')
  execute function app.meetings_order_draft();

-- ----------------------------------------------------------------------------
-- Whether the caller reads a made draft (orders_select's rule: the deal, else the contact), so its id is told only then
-- ----------------------------------------------------------------------------
create or replace function app.meeting_order_draft_readable(p_org uuid, p_order uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select case when o.deal_id is not null then exists (
                  select 1 from public.deals d where d.organization_id = p_org and d.id = o.deal_id
                     and app.can_read_record(d.organization_id, d.owner_id, d.team_id))
                else exists (
                  select 1 from public.contacts c where c.organization_id = p_org and c.id = o.contact_id
                     and app.can_read_record(c.organization_id, c.owner_id, c.team_id)) end
      from public.orders o where o.organization_id = p_org and o.id = p_order), false)
$$;
revoke all on function app.meeting_order_draft_readable(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Whether the caller may see the meeting. MUST stay in step with the meetings_select policy (as public.meeting_busy's copy
-- does); test 310 compares the two for several roles.
-- ----------------------------------------------------------------------------
create or replace function app.meeting_order_draft_meeting_readable(p_meeting public.meetings) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    app.can_read_record(p_meeting.organization_id, p_meeting.owner_id, null)
    or app.manages_meeting_organizer(p_meeting.organization_id, p_meeting.owner_id)
    or (app.is_member(p_meeting.organization_id)
        and (p_meeting.created_by = (select auth.uid()) or app.is_meeting_participant(p_meeting.organization_id, p_meeting.id)))
    or app.meeting_subject_ok(p_meeting.organization_id, p_meeting.lead_id, p_meeting.contact_id, p_meeting.company_id,
                              p_meeting.deal_id, false), false)
$$;
revoke all on function app.meeting_order_draft_meeting_readable(public.meetings) from public, anon, authenticated, service_role;

-- The caller may not edit the meeting's live contact: the button answers not_permitted before any other reason (a contact in
-- the bin is told by the rule as contact_gone; a meeting with no contact as no_contact).
create or replace function app.meeting_order_draft_forbidden(p_meeting public.meetings) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.contacts c
                  where c.organization_id = p_meeting.organization_id and c.id = p_meeting.contact_id and c.deleted_at is null)
         and not app.quote_editable(p_meeting.organization_id, null, p_meeting.contact_id)
$$;
revoke all on function app.meeting_order_draft_forbidden(public.meetings) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The button
-- ----------------------------------------------------------------------------
create or replace function public.meeting_order_draft_create(p_org uuid, p_meeting uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings;
  v_answer jsonb;
begin
  if app.membership_role(p_org) is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  -- a meeting the caller may not see answers like no meeting at all
  select * into v_meeting from public.meetings m where m.organization_id = p_org and m.id = p_meeting;
  if not found or not app.meeting_order_draft_meeting_readable(v_meeting) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  -- the right comes before every other reason, so someone who may not act learns nothing more (a made draft included)
  if app.meeting_order_draft_forbidden(v_meeting) then
    return jsonb_build_object('ok', false, 'reason', 'not_permitted');
  end if;
  v_answer := app.meeting_order_draft_make(p_org, p_meeting, true);
  -- an earlier draft's id only to someone who reads it
  if v_answer ? 'order_id' and not (v_answer ->> 'ok')::boolean
     and not app.meeting_order_draft_readable(p_org, (v_answer ->> 'order_id')::uuid) then
    v_answer := v_answer - 'order_id';
  end if;
  return v_answer;
end;
$$;
revoke all on function public.meeting_order_draft_create(uuid, uuid) from public, anon;
grant execute on function public.meeting_order_draft_create(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- What the meetings card shows: an entry only for a meeting the caller may see that is held or has a draft
-- ----------------------------------------------------------------------------
create or replace function public.meeting_order_draft_states(p_org uuid, p_meetings uuid[]) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_out jsonb := '{}'::jsonb;
  v_reason text;
  v_order uuid;
  v_meeting public.meetings;
begin
  if app.membership_role(p_org) is null then
    return v_out;
  end if;
  if coalesce(cardinality(p_meetings), 0) > 200 then
    raise exception 'too many meetings' using errcode = 'P0001', hint = 'meeting_order_draft:too_many';
  end if;
  for v_id in select distinct x from unnest(coalesce(p_meetings, '{}'::uuid[])) as x where x is not null loop
    select * into v_meeting from public.meetings m where m.organization_id = p_org and m.id = v_id;
    continue when not found or not app.meeting_order_draft_meeting_readable(v_meeting);
    v_reason := app.meeting_order_draft_refusal(p_org, v_id);
    continue when v_reason is distinct from 'exists' and v_meeting.status <> 'held';
    v_order := null;
    if app.meeting_order_draft_forbidden(v_meeting) then
      -- as the button answers; a made draft's id still goes to someone who reads the order
      if v_reason = 'exists' then
        select d.order_id into v_order from app.meeting_order_drafts d where d.organization_id = p_org and d.meeting_id = v_id;
      end if;
      v_reason := 'not_permitted';
    elsif v_reason = 'exists' then
      select d.order_id into v_order from app.meeting_order_drafts d where d.organization_id = p_org and d.meeting_id = v_id;
    end if;
    if v_order is not null and not app.meeting_order_draft_readable(p_org, v_order) then
      v_order := null;
    end if;
    v_out := v_out || jsonb_build_object(v_id::text, jsonb_build_object('reason', v_reason, 'order_id', v_order));
  end loop;
  return v_out;
end;
$$;
revoke all on function public.meeting_order_draft_states(uuid, uuid[]) from public, anon;
grant execute on function public.meeting_order_draft_states(uuid, uuid[]) to authenticated;
