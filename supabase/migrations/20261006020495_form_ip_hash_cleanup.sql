-- =============================================================================
-- FXS-11 A form sender's IP hash is kept only for the rate-limit window
-- =============================================================================
-- Public forms stored sha256(form token + IP) in form_submissions.ip_hash: the form's token is public, so the hash
-- could be reversed by trying addresses. Since FXS-11 the app sends an HMAC with the server's secret
-- INTAKE_IP_HASH_SECRET (src/lib/keyed-ip-hash.ts, owner 13 October 2026), and no hash at all without it.
-- The hash is only for intake_submit's rate limit (the same sender on the same form within 10 minutes), so it is
-- cleared after 15 minutes:
-- * app.clear_form_ip_hashes(): sets ip_hash to null on submissions older than 15 minutes. Only that value; the
--   submissions, their leads and every other column stay (owner, 13 October 2026).
-- * the existing hashes, made the old way, are cleared once here (owner's go-ahead, 13 October 2026), and pg_cron
--   'crm-form-ip-hashes' clears new ones every 10 minutes, as crm-booking-ip-hashes does for bookings.
-- Business card submissions (BIZ-02) store their card-scoped keyed hash in the same column and are cleared too.
-- Every statement is safe to run twice.

-- the clearing reads only rows that still hold a hash
create index if not exists form_submissions_ip_hash_age_idx on public.form_submissions (created_at) where ip_hash is not null;

create or replace function app.clear_form_ip_hashes() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.form_submissions s set ip_hash = null
   where s.ip_hash is not null and s.created_at < now() - interval '15 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.clear_form_ip_hashes() from public, anon, authenticated;

-- the hashes made before this migration (salted with the public token): cleared now, outside the window or not
update public.form_submissions set ip_hash = null where ip_hash is not null;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-form-ip-hashes', '*/10 * * * *', 'select app.clear_form_ip_hashes();');
  end if;
end;
$$;
