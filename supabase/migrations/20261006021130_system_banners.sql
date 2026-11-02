-- =============================================================================
-- System messages: a banner to every business or to some of them (ADM-04)
-- =============================================================================
-- SPEC-ADDITIONS chapter 15 (wave 3): "הודעות מערכת: באנר לכל הארגונים או לחלקם".
--
-- app.system_banners is a platform table in schema app (no API role reads or writes it; RLS on, no policies, like
-- every app table). A banner has a text of up to 300 characters (one line: whitespace collapsed), a severity
-- (info | warning), a window (starts_at .. ends_at, at most 367 days: the screen
-- offers a start day and an end day up to a year later, in Israel time, so a clock change may add an hour to 366 days) and a target:
--   all   every business
--   orgs  a list of 1..200 business ids
--   plan  every business whose subscription is on that plan (read when shown, so a business that moves plan
--         sees or stops seeing it at once)
-- An info banner can always be dismissed; a warning may be made non-dismissable. A banner is never edited: staff
-- end it early (ended_at) and add a new one. Nothing is deleted.
--
-- Written only by platform functions (app.require_platform: the platform owner or support, aal2; logged in
-- app.platform_log):
--   platform_add_system_banner(body, severity, dismissable, starts_at, ends_at, target_kind, orgs, plan) -> id
--   platform_end_system_banner(id)
--   platform_list_system_banners()   every banner, for every platform role (read only)
-- Members read through one definer function:
--   system_banners_for(org)          the banners that apply to this business now, minus the ones the caller dismissed;
--                                    an empty list to anyone who is neither a member nor platform staff in an
--                                    open support session (app.role_in): staff in a session see the business's
--                                    banners, as its people do, and may close one for themselves (their own row in
--                                    app.system_banner_dismissals, never anyone else's). The owner of a closed
--                                    business keeps the owner's role, so a banner to "all" reaches them too
--   system_banner_dismiss(org, id)   per person, kept in app.system_banner_dismissals (the database, not the
--                                    browser, so a dismissal holds on every device); a non-dismissable banner is
--                                    refused with hint 'banner:not_dismissable'
-- Every statement is safe to run twice. No drops, no deletes.

create table if not exists app.system_banners (
  id           uuid primary key default gen_random_uuid(),
  body         text not null
               constraint system_banners_body_check check (char_length(btrim(body)) between 1 and 300),
  severity     text not null
               constraint system_banners_severity_check check (severity in ('info', 'warning')),
  dismissable  boolean not null default true,
  target_kind  text not null
               constraint system_banners_target_kind_check check (target_kind in ('all', 'orgs', 'plan')),
  target_orgs  uuid[],
  target_plan  text references public.plans (key),
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  -- staff ended it before ends_at
  ended_at     timestamptz,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint system_banners_window check (ends_at > starts_at and ends_at <= starts_at + interval '367 days'),
  -- only a warning may stay on screen
  constraint system_banners_dismissable check (dismissable or severity = 'warning'),
  constraint system_banners_target check (
    (target_kind = 'all' and target_orgs is null and target_plan is null)
    or (target_kind = 'orgs' and target_plan is null and target_orgs is not null and cardinality(target_orgs) between 1 and 200)
    or (target_kind = 'plan' and target_orgs is null and target_plan is not null)
  )
);

comment on table app.system_banners is
  'ADM-04: platform banners shown at the top of the business screens. Written only by platform_*_system_banner; read by members through system_banners_for().';

create index if not exists system_banners_live_idx on app.system_banners (ends_at) where ended_at is null;
create index if not exists system_banners_plan_idx on app.system_banners (target_plan);

alter table app.system_banners enable row level security;
revoke all on app.system_banners from public, anon, authenticated;

-- One row per person and banner they closed.
create table if not exists app.system_banner_dismissals (
  banner_id    uuid not null references app.system_banners (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (banner_id, user_id)
);
create index if not exists system_banner_dismissals_user_idx on app.system_banner_dismissals (user_id);

alter table app.system_banner_dismissals enable row level security;
revoke all on app.system_banner_dismissals from public, anon, authenticated;

-- Does a banner apply to this business now? (live window, not ended, target matches)
create or replace function app.system_banner_applies(p_banner app.system_banners, p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_banner.ended_at is null
     and p_banner.starts_at <= now()
     and p_banner.ends_at > now()
     and case p_banner.target_kind
           when 'all' then true
           when 'orgs' then p_org = any (p_banner.target_orgs)
           when 'plan' then exists (
             select 1 from public.subscriptions s where s.organization_id = p_org and s.plan_key = p_banner.target_plan)
           else false
         end
$$;
revoke all on function app.system_banner_applies(app.system_banners, uuid) from public, anon, authenticated;

create or replace function public.platform_add_system_banner(
  p_body text, p_severity text, p_dismissable boolean, p_starts_at timestamptz, p_ends_at timestamptz,
  p_target_kind text, p_orgs uuid[], p_plan text
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_body text := regexp_replace(btrim(coalesce(p_body, '')), '[[:space:]]+', ' ', 'g');
  v_starts timestamptz := greatest(coalesce(p_starts_at, now()), now());
  v_orgs uuid[];
  v_plan text;
  v_id uuid;
begin
  perform app.require_platform(array['support']);
  if char_length(v_body) not between 1 and 300 then
    raise exception 'the banner text must be 1 to 300 characters' using errcode = '22023';
  end if;
  if p_severity is null or p_severity not in ('info', 'warning') then
    raise exception 'unknown severity' using errcode = '22023';
  end if;
  if p_ends_at is null or p_ends_at <= v_starts or p_ends_at > v_starts + interval '367 days' then
    raise exception 'the end must come after the start, within a year' using errcode = '22023';
  end if;
  if p_target_kind = 'all' then
    null;
  elsif p_target_kind = 'orgs' then
    select array_agg(distinct o) into v_orgs from unnest(coalesce(p_orgs, '{}'::uuid[])) as o where o is not null;
    if coalesce(cardinality(v_orgs), 0) not between 1 and 200 then
      raise exception 'between 1 and 200 businesses' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_orgs) as o
                where not exists (select 1 from public.organizations g where g.id = o and g.deleted_at is null)) then
      raise exception 'unknown business' using errcode = '22023';
    end if;
  elsif p_target_kind = 'plan' then
    select p.key into v_plan from public.plans p where p.key = p_plan;
    if v_plan is null then
      raise exception 'unknown plan' using errcode = '22023';
    end if;
  else
    raise exception 'unknown target' using errcode = '22023';
  end if;

  insert into app.system_banners (body, severity, dismissable, target_kind, target_orgs, target_plan, starts_at, ends_at, created_by)
  values (v_body, p_severity, coalesce(p_dismissable, true) or p_severity = 'info', p_target_kind, v_orgs, v_plan,
          v_starts, p_ends_at, auth.uid())
  returning id into v_id;

  perform app.log_platform('banner.add', null, jsonb_build_object(
    'id', v_id, 'body', v_body, 'severity', p_severity, 'dismissable', coalesce(p_dismissable, true) or p_severity = 'info',
    'target_kind', p_target_kind, 'orgs', to_jsonb(v_orgs), 'plan', v_plan, 'starts_at', v_starts, 'ends_at', p_ends_at));
  return v_id;
end;
$$;
revoke all on function public.platform_add_system_banner(text, text, boolean, timestamptz, timestamptz, text, uuid[], text) from public, anon;
grant execute on function public.platform_add_system_banner(text, text, boolean, timestamptz, timestamptz, text, uuid[], text) to authenticated;

-- Ends a banner now (it disappears on the next page load). Ending an ended or expired banner changes nothing.
create or replace function public.platform_end_system_banner(p_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v app.system_banners%rowtype;
begin
  perform app.require_platform(array['support']);
  select * into v from app.system_banners b where b.id = p_id for update;
  if not found then
    raise exception 'banner not found' using errcode = 'P0002';
  end if;
  if v.ended_at is not null or v.ends_at <= now() then
    return;
  end if;
  update app.system_banners set ended_at = now() where id = v.id;
  perform app.log_platform('banner.end', null, jsonb_build_object('id', v.id, 'body', v.body));
end;
$$;
revoke all on function public.platform_end_system_banner(uuid) from public, anon;
grant execute on function public.platform_end_system_banner(uuid) to authenticated;

-- The platform screen: the newest 200 banners with their target businesses' names and how many people closed each.
create or replace function public.platform_list_system_banners() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform app.require_platform(array['support', 'finance', 'readonly']);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', b.id, 'body', b.body, 'severity', b.severity, 'dismissable', b.dismissable,
             'target_kind', b.target_kind, 'target_plan', b.target_plan,
             'target_orgs', coalesce((
               select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.name)
                 from public.organizations o where o.id = any (b.target_orgs)), '[]'::jsonb),
             'starts_at', b.starts_at, 'ends_at', b.ends_at, 'ended_at', b.ended_at, 'created_at', b.created_at,
             'dismissals', (select count(*) from app.system_banner_dismissals d where d.banner_id = b.id))
           order by b.created_at desc, b.id)
      from (select * from app.system_banners order by created_at desc, id limit 200) b
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.platform_list_system_banners() from public, anon;
grant execute on function public.platform_list_system_banners() to authenticated;

-- The banners this business shows the caller now: warnings first, then the newest; at most 3. Not a member = none.
create or replace function public.system_banners_for(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or app.role_in(p_org) is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'body', x.body, 'severity', x.severity, 'dismissable', x.dismissable)
                     order by x.severity = 'warning' desc, x.starts_at desc, x.id)
      from (
        select b.* from app.system_banners b
         where b.ended_at is null and b.ends_at > now() and b.starts_at <= now()
           and app.system_banner_applies(b, p_org)
           and not (b.dismissable and exists (
             select 1 from app.system_banner_dismissals d where d.banner_id = b.id and d.user_id = auth.uid()))
         order by b.severity = 'warning' desc, b.starts_at desc, b.id
         limit 3
      ) x
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.system_banners_for(uuid) from public, anon;
grant execute on function public.system_banners_for(uuid) to authenticated;

-- A person closes a banner for themselves (every device). Only a banner that applies to this business now.
create or replace function public.system_banner_dismiss(p_org uuid, p_banner uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v app.system_banners%rowtype;
begin
  if auth.uid() is null or app.role_in(p_org) is null then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select * into v from app.system_banners b where b.id = p_banner;
  if not found or not app.system_banner_applies(v, p_org) then
    raise exception 'banner not found' using errcode = 'P0002';
  end if;
  if not v.dismissable then
    raise exception 'this banner cannot be closed'
      using errcode = 'P0001', hint = 'banner:not_dismissable';
  end if;
  insert into app.system_banner_dismissals (banner_id, user_id)
  values (v.id, auth.uid())
  on conflict (banner_id, user_id) do nothing;
end;
$$;
revoke all on function public.system_banner_dismiss(uuid, uuid) from public, anon;
grant execute on function public.system_banner_dismiss(uuid, uuid) to authenticated;
