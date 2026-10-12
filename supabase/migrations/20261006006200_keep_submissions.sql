-- =============================================================================
-- 0062 The inquiry log outlives its form (CAP-04)
-- =============================================================================
-- Until now deleting a form or webhook deleted its submission log with it
-- (form_submissions.form_id ... on delete cascade). The log is the business's
-- record of who wrote in, so it now stays:
-- * form_id may be empty, and its foreign key sets only form_id to null when the
--   form is deleted (organization_id stays, so the row stays in its tenant).
-- * form_name keeps the form's name. It is written once, when the form is
--   deleted, on that form's submissions only (trigger forms_keep_submissions).
--   Older rows of forms deleted before this migration are already gone; rows
--   of live forms are not touched (no backfill).
-- * form_submissions now belongs to its organization directly
--   (organization_id -> organizations on delete cascade): before, deleting an
--   organization removed its submissions through the forms cascade.
-- Who may read the log does not change (form_submissions_select: admins of the
-- organization). Privacy erasure (app.erase_submissions, app.purge_links) works
-- on these rows as before: it matches by organization and lead, not by form.
-- Retention: kept rows stay until the organization is deleted; purging their
-- lead or a privacy erasure empties their contents (payload, user_agent).
-- Every statement is safe to run twice.

alter table public.form_submissions add column if not exists form_name text;
alter table public.form_submissions drop constraint if exists form_submissions_form_name_length;
alter table public.form_submissions add constraint form_submissions_form_name_length
  check (form_name is null or char_length(form_name) <= 80);

alter table public.form_submissions alter column form_id drop not null;

alter table public.form_submissions
  drop constraint if exists form_submissions_organization_id_form_id_fkey,
  add constraint form_submissions_organization_id_form_id_fkey
    foreign key (organization_id, form_id) references public.forms (organization_id, id) on delete set null (form_id);

alter table public.form_submissions
  drop constraint if exists form_submissions_organization_id_fkey,
  add constraint form_submissions_organization_id_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade;

-- the kept rows of an organization, newest first (the intake settings page)
create index if not exists form_submissions_orphan_idx on public.form_submissions (organization_id, created_at desc)
  where form_id is null;

-- Before a form goes, its submissions take its name. Security definer: the
-- deleting admin has no update right on form_submissions. It touches only the
-- deleted form's own rows, in the form's organization.
create or replace function app.keep_form_submissions() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- the whole organization is going (cascade): its submissions go with it, and
  -- by now its leads may be gone, so an update here would fail the lead FK check
  if not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return old;
  end if;
  update public.form_submissions s
     set form_name = old.name
   where s.organization_id = old.organization_id
     and s.form_id = old.id
     and s.form_name is null;
  return old;
end;
$$;
revoke all on function app.keep_form_submissions() from public, anon, authenticated;

create or replace trigger forms_keep_submissions before delete on public.forms
  for each row execute function app.keep_form_submissions();
