-- =============================================================================
-- Price lists (PL-01, wave 2)
-- =============================================================================
-- SPEC-ADDITIONS 4.3: "the default price list is the product's own price
-- (public.products.price_agorot). Further price lists: name, valid from a date
-- to a date, active."
--
-- public.price_lists holds the further lists only. The default list is not a
-- row: a product's price is the default everywhere, and a list overrides it
-- only for the products it has lines for (public.price_list_lines, PL-02, next
-- migration). The rule that picks the price is unitPriceFor() in
-- src/features/price-lists/price.ts.
--
-- Columns:
--   name                 1..120 characters, trimmed; unique per organization
--                        ignoring case (price_lists_name_idx)
--   valid_from, valid_to calendar dates in the organization's time zone, both
--                        optional and both inclusive; valid_to is never before
--                        valid_from. Outside them the list does not apply and
--                        the product's own price is used.
--   is_active            an inactive list never applies
--
-- Business data, not a managed list: it starts empty (the owner's managed-list
-- rule of 12 October 2026 is for lists of choices). Every member reads; owners
-- and admins of a writable organization write (like products). Assigning a list
-- to a customer and documents pulling the price are PL-03.
--
-- Plan (owner's pricing of 13 October 2026, DECISIONS.md "דגלים ומכסות"): the
-- capability 'price_lists' and the quota max_price_lists ("besides the default
-- price list", so every row counts, active or not). price_lists_quota (before
-- insert, security definer so the count sees every row) takes a per-organization
-- advisory lock like products_quota (PRD-08); the capability is also in the
-- insert policy. public.org_plan_usage() gets one row; its body is that of
-- migration product_quota with that row added.
--
-- Organization in read-only or suspended: app.org_writable() stops every write;
-- the lists stay readable. Not owned by a person, so a handover (transfer_records)
-- has nothing to move. Exported in the full export (EXPORT_TABLES).
--
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.price_lists (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  valid_from       date,
  valid_to         date,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint price_lists_valid_range check (valid_from is null or valid_to is null or valid_to >= valid_from)
);

create unique index if not exists price_lists_name_idx on public.price_lists (organization_id, lower(name));

alter table public.price_lists enable row level security;

revoke all on public.price_lists from anon, authenticated;
grant select, delete on public.price_lists to authenticated;
grant insert (organization_id, name, valid_from, valid_to, is_active) on public.price_lists to authenticated;
grant update (name, valid_from, valid_to, is_active) on public.price_lists to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_lists' and policyname = 'price_lists_select') then
    create policy price_lists_select on public.price_lists for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_lists' and policyname = 'price_lists_insert') then
    create policy price_lists_insert on public.price_lists for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'price_lists'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_lists' and policyname = 'price_lists_update') then
    create policy price_lists_update on public.price_lists for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'price_lists' and policyname = 'price_lists_delete') then
    create policy price_lists_delete on public.price_lists for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger price_lists_touch before update on public.price_lists
  for each row execute function app.touch_row();
create or replace trigger price_lists_audit after insert or update or delete on public.price_lists
  for each row execute function app.audit_row();

-- The capability and the quota, for every writer (like products_quota).
create or replace function app.price_lists_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
begin
  -- A person who is not an owner or admin of this business is refused by RLS
  -- (42501) right after this trigger; answering here would tell an outsider
  -- the business's plan state. auth.uid(), not current_user: inside a definer
  -- current_user is the owner. Server writers without a session are checked.
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  if not app.org_has_feature(new.organization_id, 'price_lists') then
    raise exception 'price lists are not in this plan' using errcode = 'P0001', hint = 'feature:price_lists';
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_price_lists');
  if v_limit is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('price_lists:' || new.organization_id::text, 0));
  if (select count(*) from public.price_lists l where l.organization_id = new.organization_id) + 1 > v_limit then
    raise exception 'plan limit reached (max_price_lists = %)', v_limit using errcode = 'P0001', hint = 'limit:max_price_lists';
  end if;
  return new;
end;
$$;
revoke all on function app.price_lists_quota() from public, anon, authenticated;

create or replace trigger price_lists_quota before insert on public.price_lists
  for each row execute function app.price_lists_quota();

create or replace function public.org_plan_usage(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not app.is_member(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'plan_key', s.plan_key,
    'plan_name', p.name_he,
    'status', s.status,
    'trial_ends_at', s.trial_ends_at,
    'seats', s.seats,
    'usage', jsonb_build_array(
      jsonb_build_object('key', 'max_users', 'limit', app.org_limit(p_org, 'max_users'),
        'used', (select count(*) from public.memberships m
                  where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full')),
      jsonb_build_object('key', 'max_records', 'limit', app.org_limit(p_org, 'max_records'),
        'used', coalesce((select u.records_count from public.org_usage u where u.organization_id = p_org), 0)),
      jsonb_build_object('key', 'max_pipelines', 'limit', app.org_limit(p_org, 'max_pipelines'),
        'used', (select count(*) from public.pipelines pl where pl.organization_id = p_org and pl.deleted_at is null)),
      jsonb_build_object('key', 'max_forms', 'limit', app.org_limit(p_org, 'max_forms'),
        'used', (select count(*) from public.forms f where f.organization_id = p_org and f.kind = 'form')),
      jsonb_build_object('key', 'max_active_automations', 'limit', app.org_limit(p_org, 'max_active_automations'),
        'used', (select count(*) from public.automations a where a.organization_id = p_org and a.is_active)),
      jsonb_build_object('key', 'storage_gb', 'limit', app.org_limit(p_org, 'storage_gb'),
        'used', round(coalesce((select sum(fl.size_bytes) from public.files fl where fl.organization_id = p_org), 0) / 1073741824.0, 3)),
      jsonb_build_object('key', 'max_products', 'limit', app.org_limit(p_org, 'max_products'),
        'used', (select count(*) from public.products pr where pr.organization_id = p_org)),
      jsonb_build_object('key', 'max_price_lists', 'limit', app.org_limit(p_org, 'max_price_lists'),
        'used', (select count(*) from public.price_lists pli where pli.organization_id = p_org))
    )
  )
  into v_result
  from public.subscriptions s
  join public.plans p on p.key = s.plan_key
  where s.organization_id = p_org;

  return v_result;
end;
$$;
revoke all on function public.org_plan_usage(uuid) from public, anon;
grant execute on function public.org_plan_usage(uuid) to authenticated;
