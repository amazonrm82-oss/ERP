-- =============================================================================
-- 0036 Size limits on what a public form stores (FXS-02)
-- =============================================================================
-- Anyone with a form's link can post to it. The lead itself already keeps each
-- field short (intake_submit cuts them), but form_submissions.payload kept the
-- whole body as sent, so one sender could fill the shared database.
-- * A trigger keeps only the five known fields, cut to the same lengths as the
--   lead (name 200, phone 40, email 254, company 200, message 5000).
-- * A size check on the column, for new rows (older rows are left as they are).
-- The app also refuses bodies over 32KB before it calls the database, and
-- counts those against the sender's rate limit.
-- Every statement is safe to run twice.

create or replace function app.trim_submission_payload() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.payload := jsonb_strip_nulls(jsonb_build_object(
    'full_name', left(new.payload ->> 'full_name', 200),
    'phone', left(new.payload ->> 'phone', 40),
    'email', left(new.payload ->> 'email', 254),
    'company_name', left(new.payload ->> 'company_name', 200),
    'message', left(new.payload ->> 'message', 5000)
  ));
  return new;
end;
$$;
revoke all on function app.trim_submission_payload() from public, anon, authenticated;

drop trigger if exists form_submissions_trim_payload on public.form_submissions;
create trigger form_submissions_trim_payload before insert on public.form_submissions
  for each row execute function app.trim_submission_payload();

alter table public.form_submissions drop constraint if exists form_submissions_payload_size;
alter table public.form_submissions add constraint form_submissions_payload_size
  check (pg_column_size(payload) <= 16384) not valid;
