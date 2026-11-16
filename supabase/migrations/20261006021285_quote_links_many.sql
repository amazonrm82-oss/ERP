-- QUO-08 / QUO-18: several live links per quote (the owner's answer (385) ב, 16 November 2026, docs/DECISIONS.md). A quote may
-- have several live customer links at once, each until the quote closes (accepted, declined, cancelled, expired: the rules
-- of app.quote_link_usable / app.quote_link_open / app.quote_offer_open, unchanged) or until revoked by hand.
--
-- * app.quote_link_tokens (schema app, RLS on, no grants, so a token's hash is never selectable): one row per link issued,
--   the SHA-256 of the token only, who made it and when, how (made_by: 'screen' = the quote screen's button, 'message' = a
--   person's send from the quote screen, 'reminder' = an automatic reminder, 'migrated' = the one live link a quote had
--   before), the job of a message, and revoked_at.
-- * app.quote_links stays ONE row per quote: its token_hash is the newest live link's hash and is null exactly while the quote
--   has no live link (every "has a live link" rule reads it unchanged: app.quote_link_shows, app.quote_in_person_state, the
--   decide and in-person counters), and its counters (the 120 views per 10 minutes, the decide tries, the questions) are now
--   counted per QUOTE across all its links. The per-sender limits are unchanged.
-- * app.quote_link_token_issue (no grants) issues a link for public.quote_link_create (the screen) and for
--   app.quote_message_link_issue (021283's composers), which now ADDS a link instead of replacing one: earlier emails, SMS
--   and WhatsApp links keep working, and a message refused after its link was minted leaves the earlier ones alive. At most
--   10 live links per quote (lead's choice): issuing an 11th revokes one: first the link of a message that surely never
--   reached the customer, then an earlier attempt's link of a re-composed job, then the oldest. Nothing is revoked on the spot.
--   Lock order everywhere: the quote's app.quote_links row, then its tokens (public.quote_link_revoke takes it FOR UPDATE).
-- * public.quote_link_revoke ends every live link of the quote; public.quote_link_status also answers `live` (the count).
-- * Every token lookup (public.quote_public, quote_public_version, quote_public_answer (quote_public_decide is its wrapper),
--   quote_public_pdf, quote_public_question, app.quote_signed_pdf_token_quote, public.link_preview_public's quote kind) finds
--   the token among the quote's live links and then reads the quote's row as before; the "not found" rule is identical (an
--   unknown or revoked token answers not found). Their bodies are their latest ones (read from the built database) with only
--   that statement changed; test 253 is re-pinned.
-- * Existing rows: the one live link of each quote is copied into app.quote_link_tokens (made_by 'migrated'); nothing is
--   removed or rewritten.
-- Every statement is safe to run twice.

create table if not exists app.quote_link_tokens (
  id              uuid primary key default gen_random_uuid(),
  -- delta review 3: the order links were issued in, never tied (two issues in one transaction share now())
  seq             bigint generated always as identity,
  organization_id uuid not null,
  quote_id        uuid not null,
  token_hash      text not null unique,
  made_by         text not null check (made_by in ('screen', 'message', 'reminder', 'migrated')),
  job_id          uuid,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  constraint quote_link_tokens_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade
);
create index if not exists quote_link_tokens_quote_idx on app.quote_link_tokens (organization_id, quote_id) where revoked_at is null;
create index if not exists quote_link_tokens_org_quote_idx on app.quote_link_tokens (organization_id, quote_id);
alter table app.quote_link_tokens enable row level security;
revoke all on app.quote_link_tokens from public, anon, authenticated, service_role;

-- the one live link each quote had keeps working
insert into app.quote_link_tokens (organization_id, quote_id, token_hash, made_by, created_by, created_at)
select l.organization_id, l.quote_id, l.token_hash, 'migrated', l.created_by, coalesce(l.created_at, now())
  from app.quote_links l
 where l.token_hash is not null
on conflict (token_hash) do nothing;

create or replace function app.quote_link_max_live() returns integer
language sql immutable set search_path = '' as $$ select 10 $$;
revoke all on function app.quote_link_max_live() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- One more live link of a quote (the callers check the rights and the quote first); the token is answered once
-- ----------------------------------------------------------------------------
create or replace function app.quote_link_token_issue(p_org uuid, p_quote uuid, p_user uuid, p_made_by text, p_job uuid)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text;
  v_hash text;
begin
  -- 48 random bytes from three UUIDs, base64url: 64 characters (public.quote_link_create's token)
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  v_hash := encode(sha256(convert_to(v_token, 'UTF8')), 'hex');
  -- the quote's row first (its counters are kept; it names the newest live link), taken for update so two issues of the same
  -- quote count the live links one after the other
  insert into app.quote_links as l (quote_id, organization_id, token_hash, created_by, created_at, window_started_at, window_count)
  values (p_quote, p_org, v_hash, p_user, now(), null, 0)
  on conflict (quote_id) do update
    set token_hash = excluded.token_hash,
        created_by = excluded.created_by,
        created_at = excluded.created_at;
  insert into app.quote_link_tokens (organization_id, quote_id, token_hash, made_by, job_id, created_by)
  values (p_org, p_quote, v_hash, p_made_by, p_job, p_user);
  -- at most 10 live links (lead's choice). Nothing is revoked on the spot: every link a message carried stays live, since a
  -- re-composed message (its lease ran out after the provider took it) may be the one the customer got. Only when the 11th
  -- link is made is one revoked, in this order (second delta review):
  --   1. the link of a message that surely never reached the customer: its job refused, or dead with no message outcome, no
  --      unknown_* provider code and not ended by a lease that ran out (a missing job row counts as possibly delivered);
  --   2. an earlier attempt's link of a job that minted a newer one;
  --   3. the oldest, by the order of issue (seq).
  update app.quote_link_tokens t
     set revoked_at = now()
   where t.id in (select x.id from app.quote_link_tokens x
                   where x.organization_id = p_org and x.quote_id = p_quote and x.revoked_at is null
                   order by case
                              when x.job_id is not null and exists (
                                     select 1 from app.jobs j
                                      where j.id = x.job_id
                                        and (j.status = 'refused'
                                             or (j.status = 'dead' and j.message_outcome is null
                                                 and coalesce(j.provider_error_code, '') not like 'unknown\_%'
                                                 and j.last_error is distinct from 'lease expired'))) then 0
                              when x.job_id is not null and exists (
                                     select 1 from app.quote_link_tokens n
                                      where n.organization_id = x.organization_id and n.quote_id = x.quote_id
                                        and n.job_id = x.job_id and n.seq > x.seq) then 1
                              else 2
                            end desc,
                            x.seq desc
                  offset app.quote_link_max_live());
  return v_token;
end;
$$;
revoke all on function app.quote_link_token_issue(uuid, uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- app.quote_message_link_issue(public.quotes, uuid, uuid): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function app.quote_message_link_issue(p_quote public.quotes, p_user uuid, p_job uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_token text;
begin
  if p_quote.id is null or not coalesce(app.quote_link_open(p_quote), false) then
    return null;
  end if;
  -- owner (385) ב: the message carries one more live link; the quote's earlier links keep working, and a message that is
  -- refused after this leaves them alive (a reminder's link is marked 'reminder', a person's send 'message')
  v_token := app.quote_link_token_issue(p_quote.organization_id, p_quote.id, p_user,
                                        case when p_user is null then 'reminder' else 'message' end, p_job);
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_quote.organization_id, p_user, 'quote_link', 'quotes', p_quote.id,
          jsonb_build_object('link', 'created', 'via', 'message', 'job_id', p_job));
  return v_token;
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_link_create(uuid, uuid): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_link_create(p_org uuid, p_quote uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote public.quotes;
  v_token text;
begin
  v_quote := app.quote_link_quote(p_org, p_quote);
  if v_quote.status = 'draft' then
    raise exception 'only a sent quote has a link' using errcode = 'P0001', hint = 'quote:not_sent';
  end if;
  if not app.quote_link_open(v_quote) then
    raise exception 'the quote is no longer open' using errcode = 'P0001', hint = 'quote:closed';
  end if;

  -- owner (385) ב: one more live link; the earlier ones keep working (at most 10 live, the oldest revoked)
  v_token := app.quote_link_token_issue(p_org, p_quote, auth.uid(), 'screen', null);

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'quote_link', 'quotes', p_quote, jsonb_build_object('link', 'created'));
  return v_token;
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_link_revoke(uuid, uuid): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_link_revoke(p_org uuid, p_quote uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer;
begin
  perform app.quote_link_quote(p_org, p_quote);
  -- delta review 1: the quote's row first, the lock order of app.quote_link_token_issue, so a revoke racing an issue never
  -- leaves a live link behind a row that says none (and the two never deadlock)
  perform 1 from app.quote_links l where l.organization_id = p_org and l.quote_id = p_quote for update;
  -- owner (385) ב: the screen's "revoke" ends every live link of the quote
  update app.quote_link_tokens t set revoked_at = now()
   where t.organization_id = p_org and t.quote_id = p_quote and t.revoked_at is null;
  update app.quote_links l
     set token_hash = null, created_at = null, window_started_at = null, window_count = 0
   where l.organization_id = p_org and l.quote_id = p_quote and l.token_hash is not null;
  get diagnostics v_count = row_count;
  if v_count > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, auth.uid(), 'quote_link', 'quotes', p_quote, jsonb_build_object('link', 'revoked'));
  end if;
  return v_count > 0;
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_link_status(uuid, uuid): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_link_status(p_org uuid, p_quote uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_quote public.quotes;
  v_created timestamptz;
begin
  v_quote := app.quote_link_quote(p_org, p_quote);
  select l.created_at into v_created from app.quote_links l
   where l.organization_id = p_org and l.quote_id = p_quote and l.token_hash is not null;
  -- owner (385) ב: created_at is the newest live link's; live counts them
  return jsonb_build_object('active', v_created is not null and app.quote_link_open(v_quote), 'created_at', v_created,
                            'live', (select count(*) from app.quote_link_tokens t
                                      where t.organization_id = p_org and t.quote_id = p_quote and t.revoked_at is null));
end;
$function$;

-- ----------------------------------------------------------------------------
-- app.quote_signed_pdf_token_quote(text): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function app.quote_signed_pdf_token_quote(p_token text)
 RETURNS public.quotes
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link app.quote_links;
  v_quote public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08 / owner (385) ב: the token is one of the quote's live links (app.quote_link_tokens); the counters stay on the quote's row
  select l.* into v_link from app.quote_link_tokens t
    join app.quote_links l on l.organization_id = t.organization_id and l.quote_id = t.quote_id
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null
     and l.token_hash is not null;
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  v_quote := app.quote_shown_version(v_quote);
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  return v_quote;
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_public(text): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_public(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_count integer;
  v_design public.quote_designs;
  v_settings public.org_document_settings;
  v_org public.organizations;
  v_show_details boolean;
  v_show_logo boolean;
  -- TAX-02: the bank details stored on the quote when it was sent, when the design shows them
  v_show_bank boolean;
  v_lines jsonb;
  v_built_with boolean;
  v_schedule jsonb;
  -- QUO-12: the quote the link was made for, when the page shows a newer version of it
  v_opened public.quotes;
  v_next public.quotes;
  -- OPS-02 (owner (41) ב): the per-sender view limit
  v_sender text;
  v_bucket integer;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08 / owner (385) ב: the token is one of the quote's live links (app.quote_link_tokens); the counters stay on the quote's row
  select l.* into v_link from app.quote_link_tokens t
    join app.quote_links l on l.organization_id = t.organization_id and l.quote_id = t.quote_id
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null
     and l.token_hash is not null;
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;

  -- owner, 19 October 2026: the link of a quote that was sent never answers not found. Not found only for a token that does
  -- not exist or was revoked (its hash cleared), a draft, a customer erased or purged (customer_deleted_at), a business whose
  -- public pages are closed, or one without quotes
  if not app.quote_link_usable(v_quote) then
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
  -- OPS-02 (owner, 2 November 2026, answer (41) ב): 60 views per sender in 10 minutes, as order_public and statement_public,
  -- counted after the token lookup and the link's window. The sender is the server's keyed IP hash (FXS-11 scope 'quote'),
  -- handed over in the request header x-crm-sender (app.public_sender_header, 021127) and scoped to the link's quote by
  -- app.quote_link_sender; no header = not counted (the signed PDF's own read, quote_public_answer, a page older than this file).
  -- Only a bucket number is kept, never the hash.
  v_sender := app.quote_link_sender(v_link.quote_id, app.public_sender_header());
  if v_sender is not null then
    v_bucket := ((hashtextextended(v_sender, 0) % 1024) + 1024) % 1024;
    insert into app.quote_link_view_counts as vc (organization_id, quote_id, bucket, window_start, views)
    values (v_link.organization_id, v_link.quote_id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_count;
    if v_count > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  -- the newest version of the chain that was ever sent (QUO-12, the QUO-11 review rule), whether or not it has a link of its
  -- own; never an older one
  v_next := app.quote_shown_version(v_quote);
  if v_next.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_next.id is distinct from v_quote.id then
    v_opened := v_quote;
    v_quote := v_next;
  end if;

  -- declined, cancelled, or past its date: a status page with no prices, lines or a way to sign (owner, 19 October 2026: an
  -- accepted quote is shown in full, with the day it was accepted and no way to decide)
  if not app.quote_offer_open(v_quote) and v_quote.status <> 'accepted' then
    select * into v_org from public.organizations o where o.id = v_quote.organization_id;
    select * into v_design from public.quote_designs d where d.organization_id = v_quote.organization_id;
    select * into v_settings from public.org_document_settings s where s.organization_id = v_quote.organization_id;
    return jsonb_build_object('status_page', jsonb_build_object(
      'state', case when v_quote.status in ('rejected', 'cancelled') then v_quote.status else 'expired' end,
      'number', v_quote.number_display,
      'title', v_quote.title,
      'valid_until', v_quote.valid_until,
      -- documents use the registered name when set (owner)
      'business', coalesce(nullif(btrim(v_settings.legal_name), ''), v_org.name),
      'logo', case when coalesce(v_design.show_logo, true) then v_org.logo_path end,
      'color', coalesce(v_design.accent_color, v_org.brand_color),
      'phone', coalesce(nullif(btrim(v_settings.phone), ''), nullif(btrim(v_org.phone), '')),
      'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
      -- a newer version is being prepared (QUO-12 answer 7)
      'draft_version', exists (select 1 from public.quotes d
                                where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                  and d.status = 'draft')));
  end if;

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
  v_show_bank := coalesce(v_design.show_bank_details_quote, true);

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
           'total_agorot', l.total_agorot,
           -- PRD-09: an itemised bundle lists its parts as kept on the line when it was added (names and quantities, no prices)
           'components', case when l.bundle_display = 'itemised' then l.bundle_items end,
           -- PKG-06 (owner (156) א): a punch card line's service recipient, the name as sent (null on every other line)
           'recipient', l.recipient_name) order by l.position, l.id), '[]'::jsonb)
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
      'show_bank_details_quote', v_show_bank,
      'accent_color', v_design.accent_color),
    'brand', jsonb_build_object('logo', case when v_show_logo then v_org.logo_path end, 'color', v_org.brand_color),
    'built_with', v_built_with,
    -- TAX-02: the business's bank details for a transfer, as stored on the quote when it was sent (never the live settings);
    -- only when the design shows them and the quote has them
    'bank', case when v_show_bank and v_quote.bank_details is not null then jsonb_build_object(
                   'bank_name', v_quote.bank_details ->> 'bank_name',
                   'bank_branch', v_quote.bank_details ->> 'bank_branch',
                   'bank_account', v_quote.bank_details ->> 'bank_account',
                   'bank_account_name', v_quote.bank_details ->> 'bank_account_name') end,
    -- QUO-12: the number the customer's link was made for, when this is a newer version of it (else null)
    'replaced', case when v_opened.id is not null then jsonb_build_object('number', v_opened.number_display) end,
    -- owner, 19 October 2026: the day an accepted quote was accepted, in the business's zone (null otherwise)
    'accepted_on', case when v_quote.status = 'accepted' then
                     (select (d.decided_at at time zone app.intake_zone(v_org.timezone))::date
                        from public.quote_decisions d
                       where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id and d.decision = 'accepted') end,
    -- QUO-12 (owner, 19 October 2026): a newer version is being prepared (a draft after the quote shown); no id or content
    'draft_version', exists (select 1 from public.quotes d
                              where d.organization_id = v_quote.organization_id and d.previous_id = v_quote.id
                                and d.status = 'draft'),
    -- GAP-10: the quote this one adds to (its number), and the accepted addenda of this one; numbers, titles and totals only
    'addendum', (select jsonb_build_object('number', o.number_display) from public.quotes o
                  where v_quote.addendum_of is not null and o.organization_id = v_quote.organization_id and o.id = v_quote.addendum_of),
    -- QUO-06 (owner's answer 1): the customer may download the stored PDF of the version shown
    'pdf', exists (select 1 from public.files f
                    where f.organization_id = v_quote.organization_id and f.quote_id = v_quote.id
                      and f.unconfirmed_since is null and f.sha256 is not null),
    'addenda', coalesce((select jsonb_agg(jsonb_build_object('number', a.number_display, 'title', a.title, 'total_agorot', a.total_agorot)
                                          order by a.sent_at, a.number)
                           from public.quotes a
                          where a.organization_id = v_quote.organization_id and a.addendum_of = v_quote.id and a.status = 'accepted'),
                        '[]'::jsonb));
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_public_version(text): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_version(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link app.quote_links;
  v_quote public.quotes;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08 / owner (385) ב: the token is one of the quote's live links (app.quote_link_tokens); the counters stay on the quote's row
  select l.* into v_link from app.quote_link_tokens t
    join app.quote_links l on l.organization_id = t.organization_id and l.quote_id = t.quote_id
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null
     and l.token_hash is not null;
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- owner, 19 October 2026: the link of a sent quote never answers not found (app.quote_link_usable)
  if not found or not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if v_link.window_started_at > now() - interval '10 minutes' and v_link.window_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_quote := app.quote_shown_version(v_quote);
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08: an accepted quote whose stored PDF (as sent) differs from what was accepted says so; every other answer is as before
  -- QUO-09: once the signed PDF is kept the customer downloads that one, and the label goes
  if v_quote.status = 'accepted'
     and not app.quote_signed_pdf_done(v_quote)
     and exists (select 1 from public.quote_decisions d
                  where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id
                    and d.decision = 'accepted' and d.accepted_net_total_agorot is not null
                    and d.accepted_net_total_agorot is distinct from d.sent_net_total_agorot) then
    return jsonb_build_object('number', v_quote.number_display, 'fingerprint', null, 'pdf_as_sent', true);
  end if;
  -- a fingerprint only for an open newest version: only that one is decided
  return jsonb_build_object(
    'number', v_quote.number_display,
    'fingerprint', case when app.quote_offer_open(v_quote) then app.quote_fingerprint(v_quote) end);
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_public_answer(text, text, text, text, text, text, text, text, boolean, text, text, text, integer[], bigint): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_answer(p_token text, p_decision text, p_fingerprint text, p_signer_name text DEFAULT NULL::text, p_id_number text DEFAULT NULL::text, p_signature_kind text DEFAULT NULL::text, p_signature_image text DEFAULT NULL::text, p_wording_version text DEFAULT NULL::text, p_agreed boolean DEFAULT false, p_decline_reason text DEFAULT NULL::text, p_ip text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_optional_keys integer[] DEFAULT NULL::integer[], p_accepted_total_agorot bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_views integer;
  v_tries integer;
  v_shown public.quotes;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_reason text := nullif(btrim(coalesce(p_decline_reason, '')), '');
  v_deal_note text;
  -- QUO-08: the ticked optional lines, and the totals of that choice
  v_choice uuid[];
  v_matched integer;
  v_totals jsonb;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08 / owner (385) ב: the token is one of the quote's live links (app.quote_link_tokens); the counters stay on the quote's row
  select l.* into v_link from app.quote_link_tokens t
    join app.quote_links l on l.organization_id = t.organization_id and l.quote_id = t.quote_id
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null
     and l.token_hash is not null;
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- owner, 19 October 2026: the link of a sent quote never answers not found (app.quote_link_usable)
  if not found or not app.quote_link_usable(v_quote) then
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

  -- the version the page shows: the newest that was ever sent (QUO-12, QUO-11 review), locked against a second decision in
  -- parallel; the superseded quote is never decided on
  v_shown := app.quote_shown_version(v_quote);
  select * into v_quote from public.quotes q where q.organization_id = v_shown.organization_id and q.id = v_shown.id for update;
  if v_quote.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- re-read after the lock: a newer version sent while this call waited (its send held this quote FOR SHARE) means the page
  -- the customer answered is no longer the one shown
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_quote.status in ('accepted', 'rejected') then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  -- owner, 19 October 2026: deciding only on an open newest version (a cancelled or expired one shows its status page)
  if not app.quote_offer_open(v_quote) then
    return jsonb_build_object('status', 'closed');
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

    -- QUO-08 (owner, 1 November 2026): the optional lines the customer ticked, by their place in the page's list (quote_public
    -- lists the lines by position, id and answers no ids). Every key names an optional item line of this version, once;
    -- anything else is refused. No keys sent (an older page): the rep's preselection, as before.
    if p_optional_keys is null then
      if p_accepted_total_agorot is not null then
        return jsonb_build_object('status', 'invalid');
      end if;
      select coalesce(array_agg(l.id order by l.position, l.id), '{}') into v_choice
        from public.quote_lines l
       where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
         and l.kind = 'item' and l.is_optional and l.optional_selected;
    else
      if p_accepted_total_agorot is null or cardinality(p_optional_keys) > 200 or array_position(p_optional_keys, null) is not null
         or cardinality(p_optional_keys) <> (select count(distinct k) from unnest(p_optional_keys) k) then
        return jsonb_build_object('status', 'invalid');
      end if;
      select coalesce(array_agg(o.id order by o.place), '{}'), count(*) into v_choice, v_matched
        from (select l.id, l.kind, l.is_optional, row_number() over (order by l.position, l.id) as place
                from public.quote_lines l
               where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id) o
       where o.place = any (p_optional_keys) and o.kind = 'item' and o.is_optional;
      if v_matched <> cardinality(p_optional_keys) then
        return jsonb_build_object('status', 'invalid');
      end if;
    end if;
    begin
      v_totals := app.quote_counted_totals(v_quote, v_quote.vat_rate_bp, v_choice);
    exception when sqlstate '22023' then
      -- a fixed document discount larger than the chosen lines
      return jsonb_build_object('status', 'invalid');
    end;
    -- the total the page showed for that choice; another one means the page and the choice disagree
    if p_accepted_total_agorot is not null and p_accepted_total_agorot is distinct from (v_totals ->> 'total_agorot')::bigint then
      return jsonb_build_object('status', 'changed');
    end if;

    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                        signature_image, wording_version, content_sha256, ip, user_agent,
                                        optional_line_ids, choice_sha256, sent_net_total_agorot, sent_total_agorot,
                                        accepted_subtotal_agorot, accepted_discount_total_agorot, accepted_net_total_agorot,
                                        accepted_vat_agorot, accepted_total_agorot)
    values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
            case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500),
            v_choice, app.quote_choice_fingerprint(p_fingerprint, v_choice), v_quote.net_total_agorot, v_quote.total_agorot,
            (v_totals ->> 'subtotal_agorot')::bigint, (v_totals ->> 'document_discount_agorot')::bigint,
            (v_totals ->> 'net_total_agorot')::bigint, (v_totals ->> 'vat_agorot')::bigint, (v_totals ->> 'total_agorot')::bigint);

    -- the choice becomes the accepted quote's: its lines say which optional ones count, and app.quotes_check works its totals
    -- out again from them (only while this setting names it), so every reader of an accepted quote reads what was accepted
    perform set_config('app.quote_accept_choice', v_quote.id::text, true);
    update public.quote_lines l
       set optional_selected = (l.id = any (v_choice))
     where l.organization_id = v_quote.organization_id and l.quote_id = v_quote.id
       and l.kind = 'item' and l.is_optional and l.optional_selected is distinct from (l.id = any (v_choice));
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
  perform set_config('app.quote_accept_choice', '', true);
  -- QUO-08: the accepted figures, for the deal step below
  select * into v_quote from public.quotes q where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  -- QUO-13: the deal of an accepted quote, by the business's setting. Never fails the decision: a failure is logged and
  -- said in the notice, and the quote page keeps offering the move while the deal is open.
  if p_decision = 'accepted' then
    begin
      v_deal_note := app.quote_accept_deal(v_quote);
    exception when others then
      raise warning 'QUO-13: the deal step of quote % failed: % (%)', v_quote.id, sqlerrm, sqlstate;
      v_deal_note := 'לא הצלחנו לטפל בעסקה של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה.';
    end;
  end if;

  -- the quote's owner hears of it (kind `quote`, coordinator 18 October 2026): number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left(case when p_decision = 'accepted' then 'הצעת מחיר אושרה: ' else 'הצעת מחיר נדחתה: ' end || v_quote.title, 200),
         nullif(concat_ws(' · ', case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end, v_deal_note), ''),
         'quote', v_quote.id
    from app.quote_notice_recipients(v_quote) r(user_id);
  return jsonb_build_object('status', p_decision);
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_public_pdf(text, text): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_pdf(p_token text, p_ip_hash text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link    app.quote_links;
  v_quote   public.quotes;
  v_shown   public.quotes;
  v_count   integer;
  v_bucket  integer;
  v_file    public.files;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08 / owner (385) ב: the token is one of the quote's live links (app.quote_link_tokens); the counters stay on the quote's row
  select l.* into v_link from app.quote_link_tokens t
    join app.quote_links l on l.organization_id = t.organization_id and l.quote_id = t.quote_id
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null
     and l.token_hash is not null;
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- the one rule for a sent quote's link (quote_public)
  if not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- the link's own window, shared with the page (120 in 10 minutes), counted first
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count into v_count;
  if v_count > 120 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- FXS-11: 20 downloads per sender in 10 minutes, by the server's keyed IP hash scoped to this quote
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.quote_link_sender(v_quote.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.quote_pdf_download_counts as dc (organization_id, quote_id, bucket, window_start, downloads)
    values (v_quote.organization_id, v_quote.id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when dc.window_start > now() - interval '10 minutes' then dc.window_start else now() end,
          downloads = case when dc.window_start > now() - interval '10 minutes' then dc.downloads + 1 else 1 end
    returning dc.downloads into v_count;
    if v_count > 20 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  -- the version the page shows (quote_public's chain walk), only while the page shows it in full
  v_shown := app.quote_shown_version(v_quote);
  if v_shown.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if not (app.quote_offer_open(v_shown) or v_shown.status = 'accepted') then
    return jsonb_build_object('unavailable', true);
  end if;
  -- QUO-09 (answer (33) ב): the newest confirmed, fingerprinted version: the signed PDF once it is kept, else the one as sent
  select * into v_file from public.files f
   where f.organization_id = v_shown.organization_id and f.quote_id = v_shown.id
     and f.unconfirmed_since is null and f.sha256 is not null
   order by (f.quote_signed is true) desc, f.created_at desc, f.id desc
   limit 1;
  if not found then
    return jsonb_build_object('unavailable', true);
  end if;

  -- QUO-10: a download is a view of the quote shown
  perform app.quote_mark_viewed(v_shown);
  return jsonb_build_object('path', v_file.storage_path, 'sha256', v_file.sha256, 'name', v_file.name);
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.quote_public_question(text, text, text): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_question(p_token text, p_ip_hash text DEFAULT NULL::text, p_text text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_link    app.quote_links;
  v_quote   public.quotes;
  v_shown   public.quotes;
  v_count   integer;
  v_asked   integer;
  v_bucket  integer;
  v_text    text;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- QUO-08 / owner (385) ב: the token is one of the quote's live links (app.quote_link_tokens); the counters stay on the quote's row
  select l.* into v_link from app.quote_link_tokens t
    join app.quote_links l on l.organization_id = t.organization_id and l.quote_id = t.quote_id
   where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null
     and l.token_hash is not null;
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  -- the one rule for a sent quote's link (quote_public)
  if not app.quote_link_usable(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- counted first: the link's own window, shared with the page (120 in 10 minutes), and 20 questions per link in 24 hours
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         question_window_started_at = case when l.question_window_started_at > now() - interval '24 hours'
                                           then l.question_window_started_at else now() end,
         question_count = case when l.question_window_started_at > now() - interval '24 hours' then l.question_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count, l.question_count into v_count, v_asked;
  if v_count > 120 or v_asked > 20 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  -- FXS-11: 5 per sender in 10 minutes, by the server's keyed IP hash scoped to this quote
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.quote_link_sender(v_quote.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.quote_question_counts as qc (organization_id, quote_id, bucket, window_start, questions)
    values (v_quote.organization_id, v_quote.id, v_bucket, now(), 1)
    on conflict (quote_id, bucket) do update
      set window_start = case when qc.window_start > now() - interval '10 minutes' then qc.window_start else now() end,
          questions = case when qc.window_start > now() - interval '10 minutes' then qc.questions + 1 else 1 end
    returning qc.questions into v_count;
    if v_count > 5 then
      return jsonb_build_object('status', 'rate_limited');
    end if;
  end if;

  -- the version the page shows (quote_public's chain walk), only while the page shows it in full (open, or accepted)
  v_shown := app.quote_shown_version(v_quote);
  if v_shown.customer_deleted_at is not null then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  if not (app.quote_offer_open(v_shown) or v_shown.status = 'accepted') then
    return jsonb_build_object('status', 'closed');
  end if;

  -- the text as the app cleans it (questionText in src/features/quotes/decision.ts, keep the two in step): line breaks as LF;
  -- zero-width characters (U+200B-U+200D, U+FEFF) and bidi controls (U+200E/U+200F, U+202A-U+202E, U+2066-U+2069) removed;
  -- the other C0 controls, DEL and the C1 controls (U+0080-U+009F) become spaces; trimmed of spaces and line breaks;
  -- then 1..500 characters on at most 20 lines
  v_text := replace(replace(coalesce(p_text, ''), chr(13) || chr(10), chr(10)), chr(13), chr(10));
  v_text := translate(v_text,
                      chr(8203) || chr(8204) || chr(8205) || chr(65279) || chr(8206) || chr(8207)
                        || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)
                        || chr(8294) || chr(8295) || chr(8296) || chr(8297),
                      '');
  v_text := regexp_replace(v_text, '[' || chr(1) || '-' || chr(9) || chr(11) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']', ' ', 'g');
  v_text := btrim(v_text, ' ' || chr(10));
  if char_length(v_text) not between 1 and 500 or array_length(string_to_array(v_text, chr(10)), 1) > 20 then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- one system entry with no author on the quote's deal and contact (activities_zz_quote_system_author; a person never writes
  -- or changes a quote_* entry: app.activities_quote_entry_guard)
  if v_shown.deal_id is not null or v_shown.contact_id is not null then
    insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
    values (v_shown.organization_id, 'system', v_shown.deal_id, v_shown.contact_id,
            'שאלה מהלקוח על הצעת מחיר' || coalesce(' ' || v_shown.number_display, '') || ': ' || v_text,
            jsonb_build_object('kind', 'quote_question', 'quote_id', v_shown.id, 'number', v_shown.number_display));
  end if;

  -- the quote's owner, else the deal's or contact's, else the owners and admins (RVW-34), with kind `quote`
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_shown.organization_id, r.user_id, 'quote',
         left('שאלה על הצעת מחיר: ' || v_shown.title, 200),
         concat_ws(' · ', case when v_shown.number_display is not null then 'הצעה ' || v_shown.number_display end, 'שאלה: ' || v_text),
         'quote', v_shown.id
    from app.quote_notice_recipients(v_shown) r(user_id);
  return jsonb_build_object('status', 'sent');
end;
$function$;

-- ----------------------------------------------------------------------------
-- public.link_preview_public(text, text, text): its latest body, the token looked up among the quote's live links
-- ----------------------------------------------------------------------------
create or replace function public.link_preview_public(p_kind text, p_token text, p_ip_hash text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_business_page public.business_pages;
  v_result jsonb;
begin
  if p_kind is null or p_kind not in ('form', 'quote', 'order', 'booking', 'booking_manage', 'card', 'page') then
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
    -- the sender across all links and kinds
    v_bucket := ((hashtextextended(p_ip_hash, 0) % 1024) + 1024) % 1024;
    insert into app.link_preview_ip_counts as ic (bucket, window_start, views)
    values (v_bucket, now(), 1)
    on conflict (bucket) do update
      set window_start = case when ic.window_start > now() - interval '10 minutes' then ic.window_start else now() end,
          views = case when ic.window_start > now() - interval '10 minutes' then ic.views + 1 else 1 end
    returning ic.views into v_views;
    if v_views > app.link_preview_ip_limit() then
      return jsonb_build_object('refused', 'rate');
    end if;
    -- the sender on this link
    v_bucket := ((hashtextextended(app.link_preview_sender(p_kind, p_token, p_ip_hash), 0) % 1024) + 1024) % 1024;
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
      -- owner (385) ב: one of the quote's live links
      select l.* into v_quote_link from app.quote_link_tokens t
        join app.quote_links l on l.organization_id = t.organization_id and l.quote_id = t.quote_id
       where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex') and t.revoked_at is null
         and l.token_hash is not null;
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

  -- BIZ-01 (021237): the business page, by its own rule
  elsif p_kind = 'page' then
    select * into v_business_page from public.business_pages b where b.token = coalesce(p_token, '');
    if coalesce(app.business_page_open(v_business_page), false) then
      v_org := v_business_page.organization_id;
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
$function$;
