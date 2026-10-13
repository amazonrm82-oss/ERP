-- DEAL-04: the close window confirms a won deal's amount and close date.
--
-- deals has a table-wide UPDATE grant, so a person could already write
-- closed_at; app.sync_deal_stage() (deals_sync_stage) keeps a date sent with a
-- move into a closed stage (coalesce). Two gaps, closed here by one more trigger
-- that runs right after it (triggers fire in name order: deals_sync_stage,
-- deals_sync_stage_close, deals_sync_stage_loss):
--   * a deal that moved between won and lost kept the old close date (coalesce
--     with the old value), so a deal won today counted in the month it was lost.
--     A change of status without a new date now stamps now().
--   * an open deal could carry a close date written by hand; now it never does.
-- A person may not set a close date more than a day ahead (the app checks
-- "not after today" in the organization's time zone; the day covers zones).
-- Server writers (automations, merge, imports) are not limited.
-- Every statement is safe to run twice.

create or replace function app.deal_close_date() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  -- security invoker on purpose: current_user tells a browser write from a server one.
  -- Fires after deals_sync_stage, so new.status is already the stage's kind.
  if new.status = 'open' then
    new.closed_at := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status
     and new.closed_at is not distinct from old.closed_at then
    new.closed_at := now();
  end if;
  if current_user = 'authenticated'
     and (tg_op = 'INSERT' or new.closed_at is distinct from old.closed_at)
     and new.closed_at > now() + interval '1 day' then
    raise exception 'close date in the future' using errcode = 'P0001', hint = 'deal:closed_at';
  end if;
  return new;
end;
$$;
revoke all on function app.deal_close_date() from public, anon, authenticated;

create or replace trigger deals_sync_stage_close before insert or update on public.deals
  for each row execute function app.deal_close_date();
