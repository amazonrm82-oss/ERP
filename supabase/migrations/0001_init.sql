-- ERP — independent system, own Supabase project (not connected to Arizot CRM's data).
-- Same architecture pattern as arizot-crm-web (Postgres + Auth + RLS + Realtime), simplified role
-- model since this is a back-office system, not a sales team: just "עובד" and "מנהל".

create extension if not exists pgcrypto;

-- ============================================================================
-- PROFILES (one row per Supabase Auth user)
-- ============================================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  name text not null,
  role text not null check (role in ('עובד', 'מנהל')),
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'App-level identity + role for each login account.';

create or replace function public.current_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_super_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin() or public.current_role() = 'מנהל';
$$;

-- Username -> email lookup so the login screen can accept a username, same UX as arizot-crm-web.
create or replace function public.email_for_username(p_username text)
returns text language sql stable security definer set search_path = public as $$
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.username = p_username
  limit 1;
$$;

grant execute on function public.email_for_username(text) to anon, authenticated;

alter table public.profiles enable row level security;

create policy profiles_select_all on public.profiles for select using (auth.uid() is not null);
create policy profiles_update_self_or_manager on public.profiles for update
  using (id = auth.uid() or public.is_manager())
  with check (id = auth.uid() or public.is_manager());
create policy profiles_delete_manager on public.profiles for delete using (public.is_manager() and not is_super_admin);

-- Same defense-in-depth as arizot-crm-web: a manager can change roles via the policy above, but
-- must never grant/revoke is_super_admin or change their own role, even via a raw table update.
create or replace function public.enforce_profile_update_guards()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_super_admin is distinct from old.is_super_admin and not public.is_super_admin() then
    raise exception 'רק סופר-אדמין יכול לשנות סטטוס סופר-אדמין';
  end if;
  if new.role is distinct from old.role and old.id = auth.uid() and not public.is_manager() then
    raise exception 'אין הרשאה לשנות תפקיד עצמי';
  end if;
  return new;
end;
$$;

create trigger profiles_update_guard
  before update on public.profiles
  for each row execute function public.enforce_profile_update_guards();

-- ============================================================================
-- CUSTOMERS — this system's own registry (independent of Arizot's leads/customers)
-- ============================================================================

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business_name text,
  phone text,
  email text,
  address text,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.customers enable row level security;

create policy customers_select on public.customers for select using (auth.uid() is not null);
create policy customers_insert on public.customers for insert with check (auth.uid() is not null);
create policy customers_update on public.customers for update using (auth.uid() is not null) with check (auth.uid() is not null);
create policy customers_delete on public.customers for delete using (public.is_manager());
