-- =============================================================================
-- DOC-04 follow-up (owner, 25 October 2026, DECISIONS.md "מסמך ותשלום בציר הזמן", the second answers): a payment that fails or
-- is refunded is on the timeline too, and a failed payment received after all is written again
-- =============================================================================
-- * app.payments_timeline (the body of 020750) adds, on the payment's deal and contact, a system entry with no author:
--     - a move into failed: "תשלום נכשל · <method>", kind payment_failed (a bounced cheque, PAY-04, writes it the same way);
--     - a move into refunded: "תשלום הוחזר · <method>", kind payment_refunded;
--     - a move from failed back into recorded or confirmed: "התקבל תשלום · <method>" again, kind payment_received.
--   The method only, never an amount (answer (1) ב). Confirming a recorded payment still writes nothing.
-- * The trigger payments_timeline fires on every update, not only "update of status": a status a BEFORE trigger derives (PAY-04's
--   cheque status sets the payment's) is not in the statement's column list, and "update of status" would miss it. The function
--   returns at once when the status did not change.
-- * The guard app.activities_money_entry_guard and the author trigger activities_zz_money_entry_author (both of 020750) know
--   the two new kinds: a person never writes, changes or removes them. Erasure needs nothing (no reason in these entries).
-- Every statement is safe to run twice. No drops, no row removal.

create or replace function app.activities_money_entry_guard() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    if coalesce(old.metadata ->> 'kind', '') in ('document_recorded', 'document_cancelled', 'payment_received', 'payment_cancelled', 'payment_failed', 'payment_refunded') then
      raise exception 'a document or payment on the timeline is history' using errcode = '42501', hint = 'activity:money_entry';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if coalesce(new.metadata ->> 'kind', '') in ('document_recorded', 'document_cancelled', 'payment_received', 'payment_cancelled', 'payment_failed', 'payment_refunded') then
      raise exception 'only the server writes a document or payment entry' using errcode = '42501', hint = 'activity:money_entry';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function app.activities_money_entry_guard() from public, anon, authenticated, service_role;

create or replace trigger activities_money_entry_guard before insert or update or delete on public.activities
  for each row execute function app.activities_money_entry_guard();

create or replace trigger activities_zz_money_entry_author before insert on public.activities
  for each row when (new.type = 'system'
                     and coalesce(new.metadata ->> 'kind', '') in ('document_recorded', 'document_cancelled', 'payment_received', 'payment_cancelled', 'payment_failed', 'payment_refunded'))
  execute function app.activities_money_entry_author();

create or replace function app.payments_timeline() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_method text := app.payment_method_label(new.method);
begin
  if new.deal_id is null and new.contact_id is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.status in ('recorded', 'confirmed') then
      insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
      values (new.organization_id, 'system', new.deal_id, new.contact_id, 'התקבל תשלום · ' || v_method,
              jsonb_build_object('kind', 'payment_received', 'payment_id', new.id, 'method', new.method));
    end if;
    return null;
  end if;
  if new.status is not distinct from old.status then
    return null;
  end if;
  if new.status = 'cancelled' then
    insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
    values (new.organization_id, 'system', new.deal_id, new.contact_id,
            'בוטל תשלום · ' || v_method || coalesce(' · סיבה: ' || new.cancel_reason, ''),
            jsonb_build_object('kind', 'payment_cancelled', 'payment_id', new.id, 'method', new.method));
  elsif new.status = 'failed' then
    insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
    values (new.organization_id, 'system', new.deal_id, new.contact_id, 'תשלום נכשל · ' || v_method,
            jsonb_build_object('kind', 'payment_failed', 'payment_id', new.id, 'method', new.method));
  elsif new.status = 'refunded' then
    insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
    values (new.organization_id, 'system', new.deal_id, new.contact_id, 'תשלום הוחזר · ' || v_method,
            jsonb_build_object('kind', 'payment_refunded', 'payment_id', new.id, 'method', new.method));
  elsif old.status = 'failed' and new.status in ('recorded', 'confirmed') then
    insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata)
    values (new.organization_id, 'system', new.deal_id, new.contact_id, 'התקבל תשלום · ' || v_method,
            jsonb_build_object('kind', 'payment_received', 'payment_id', new.id, 'method', new.method));
  end if;
  return null;
end;
$$;
revoke all on function app.payments_timeline() from public, anon, authenticated, service_role;

create or replace trigger payments_timeline after insert or update on public.payments
  for each row execute function app.payments_timeline();
