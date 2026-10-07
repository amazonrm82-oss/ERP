-- =============================================================================
-- 0031 Notification preferences per user
-- =============================================================================
-- Per kind of notification, each user chooses: bell and phone, bell only, or off.
-- * public.notification_settings: one row per user, for every organization
--   (muted: not created; no_push: bell only). Read your own row; write through
--   public.set_notification_settings().
-- * A before-insert trigger drops a muted kind and marks a bell-only kind as
--   already pushed, so the push dispatcher never claims it.
-- Kinds: assigned, task_reminder, inquiry, automation. 'system' always arrives.
-- Every statement is safe to run twice.

create table if not exists public.notification_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  muted      text[] not null default '{}',
  no_push    text[] not null default '{}',
  updated_at timestamptz not null default now(),
  constraint notification_settings_kinds check (
    muted <@ array['assigned', 'task_reminder', 'inquiry', 'automation']
    and no_push <@ array['assigned', 'task_reminder', 'inquiry', 'automation'])
);

alter table public.notification_settings enable row level security;
revoke all on public.notification_settings from anon, authenticated;
grant select on public.notification_settings to authenticated;

drop policy if exists notification_settings_select on public.notification_settings;
create policy notification_settings_select on public.notification_settings for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.set_notification_settings(p_muted text[], p_no_push text[]) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into public.notification_settings (user_id, muted, no_push, updated_at)
  values (auth.uid(), coalesce(p_muted, '{}'), coalesce(p_no_push, '{}'), now())
  on conflict (user_id) do update
    set muted = excluded.muted, no_push = excluded.no_push, updated_at = now();
end;
$$;

create or replace function app.apply_notification_settings() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_muted text[];
  v_no_push text[];
begin
  select s.muted, s.no_push into v_muted, v_no_push
    from public.notification_settings s where s.user_id = new.user_id;
  if new.type = any (coalesce(v_muted, '{}')) then
    return null;
  end if;
  if new.type = any (coalesce(v_no_push, '{}')) then
    new.pushed_at := now();
  end if;
  return new;
end;
$$;

revoke all on function public.set_notification_settings(text[], text[]) from public, anon;
grant execute on function public.set_notification_settings(text[], text[]) to authenticated;
revoke all on function app.apply_notification_settings() from public, anon, authenticated;

drop trigger if exists notifications_apply_settings on public.notifications;
create trigger notifications_apply_settings before insert on public.notifications
  for each row execute function app.apply_notification_settings();
