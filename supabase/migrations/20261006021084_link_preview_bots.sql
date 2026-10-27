-- WAB-05 follow-up (owner, 27 October 2026, DECISIONS.md "תצוגה מקדימה של קישור: בוטים ושם העסק", answers (1) ב and (2) ב):
-- a messaging app's preview bot (WhatsApp on the rep's phone, Facebook, Telegram, ... from a CLOSED list of User-Agents in
-- src/lib/preview-bots.ts) that fetches a customer page's link gets ONLY the business's display name and logo, through this
-- one narrow function, instead of running the page: no view is counted, no quote is marked viewed, nobody is told, no
-- automation runs. A bot not on the list gets the normal page.
--
-- public.link_preview_public(p_kind, p_token, p_ip_hash) is a new use of the service-role key under the approved public
-- secret-link pattern: security definer, granted to service_role only, no table access for the server. It answers
--   {kind, business, logo}            (a card adds {rep}: the name the card itself always shows)
--   {not_found: true}                  whenever the page itself would show no business (unknown or revoked token, draft,
--                                      deleted customer, inactive, closed public pages, no plan flag, read-only booking page)
--   {refused: 'rate'}                  over the limits
-- business = organizations.name, the business's DISPLAY name (owner's answer (2) ב), never the registered legal_name;
-- logo = the logo object's name in the public bucket org-logos, and for a quote or an order only while its design shows the
-- logo (as the page). Never a number, an amount, a title, a time, a customer's or a meeting's detail.
--
-- The only write is its own rate-limit counters (counted first, before the token is looked up, so a bot guessing tokens is
-- limited too):
--   app.link_preview_reads        one row: at most app.link_preview_reads_per_minute() (300) previews a minute in total;
--   app.link_preview_sender_counts 1,024 reused buckets keyed by the server's keyed IP hash (FXS-11, scope 'preview'): at most
--                                 app.link_preview_sender_limit() (30) per sender in 10 minutes. Only the bucket number is
--                                 kept, never the hash, so there is nothing for a cleanup job to clear (as
--                                 app.booking_view_counts). A call without a hash (no secret set) meets the global limit only.
--
-- "Usable" is decided by each page's own rule, through its existing helper where one exists:
--   quote          app.quote_link_usable on the link's quote, and the shown version (app.quote_shown_version) with its customer
--                  not deleted: quote_public's two not-found checks (copied: the second one; test 253-link-preview-bots pins equality);
--   order          app.order_link_usable (order_public's not-found rule);
--   booking        app.booking_page_state = 'open' and no closure (booking_page_public answers unavailable otherwise, which shows
--                  no business; copied, test 253-link-preview-bots pins equality);
--   booking_manage app.booking_manage_link, the meeting found, public pages open and the business writable
--                  (booking_manage_public's rule; copied, test 253-link-preview-bots pins equality);
--   card           app.business_card_open (business_card_public's rule);
--   form           a form of kind 'form', active, public pages open (intake_form's rule; copied, test 253-link-preview-bots pins equality).

create table if not exists app.link_preview_reads (
  id      integer primary key constraint link_preview_reads_one check (id = 1),
  minute  timestamptz not null,
  reads   integer not null
);
alter table app.link_preview_reads enable row level security;
revoke all on app.link_preview_reads from public, anon, authenticated, service_role;

create table if not exists app.link_preview_sender_counts (
  bucket       integer primary key check (bucket between 0 and 1023),
  window_start timestamptz not null,
  views        integer not null
);
alter table app.link_preview_sender_counts enable row level security;
revoke all on app.link_preview_sender_counts from public, anon, authenticated, service_role;

create or replace function app.link_preview_reads_per_minute() returns integer
language sql immutable
set search_path = ''
as $$ select 300 $$;
revoke all on function app.link_preview_reads_per_minute() from public, anon, authenticated, service_role;

create or replace function app.link_preview_sender_limit() returns integer
language sql immutable
set search_path = ''
as $$ select 30 $$;
revoke all on function app.link_preview_sender_limit() from public, anon, authenticated, service_role;

create or replace function public.link_preview_public(p_kind text, p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_minute timestamptz := date_trunc('minute', now());
  v_reads integer;
  v_bucket integer;
  v_views integer;
  v_org uuid;
  v_logo_shown boolean := true;
  v_rep uuid;
  v_quote_link app.quote_links;
  v_quote public.quotes;
  v_shown public.quotes;
  v_order_link app.order_links;
  v_order public.orders;
  v_page public.booking_pages;
  v_manage app.booking_manage_links;
  v_meeting public.meetings;
  v_card public.business_cards;
  v_form public.forms;
  v_result jsonb;
begin
  if p_kind is null or p_kind not in ('form', 'quote', 'order', 'booking', 'booking_manage', 'card') then
    raise exception 'unknown preview kind' using errcode = '22023';
  end if;

  -- the limits, counted first: in total a minute (a late commit never moves the minute back), then per sender
  insert into app.link_preview_reads as r (id, minute, reads)
  values (1, v_minute, 1)
  on conflict (id) do update
     set minute = greatest(r.minute, excluded.minute),
         reads = case when r.minute >= excluded.minute then r.reads + 1 else 1 end
  returning r.reads into v_reads;
  if v_reads > app.link_preview_reads_per_minute() then
    return jsonb_build_object('refused', 'rate');
  end if;
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(p_ip_hash, 0) % 1024) + 1024) % 1024;
    insert into app.link_preview_sender_counts as vc (bucket, window_start, views)
    values (v_bucket, now(), 1)
    on conflict (bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > app.link_preview_sender_limit() then
      return jsonb_build_object('refused', 'rate');
    end if;
  end if;

  if p_kind = 'quote' then
    if coalesce(p_token, '') ~ '^[A-Za-z0-9_-]{64}$' then
      select * into v_quote_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
      if v_quote_link.quote_id is not null then
        select * into v_quote from public.quotes q
         where q.organization_id = v_quote_link.organization_id and q.id = v_quote_link.quote_id;
        if app.quote_link_usable(v_quote) then
          v_shown := app.quote_shown_version(v_quote);
          if v_shown.customer_deleted_at is null then
            v_org := v_quote.organization_id;
            select coalesce(d.show_logo, true) into v_logo_shown from public.quote_designs d where d.organization_id = v_org;
            v_logo_shown := coalesce(v_logo_shown, true);
          end if;
        end if;
      end if;
    end if;

  elsif p_kind = 'order' then
    if coalesce(p_token, '') ~ '^[A-Za-z0-9_-]{64}$' then
      select * into v_order_link from app.order_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
      if v_order_link.order_id is not null then
        select * into v_order from public.orders o
         where o.organization_id = v_order_link.organization_id and o.id = v_order_link.order_id;
        if app.order_link_usable(v_order) then
          v_org := v_order.organization_id;
          select coalesce(d.show_logo, true) into v_logo_shown from public.quote_designs d where d.organization_id = v_org;
          v_logo_shown := coalesce(v_logo_shown, true);
        end if;
      end if;
    end if;

  elsif p_kind = 'booking' then
    select * into v_page from public.booking_pages b where b.token = coalesce(p_token, '');
    if app.booking_page_state(v_page) = 'open'
       and not exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
      v_org := v_page.organization_id;
    end if;

  elsif p_kind = 'booking_manage' then
    v_manage := app.booking_manage_link(p_token);
    select * into v_meeting from public.meetings m where m.organization_id = v_manage.organization_id and m.id = v_manage.meeting_id;
    if v_meeting.id is not null and app.org_public_pages_open(v_meeting.organization_id) and app.org_writable(v_meeting.organization_id) then
      v_org := v_meeting.organization_id;
    end if;

  elsif p_kind = 'card' then
    select * into v_card from public.business_cards c where c.token = coalesce(p_token, '');
    if app.business_card_open(v_card) then
      v_org := v_card.organization_id;
      v_rep := v_card.user_id;
    end if;

  else -- form
    select * into v_form from public.forms f where f.token = coalesce(p_token, '') and f.kind = 'form';
    if v_form.id is not null and v_form.is_active and app.org_public_pages_open(v_form.organization_id) then
      v_org := v_form.organization_id;
    end if;
  end if;

  if v_org is null then
    return jsonb_build_object('not_found', true);
  end if;

  -- the business's display name and logo only; for a card also the name the card always shows (the rep's, else the business's)
  select jsonb_build_object('kind', p_kind, 'business', o.name, 'logo', case when v_logo_shown then o.logo_path end)
         || case when p_kind = 'card'
                 then jsonb_build_object('rep', coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.id = v_rep), o.name))
                 else '{}'::jsonb end
    into v_result
    from public.organizations o
   where o.id = v_org;
  return coalesce(v_result, jsonb_build_object('not_found', true));
end;
$$;
revoke all on function public.link_preview_public(text, text, text) from public, anon, authenticated;
grant execute on function public.link_preview_public(text, text, text) to service_role;
