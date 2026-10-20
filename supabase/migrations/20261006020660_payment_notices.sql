-- =============================================================================
-- PAY-07, the notice part: a payment received tells the record's owner
-- =============================================================================
-- * When a payment is recorded (insert, status recorded or confirmed), one notice of the existing kind `system` goes to the
--   owner of its deal, else of its contact: an active member who is not a viewer and is not the person who recorded it. No
--   owner (or only the recorder) = no notice; nobody else is told.
-- * The text names no person: title "התקבל תשלום", body the amount and the method ("1,170 ₪ · העברה בנקאית"). The notice
--   leads to the deal, else the contact (entity_type deal|contact), whose read rule covers the payment.
-- * Cancelling, correcting or moving a payment's status sends nothing (only the first recording does).
-- * The automation event (a new trigger "a payment was received") needs the shared engine (app.process_outbox, the
--   automations trigger_type check, app.automation_event_matches); it is not here.
-- Every statement is safe to run twice. No drops, no row removal.

-- "1,170 ₪" / "1,170.50 ₪" from agorot (whole shekels without ".00", as formatMoney)
create or replace function app.payment_amount_text(p_agorot bigint) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_agorot % 100 = 0
              then to_char(p_agorot / 100, 'FM999,999,999,999,990')
              else to_char(p_agorot / 100.0, 'FM999,999,999,999,990.00') end || ' ₪'
$$;
revoke all on function app.payment_amount_text(bigint) from public, anon, authenticated, service_role;

-- the Hebrew name of a payment method (mirrors PAYMENT_METHOD_LABELS, src/features/payments/schema.ts; unit test)
create or replace function app.payment_method_label(p_method text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_method
           when 'credit' then 'כרטיס אשראי'
           when 'transfer' then 'העברה בנקאית'
           when 'cash' then 'מזומן'
           when 'cheque' then 'צ''ק'
           when 'bit_paybox' then 'Bit או PayBox'
           when 'standing_order' then 'הוראת קבע'
           else 'אחר' end
$$;
revoke all on function app.payment_method_label(text) from public, anon, authenticated, service_role;

create or replace function app.notify_payment_received() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_kind text;
  v_entity uuid;
begin
  if new.status not in ('recorded', 'confirmed') then
    return null;
  end if;
  -- the deal's owner, else the contact's
  if new.deal_id is not null then
    select d.owner_id into v_owner from public.deals d where d.organization_id = new.organization_id and d.id = new.deal_id;
    v_kind := 'deal';
    v_entity := new.deal_id;
  end if;
  if v_owner is null and new.contact_id is not null then
    select c.owner_id into v_owner from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id;
    v_kind := 'contact';
    v_entity := new.contact_id;
  end if;
  if v_owner is null or v_owner is not distinct from coalesce(auth.uid(), new.created_by) then
    return null;
  end if;
  if not exists (select 1 from public.memberships m
                  where m.organization_id = new.organization_id and m.user_id = v_owner
                    and m.status = 'active' and m.role <> 'viewer') then
    return null;
  end if;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  values (new.organization_id, v_owner, 'system', 'התקבל תשלום',
          app.payment_amount_text(new.amount_agorot) || ' · ' || app.payment_method_label(new.method),
          v_kind, v_entity);
  return null;
end;
$$;
revoke all on function app.notify_payment_received() from public, anon, authenticated, service_role;

create or replace trigger payments_notify_received after insert on public.payments
  for each row execute function app.notify_payment_received();
