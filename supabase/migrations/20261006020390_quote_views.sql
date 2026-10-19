-- =============================================================================
-- QUO-10: the customer's views of a quote, and the "quote viewed" notification
-- =============================================================================
-- Owner, 18 October 2026 (answer 17): a new notification kind `quote_viewed`, which a person can mute. Spec QUO-10:
-- first view, number of views, last view; the owner is told at the first view (and at accept / reject, which come with
-- QUO-09 and its own kind decision).
-- * notifications_kinds / notification_settings_kinds take 'quote_viewed' (shared ground; kept in step with
--   src/features/notifications/settings.ts, unit test notification-kinds).
-- * public.quote_views: one row per quote that a customer opened (first_viewed_at, last_viewed_at, view_count). Written
--   only by the server (no client insert, update or delete grant); read by whoever reads the quote (the select policy
--   asks public.quotes under the caller's own rights). Cascades with the quote. Kept apart from public.quotes so a view
--   neither writes the quote's audit log nor moves its updated_at; only the one status change does.
-- * app.quote_mark_viewed(quote) (definer, no grants): counts the view, moves a sent quote to viewed once (an update
--   guarded by status = 'sent', so two parallel first views notify once) and then sends `quote_viewed` to the quote's
--   owner while they are an active member: the quote's number in the title and the quote's title in the body, never the
--   customer's name (a later privacy erasure does not empty notifications). Returns true when this view was the first.
-- * public.quote_public (body of 020345): the same, plus the call above for the quote it shows (after the rate limit and
--   the QUO-12 chain, so the version the customer sees is the one counted). A view over the limit is not counted.
-- No drop statement, no delete. Safe to run twice.

-- ----------------------------------------------------------------------------
-- The new notification kind
-- ----------------------------------------------------------------------------
alter table public.notifications
  drop constraint if exists notifications_kinds,
  add constraint notifications_kinds check (type in (
    'system', 'assigned', 'task_reminder', 'inquiry', 'automation',
    'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
    'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue'));

alter table public.notification_settings
  drop constraint if exists notification_settings_kinds,
  add constraint notification_settings_kinds check (
    muted <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                   'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                   'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue']
    and no_push <@ array['assigned', 'task_reminder', 'inquiry', 'automation',
                         'lead_new', 'mention', 'follow', 'meeting_scheduled', 'meeting_reminder', 'meeting_cancelled',
                         'automation_failed', 'quote', 'quote_viewed', 'payment', 'response_overdue']);

-- ----------------------------------------------------------------------------
-- The views
-- ----------------------------------------------------------------------------
create table if not exists public.quote_views (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  quote_id        uuid not null,
  first_viewed_at timestamptz not null default now(),
  last_viewed_at  timestamptz not null default now(),
  view_count      integer not null default 1 check (view_count >= 1),
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  -- one row per quote; also the index of the foreign key
  constraint quote_views_quote_unique unique (organization_id, quote_id),
  constraint quote_views_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade
);

alter table public.quote_views enable row level security;
revoke all on public.quote_views from anon, authenticated;
grant select on public.quote_views to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_views' and policyname = 'quote_views_select') then
    -- whoever reads the quote (its deal's or contact's rules, through the quotes policy) reads its views
    create policy quote_views_select on public.quote_views for select to authenticated
      using (app.is_member(organization_id)
             and exists (select 1 from public.quotes q
                          where q.organization_id = quote_views.organization_id and q.id = quote_views.quote_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Counting a view
-- ----------------------------------------------------------------------------
create or replace function app.quote_mark_viewed(p_quote public.quotes) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_first public.quotes;
begin
  if p_quote.id is null then
    return false;
  end if;
  insert into public.quote_views as v (organization_id, quote_id)
  values (p_quote.organization_id, p_quote.id)
  on conflict (organization_id, quote_id) do update
    set last_viewed_at = now(), view_count = v.view_count + 1;

  -- the first view of a sent quote: once, even when two views arrive together
  update public.quotes q set status = 'viewed'
   where q.organization_id = p_quote.organization_id and q.id = p_quote.id and q.status = 'sent'
  returning q.* into v_first;
  if v_first.id is null then
    return false;
  end if;

  if v_first.owner_id is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = v_first.organization_id and m.user_id = v_first.owner_id and m.status = 'active') then
    insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
    values (v_first.organization_id, v_first.owner_id, 'quote_viewed',
            'הלקוח פתח את הצעת המחיר' || coalesce(' ' || v_first.number_display, ''),
            -- no personal data: a later privacy erasure does not reach notification bodies
            nullif(btrim(coalesce(v_first.title, '')), ''),
            'quote', v_first.id);
  end if;
  return true;
end;
$$;
revoke all on function app.quote_mark_viewed(public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The customer's page (QUO-08, GAP-09, QUO-12; the body of 020345 with the view counted)
-- ----------------------------------------------------------------------------
create or replace function public.quote_public(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_count integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_show_details boolean;
  v_show_logo boolean;
  v_lines jsonb;
  v_built_with boolean;
  v_schedule jsonb;
  -- QUO-12: the quote the link was made for, when the page shows a newer version of it
  v_opened public.quotes;
  v_next public.quotes;
  v_steps integer := 0;
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

  -- 120 views per link in 10 minutes; counted first, so the limit holds under parallel load
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;

  -- QUO-12: a newer version replaces the quote on its old link once that version is sent and has a working link of its own
  -- (the newest such one in the chain); until then the link shows the quote it was made for
  v_next := v_quote;
  loop
    select * into v_next from public.quotes q
     where q.organization_id = v_next.organization_id and q.previous_id = v_next.id;
    exit when not found;
    v_steps := v_steps + 1;
    exit when v_steps > 100;
    if app.quote_link_open(v_next)
       and exists (select 1 from app.quote_links l
                    where l.organization_id = v_next.organization_id and l.quote_id = v_next.id and l.token_hash is not null) then
      if v_opened.id is null then
        v_opened := v_quote;
      end if;
      v_quote := v_next;
    end if;
  end loop;

  -- QUO-10: the customer opened the quote shown; count the view, and the first one marks it viewed and tells its owner
  if app.quote_mark_viewed(v_quote) then
    v_quote.status := 'viewed';
  end if;

  select * into v_org from public.organizations o where o.id = v_quote.organization_id;
  select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
  select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
  -- QUO-05: no design row = the defaults (logo and business details shown)
  v_show_details := coalesce(v_design.show_business_details, true);
  v_show_logo := coalesce(v_design.show_logo, true);

  select coalesce(jsonb_agg(jsonb_build_object(
           'position', l.position,
           'kind', l.kind,
           'name', l.name,
           'description', l.description,
           'unit_name', l.unit_name,
           'quantity', l.quantity,
           'unit_price_agorot', l.unit_price_agorot,
           'discount_bp', l.discount_bp,
           'discount_agorot', l.discount_agorot,
           'vat_exempt', l.vat_exempt,
           'billing', l.billing,
           'is_optional', l.is_optional,
           'optional_selected', l.optional_selected,
           'total_agorot', l.total_agorot) order by l.position, l.id), '[]'::jsonb)
    into v_lines
    from public.quote_lines l
   where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id;

  -- GAP-09: the payment schedule, with each row's share of the total (the shares add up to the total)
  v_schedule := app.quote_schedule(v_quote.organization_id, v_quote.id, v_quote.total_agorot);

  begin
    v_built_with := coalesce(app.show_built_with(v_quote.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return jsonb_build_object(
    'quote', jsonb_build_object(
      'number', v_quote.number_display,
      'title', v_quote.title,
      'status', v_quote.status,
      'quote_date', v_quote.quote_date,
      'valid_until', v_quote.valid_until,
      'sent_at', v_quote.sent_at,
      'prices_include_vat', v_quote.prices_include_vat,
      'no_vat_reason', v_quote.no_vat_reason,
      'no_vat_note', v_quote.no_vat_note,
      'discount_bp', v_quote.discount_bp,
      'discount_agorot', v_quote.discount_agorot,
      'notes', v_quote.notes,
      'terms', v_quote.terms,
      'vat_rate_bp', v_quote.vat_rate_bp,
      'subtotal_agorot', v_quote.subtotal_agorot,
      'discount_total_agorot', v_quote.discount_total_agorot,
      'net_total_agorot', v_quote.net_total_agorot,
      'vat_agorot', v_quote.vat_agorot,
      'total_agorot', v_quote.total_agorot,
      'currency', v_quote.currency),
    -- the customer as printed when the quote was sent (QUO-07); never the live record
    'customer', jsonb_build_object('name', v_quote.customer_name, 'contact', v_quote.customer_contact_name),
    'lines', v_lines,
    'schedule', v_schedule,
    -- documents use the registered name when set (owner); the rest only when the design shows the details
    'business', jsonb_build_object(
      'name', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'tax_id', case when v_show_details then v_settings.tax_id end,
      'address_line', case when v_show_details then v_settings.address_line end,
      'city', case when v_show_details then v_settings.city end,
      'postal_code', case when v_show_details then v_settings.postal_code end,
      'phone', case when v_show_details then v_settings.phone end,
      'email', case when v_show_details then v_settings.email end),
    'design', jsonb_build_object(
      'header_text', v_design.header_text,
      'footer_text', v_design.footer_text,
      'show_logo', v_show_logo,
      'show_business_details', v_show_details,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- QUO-12: the number the customer's link was made for, when this is a newer version of it (else null)
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end);
end;
$$;
revoke all on function public.quote_public(text) from public, anon, authenticated;
grant execute on function public.quote_public(text) to service_role;

notify pgrst, 'reload schema';
