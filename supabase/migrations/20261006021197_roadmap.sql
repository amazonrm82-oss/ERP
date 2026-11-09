-- =============================================================================
-- Roadmap: what is being built and what is planned, and a vote per business (TRU-01)
-- =============================================================================
-- SPEC-ADDITIONS 19.8 (wave 3): "מפת דרכים ציבורית: מה בבנייה ומה מתוכנן, והצבעה של לקוחות על בקשות. מתפרסם רק נוסח שצוות
-- Mexuz כתב, וטקסט של לקוח לא מוצג ללקוחות אחרים. הצבעה אחת לכל ארגון. הבקשות עצמן מגיעות מטופס הפנייה (USR-12)".
--
-- app.roadmap_items is a platform table in schema app (no API role reads or writes it; RLS on, no policies, like every app
-- table). An item has a title (1..120) and a short description (1..1,000), both written by the Mexuz team, a status
-- (planned | building | done), a published switch (only published items reach businesses), a sort order and, optionally,
-- the ids of the support requests (USR-12) it answers: ids only, at most 200, never shown to a business. A customer's own
-- text never enters this table: staff write the item's wording themselves.
--
-- app.roadmap_votes: one row per business and item (primary key), cast by an owner or admin of the business for the whole
-- business (lead's choice). Withdrawing a vote stamps withdrawn_at (no delete); voting again clears it. Counts only ever
-- leave the database: no function answers which business voted.
--
-- Written only by platform functions (app.require_platform: the platform owner or support, aal2; logged in
-- app.platform_log):
--   platform_add_roadmap_item(title, description, status, published, sort_order, request_ids) -> id
--   platform_update_roadmap_item(id, title, description, status, published, sort_order, request_ids)
--   platform_list_roadmap_items()   {items, total}: the newest 500 items with their vote counts, for every platform role;
--                                   the linked request ids only for the platform owner and support (else null)
-- Members read and vote through definer functions:
--   roadmap_items_for(org)          published items with the vote count, whether this business voted and whether the
--                                   caller may vote; an empty list to anyone who is neither a member nor platform staff in
--                                   an open support session (app.role_in)
--   roadmap_vote(org, item, vote)   owners and admins of a business that is not closed or deleted (app.membership_role: a
--                                   support session cannot vote); an item that is published and not done; answers
--                                   {votes, voted}
-- The public page (/help/roadmap) does not read this table: it is a static list in the code
-- (src/features/roadmap/public-items.ts), so no new service-key use.
-- Every statement is safe to run twice. No drops, no deletes.

create table if not exists app.roadmap_items (
  id           uuid primary key default gen_random_uuid(),
  title        text not null
               constraint roadmap_items_title_check check (char_length(btrim(title)) between 1 and 120),
  description  text not null
               constraint roadmap_items_description_check check (char_length(btrim(description)) between 1 and 1000),
  status       text not null default 'planned'
               constraint roadmap_items_status_check check (status in ('planned', 'building', 'done')),
  published    boolean not null default false,
  sort_order   integer not null default 0
               constraint roadmap_items_sort_order_check check (sort_order between -100000 and 100000),
  -- USR-12 support requests this item answers: ids only, for the platform staff
  request_ids  uuid[] not null default '{}'
               constraint roadmap_items_request_ids_check check (cardinality(request_ids) <= 200),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table app.roadmap_items is
  'TRU-01: roadmap items written by the Mexuz team. Written only by platform_*_roadmap_item; read by members through roadmap_items_for().';

create index if not exists roadmap_items_published_idx on app.roadmap_items (published, status, sort_order);

alter table app.roadmap_items enable row level security;
revoke all on app.roadmap_items from public, anon, authenticated;

create table if not exists app.roadmap_votes (
  item_id         uuid not null references app.roadmap_items (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  voted_by        uuid references auth.users (id) on delete set null,
  voted_at        timestamptz not null default now(),
  -- the business took its vote back (a row is never deleted)
  withdrawn_at    timestamptz,
  primary key (item_id, organization_id)
);
create index if not exists roadmap_votes_org_idx on app.roadmap_votes (organization_id);

comment on table app.roadmap_votes is
  'TRU-01: one vote per business and roadmap item; withdrawn_at marks a vote taken back. Never answered per business.';

alter table app.roadmap_votes enable row level security;
revoke all on app.roadmap_votes from public, anon, authenticated;

-- Live votes of an item: not withdrawn, from a business that is not deleted.
create or replace function app.roadmap_vote_count(p_item uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select count(*)::integer
    from app.roadmap_votes v
    join public.organizations o on o.id = v.organization_id
   where v.item_id = p_item and v.withdrawn_at is null and o.deleted_at is null
$$;
revoke all on function app.roadmap_vote_count(uuid) from public, anon, authenticated;

-- Checks and cleans an item's fields; raises 22023 on a bad value. Returns the cleaned text and the request ids.
create or replace function app.roadmap_item_values(
  p_title text, p_description text, p_status text, p_sort_order integer, p_request_ids uuid[],
  out title text, out description text, out request_ids uuid[]
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  title := regexp_replace(btrim(coalesce(p_title, '')), '[[:space:]]+', ' ', 'g');
  description := btrim(coalesce(p_description, ''));
  if char_length(title) not between 1 and 120 then
    raise exception 'the title must be 1 to 120 characters' using errcode = '22023';
  end if;
  if char_length(description) not between 1 and 1000 then
    raise exception 'the description must be 1 to 1000 characters' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('planned', 'building', 'done') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  if p_sort_order is not null and p_sort_order not between -100000 and 100000 then
    raise exception 'the sort order is out of range' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct r order by r), '{}'::uuid[]) into request_ids
    from unnest(coalesce(p_request_ids, '{}'::uuid[])) as r where r is not null;
  if cardinality(request_ids) > 200 then
    raise exception 'at most 200 support requests' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(request_ids) as r
              where not exists (select 1 from public.support_requests s where s.id = r)) then
    raise exception 'unknown support request' using errcode = '22023';
  end if;
end;
$$;
revoke all on function app.roadmap_item_values(text, text, text, integer, uuid[]) from public, anon, authenticated;

create or replace function public.platform_add_roadmap_item(
  p_title text, p_description text, p_status text, p_published boolean, p_sort_order integer, p_request_ids uuid[]
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v record;
  v_id uuid;
begin
  perform app.require_platform(array['support']);
  select * into v from app.roadmap_item_values(p_title, p_description, p_status, p_sort_order, p_request_ids);
  insert into app.roadmap_items (title, description, status, published, sort_order, request_ids, created_by)
  values (v.title, v.description, p_status, coalesce(p_published, false), coalesce(p_sort_order, 0), v.request_ids, auth.uid())
  returning id into v_id;
  perform app.log_platform('roadmap.add', null, jsonb_build_object(
    'id', v_id, 'title', v.title, 'status', p_status, 'published', coalesce(p_published, false),
    'requests', cardinality(v.request_ids)));
  return v_id;
end;
$$;
revoke all on function public.platform_add_roadmap_item(text, text, text, boolean, integer, uuid[]) from public, anon;
grant execute on function public.platform_add_roadmap_item(text, text, text, boolean, integer, uuid[]) to authenticated;

create or replace function public.platform_update_roadmap_item(
  p_id uuid, p_title text, p_description text, p_status text, p_published boolean, p_sort_order integer, p_request_ids uuid[]
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v record;
  v_old app.roadmap_items%rowtype;
begin
  perform app.require_platform(array['support']);
  select * into v_old from app.roadmap_items i where i.id = p_id for update;
  if not found then
    raise exception 'roadmap item not found' using errcode = 'P0002';
  end if;
  select * into v from app.roadmap_item_values(p_title, p_description, p_status, p_sort_order, p_request_ids);
  update app.roadmap_items
     set title = v.title, description = v.description, status = p_status,
         published = coalesce(p_published, v_old.published), sort_order = coalesce(p_sort_order, v_old.sort_order),
         request_ids = v.request_ids, updated_at = now()
   where id = p_id;
  perform app.log_platform('roadmap.update', null, jsonb_build_object(
    'id', p_id, 'title', v.title, 'status', p_status, 'status_before', v_old.status,
    'published', coalesce(p_published, v_old.published), 'requests', cardinality(v.request_ids)));
end;
$$;
revoke all on function public.platform_update_roadmap_item(uuid, text, text, text, boolean, integer, uuid[]) from public, anon;
grant execute on function public.platform_update_roadmap_item(uuid, text, text, text, boolean, integer, uuid[]) to authenticated;

-- The platform screen: {items, total}. items = the newest 500 items with their live vote counts; total = how many exist,
-- so the screen can say when it shows only the newest 500. The linked support request ids go only to the platform owner
-- and support (who read support requests); finance and readonly get null. Never which business voted.
create or replace function public.platform_list_roadmap_items() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_role text;
  v_requests boolean;
begin
  v_role := app.require_platform(array['support', 'finance', 'readonly']);
  v_requests := v_role in ('owner', 'support');
  return jsonb_build_object(
    'total', (select count(*)::integer from app.roadmap_items),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'title', i.title, 'description', i.description, 'status', i.status, 'published', i.published,
               'sort_order', i.sort_order,
               'request_ids', case when v_requests then to_jsonb(i.request_ids) else null end,
               'votes', app.roadmap_vote_count(i.id),
               'created_at', i.created_at, 'updated_at', i.updated_at)
             order by i.status = 'done', i.sort_order, i.created_at, i.id)
        from (select * from app.roadmap_items order by created_at desc, id limit 500) i
    ), '[]'::jsonb));
end;
$$;
revoke all on function public.platform_list_roadmap_items() from public, anon;
grant execute on function public.platform_list_roadmap_items() to authenticated;

-- Is the business open for voting? Not closed (suspended, cancelled) and not deleted.
create or replace function app.roadmap_org_votes(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select not app.org_closed(p_org)
     and exists (select 1 from public.organizations o where o.id = p_org and o.deleted_at is null)
$$;
revoke all on function app.roadmap_org_votes(uuid) from public, anon, authenticated;

-- May the caller cast this business's vote? An owner or admin by plain membership (no support session), business open.
create or replace function app.roadmap_may_vote(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select auth.uid() is not null
     and coalesce(app.membership_role(p_org) in ('owner', 'admin'), false)
     and app.roadmap_org_votes(p_org)
$$;
revoke all on function app.roadmap_may_vote(uuid) from public, anon, authenticated;

-- The roadmap a business sees: published items, building first, then planned, then done; the live vote count, whether this
-- business voted (not who) and whether the caller may vote. Not a member = none.
create or replace function public.roadmap_items_for(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_may boolean;
begin
  if auth.uid() is null or app.role_in(p_org) is null then
    return '[]'::jsonb;
  end if;
  v_may := app.roadmap_may_vote(p_org);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', i.id, 'title', i.title, 'description', i.description, 'status', i.status,
             'votes', app.roadmap_vote_count(i.id),
             'voted', exists (select 1 from app.roadmap_votes v
                               where v.item_id = i.id and v.organization_id = p_org and v.withdrawn_at is null),
             'can_vote', v_may and i.status <> 'done')
           order by case i.status when 'building' then 0 when 'planned' then 1 else 2 end, i.sort_order, i.created_at, i.id)
      from app.roadmap_items i
     where i.published
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.roadmap_items_for(uuid) from public, anon;
grant execute on function public.roadmap_items_for(uuid) to authenticated;

-- An owner or admin casts (p_vote true) or takes back (false) the business's one vote on an item.
create or replace function public.roadmap_vote(p_org uuid, p_item uuid, p_vote boolean) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_item app.roadmap_items%rowtype;
begin
  if auth.uid() is null or app.membership_role(p_org) is null then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if app.membership_role(p_org) not in ('owner', 'admin') then
    raise exception 'only owners and admins vote for the business' using errcode = 'P0001', hint = 'roadmap:vote_admin';
  end if;
  if not app.roadmap_org_votes(p_org) then
    raise exception 'the business is closed' using errcode = 'P0001', hint = 'roadmap:closed';
  end if;
  select * into v_item from app.roadmap_items i where i.id = p_item and i.published for share;
  if not found then
    raise exception 'roadmap item not found' using errcode = 'P0002';
  end if;
  if v_item.status = 'done' then
    raise exception 'voting on this item is over' using errcode = 'P0001', hint = 'roadmap:done';
  end if;

  if coalesce(p_vote, false) then
    insert into app.roadmap_votes (item_id, organization_id, voted_by)
    values (v_item.id, p_org, auth.uid())
    on conflict (item_id, organization_id) do update
      set voted_by = excluded.voted_by, voted_at = now(), withdrawn_at = null
      where app.roadmap_votes.withdrawn_at is not null;
  else
    update app.roadmap_votes
       set withdrawn_at = now()
     where item_id = v_item.id and organization_id = p_org and withdrawn_at is null;
  end if;

  return jsonb_build_object(
    'votes', app.roadmap_vote_count(v_item.id),
    'voted', exists (select 1 from app.roadmap_votes v
                      where v.item_id = v_item.id and v.organization_id = p_org and v.withdrawn_at is null));
end;
$$;
revoke all on function public.roadmap_vote(uuid, uuid, boolean) from public, anon;
grant execute on function public.roadmap_vote(uuid, uuid, boolean) to authenticated;
