-- =============================================================================
-- FLD-10: a business's own words for contacts, leads and deals (owner, 18 October 2026, answer (א))
-- =============================================================================
-- A ready list only, no free text (free text breaks gender and plural on every screen):
--   contact: contact (איש קשר) | customer (לקוח) | patient (מטופל) | student (תלמיד) | member (חבר)
--   lead:    lead (ליד) | inquiry (פנייה) | prospect (מתעניין)
--   deal:    deal (עסקה) | opportunity (הזדמנות) | case (תיק)
-- Every form of each word (singular, plural, gender, "new …") is written by hand in src/features/terminology/terms.ts,
-- which mirrors these lists (a unit test reads this file).
-- * public.org_terms: one row per business, a nullable column per type; null (or no row) = today's word, so nothing
--   changes until a business picks. Members read; owners/admins of a writable business write; no delete (clear a column
--   instead); audited. Core: every plan, no plan key (a wording, not a capability).
-- Additive only. Safe to run twice.

create table if not exists public.org_terms (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  contact_term     text check (contact_term is null or contact_term in ('contact', 'customer', 'patient', 'student', 'member')),
  lead_term        text check (lead_term is null or lead_term in ('lead', 'inquiry', 'prospect')),
  deal_term        text check (deal_term is null or deal_term in ('deal', 'opportunity', 'case')),
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

create or replace trigger org_terms_touch before insert or update on public.org_terms
  for each row execute function app.touch_row();
create or replace trigger org_terms_audit after insert or update or delete on public.org_terms
  for each row execute function app.audit_row();

alter table public.org_terms enable row level security;
revoke all on public.org_terms from anon, authenticated;
grant select on public.org_terms to authenticated;
grant insert (organization_id, contact_term, lead_term, deal_term) on public.org_terms to authenticated;
grant update (contact_term, lead_term, deal_term) on public.org_terms to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_terms' and policyname = 'org_terms_select') then
    create policy org_terms_select on public.org_terms for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_terms' and policyname = 'org_terms_insert') then
    create policy org_terms_insert on public.org_terms for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'org_terms' and policyname = 'org_terms_update') then
    create policy org_terms_update on public.org_terms for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

notify pgrst, 'reload schema';
