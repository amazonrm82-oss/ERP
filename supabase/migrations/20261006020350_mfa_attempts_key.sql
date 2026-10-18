-- =============================================================================
-- A primary key for the backup-code attempts table (FXD-08 part one)
-- =============================================================================
-- app.mfa_recovery_attempts (0015) has no primary key. Owner, 18 October 2026: approved, with the row count
-- reported before it runs. Count first, read only:
--   select count(*) from app.mfa_recovery_attempts;
-- (the table is small: public.mfa_recover() removes a user's attempts older than a day on every try, and all of
-- them on success).
-- * id bigint generated always as identity: adding an identity column gives every existing row a value in the same
--   statement (a rewrite of this one small table, no row changes otherwise); then the primary key on it.
-- * Nothing reads or writes the column: inserts name only user_id, deletes go by user_id and time.
-- Safe to run twice: the column is added only when missing, the key only when there is none.

alter table app.mfa_recovery_attempts add column if not exists id bigint generated always as identity;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'app.mfa_recovery_attempts'::regclass and contype = 'p') then
    alter table app.mfa_recovery_attempts add constraint mfa_recovery_attempts_pkey primary key (id);
  end if;
end;
$$;
