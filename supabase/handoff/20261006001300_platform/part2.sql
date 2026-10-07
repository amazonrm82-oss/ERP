-- 20261006001300_platform: part 2 of 11. Run the parts in order.
-- ----------------------------------------------------------------------------
-- Support access: the customer (owner or admin) lets platform support in, for a while
-- ----------------------------------------------------------------------------
create table if not exists public.support_access_grants (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  granted_by      uuid default auth.uid() references auth.users (id) on delete set null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);
create index if not exists support_access_grants_org_idx on public.support_access_grants (organization_id, expires_at desc);

alter table public.support_access_grants enable row level security;
revoke all on public.support_access_grants from anon, authenticated;
grant all on public.support_access_grants to service_role;
grant select on public.support_access_grants to authenticated;
grant insert (organization_id, expires_at) on public.support_access_grants to authenticated;
grant update (revoked_at) on public.support_access_grants to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'support_access_grants' and policyname = 'support_access_grants_select') then
    create policy support_access_grants_select on public.support_access_grants for select to authenticated
      using (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'support_access_grants' and policyname = 'support_access_grants_insert') then
    create policy support_access_grants_insert on public.support_access_grants for insert to authenticated
      with check (app.is_admin(organization_id) and granted_by = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'support_access_grants' and policyname = 'support_access_grants_update') then
    create policy support_access_grants_update on public.support_access_grants for update to authenticated
      using (app.is_admin(organization_id)) with check (app.is_admin(organization_id));
  end if;
end;
$$;

create or replace trigger support_access_grants_touch before insert or update on public.support_access_grants
  for each row execute function app.touch_row();
create or replace trigger support_access_grants_audit after insert or update on public.support_access_grants
  for each row execute function app.audit_row();

-- true while the caller is platform support (with a second factor) and the
-- organization has an open grant
create or replace function app.support_session(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.platform_role() in ('owner', 'support'), false)
     and exists (select 1 from public.support_access_grants g
                  where g.organization_id = p_org and g.revoked_at is null and g.expires_at > now());
$$;
