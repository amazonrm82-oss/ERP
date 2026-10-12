-- =============================================================================
-- What a person may write on a timeline: the six types they log, and a size (RVW-11)
-- =============================================================================
-- Until now a browser insert into public.activities accepted any type that matched
-- '^[a-z_]{2,40}$', so a member could write an entry that looks like a form inquiry,
-- a status change or a merge, with invented details; after 0052 / 0059 only an admin
-- can remove such an entry. body and metadata had no size limit in the database (the
-- forms cut a note at 5,000 characters, a direct API call did not).
--
-- * Type: activities_insert also asks type = any (app.contact_types()): note, call,
--   meeting, email, whatsapp, sms, the same list as LOGGED_TYPES in
--   src/features/activities/schema.ts and the update policy of 0059 / 0067.
--   Everything the policy checked before stays (0060: writable organization, every
--   linked record visible). A client cannot change type later (no update grant on it).
--   Server writers (status / stage logging, conversion, merge, intake, the held
--   meeting entry of 0069) are security definer, run as the table owner and are not
--   subject to the policy; they keep writing their own types.
-- * body: check activities_body_length, at most 10,000 characters, for every writer.
--   The longest server body is a held meeting (title 300 + two line breaks + outcome
--   5,000); an inquiry carries the form message (5,000); a note or a call is at most
--   5,000 after cleaning. The constraint is validated: every row any of them wrote
--   passes. (Only a row written straight to the API could be longer; if one exists
--   the apply stops and changes nothing, and the lead must look at it first.)
-- * metadata: at most 4 KB of JSON text when a browser writes it (insert, or an
--   update that changes it); trigger activities_client_size, security invoker on
--   purpose because it reads current_user. The app itself only sends
--   {"outcome": "..."} for a call. It is not a table check because a server entry
--   may legitimately be larger (a merge keeps the whole merged record in metadata),
--   and a check would also run on a pin or an edit of such an entry. 23514, so the
--   app shows its usual "details are not valid" message.
-- * The trigger changes nothing in the row, it only refuses, so its place among the
--   other before triggers (activities_touch, activities_verify_meeting_entry) does
--   not matter.
-- Every statement is safe to run twice.

-- altered in place: the policy exists since 0004 (rls.sql), changed in 0060
alter policy activities_insert on public.activities
  with check (app.can_write(organization_id)
              and type = any (app.contact_types())
              and app.can_read_every_activity_subject(lead_id, contact_id, company_id, deal_id));

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.activities'::regclass and conname = 'activities_body_length'
  ) then
    alter table public.activities
      add constraint activities_body_length check (body is null or char_length(body) <= 10000);
  end if;
end;
$$;

-- SECURITY INVOKER on purpose: current_user tells a browser write from a server one.
create or replace function app.activities_client_size() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and (tg_op = 'INSERT' or new.metadata is distinct from old.metadata)
     and octet_length(new.metadata::text) > 4096 then
    raise exception 'activity metadata is too large' using errcode = '23514', hint = 'activity:too_large';
  end if;
  return new;
end;
$$;
revoke all on function app.activities_client_size() from public, anon, authenticated;

create or replace trigger activities_client_size
  before insert or update of metadata on public.activities
  for each row execute function app.activities_client_size();
