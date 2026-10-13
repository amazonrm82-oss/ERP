-- =============================================================================
-- Business branding: logo and main colour (FLD-04, wave 1; DSN-17 colour rule)
-- =============================================================================
-- * organizations.logo_path: the business logo, an object in bucket 'org-logos'
--   named '<organization id>/<random uuid>'. A trigger checks that the object
--   exists and sits in this organization's folder (hint 'branding:logo').
-- * organizations.brand_color: the business's main colour, '#rrggbb' in lower
--   case (hint-less check constraint). The app corrects it for contrast where it
--   is shown (src/features/branding/color.ts); the stored value is what was picked.
-- * Owners and admins write both columns, like the other profile columns
--   (policy organizations_update = app.is_admin); everyone else gets 0 rows.
--   A change is a normal update of the organization and is audited as one.
-- * Bucket 'org-logos' is PUBLIC: the logo is shown on the business's public
--   pages (lead form now; booking, quotes, emails later) to people who are not
--   signed in, so it is served by its public URL and no key is needed to show
--   it. 1 MB, JPG / PNG / WebP only (no SVG: it could carry script). Writes:
--   only owners/admins of the organization, only into its folder, uuid names;
--   no update policy, so an object is never overwritten (a new logo is a new
--   object and the app removes the old one). Members may list their own
--   organization's folder (the storage API needs it to delete).
-- * public.intake_form() now also returns 'brand': {logo, color} of the form's
--   organization, for the hosted form (service role only, as before).
-- Every statement is safe to run twice.

alter table public.organizations add column if not exists logo_path text;
alter table public.organizations add column if not exists brand_color text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_brand_color_check') then
    alter table public.organizations add constraint organizations_brand_color_check
      check (brand_color is null or brand_color ~ '^#[0-9a-f]{6}$');
  end if;
end;
$$;

comment on column public.organizations.logo_path is
  'FLD-04: business logo, object name in the public bucket org-logos (<organization id>/<uuid>); null = none.';
comment on column public.organizations.brand_color is
  'FLD-04: main colour as picked, #rrggbb lower case; corrected for contrast where shown; null = the product default.';

grant update (logo_path, brand_color) on public.organizations to authenticated;

-- '<organization id>/<uuid>' -> the organization id; anything else -> null
create or replace function app.org_logo_org(p_name text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;
revoke all on function app.org_logo_org(text) from public, anon;
grant execute on function app.org_logo_org(text) to authenticated, service_role;

-- security invoker: the writer must be able to see the object it points at
create or replace function app.organizations_branding_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if new.logo_path is distinct from old.logo_path and new.logo_path is not null
     and (app.org_logo_org(new.logo_path) is distinct from new.id
          or not exists (select 1 from storage.objects o where o.bucket_id = 'org-logos' and o.name = new.logo_path)) then
    raise exception 'logo must be an uploaded image of this organization' using errcode = 'P0001', hint = 'branding:logo';
  end if;
  return new;
end;
$$;
revoke all on function app.organizations_branding_check() from public, anon;
grant execute on function app.organizations_branding_check() to authenticated, service_role;

create or replace trigger organizations_branding_check before update of logo_path on public.organizations
  for each row execute function app.organizations_branding_check();

-- ----------------------------------------------------------------------------
-- Logo bucket
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('org-logos', 'org-logos', true, 1048576)
on conflict (id) do update set public = true, file_size_limit = 1048576;

do $$
begin
  -- hosted Supabase has the column; the local test shim does not
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    execute $sql$update storage.buckets set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'] where id = 'org-logos'$sql$;
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'org_logos_select') then
    create policy org_logos_select on storage.objects for select to authenticated
      using (bucket_id = 'org-logos' and app.is_member(app.org_logo_org(objects.name)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'org_logos_insert') then
    create policy org_logos_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'org-logos' and app.is_admin(app.org_logo_org(objects.name)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'org_logos_delete') then
    create policy org_logos_delete on storage.objects for delete to authenticated
      using (bucket_id = 'org-logos' and app.is_admin(app.org_logo_org(objects.name)));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- intake_form: the body of 0054 plus the organization's logo and colour
-- ----------------------------------------------------------------------------
create or replace function public.intake_form(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_fields jsonb;
  v_brand jsonb;
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

  return jsonb_build_object(
    'title', coalesce(nullif(btrim(v_form.title), ''), v_form.name),
    'intro', v_form.intro,
    'submit_label', v_form.submit_label,
    'fields', v_fields,
    'brand', coalesce(v_brand, jsonb_build_object('logo', null, 'color', null)));
end;
$$;
revoke all on function public.intake_form(text) from public, anon, authenticated;
grant execute on function public.intake_form(text) to service_role;
