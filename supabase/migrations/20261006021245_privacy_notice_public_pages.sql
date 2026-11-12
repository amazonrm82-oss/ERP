-- LEGAL-2 (4), owner 12 November 2026: the notice to the person whose details a public form collects (section 11 of the
-- privacy law after amendment 13): voluntary, the purpose, the controller's name and a way to reach it, to whom it is
-- passed (the system's provider, as processor), and the rights of access and correction. The pages that already answer
-- the business's name and a contact (business card, business page, quote, order, signature, privacy request) need no
-- change. Three public page functions did not answer a contact (the hosted form not even the name), so each now adds
-- one key, `notice`, built by one helper:
--
--   app.privacy_notice_contact(org)  {name, email, phone}: the display name (organizations.name), the email of the
--       business details for documents (org_document_settings.email) and their phone, else the business phone
--       (organizations.phone). The same details the privacy-notice paragraph of /settings/privacy/wordings uses (PRK-04).
--       Definer, no grants; read only by the three functions below.
--
--   public.intake_form(text)                    021127's body + 'notice'
--   public.site_widget_public(text, text)       020305's body + 'notice'
--   public.booking_page_public(text, date, text) 020100's body + 'notice'
--
-- Every not-found, inactive and rate-limited branch is unchanged; the key is added only to the full answer. The
-- business's contact details are ones it gives its customers on its documents; nothing about a person or a record is
-- added. Signatures and grants are unchanged. Every statement is safe to run twice.

create or replace function app.privacy_notice_contact(p_org uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'name', o.name,
           'email', nullif(btrim(s.email), ''),
           'phone', coalesce(nullif(btrim(s.phone), ''), nullif(btrim(o.phone), '')))
    from public.organizations o
    left join public.org_document_settings s on s.organization_id = o.id
   where o.id = p_org
$$;
revoke all on function app.privacy_notice_contact(uuid) from public, anon, authenticated;

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

  -- OPS-02: the view limit of the hosted form page, as the other public pages (BIZ-02, SPD-07, CAL-10) but with its own
  -- number, app.form_view_limit() per sender in 10 minutes, then "try again later" and nothing of the form. Counted
  -- after the token lookup, like them. The sender is the server's keyed IP hash (FXS-11, scope "intake" and the form's
  -- token), handed over in the request header x-crm-sender (app.public_sender_header); no header, no count (the
  -- submission's own read, a direct SQL caller). Only a bucket number is kept, never the hash.
  v_sender := app.public_sender_header();
  if v_sender is not null then
    v_bucket := ((hashtextextended(v_sender, 0) % 1024) + 1024) % 1024;
    insert into app.form_view_counts as vc (form_id, bucket, window_start, views)
    values (v_form.id, v_bucket, now(), 1)
    on conflict (form_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > app.form_view_limit() then
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
    -- LEGAL-2 (4): the business's display name and contact for the privacy notice under the form (section 11)
    'notice', app.privacy_notice_contact(v_form.organization_id),
    'thanks', jsonb_build_object(
      'whatsapp', v_whatsapp,
      'whatsapp_text', case when v_whatsapp is not null then nullif(btrim(v_form.whatsapp_text), '') end));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;
grant execute on function public.intake_form(text) to service_role;

create or replace function public.site_widget_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_widget public.site_widgets;
  v_bucket integer;
  v_views integer;
  v_phone text;
  v_result jsonb;
begin
  select * into v_widget from public.site_widgets w where w.token = coalesce(p_token, '');
  if not app.site_widget_open(v_widget) then
    raise exception 'site widget not found' using errcode = 'P0002';
  end if;

  -- 60 views per sender in 10 minutes; counted first, so the limit holds under parallel load
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.site_widget_sender(v_widget.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.site_widget_view_counts as vc (widget_id, bucket, window_start, views)
    values (v_widget.id, v_bucket, now(), 1)
    on conflict (widget_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select app.normalize_phone(coalesce(nullif(btrim(v_widget.phone), ''), o.phone)) into v_phone
    from public.organizations o where o.id = v_widget.organization_id;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    v_phone := null;
  end if;
  select jsonb_build_object(
           'label', v_widget.button_label,
           'position', v_widget.position,
           'business', o.name,
           'brand', jsonb_build_object('logo', o.logo_path, 'color', o.brand_color),
           'built_with', app.show_built_with(o.id),
           -- digits of a valid E.164 number only (the same rule as the card and the thank-you button)
           'whatsapp', case when v_widget.show_whatsapp and v_phone is not null then substr(v_phone, 2) end,
           'call', case when v_widget.show_call and v_phone is not null then v_phone end,
           -- the short form: a business that takes leads (a read-only or suspended one does)
           'form', v_widget.show_form and app.org_takes_leads(o.id),
           -- LEGAL-2 (4): the business's display name and contact for the privacy notice under the short form
           'notice', app.privacy_notice_contact(o.id))
    into v_result
    from public.organizations o
   where o.id = v_widget.organization_id;
  return jsonb_strip_nulls(v_result);
end;
$$;
revoke all on function public.site_widget_public(text, text) from public, anon, authenticated;
grant execute on function public.site_widget_public(text, text) to service_role;

create or replace function public.booking_page_public(p_token text, p_from date default null, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_page public.booking_pages;
  v_state text;
  v_zone text;
  v_today date;
  v_from date;
  v_result jsonb;
  v_bucket integer;
  v_views integer;
begin
  select * into v_page from public.booking_pages b where b.token = coalesce(p_token, '');
  -- the sender's hash, scoped to this page (CAL-10b review): the same visitor is a different sender on every page
  p_ip_hash := app.booking_sender(v_page.id, p_ip_hash);
  v_state := app.booking_page_state(v_page);
  if v_state = 'not_found' then
    raise exception 'booking page not found' using errcode = 'P0002';
  end if;
  -- read only or suspended, or closed for an hour after too many failed attempts: "not available now"
  if v_state = 'unavailable'
     or exists (select 1 from app.booking_page_closures c where c.page_id = v_page.id and c.closed_until > now()) then
    return jsonb_build_object('unavailable', true);
  end if;

  -- view limit (FXS-11 style): 60 per sender in 10 minutes, then "try again later" without working out any times.
  -- Views never close a page (owner, 15 October 2026). The view is counted first and the returned count decides, so
  -- the limit is exact under parallel load; the only lock is the bucket's row (one sender, or the rare senders that
  -- share its bucket). A view without a sender hash is not counted.
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(p_ip_hash, 0) % 1024) + 1024) % 1024;
    insert into app.booking_view_counts as vc (page_id, bucket, window_start, views)
    values (v_page.id, v_bucket, now(), 1)
    on conflict (page_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      return jsonb_build_object('rate_limited', true);
    end if;
  end if;

  select app.intake_zone(o.timezone) into v_zone from public.organizations o where o.id = v_page.organization_id;
  v_today := (now() at time zone v_zone)::date;
  v_from := least(greatest(coalesce(p_from, v_today), v_today), v_today + v_page.max_days_ahead);

  -- only what the page shows: no ids, no contact details of the rep; the business's contact only inside `notice`, for
  -- the privacy notice under the booking form (LEGAL-2 (4), section 11 of the privacy law)
  select jsonb_build_object(
           'title', v_page.title,
           'intro', v_page.intro,
           'business', o.name,
           'rep', coalesce(nullif(btrim(p.full_name), ''), o.name),
           'brand', jsonb_build_object('logo', o.logo_path, 'color', o.brand_color),
           'built_with', app.show_built_with(o.id),
           'time_zone', v_zone,
           'meeting', jsonb_build_object('name', t.name, 'duration_minutes', t.duration_minutes,
                                         'format', coalesce(t.meeting_format, 'in_person'), 'location', t.location),
           'questions', v_page.questions,
           'today', v_today,
           'last_day', v_today + v_page.max_days_ahead,
           'from', v_from,
           'slots', coalesce((select jsonb_agg(s order by s) from app.booking_slots(v_page.id, v_from, 7) s), '[]'::jsonb),
           'notice', app.privacy_notice_contact(o.id))
    into v_result
    from public.organizations o
    join public.meeting_types t on t.organization_id = o.id and t.id = v_page.meeting_type_id
    left join public.profiles p on p.id = v_page.user_id
   where o.id = v_page.organization_id;

  return v_result;
end;
$$;
revoke all on function public.booking_page_public(text, date, text) from public, anon, authenticated;
grant execute on function public.booking_page_public(text, date, text) to service_role;
