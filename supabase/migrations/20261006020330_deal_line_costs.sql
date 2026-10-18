-- =============================================================================
-- PRD-06 follow-up: the cost of each deal line, kept when the line is made
-- =============================================================================
-- Owner, 15 October 2026 (PRD-06, answer 2): one cost per unit in the catalog (product_costs), and a copy kept in every
-- deal line the moment it is made; whoever may see costs edits it on the line; on an open deal the screen says when the
-- catalog cost changed and offers to update the line; on a closed deal it is locked; documents copy it from the line.
--
-- * public.deal_line_costs: one row per deal line (unique organization, line), cost_agorot per unit as in the catalog
--   (before VAT in a business that charges VAT, the amount paid otherwise). The line FK cascades: the cost goes with its
--   line, and the line with its deal.
-- * Made by the database (app.deal_line_cost_snapshot, after insert on deal_lines, security definer): a product line
--   whose product has a cost gets a copy of it, whoever adds the line (a member who may not see costs too). A free line
--   or a product with no cost gets none.
-- * RLS: every verb needs app.can_view_costs (the PRD-06 rule) and a line the caller reads (its deal's RLS). Writes also
--   need app.deal_line_cost_editable: the line's deal is live, open (not won or lost: a closed deal is locked) and the
--   caller may edit it, in a writable business with the 'products' capability. Nothing else in the API carries a line's
--   cost: deal_lines holds none.
-- * Audited (app.audit_row; the audit log is for owners and admins, who see costs). No emit_event.
--
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.deal_line_costs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  deal_line_id    uuid not null,
  cost_agorot     bigint not null check (cost_agorot between 0 and 1000000000000),
  currency        text not null default 'ILS' check (currency = 'ILS'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  constraint deal_line_costs_one_per_line unique (organization_id, deal_line_id),
  constraint deal_line_costs_line_fk foreign key (organization_id, deal_line_id)
    references public.deal_lines (organization_id, id) on delete cascade
);

alter table public.deal_line_costs enable row level security;

revoke all on public.deal_line_costs from anon, authenticated;
grant select, delete on public.deal_line_costs to authenticated;
grant insert (organization_id, deal_line_id, cost_agorot, currency) on public.deal_line_costs to authenticated;
grant update (cost_agorot, currency) on public.deal_line_costs to authenticated;

-- A person may set a line's cost: its deal is live and open, they may edit it, in a writable business with products
create or replace function app.deal_line_cost_editable(p_org uuid, p_line uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.org_writable(p_org) and app.org_has_feature(p_org, 'products')
     and exists (
       select 1 from public.deal_lines l
         join public.deals d on d.organization_id = l.organization_id and d.id = l.deal_id
        where l.organization_id = p_org and l.id = p_line
          and d.deleted_at is null and d.status = 'open'
          and app.can_edit_record(d.organization_id, d.owner_id, d.team_id))
$$;
revoke all on function app.deal_line_cost_editable(uuid, uuid) from public, anon;
grant execute on function app.deal_line_cost_editable(uuid, uuid) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_line_costs' and policyname = 'deal_line_costs_select') then
    create policy deal_line_costs_select on public.deal_line_costs for select to authenticated
      using (app.can_view_costs(organization_id)
             and exists (select 1 from public.deal_lines l
                          where l.organization_id = deal_line_costs.organization_id and l.id = deal_line_costs.deal_line_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_line_costs' and policyname = 'deal_line_costs_insert') then
    create policy deal_line_costs_insert on public.deal_line_costs for insert to authenticated
      with check (app.can_view_costs(organization_id) and app.deal_line_cost_editable(organization_id, deal_line_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_line_costs' and policyname = 'deal_line_costs_update') then
    create policy deal_line_costs_update on public.deal_line_costs for update to authenticated
      using (app.can_view_costs(organization_id) and app.deal_line_cost_editable(organization_id, deal_line_id))
      with check (app.can_view_costs(organization_id) and app.deal_line_cost_editable(organization_id, deal_line_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'deal_line_costs' and policyname = 'deal_line_costs_delete') then
    create policy deal_line_costs_delete on public.deal_line_costs for delete to authenticated
      using (app.can_view_costs(organization_id) and app.deal_line_cost_editable(organization_id, deal_line_id));
  end if;
end;
$$;

create or replace trigger deal_line_costs_touch before insert or update on public.deal_line_costs
  for each row execute function app.touch_row();
create or replace trigger deal_line_costs_audit after insert or update or delete on public.deal_line_costs
  for each row execute function app.audit_row();

-- The copy taken when a line is made: the catalog cost of its product, if it has one
create or replace function app.deal_line_cost_snapshot() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.product_id is not null then
    insert into public.deal_line_costs (organization_id, deal_line_id, cost_agorot, currency)
    select new.organization_id, new.id, c.cost_agorot, c.currency
      from public.product_costs c
     where c.organization_id = new.organization_id and c.product_id = new.product_id
    on conflict (organization_id, deal_line_id) do nothing;
  end if;
  return null;
end;
$$;
revoke all on function app.deal_line_cost_snapshot() from public, anon, authenticated, service_role;

create or replace trigger deal_lines_cost_snapshot after insert on public.deal_lines
  for each row execute function app.deal_line_cost_snapshot();

-- Lines made before this migration get the catalog cost of today, once (a line that already has a row keeps it)
insert into public.deal_line_costs (organization_id, deal_line_id, cost_agorot, currency)
select l.organization_id, l.id, c.cost_agorot, c.currency
  from public.deal_lines l
  join public.product_costs c on c.organization_id = l.organization_id and c.product_id = l.product_id
on conflict (organization_id, deal_line_id) do nothing;
