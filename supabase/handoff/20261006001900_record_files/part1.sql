-- 20261006001900_record_files: part 1 of 3. Run the parts in order.
-- =============================================================================
-- 0019 Files on records
-- =============================================================================
-- * public.files: one row per file attached to a lead, contact, company or deal.
--   Who sees a file is who sees its record (the same rule as the timeline).
-- * The file itself is in the private Storage bucket 'record-files', at
--   '<organization id>/<file id>' (set by trigger, never by the client). The
--   storage.objects policies point back to public.files, so a file can be read,
--   uploaded or deleted only by someone who may do it to its row.
-- * Up to 25 MB a file. The organization's total is capped by the plan
--   (plans.limits.storage_gb); over it the insert fails with hint 'limit:storage_gb'.
-- * A deleted row leaves its storage path in app.orphan_files, for a cleanup that
--   removes the object through the Storage API (the app deletes the object first
--   when a user deletes a file; a record purged by the nightly job leaves one).
-- Every statement is safe to run twice.

create table if not exists public.files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  lead_id         uuid,
  contact_id      uuid,
  company_id      uuid,
  deal_id         uuid,
  name            text not null check (char_length(btrim(name)) between 1 and 200),
  mime_type       text not null check (char_length(mime_type) between 1 and 120),
  size_bytes      bigint not null check (size_bytes between 1 and 26214400),
  storage_path    text not null unique,
  uploaded_by     uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete cascade,
  foreign key (organization_id, contact_id) references public.contacts (organization_id, id) on delete cascade,
  foreign key (organization_id, company_id) references public.companies (organization_id, id) on delete cascade,
  foreign key (organization_id, deal_id) references public.deals (organization_id, id) on delete cascade,
  constraint files_one_subject check (num_nonnulls(lead_id, contact_id, company_id, deal_id) = 1),
  constraint files_path check (storage_path = organization_id::text || '/' || id::text)
);
create index if not exists files_lead_idx on public.files (lead_id, created_at desc) where lead_id is not null;
create index if not exists files_contact_idx on public.files (contact_id, created_at desc) where contact_id is not null;
create index if not exists files_company_idx on public.files (company_id, created_at desc) where company_id is not null;
create index if not exists files_deal_idx on public.files (deal_id, created_at desc) where deal_id is not null;
create index if not exists files_org_idx on public.files (organization_id);

alter table public.files enable row level security;
revoke all on public.files from anon, authenticated;
grant select, delete on public.files to authenticated;
grant insert (organization_id, lead_id, contact_id, company_id, deal_id, name, mime_type, size_bytes) on public.files to authenticated;
grant all on public.files to service_role;
