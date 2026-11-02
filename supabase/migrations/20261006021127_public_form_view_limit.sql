-- =============================================================================
-- OPS-02: one rate-limit layer for every public path; the hosted form page's view limit
-- =============================================================================
-- SPEC-ADDITIONS OPS-02: a uniform rate limit for every public path. Every public page and route already limits inside
-- its own service_role function (FXS-11 keyed IP hash, per link and per sender), except one: the hosted web form
-- /f/<token> (and its printable QR page /f/<token>/qr) read public.intake_form() with no limit at all, while the form's
-- token is public by design (it sits in the embed code on the business's own site). This file gives that read the limit
-- every other public view has (BIZ-02 cards, SPD-07 widgets, CAL-10 booking pages): 60 views per sender in 10 minutes
-- per form, counted after the token lookup like them, in a fixed set of 1,024 reused buckets per form (no row per view,
-- no hash stored; app.form_view_counts, cascades with the form).
--
-- * public.intake_form(text) keeps its signature (a second argument would leave a second overload behind whenever an
--   older file that defines it is re-run, and test 07 keys functions by name) and becomes VOLATILE (it now writes a
--   counter; PostgREST runs a stable function in a read-only transaction). The sender arrives in the request header
--   x-crm-sender, read by app.public_sender_header(): the keyed IP hash the server makes (src/lib/keyed-ip-hash.ts, scope
--   "intake" and the form's token, the same value intake_submit already gets). Only the service role can call
--   intake_form, so only our server can send it; anything that is not 64 hex characters is ignored. No header = not
--   counted: the submission route's own read of the form (intake_submit has its own limits: 10 per sender in 10 minutes,
--   500 an hour per form) and direct SQL callers.
-- * Over the limit the answer is {rate_limited: true} (the shape of business_card_public / site_widget_public); the page
--   shows the shared Hebrew "try again" text. Not found (null) and {inactive} are unchanged, so the link preview's
--   not-found rule (WAB-05, test 253) still holds.
-- * The rest of the body is 020935's, unchanged. The service-role use is the existing one (CLAUDE.md hard rule 5: the
--   lead intake reads a form's public display settings); no new function is granted to service_role.

-- ----------------------------------------------------------------------------
-- The counters: a fixed set per form, each counting its 10-minute window and reused by the next (an update, never a delete)
-- ----------------------------------------------------------------------------
create table if not exists app.form_view_counts (
  form_id      uuid not null references public.forms (id) on delete cascade,
  bucket       integer not null check (bucket between 0 and 1023),
  window_start timestamptz not null,
  views        integer not null,
  primary key (form_id, bucket)
);
alter table app.form_view_counts enable row level security;
revoke all on app.form_view_counts from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The sender a public read was given by our server: the request header x-crm-sender, when it is a keyed IP hash
-- (64 lower-case hex characters), else null. Stable, no table read.
-- ----------------------------------------------------------------------------
create or replace function app.public_sender_header() returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_value text;
begin
  begin
    v_value := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-crm-sender';
  exception when others then
    return null;
  end;
  return case when v_value ~ '^[0-9a-f]{64}$' then v_value end;
end;
$$;
revoke all on function app.public_sender_header() from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- public.intake_form: 020935's body with the view limit after the not-found and closed-business answers
-- ----------------------------------------------------------------------------
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
  v_whatsapp text;
  -- SPD-05
  v_callback jsonb;
  -- FLD-04: the "נבנה ב-Mexuz" line
  v_built_with boolean;
  -- LEAD-04 / CAP-08 (020830): the products the form offers (id and name only)
  v_products jsonb;
  -- CAP-07 / CNS-04: the marketing-consent boxes the form shows (channel and DRAFT wording), or null
  v_consent jsonb;
  -- OPS-02: the view limit
  v_sender text;
  v_bucket integer;
  v_views integer;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
  end if;
  -- 0163: a business whose public pages are closed (cancelled, deleted): a marker and nothing else
  if not app.org_public_pages_open(v_form.organization_id) then
    return jsonb_build_object('inactive', true);
  end if;

  -- OPS-02: the view limit of the hosted form page, as the other public pages (BIZ-02, SPD-07, CAL-10): 60 per sender in
  -- 10 minutes, then "try again later" and nothing of the form. Counted after the token lookup, like them. The sender is
  -- the server's keyed IP hash (FXS-11, scope "intake" and the form's token), handed over in the request header
  -- x-crm-sender (app.public_sender_header); no header, no count (the submission's own read, a direct SQL caller). Only a
  -- bucket number is kept, never the hash.
  v_sender := app.public_sender_header();
  if v_sender is not null then
    v_bucket := ((hashtextextended(v_sender, 0) % 1024) + 1024) % 1024;
    insert into app.form_view_counts as vc (form_id, bucket, window_start, views)
    values (v_form.id, v_bucket, now(), 1)
    on conflict (form_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select coalesce(jsonb_agg(x.field order by x.ord), '[]'::jsonb) into v_fields
    from (
      select a.ord,
             jsonb_build_object(
               'key', a.item ->> 'key',
               'required', coalesce(a.item -> 'required' = 'true'::jsonb, false),
               'help', coalesce(nullif(btrim(a.item ->> 'help'), ''), d.help_text),
               'show_if', case when jsonb_typeof(a.item -> 'show_if') = 'object' then a.item -> 'show_if' end,
               'label', d.label,
               'type', d.field_type,
               'options', d.options) as field
        from jsonb_array_elements(case when jsonb_typeof(v_form.fields) = 'array' then v_form.fields else '[]'::jsonb end)
               with ordinality as a(item, ord)
        left join public.field_definitions d
          on (a.item ->> 'key') like 'cf:%'
         and d.organization_id = v_form.organization_id
         and d.object_type = 'lead'
         and d.key = substr(a.item ->> 'key', 4)
         and d.is_active
         and d.field_type not in ('user', 'record_link', 'file')
       where (a.item ->> 'key') in ('full_name', 'phone', 'email', 'company_name', 'message')
          or d.id is not null
    ) x;

  -- FLD-04: only the logo's object name and the colour; nothing else of the organization (CAP-07: when a consent box
  -- is on, the business's display name also appears inside its wording, below, as the sender the law asks to name)
  select jsonb_build_object('logo', o.logo_path, 'color', o.brand_color) into v_brand
    from public.organizations o
   where o.id = v_form.organization_id;

  -- CAP-05: the WhatsApp number of the thank-you page, only when the form turns it on:
  -- the form's own number, else the business phone; only a valid E.164 number leaves
  if v_form.whatsapp_button then
    select app.normalize_phone(coalesce(nullif(btrim(v_form.whatsapp_phone), ''), o.phone)) into v_whatsapp
      from public.organizations o
     where o.id = v_form.organization_id;
    if v_whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
      v_whatsapp := null;
    end if;
  end if;

  -- SPD-05: the call-back choice: the business's time zone, whether "now" is
  -- offered, and the slots still open today and on the next working day
  if v_form.callback_choice then
    select jsonb_build_object('time_zone', app.intake_zone(o.timezone))
           || app.intake_callback_offer(v_form.organization_id, v_form.callback_slots_off, now())
      into v_callback
      from public.organizations o
     where o.id = v_form.organization_id;
  end if;

  -- LEAD-04 / CAP-08 (020830): when the form asks for a product and the business has the products flag: the offered
  -- products, id and name only (no price, SKU or anything else); none offerable = no question
  if v_form.product_choice and app.org_has_feature(v_form.organization_id, 'products') then
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.ord) into v_products
      from app.intake_form_products(v_form.organization_id, v_form.product_ids, v_form.product_category_ids) p;
  end if;

  -- CAP-07 / CNS-04: one unticked box per channel the form turns on and collects (email for email, phone for SMS
  -- and WhatsApp), with the business's wording of this version; none = no box
  select jsonb_build_object(
           'version', app.marketing_consent_version(),
           'channels', jsonb_agg(jsonb_build_object('channel', c.channel,
                                                    'text', app.marketing_consent_wording(c.channel, o.name))
                                 order by c.ord))
    into v_consent
    from unnest(app.form_marketing_channels(v_form.marketing_consent_channels, v_form.fields)) with ordinality as c(channel, ord)
    cross join public.organizations o
   where o.id = v_form.organization_id
  having count(*) > 0;

  -- FLD-04: shown unless the plan or the override turns remove_built_with on; a bad
  -- plan value never fails the form (the line then shows)
  begin
    v_built_with := coalesce(app.show_built_with(v_form.organization_id), true);
  exception when others then
    v_built_with := true;
  end;

  return case when v_products is not null then jsonb_build_object('products', v_products) else '{}'::jsonb end
  || jsonb_build_object(
    'built_with', v_built_with,
    'callback', v_callback,
    -- CON-10: ask how the person likes to be contacted (the four channels)
    'channel_choice', v_form.channel_choice,
    -- CAP-08: ask the person's preferred language (the contacts' codes)
    'locale_choice', v_form.locale_choice,
    -- CAP-07 / CNS-04: the marketing-consent boxes (null = none)
    'marketing_consent', v_consent,
    'title', coalesce(nullif(btrim(v_form.title), ''), v_form.name),
    'intro', v_form.intro,
    'submit_label', v_form.submit_label,
    'fields', v_fields,
    'brand', coalesce(v_brand, jsonb_build_object('logo', null, 'color', null)),
    'thanks', jsonb_build_object(
      'whatsapp', v_whatsapp,
      'whatsapp_text', case when v_whatsapp is not null then nullif(btrim(v_form.whatsapp_text), '') end));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;

grant execute on function public.intake_form(text) to service_role;
