-- =============================================================================
-- "What's new" and the support request form (USR-12)
-- =============================================================================
-- SPEC-ADDITIONS chapter 11 (wave 3): "מסך 'מה חדש', וטופס פנייה לתמיכה מתוך המערכת".
--
-- What's new: the release notes are a static list in the code (src/features/whats-new/entries.ts). The database only
-- keeps, per person, the date of the newest entry they have seen: profiles.whats_new_seen_on (null = never opened),
-- written by the person through a column grant (the profiles update policy is the person's own row).
--
-- Support requests: public.support_requests, one row per request a person sends from inside a business.
--   * category from a closed list (question | bug | billing | feature | other, mirrored by SUPPORT_CATEGORIES in
--     src/features/support-requests/categories.ts), subject 1..120, message 1..2,000, and optionally the page the person was on
--     (a path without query or fragment, up to 300 characters)
--   * user_id comes from the session (trigger), status starts 'open'; open | in_progress | closed, changed only by
--     platform staff (ADM-05, platform_* functions): clients have no update or delete grant
--   * insert: an active member of the business (app.membership_role: a support session cannot write one; the owner of
--     a closed business can, because that is when help is needed; read-only businesses too), for themselves
--   * select: the requester reads their own requests; owners and admins read all of their business's
--   * at most 5 per person per hour across businesses (hint 'support:rate'), counted under an advisory lock per person
--   * no email: there is no email provider yet; the request reaches the platform through ADM-05
-- Not audited (a message to the platform, not business data), no automations, not in the full export (LEFT_OUT in
-- test 74). A person who leaves keeps nothing: the business still holds the request; user_id becomes null when the
-- account is deleted.
-- Every statement is safe to run twice. No drops, no deletes.

alter table public.profiles add column if not exists whats_new_seen_on date;
comment on column public.profiles.whats_new_seen_on is
  'USR-12: the date of the newest "what''s new" entry this person has seen; null = never opened.';
grant update (whats_new_seen_on) on public.profiles to authenticated;

create table if not exists public.support_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  user_id           uuid references auth.users (id) on delete set null,
  category          text not null
                    constraint support_requests_category_check check (category in ('question', 'bug', 'billing', 'feature', 'other')),
  subject           text not null
                    constraint support_requests_subject_check check (char_length(btrim(subject)) between 1 and 120),
  message           text not null
                    constraint support_requests_message_check check (char_length(btrim(message)) between 1 and 2000),
  page_path         text
                    constraint support_requests_page_path_check check (
                      page_path is null or (char_length(page_path) between 1 and 300 and page_path ~ '^/[^?#[:space:]]*$')),
  status            text not null default 'open'
                    constraint support_requests_status_check check (status in ('open', 'in_progress', 'closed')),
  status_changed_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, id)
);

comment on table public.support_requests is
  'USR-12: support requests sent from inside a business. Members insert their own; the requester reads theirs, owners/admins all of the business. Status changes only through platform_* (ADM-05).';

create index if not exists support_requests_org_idx on public.support_requests (organization_id, created_at desc);
create index if not exists support_requests_user_idx on public.support_requests (user_id, created_at desc);
create index if not exists support_requests_status_idx on public.support_requests (status, created_at desc);

create or replace trigger support_requests_touch before update on public.support_requests
  for each row execute function app.touch_row();

alter table public.support_requests enable row level security;
revoke all on public.support_requests from anon, authenticated;
grant select on public.support_requests to authenticated;
grant insert (organization_id, category, subject, message, page_path) on public.support_requests to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'support_requests' and policyname = 'support_requests_select') then
    create policy support_requests_select on public.support_requests for select to authenticated
      using (app.is_member(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'support_requests' and policyname = 'support_requests_insert') then
    create policy support_requests_insert on public.support_requests for insert to authenticated
      with check (app.membership_role(organization_id) is not null and user_id = (select auth.uid()));
  end if;
end;
$$;

alter policy support_requests_select on public.support_requests
  using (app.is_member(organization_id) and (user_id = (select auth.uid()) or app.is_admin(organization_id)));
alter policy support_requests_insert on public.support_requests
  with check (app.membership_role(organization_id) is not null and user_id = (select auth.uid()));

create or replace function app.support_requests_per_hour() returns integer
language sql immutable
set search_path = ''
as $$ select 5 $$;
revoke all on function app.support_requests_per_hour() from public, anon, authenticated;

-- A person's insert: the requester and a fresh state come from the server, and the hourly limit is counted.
-- Definer so the count sees the person's requests in every business; an outsider is left to RLS's plain 42501 first.
create or replace function app.support_requests_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return new;
  end if;
  new.user_id := v_uid;
  if app.membership_role(new.organization_id) is null then
    -- not a member: the insert policy refuses it, and nothing is counted or told
    return new;
  end if;
  new.status := 'open';
  new.status_changed_at := null;
  new.created_at := now();
  new.subject := btrim(new.subject);
  new.message := btrim(new.message);
  perform pg_advisory_xact_lock(hashtextextended('support_request:' || v_uid::text, 0));
  if (select count(*) from public.support_requests r
       where r.user_id = v_uid and r.created_at > now() - interval '1 hour') >= app.support_requests_per_hour() then
    raise exception 'too many support requests in the last hour'
      using errcode = 'P0001', hint = 'support:rate';
  end if;
  return new;
end;
$$;
revoke all on function app.support_requests_check() from public, anon, authenticated;

create or replace trigger support_requests_check before insert on public.support_requests
  for each row execute function app.support_requests_check();
