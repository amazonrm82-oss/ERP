-- =============================================================================
-- CNS-09 / CNS-10 retention (owner (233) ב): the purge of preference-link tokens older than 24 months
-- =============================================================================
-- Its own small file because it holds a delete (the connector refuses one): the owner pastes it in the SQL Editor after
-- _consent_preference_links.sql, whose wrapper app.run_preference_token_purge() (pg_cron 'crm-preference-token-purge') calls
-- this function once it exists. A token row is its SHA-256 and the HMAC of the address it was made for; once deleted the
-- link answers "not found" (the link row itself stays, with no address). At most p_limit rows a run, oldest first.
-- Safe to run twice.

create or replace function app.purge_old_preference_tokens(p_limit integer) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  with old as (
    select t.token_hash from app.consent_preference_tokens t
     where t.created_at < now() - interval '24 months'
     order by t.created_at
     limit greatest(coalesce(p_limit, 0), 0)
     for update skip locked)
  delete from app.consent_preference_tokens t using old where t.token_hash = old.token_hash;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.purge_old_preference_tokens(integer) from public, anon, authenticated, service_role;
