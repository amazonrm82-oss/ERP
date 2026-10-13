-- =============================================================================
-- "עדכנו אותי כשזה זמין" on a coming-soon plan (owner's pricing, 13 October 2026)
-- =============================================================================
-- Inside the app, a person of a business asks to hear when a coming-soon plan
-- opens: one row per business, person and plan. They see their own rows only and
-- add rows for themselves only, for a plan that is coming soon. Nothing is changed
-- or removed by the browser; a row goes with the membership (on delete cascade).
-- The platform panel sees the count per plan (platform_plan_waitlist()).
-- The landing-page part (an email from an anonymous visitor) is not built here.
-- Every statement is safe to run twice.

create table if not exists public.plan_waitlist (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null default auth.uid(),
  plan_key        text not null references public.plans (key),
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint plan_waitlist_once unique (organization_id, user_id, plan_key),
  foreign key (organization_id, user_id) references public.memberships (organization_id, user_id) on delete cascade
);
create index if not exists plan_waitlist_plan_idx on public.plan_waitlist (plan_key);

alter table public.plan_waitlist enable row level security;
revoke all on public.plan_waitlist from anon, authenticated;
grant select on public.plan_waitlist to authenticated;
grant insert (organization_id, plan_key) on public.plan_waitlist to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plan_waitlist' and policyname = 'plan_waitlist_select') then
    create policy plan_waitlist_select on public.plan_waitlist for select to authenticated
      using (user_id = (select auth.uid()) and app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plan_waitlist' and policyname = 'plan_waitlist_insert') then
    create policy plan_waitlist_insert on public.plan_waitlist for insert to authenticated
      with check (user_id = (select auth.uid()) and app.is_member(organization_id)
                  and exists (select 1 from public.plans p where p.key = plan_key and p.availability = 'coming_soon'));
  end if;
end;
$$;

-- how many people asked per plan (any platform role)
create or replace function public.platform_plan_waitlist() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return coalesce((
    select jsonb_object_agg(w.plan_key, w.n)
      from (select plan_key, count(*) as n from public.plan_waitlist group by plan_key) w), '{}'::jsonb);
end;
$$;
revoke all on function public.platform_plan_waitlist() from public, anon;
grant execute on function public.platform_plan_waitlist() to authenticated;
