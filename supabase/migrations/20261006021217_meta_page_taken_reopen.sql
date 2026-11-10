-- CAP-11 follow-up (independent review of _meta_lead_finish_race.sql, 021215, low severity).
--
-- Since 021215 (and already since 021208's integration_test_finish) an UNVERIFIED Meta connection that lost the page to
-- another business is ended by its code alone: status kept ('connected' or 'error'), last_error_code 'page_taken', so
-- app.meta_lead_connection_open is false for it. public.integration_secret_set (021179) clears last_error_code when a new
-- token is saved; on such a connection the status does not change ('connected' -> 'connected'), so the going-live check of
-- app.integrations_check (app.integration_page_taken) did not run, and the connection looked healthy (open again for
-- receive and claim) although the page is verified by another business. No lead could reach it (receive gives arrivals of a
-- verified page to the verified connection only), but the screen misled.
--
-- Fix, in the one place every writer passes: app.integrations_check's going-live condition also runs when an update
-- RE-OPENS a connection, i.e. clears a last_error_code that was set (old not null, new null). While another live connection
-- holds the page VERIFIED, the write is refused with the existing P0001 hint integration:taken, and integration_secret_set's
-- whole transaction (the stored ciphertext included) rolls back, so nothing changes. A connection whose page is not
-- verified elsewhere re-opens as before; the verified owner's own connection passes (no other connection of its page is
-- verified). The other server path that clears a code, integration_test_finish, clears token_invalid / secret_unreadable
-- only after proving the token and, for an unverified connection, only together with verified_at (already checked); its
-- page lock is held since the row was read. Lock order is unchanged: every path takes the page advisory lock
-- (meta_page:<page>) before the row, and app.integration_page_taken takes it again (re-entrant).
--
-- Only app.integrations_check changes (same signature, invoker, search_path '', same grants; the trigger is kept).
-- No destructive statements and no escaped code points; safe to run twice.

create or replace function app.integrations_check() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- a caller the write policy refuses gets RLS's plain 42501 (RVW-23)
  if auth.uid() is not null and not (app.is_admin(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      -- a new connection waits for its secret
      new.status := 'pending';
      new.secret_set_at := null;
      new.secret_key_version := null;
      new.last_error_code := null;
      new.last_error_at := null;
      new.verified_at := null;
    elsif new.status is distinct from old.status then
      if not (new.status = 'disconnected'
              or (new.status = 'connected' and old.status in ('disconnected', 'error') and old.secret_set_at is not null)) then
        raise exception 'this connection cannot move to that status' using errcode = 'P0001', hint = 'integration:status';
      end if;
    end if;
  end if;
  if tg_op = 'UPDATE' and new.provider is distinct from old.provider then
    raise exception 'a connection keeps its provider' using errcode = 'P0001', hint = 'integration:fixed';
  end if;
  if new.provider = 'meta_lead_ads' and (new.external_id is null or new.external_id !~ '^[0-9]{1,40}$') then
    raise exception 'a Meta page id is digits' using errcode = 'P0001', hint = 'integration:page_id';
  end if;
  -- going live, being verified, or re-opened (an error code cleared, e.g. by a new token: 021217), while another
  -- connection holds the page VERIFIED
  if new.provider = 'meta_lead_ads' and new.status in ('connected', 'error')
     and (tg_op = 'INSERT' or new.status is distinct from old.status or new.external_id is distinct from old.external_id
          or (new.verified_at is not null and old.verified_at is null)
          or (old.last_error_code is not null and new.last_error_code is null))
     and app.integration_page_taken(new.external_id, new.id) then
    raise exception 'this page is connected elsewhere' using errcode = 'P0001', hint = 'integration:taken';
  end if;
  return new;
end;
$$;
revoke all on function app.integrations_check() from public, anon, authenticated;
