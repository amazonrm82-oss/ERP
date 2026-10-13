-- =============================================================================
-- WhatsApp text templates for the one-to-one link (WA-01)
-- =============================================================================
-- No provider: the WhatsApp button of a record offers the organization's
-- templates, opens wa.me with the filled text, and the app logs an activity of
-- type 'whatsapp' with the user's session (activities_insert of 0072 already
-- allows that type). Nothing is sent by the system, one by one or in bulk.
-- * public.whatsapp_templates: a managed list (owner's rule of 12 October 2026).
--   Configuration: every member reads, owners and admins of a writable
--   organization write (as disqualify_reasons). At most 50 per organization
--   (hint 'whatsapp_templates:max'); names unique per organization, ignoring case.
--   body holds placeholders such as {שם פרטי}; the app fills them
--   (src/features/whatsapp/templates.ts lists them).
-- * kind: null, or 'meeting_reminder' on the default template for a reminder of
--   tomorrow's meeting (GAP-03 offers that one first). Set by the seed only:
--   clients have no insert or update grant on it. One per organization.
-- * Defaults: app.seed_whatsapp_templates(org) inserts them while the
--   organization has no template at all. It runs for every existing
--   organization once, and for each new organization from the after insert
--   trigger organizations_seed_whatsapp_templates (create_organization is not
--   changed). The texts mirror DEFAULT_TEMPLATES in
--   src/features/whatsapp/templates.ts (a unit test reads this file).
-- * Re-applying this file by hand: the final backfill runs again and puts the
--   defaults back into every organization that has no template at all at that
--   moment (one that deleted all of them on purpose gets them again). An
--   organization with at least one template is left alone.
-- * Deleting the meeting-reminder template is final: nothing restores it or
--   moves kind 'meeting_reminder' to another template. GAP-03 must handle an
--   organization without it (offer the other templates, or an empty text).
-- Every statement is safe to run twice.

create table if not exists public.whatsapp_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  body            text not null check (char_length(body) between 1 and 1000 and body = btrim(body)),
  position        integer not null default 0,
  kind            text check (kind in ('meeting_reminder')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

create unique index if not exists whatsapp_templates_name_idx on public.whatsapp_templates (organization_id, lower(name));
create unique index if not exists whatsapp_templates_kind_idx on public.whatsapp_templates (organization_id, kind) where kind is not null;
create index if not exists whatsapp_templates_org_idx on public.whatsapp_templates (organization_id, position);

alter table public.whatsapp_templates enable row level security;

revoke all on public.whatsapp_templates from anon, authenticated;
grant select, delete on public.whatsapp_templates to authenticated;
-- kind is the server's (seed only)
grant insert (organization_id, name, body, position) on public.whatsapp_templates to authenticated;
grant update (name, body, position) on public.whatsapp_templates to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'whatsapp_templates' and policyname = 'whatsapp_templates_select') then
    create policy whatsapp_templates_select on public.whatsapp_templates for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'whatsapp_templates' and policyname = 'whatsapp_templates_insert') then
    create policy whatsapp_templates_insert on public.whatsapp_templates for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'whatsapp_templates' and policyname = 'whatsapp_templates_update') then
    create policy whatsapp_templates_update on public.whatsapp_templates for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'whatsapp_templates' and policyname = 'whatsapp_templates_delete') then
    create policy whatsapp_templates_delete on public.whatsapp_templates for delete to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

create or replace trigger whatsapp_templates_touch before update on public.whatsapp_templates
  for each row execute function app.touch_row();
create or replace trigger whatsapp_templates_audit after insert or update or delete on public.whatsapp_templates
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- At most 50 templates per organization
-- ----------------------------------------------------------------------------
create or replace function app.whatsapp_templates_cap() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- one insert at a time per organization, so two cannot both pass the count
  perform pg_advisory_xact_lock(hashtextextended('whatsapp_templates:' || new.organization_id::text, 0));
  if (select count(*) from public.whatsapp_templates t where t.organization_id = new.organization_id) >= 50 then
    raise exception 'too many whatsapp templates' using errcode = 'P0001', hint = 'whatsapp_templates:max';
  end if;
  return new;
end;
$$;
revoke all on function app.whatsapp_templates_cap() from public, anon, authenticated;

create or replace trigger whatsapp_templates_cap before insert on public.whatsapp_templates
  for each row execute function app.whatsapp_templates_cap();

-- ----------------------------------------------------------------------------
-- Default templates: an organization starts with these and renames or deletes them
-- ----------------------------------------------------------------------------
create or replace function app.seed_whatsapp_templates(p_org uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.whatsapp_templates (organization_id, name, body, position, kind)
  select p_org, d.name, d.body, (d.n - 1)::integer, d.kind
    from (values
      (1, 'פנייה ראשונה',
          'שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}. קיבלנו את הפנייה שלך. מתי נוח לך לדבר?', null::text),
      (2, 'לא הצלחנו להשיג',
          'שלום {שם פרטי}, ניסיתי להתקשר אליך ולא הצלחתי להשיג. מתי נוח שאחזור אליך? {שם הנציג}, {שם העסק}', null),
      (3, 'תזכורת לפגישה מחר',
          'שלום {שם פרטי}, תזכורת לפגישה שלנו מחר, {תאריך} בשעה {שעה}. אם צריך לשנות, אפשר לכתוב לי כאן. {שם הנציג}, {שם העסק}', 'meeting_reminder'),
      (4, 'תודה על השיחה',
          'תודה {שם פרטי}, היה נעים לדבר. אם יש שאלות, אני כאן. {שם הנציג}, {שם העסק}', null)
    ) as d(n, name, body, kind)
   where not exists (select 1 from public.whatsapp_templates t where t.organization_id = p_org)
   order by d.n;
end;
$$;
revoke all on function app.seed_whatsapp_templates(uuid) from public, anon, authenticated;

create or replace function app.organizations_seed_whatsapp_templates() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.seed_whatsapp_templates(new.id);
  return null;
end;
$$;
revoke all on function app.organizations_seed_whatsapp_templates() from public, anon, authenticated;

create or replace trigger organizations_seed_whatsapp_templates after insert on public.organizations
  for each row execute function app.organizations_seed_whatsapp_templates();

-- existing organizations: once (an organization that already has templates is left alone)
select app.seed_whatsapp_templates(o.id) from public.organizations o;
