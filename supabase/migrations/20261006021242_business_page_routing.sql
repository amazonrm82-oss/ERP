-- =============================================================================
-- 021242 BIZ-01: who gets the leads of the business page's form (owner, 12 November 2026, answer (314) ב)
-- =============================================================================
-- Owners and admins choose, on /settings/business-page, who gets the leads from the page's contact form:
-- * by default (both columns null) the business's regular lead distribution, as before (assign_mode round_robin, no team);
-- * one person (business_pages.owner_user_id: an active member who is not a viewer), or
-- * one team (business_pages.team_id: a team of the business; the distribution among its members, CAP-08's pick).
-- At most one of the two (constraint business_pages_routing_one, checked first by the trigger with hint
-- business_page:routing). Both are composite foreign keys, set null of their own column when the member or team is removed.
--
-- No new path into intake_submit: the choice is applied to the page's own form of kind 'page' (forms.owner_id, team_id,
-- assign_mode), which intake_submit already honours for every form: a person = assign_mode 'owner' with forms.owner_id
-- (HEB-08's deputy through app.auto_lead_owner, as for any form owner); a team = assign_mode 'round_robin' with
-- forms.team_id (app.lead_distribution_route with the team); the default = 'round_robin' with neither.
-- * app.business_pages_make_form (021237's body) makes the form with the page's choice.
-- * app.business_pages_sync_form (new, definer, after update of owner_user_id, team_id) keeps the form in step, as the site
--   widget's form is kept in step with its widget (app.site_widgets_sync_form).
-- * A chosen person who leaves falls back to the regular distribution: app.memberships_business_page_owner_off (definer,
--   after update of status or role on memberships) clears owner_user_id when the member is no longer active or becomes a
--   viewer, and the foreign key clears it when the membership is removed; either way the form goes back to round_robin.
--   Until then a person away on leave is covered by their deputy, like any form owner (HEB-08).
-- * app.business_pages_check (021237's body) adds: the person is an active non-viewer member (hint business_page:owner),
--   judged on insert or when the person changes, with the membership row taken FOR SHARE (a concurrent suspension waits,
--   then its trigger clears the choice); at most one of person and team (hint business_page:routing).
-- Safe to run twice. No drop statement, no row removal.

alter table public.business_pages add column if not exists owner_user_id uuid;
alter table public.business_pages add column if not exists team_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_pages'::regclass and conname = 'business_pages_owner_fk') then
    alter table public.business_pages add constraint business_pages_owner_fk foreign key (organization_id, owner_user_id)
      references public.memberships (organization_id, user_id) on delete set null (owner_user_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_pages'::regclass and conname = 'business_pages_team_fk') then
    alter table public.business_pages add constraint business_pages_team_fk foreign key (organization_id, team_id)
      references public.teams (organization_id, id) on delete set null (team_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.business_pages'::regclass and conname = 'business_pages_routing_one') then
    alter table public.business_pages add constraint business_pages_routing_one check (owner_user_id is null or team_id is null);
  end if;
end;
$$;

create index if not exists business_pages_owner_idx on public.business_pages (organization_id, owner_user_id);
create index if not exists business_pages_team_idx on public.business_pages (organization_id, team_id);

grant insert (owner_user_id, team_id) on public.business_pages to authenticated;
grant update (owner_user_id, team_id) on public.business_pages to authenticated;

-- 021237's check plus the routing rules. The outsider guard first, so a person outside the business gets RLS's plain
-- refusal and learns nothing about its plan, booking pages or members.
create or replace function app.business_pages_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if new.is_active and (tg_op = 'INSERT' or not old.is_active)
     and not app.org_has_feature(new.organization_id, 'public_page') then
    raise exception 'the business page is not in the plan' using errcode = 'P0001', hint = 'feature:public_page';
  end if;
  if (tg_op = 'INSERT' or new.booking_page_ids is distinct from old.booking_page_ids)
     and (array_position(new.booking_page_ids, null) is not null
          or cardinality(new.booking_page_ids) <> (select count(distinct x) from unnest(new.booking_page_ids) x)
          or exists (select 1 from unnest(new.booking_page_ids) x
                      where not exists (select 1 from public.booking_pages b
                                         where b.organization_id = new.organization_id and b.id = x))) then
    raise exception 'a business page links only to the business''s own booking pages' using errcode = 'P0001', hint = 'business_page:booking_page';
  end if;
  -- BIZ-01 (314) ב: one person or one team, never both
  if new.owner_user_id is not null and new.team_id is not null then
    raise exception 'the page''s leads go to one person or one team' using errcode = 'P0001', hint = 'business_page:routing';
  end if;
  if new.owner_user_id is not null
     and (tg_op = 'INSERT' or new.owner_user_id is distinct from old.owner_user_id) then
    -- the membership row FOR SHARE: a concurrent suspension or move to viewer waits for this write, and its trigger
    -- (app.memberships_business_page_owner_off) then sees the stored choice and clears it
    perform 1 from public.memberships m
     where m.organization_id = new.organization_id and m.user_id = new.owner_user_id
       and m.status = 'active' and m.role <> 'viewer'
       for share of m;
    if not found then
      raise exception 'the page''s leads go to an active member who is not a viewer' using errcode = 'P0001', hint = 'business_page:owner';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.business_pages_check() from public, anon, authenticated;

-- 021237's form maker with the page's choice of who gets its leads
create or replace function app.business_pages_make_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_source uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('business_page_source:' || new.organization_id::text, 0));
  select s.id into v_source from public.lead_sources s
   where s.organization_id = new.organization_id
     and (s.kind = 'business_page' or btrim(s.name) = 'דף העסק')
   order by s.is_active desc, (s.kind = 'business_page') desc, s.created_at
   limit 1;
  if v_source is null then
    insert into public.lead_sources (organization_id, name, kind)
    values (new.organization_id, 'דף העסק', 'business_page')
    returning id into v_source;
  end if;
  perform set_config('app.page_form', 'on', true);
  insert into public.forms (organization_id, kind, name, title, owner_id, team_id, assign_mode, source_id, is_active, business_page_id)
  values (new.organization_id, 'page', 'דף העסק', 'צרו קשר', new.owner_user_id, new.team_id,
          case when new.owner_user_id is not null then 'owner' else 'round_robin' end, v_source, true, new.id);
  perform set_config('app.page_form', '', true);
  return null;
end;
$$;
revoke all on function app.business_pages_make_form() from public, anon, authenticated;

-- The page's form follows a change of who gets its leads (a person's choice, or the foreign keys' set null)
create or replace function app.business_pages_sync_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.owner_user_id is not distinct from old.owner_user_id and new.team_id is not distinct from old.team_id then
    return null;
  end if;
  perform set_config('app.page_form', 'on', true);
  update public.forms f
     set owner_id = new.owner_user_id, team_id = new.team_id,
         assign_mode = case when new.owner_user_id is not null then 'owner' else 'round_robin' end
   where f.organization_id = new.organization_id and f.business_page_id = new.id;
  perform set_config('app.page_form', '', true);
  return null;
end;
$$;
revoke all on function app.business_pages_sync_form() from public, anon, authenticated;

create or replace trigger business_pages_sync_form after update of owner_user_id, team_id on public.business_pages
  for each row execute function app.business_pages_sync_form();

-- A chosen person who is no longer an active, non-viewer member: back to the regular distribution
create or replace function app.memberships_business_page_owner_off() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.status <> 'active' or new.role = 'viewer' then
    update public.business_pages b
       set owner_user_id = null
     where b.organization_id = new.organization_id and b.owner_user_id = new.user_id;
  end if;
  return null;
end;
$$;
revoke all on function app.memberships_business_page_owner_off() from public, anon, authenticated;

create or replace trigger memberships_business_page_owner_off after update of status, role on public.memberships
  for each row execute function app.memberships_business_page_owner_off();
