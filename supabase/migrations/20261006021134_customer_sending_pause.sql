-- =============================================================================
-- HEB-09: "stop everything" - a business pauses all automatic sending to customers
-- =============================================================================
-- Spec (SPEC-ADDITIONS, HEB-09, wave 3): an owner or admin pauses with one click all automatic sending to
-- customers (marketing and reminders) until they resume it. A banner reminds that sending is paused. For
-- days of mourning and emergencies.
-- * public.org_sending_pauses: one row per business (no row = sending is not paused). `paused` and the
--   required `reason` (1..500, trimmed) are written by owners/admins through column grants; `paused_at`,
--   `paused_by`, `resumed_at`, `resumed_by` are server-kept by the definer-free trigger
--   app.org_sending_pauses_stamp (no client grant on them). Members read the row (the banner shows to all of
--   them). No delete (resume instead). Audited (app.audit_row): who paused and resumed, when, and why.
-- * Who: owners and admins, in any business that is not closed (app.org_closed). Deliberately NOT
--   app.org_writable: a read-only business still takes leads and bookings, so the brake must work there.
-- * One rule: app.customer_sending_paused(org) (definer, stable, no grants; true while paused). EVERY
--   automatic sender of a message to a customer asks it first and sends nothing while it is true. Staff
--   notices (bell, push, task reminders, meeting reminders to staff, collection reminder TASKS) are not
--   paused: they go to the business's own people, not to customers.
--   Built today: no automatic sender to customers exists yet (WhatsApp goes out by hand through a wa.me
--   link; no email/SMS provider; booking and quote pages show their answer on screen). The future senders
--   that must ask it: the OPS-04 send queue and its dispatcher, CNS-07 marketing sends, MSG-*/EML-*/SMS-*,
--   AUT-08 message steps in automations, booking confirmations and reminders to the customer, COL-04
--   reminders if they ever message the customer, and any provider adapter.
-- * Core: every plan, no plan key (a safety brake).
-- Every statement is safe to run twice.

create table if not exists public.org_sending_pauses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  paused           boolean not null default false,
  reason           text,
  paused_at        timestamptz,
  paused_by        uuid references auth.users (id) on delete set null,
  resumed_at       timestamptz,
  resumed_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id),
  -- a pause carries its reason; a resumed business keeps none
  constraint org_sending_pauses_reason check (
    (paused and reason is not null and char_length(reason) between 1 and 500 and reason = btrim(reason))
    or (not paused and reason is null)
  )
);

comment on table public.org_sending_pauses is
  'HEB-09: one row per business; while paused, every automatic sender to customers sends nothing (app.customer_sending_paused)';

alter table public.org_sending_pauses enable row level security;
revoke all on public.org_sending_pauses from anon, authenticated;
grant select on public.org_sending_pauses to authenticated;
grant insert (organization_id, paused, reason) on public.org_sending_pauses to authenticated;
grant update (paused, reason) on public.org_sending_pauses to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_sending_pauses' and policyname = 'org_sending_pauses_select') then
    create policy org_sending_pauses_select on public.org_sending_pauses for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_sending_pauses' and policyname = 'org_sending_pauses_insert') then
    create policy org_sending_pauses_insert on public.org_sending_pauses for insert to authenticated
      with check (app.is_admin(organization_id) and not app.org_closed(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_sending_pauses' and policyname = 'org_sending_pauses_update') then
    create policy org_sending_pauses_update on public.org_sending_pauses for update to authenticated
      using (app.is_admin(organization_id) and not app.org_closed(organization_id))
      with check (app.is_admin(organization_id) and not app.org_closed(organization_id));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The pause and resume stamps: server-kept for every writer
-- ----------------------------------------------------------------------------
create or replace function app.org_sending_pauses_stamp() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.paused then
      new.paused_at := now();
      new.paused_by := auth.uid();
    else
      new.paused_at := null;
      new.paused_by := null;
    end if;
    new.resumed_at := null;
    new.resumed_by := null;
    return new;
  end if;
  if new.paused and not old.paused then
    new.paused_at := now();
    new.paused_by := auth.uid();
    new.resumed_at := null;
    new.resumed_by := null;
  elsif old.paused and not new.paused then
    new.paused_at := old.paused_at;
    new.paused_by := old.paused_by;
    new.resumed_at := now();
    new.resumed_by := auth.uid();
  else
    new.paused_at := old.paused_at;
    new.paused_by := old.paused_by;
    new.resumed_at := old.resumed_at;
    new.resumed_by := old.resumed_by;
  end if;
  return new;
end;
$$;
revoke all on function app.org_sending_pauses_stamp() from public, anon, authenticated;

create or replace trigger org_sending_pauses_stamp before insert or update on public.org_sending_pauses
  for each row execute function app.org_sending_pauses_stamp();
create or replace trigger org_sending_pauses_touch before insert or update on public.org_sending_pauses
  for each row execute function app.touch_row();
create or replace trigger org_sending_pauses_audit after insert or update or delete on public.org_sending_pauses
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- The one rule every automatic sender to customers asks
-- ----------------------------------------------------------------------------
create or replace function app.customer_sending_paused(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select p.paused from public.org_sending_pauses p where p.organization_id = p_org), false)
$$;
revoke all on function app.customer_sending_paused(uuid) from public, anon, authenticated;

comment on function app.customer_sending_paused(uuid) is
  'HEB-09: true while the business paused automatic sending to customers; every automatic customer-facing sender asks it first and sends nothing while true';

notify pgrst, 'reload schema';
