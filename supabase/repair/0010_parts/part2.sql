-- Part 2 of 4: resume migration 0010 (safe to run more than once)

create or replace function app.own_push_subscription() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

create or replace trigger push_subscriptions_owner before insert on public.push_subscriptions
  for each row execute function app.own_push_subscription();

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions' and policyname = 'push_subscriptions_select') then
    create policy push_subscriptions_select on public.push_subscriptions for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions' and policyname = 'push_subscriptions_insert') then
    create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions' and policyname = 'push_subscriptions_delete') then
    create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;
end;
$$;

alter table public.notifications add column if not exists pushed_at timestamptz;
create index if not exists notifications_unpushed_idx on public.notifications (created_at) where pushed_at is null;

-- Settings only the database itself reads
create table if not exists app.settings (
  key   text primary key,
  value text not null
);
revoke all on app.settings from public, anon, authenticated;
