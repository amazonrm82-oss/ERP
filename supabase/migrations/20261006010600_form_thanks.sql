-- =============================================================================
-- Thank-you page with a WhatsApp button (CAP-05, wave 1)
-- =============================================================================
-- * forms.whatsapp_button: the hosted form's thank-you state shows a button that
--   opens a WhatsApp chat with the business (wa.me). Off by default.
-- * forms.whatsapp_phone: the number of that chat as typed; empty = the business
--   phone (organizations.phone). Digits, spaces, +, -, ( ) only.
-- * forms.whatsapp_text: an optional text written in the chat in advance.
-- * Written by owners and admins like the other form settings (column grants;
--   policies forms_insert / forms_update unchanged); audited as a form change.
-- * public.intake_form(): the body of 0103 (org_branding) plus 'thanks':
--   {whatsapp: E.164 number or null, whatsapp_text}. The number is returned only
--   when the button is on and it normalizes (app.normalize_phone) to a valid
--   E.164 number; otherwise null and the page shows no button. Service role only.
-- * success_message / redirect_url are unchanged: a redirect still wins.
-- Every statement is safe to run twice.

alter table public.forms add column if not exists whatsapp_button boolean not null default false;
alter table public.forms add column if not exists whatsapp_phone text;
alter table public.forms add column if not exists whatsapp_text text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_whatsapp_phone_check') then
    alter table public.forms add constraint forms_whatsapp_phone_check
      check (whatsapp_phone is null or (char_length(whatsapp_phone) <= 30 and whatsapp_phone ~ '^[0-9+() -]+$'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.forms'::regclass and conname = 'forms_whatsapp_text_check') then
    alter table public.forms add constraint forms_whatsapp_text_check
      check (whatsapp_text is null or char_length(whatsapp_text) <= 300);
  end if;
end;
$$;

comment on column public.forms.whatsapp_button is
  'CAP-05: the thank-you state of the hosted form shows a WhatsApp chat button.';
comment on column public.forms.whatsapp_phone is
  'CAP-05: the chat number as typed; null = the business phone (organizations.phone).';
comment on column public.forms.whatsapp_text is
  'CAP-05: optional text prefilled in the WhatsApp chat.';

grant insert (whatsapp_button, whatsapp_phone, whatsapp_text), update (whatsapp_button, whatsapp_phone, whatsapp_text)
  on public.forms to authenticated;

-- ----------------------------------------------------------------------------
-- intake_form: the body of 0103 plus the thank-you page's WhatsApp details
-- ----------------------------------------------------------------------------
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
  v_whatsapp text;
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = 'form';
  if not found or not v_form.is_active then
    return null;
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
         and d.field_type <> 'user'
       where (a.item ->> 'key') in ('full_name', 'phone', 'email', 'company_name', 'message')
          or d.id is not null
    ) x;

  -- FLD-04: only the logo's object name and the colour; nothing else of the organization
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

  return jsonb_build_object(
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
