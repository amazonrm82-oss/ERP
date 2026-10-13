-- =============================================================================
-- Deal loss reasons as a managed list, and a competitor field (DEAL-03)
-- =============================================================================
-- * public.deal_loss_reasons: the reasons an organization offers when a deal is
--   lost. Configuration, exactly like disqualify_reasons (0058): everyone in the
--   organization reads, owners and admins write; a hidden reason (is_active =
--   false) is no longer offered; at most 50 per organization (hint
--   'reasons:max'); names unique per organization, ignoring case.
-- * deals.lost_reason_id: the reason picked from the list (composite FK, set to
--   null when the reason is deleted). deals.lost_reason stays: it keeps the
--   reason's name as a snapshot (set by trigger whenever a reason is picked), so
--   a deleted reason still shows, and it still holds the free text old deals
--   were lost with. Picking a reason is optional (22.9 has no default; the app
--   asks gently and lets the person skip).
-- * Trigger deals_sync_stage_loss (fires right after deals_sync_stage, by name):
--   a deal that is not lost has no picked reason (id cleared); its text is
--   cleared on insert and when it moves out of lost, never on other edits; a person
--   (role authenticated) may pick only an active reason (hint
--   'deal:lost_reason'); a person who clears the picked reason also clears its
--   snapshot. A reason deleted by an admin (FK set null, run as the table
--   owner) leaves the snapshot in place.
-- * deals.competitor: free text (up to 120 characters), on any deal.
-- * report_lost_reasons groups by the reason's current name, falling back to
--   the stored text (old free text, or a deleted reason's name), and adds a
--   by_competitor section. Still security invoker.
-- * Defaults: app.seed_deal_loss_reasons(org) inserts them while the list is
--   empty; the trigger organizations_seed_deal_loss_reasons seeds every new
--   organization (create_organization is not changed), and existing
--   organizations are seeded once at the end. The names mirror
--   DEFAULT_LOSS_REASONS in src/features/deal-loss-reasons/schema.ts
--   (tests/db/76-deal-loss-reasons.test.ts keeps them equal).
-- Every statement is safe to run twice. No deletes, no drops.

create table if not exists public.deal_loss_reasons (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  position        integer not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists deal_loss_reasons_name_idx on public.deal_loss_reasons (organization_id, lower(name));
create index if not exists deal_loss_reasons_org_idx on public.deal_loss_reasons (organization_id, position);

alter table public.deal_loss_reasons enable row level security;

revoke all on public.deal_loss_reasons from anon, authenticated;
grant select, insert, update, delete on public.deal_loss_reasons to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_loss_reasons' and policyname = 'deal_loss_reasons_select') then
    create policy deal_loss_reasons_select on public.deal_loss_reasons for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_loss_reasons' and policyname = 'deal_loss_reasons_insert') then
    create policy deal_loss_reasons_insert on public.deal_loss_reasons for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_loss_reasons' and policyname = 'deal_loss_reasons_update') then
    create policy deal_loss_reasons_update on public.deal_loss_reasons for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_loss_reasons' and policyname = 'deal_loss_reasons_delete') then
    create policy deal_loss_reasons_delete on public.deal_loss_reasons for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger deal_loss_reasons_touch before update on public.deal_loss_reasons
  for each row execute function app.touch_row();
create or replace trigger deal_loss_reasons_audit after insert or update or delete on public.deal_loss_reasons
  for each row execute function app.audit_row();

create or replace function app.deal_loss_reasons_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('deal_loss_reasons:' || new.organization_id::text, 0));
  if (select count(*) from public.deal_loss_reasons r where r.organization_id = new.organization_id) >= 50 then
    raise exception 'too many loss reasons' using errcode = 'P0001', hint = 'reasons:max';
  end if;
  return new;
end;
$$;
revoke all on function app.deal_loss_reasons_cap() from public, anon, authenticated;

create or replace trigger deal_loss_reasons_cap before insert on public.deal_loss_reasons
  for each row execute function app.deal_loss_reasons_cap();

-- ----------------------------------------------------------------------------
-- The deal's reason and competitor
-- ----------------------------------------------------------------------------
alter table public.deals add column if not exists lost_reason_id uuid;
alter table public.deals add column if not exists competitor text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_lost_reason_fk') then
    alter table public.deals add constraint deals_lost_reason_fk foreign key (organization_id, lost_reason_id)
      references public.deal_loss_reasons (organization_id, id) on delete set null (lost_reason_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass and conname = 'deals_competitor_check') then
    alter table public.deals add constraint deals_competitor_check
      check (competitor is null or (char_length(competitor) between 1 and 120 and competitor = btrim(competitor)));
  end if;
end;
$$;

create index if not exists deals_lost_reason_idx on public.deals (organization_id, lost_reason_id) where lost_reason_id is not null;

-- deals has a table-wide grant today; these keep the new columns writable if it
-- ever moves to column grants (as leads, contacts and tasks did)
grant insert (lost_reason_id, competitor), update (lost_reason_id, competitor) on public.deals to authenticated;

create or replace function app.deal_loss_reason() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_name text;
  v_active boolean;
  v_changed boolean := tg_op = 'INSERT' or new.lost_reason_id is distinct from old.lost_reason_id;
begin
  -- security invoker on purpose: current_user tells a browser write from a server one.
  -- Fires after deals_sync_stage, so new.status is already the stage's kind.
  if new.status is distinct from 'lost' then
    -- a deal that is not lost carries no picked reason. Its text is cleared only
    -- when the deal is created that way or moves out of lost; any other update
    -- leaves it alone, like deals_sync_stage always did (a won deal keeps old
    -- free text on a rename).
    new.lost_reason_id := null;
    if tg_op = 'INSERT' then
      new.lost_reason := null;
    elsif old.status is not distinct from 'lost' then
      new.lost_reason := null;
    end if;
    return new;
  end if;
  if not v_changed then
    return new;
  end if;
  if new.lost_reason_id is null then
    -- a person cleared the reason they had picked; a deleted reason (FK set null,
    -- run as the table owner) keeps its name on the deal
    if tg_op = 'UPDATE' and current_user = 'authenticated' then
      new.lost_reason := null;
    end if;
    return new;
  end if;
  select r.name, r.is_active into v_name, v_active
    from public.deal_loss_reasons r
   where r.organization_id = new.organization_id and r.id = new.lost_reason_id;
  if current_user = 'authenticated' and v_active is distinct from true then
    raise exception 'pick a reason from the list' using errcode = 'P0001', hint = 'deal:lost_reason';
  end if;
  if v_name is not null then
    new.lost_reason := v_name;
  end if;
  return new;
end;
$$;
revoke all on function app.deal_loss_reason() from public, anon, authenticated;

-- named to sort right after deals_sync_stage: triggers fire in name order
create or replace trigger deals_sync_stage_loss before insert or update on public.deals
  for each row execute function app.deal_loss_reason();

-- ----------------------------------------------------------------------------
-- Report 7: by the reason's current name, else the stored text; and by competitor
-- ----------------------------------------------------------------------------
create or replace function public.report_lost_reasons(
  p_org uuid, p_from timestamptz, p_to timestamptz, p_pipeline uuid default null, p_owner uuid default null)
returns jsonb
language sql stable
set search_path = ''
as $$
  with lost as (
    select d.id, d.owner_id, d.amount_agorot,
           coalesce(r.name, nullif(btrim(d.lost_reason), '')) as reason,
           nullif(btrim(d.competitor), '') as competitor,
           (select app.safe_uuid(a.metadata ->> 'from_stage_id')
              from public.activities a
             where a.organization_id = d.organization_id and a.deal_id = d.id and a.type = 'stage_change'
               and app.safe_uuid(a.metadata ->> 'to_stage_id') = d.stage_id
             order by a.occurred_at desc limit 1) as from_stage_id
      from public.deals d
      left join public.deal_loss_reasons r on r.organization_id = d.organization_id and r.id = d.lost_reason_id
     where d.organization_id = p_org and d.deleted_at is null and d.status = 'lost'
       and d.closed_at >= p_from and d.closed_at < p_to
       and (p_pipeline is null or d.pipeline_id = p_pipeline)
       and (p_owner is null or d.owner_id = p_owner)
  )
  select jsonb_build_object(
    'by_reason', coalesce((
      select jsonb_agg(r order by r.deals desc) from (
        select reason, count(*) as deals, coalesce(sum(amount_agorot), 0) as amount
          from lost group by reason) r), '[]'::jsonb),
    'by_stage', coalesce((
      select jsonb_agg(r order by r.position nulls last) from (
        select l.from_stage_id as stage_id, s.name, s.position, count(*) as deals
          from lost l
          left join public.stages s on s.organization_id = p_org and s.id = l.from_stage_id
         group by l.from_stage_id, s.name, s.position) r), '[]'::jsonb),
    'by_owner', coalesce((
      select jsonb_agg(r order by r.deals desc) from (
        select owner_id, count(*) as deals, coalesce(sum(amount_agorot), 0) as amount
          from lost group by owner_id) r), '[]'::jsonb),
    'by_competitor', coalesce((
      select jsonb_agg(r order by r.deals desc) from (
        select competitor, count(*) as deals, coalesce(sum(amount_agorot), 0) as amount
          from lost where competitor is not null group by competitor) r), '[]'::jsonb));
$$;
revoke all on function public.report_lost_reasons(uuid, timestamptz, timestamptz, uuid, uuid) from public, anon;
grant execute on function public.report_lost_reasons(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Sample data (USR-04) survives a new column
-- ----------------------------------------------------------------------------
-- app.sample_row() (from 0105, setup_checklist; body unchanged except as noted)
-- compared the whole row with the snapshot, so adding deals.lost_reason_id and
-- deals.competitor made every existing sample deal differ from its snapshot and
-- sample_data_remove() would keep it (and its contact and company) forever.
-- Now, for a record already noted in app.sample_records, a key missing from its
-- snapshot (a column added after the sample was created) is compared only when
-- it holds a value: while it is null it is ignored, and once a person fills it
-- the record counts as changed and is kept. (A new column with a non-null
-- default would count as a change on every old sample record, which only keeps
-- them; it never loses data.) While the note
-- does not exist yet (sample_data_add() takes the snapshot), the whole row is
-- returned, as before. A column that disappears still counts as a change.
-- Same signature, security, search_path, time zone and grants. No row changes.
create or replace function app.sample_row(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
-- timestamps in the snapshot must not depend on the caller's time zone
set timezone = 'UTC'
as $$
declare
  v_row jsonb;
  v_snapshot jsonb;
begin
  if p_type not in ('lead', 'contact', 'company', 'deal', 'task') then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select to_jsonb(t) - array[''updated_at'', ''updated_by'', ''deleted_at''] from public.%I t where t.organization_id = $1 and t.id = $2',
                 case p_type when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                             when 'deal' then 'deals' else 'tasks' end)
    into v_row using p_org, p_id;
  if v_row is null then
    return null;
  end if;
  -- a column added after the snapshot was taken is left out while it is null
  select s.snapshot into v_snapshot
    from app.sample_records s
   where s.organization_id = p_org
     and app.sample_note_type(s) = p_type
     and coalesce(s.lead_id, s.contact_id, s.company_id, s.deal_id, s.task_id) = p_id
   limit 1;
  if v_snapshot is not null and jsonb_typeof(v_snapshot) = 'object' then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_row
      from jsonb_each(v_row) e
     where v_snapshot ? e.key or e.value <> 'null'::jsonb;
  end if;
  return v_row;
end;
$$;
revoke all on function app.sample_row(uuid, text, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Default reasons: an organization starts with these and renames or deletes them
-- ----------------------------------------------------------------------------
create or replace function app.seed_deal_loss_reasons(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_reasons constant text[] := array['מחיר', 'בחרו במתחרה', 'לא בזמן הנכון', 'אין תקציב', 'לא ענו', 'אחר'];
begin
  insert into public.deal_loss_reasons (organization_id, name, position)
  select p_org, d.name, (d.n - 1)::integer
    from unnest(v_reasons) with ordinality as d(name, n)
   where not exists (select 1 from public.deal_loss_reasons r where r.organization_id = p_org)
   order by d.n;
end;
$$;
revoke all on function app.seed_deal_loss_reasons(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_deal_loss_reasons() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_deal_loss_reasons(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_deal_loss_reasons() from public, anon, authenticated;

create or replace trigger organizations_seed_deal_loss_reasons after insert on public.organizations
  for each row execute function app.organizations_seed_deal_loss_reasons();

-- existing organizations: once (an organization that already has reasons is left alone)
select app.seed_deal_loss_reasons(o.id) from public.organizations o;
