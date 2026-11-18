-- =============================================================================
-- LNK-04b: a payment through a link while the business is closed is recorded, and the owners are told
-- =============================================================================
-- Owner's answer (422) א (18 November 2026): a payment made through a payment link is recorded even when the business is
-- closed (suspended, cancelled, read-only, or in ADM-03's deletion wait), and in addition the owners get a notice.
-- LNK-04's webhook (021316) already records it in every state; this file adds the notice only.
--
-- * app.payment_link_owner_notice(org, title, body) (definer, no grants): one `system` notice to each ACTIVE OWNER of the
--   business (never admins: the owner's answer names the owners, and in a suspended or cancelled business the trigger
--   notifications_closed_org keeps only the owner's system notices anyway).
-- * public.payment_link_webhook: 021316's body unchanged, plus one step after a recorded payment: when
--   app.org_writable(org) is false, the notice above, with the link's title only (never the customer, never the amount).
--   The notice runs in its own block: any error is swallowed so the webhook still answers `recorded`, except a deadlock,
--   a serialization failure or a lock not taken (40P01, 40001, 55P03), which are raised again as elsewhere in the function
--   (the provider sends the event again; nothing of this transaction stays).
-- DRAFT wording. Every statement is safe to run twice. No drops, no row removal.

create or replace function app.payment_link_owner_notice(p_org uuid, p_title text, p_body text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  insert into public.notifications (organization_id, user_id, type, title, body)
  select m.organization_id, m.user_id, 'system', p_title, p_body
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role = 'owner';
end;
$$;
revoke all on function app.payment_link_owner_notice(uuid, text, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The webhook's one function (service_role only): 021316's body, plus the closed-business notice
-- ----------------------------------------------------------------------------
create or replace function public.payment_link_webhook(p_provider text, p_event jsonb) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_event_id text;
  v_link_ref text;
  v_status text;
  v_paid bigint;
  v_payment_ref text;
  v_currency text;
  v_installments integer;
  v_minute timestamptz := date_trunc('minute', now());
  v_hits integer;
  v_inserted boolean;
  v_count integer;
  v_link public.payment_links;
  v_today date;
  v_deal uuid;
  v_contact uuid;
  v_order uuid;
  v_quote uuid;
  v_payment uuid;
  v_balance bigint;
  v_state text;
  v_server text;
begin
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_event_id := p_event ->> 'event_id';
  v_link_ref := p_event ->> 'provider_link_id';
  v_status := p_event ->> 'status';
  v_payment_ref := nullif(p_event ->> 'provider_payment_id', '');
  v_currency := nullif(p_event ->> 'currency', '');
  if coalesce(v_event_id, '') !~ '^[A-Za-z0-9_.:-]{1,128}$' or coalesce(v_link_ref, '') !~ '^[A-Za-z0-9_.:-]{1,128}$'
     or coalesce(v_status, '') not in ('pending', 'paid', 'failed', 'expired', 'cancelled')
     or (v_payment_ref is not null and v_payment_ref !~ '^[A-Za-z0-9_.:-]{1,128}$')
     or (v_currency is not null and v_currency !~ '^[A-Z]{3}$')
     or (p_event ? 'paid_agorot' and jsonb_typeof(p_event -> 'paid_agorot') not in ('number', 'null'))
     or (p_event ? 'installments' and jsonb_typeof(p_event -> 'installments') not in ('number', 'null')) then
    return jsonb_build_object('status', 'invalid');
  end if;
  begin
    v_paid := (p_event ->> 'paid_agorot')::bigint;
    v_installments := (p_event ->> 'installments')::integer;
  exception when others then
    return jsonb_build_object('status', 'invalid');
  end;
  if (v_paid is not null and v_paid not between 1 and 1000000000000) or (v_installments is not null and v_installments not between 1 and 36) then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- review 1, 5: a paid event names what was paid, in which currency, and the provider's payment
  if v_status = 'paid' and (v_paid is null or v_currency is null or v_payment_ref is null) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if not app.payment_link_provider_usable(p_provider) then
    return jsonb_build_object('status', 'ignored');
  end if;

  -- 3,000 events a minute in total, one row per minute of the hour (reused)
  insert into app.payment_webhook_minutes as m (slot, minute, hits)
  values (extract(minute from v_minute)::smallint, v_minute, 1)
  on conflict (slot) do update
     set hits = case when m.minute = excluded.minute then m.hits + 1 else 1 end, minute = excluded.minute
  returning hits into v_hits;
  if v_hits > app.payment_webhook_limit() then
    return jsonb_build_object('status', 'busy');
  end if;

  -- once per provider event
  insert into app.payment_webhook_events (provider, event_id, status)
  values (p_provider, v_event_id, v_status)
  on conflict (provider, event_id) do nothing
  returning true into v_inserted;
  if not coalesce(v_inserted, false) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  select count(*) into v_count from public.payment_links l where l.provider = p_provider and l.provider_link_id = v_link_ref;
  if v_count <> 1 then
    update app.payment_webhook_events e set outcome = case when v_count = 0 then 'unknown_link' else 'ambiguous_link' end
     where e.provider = p_provider and e.event_id = v_event_id;
    -- review 6: a paid event nobody can take is logged (ids and codes only)
    if v_status = 'paid' then
      insert into app.platform_log (action, details)
      values ('payment_link.webhook_unknown',
              jsonb_build_object('provider', p_provider, 'event_id', v_event_id, 'provider_link_id', v_link_ref,
                                 'outcome', case when v_count = 0 then 'unknown_link' else 'ambiguous_link' end));
    end if;
    return jsonb_build_object('status', 'ignored');
  end if;
  select * into v_link from public.payment_links l where l.provider = p_provider and l.provider_link_id = v_link_ref for update;
  update app.payment_webhook_events e set organization_id = v_link.organization_id, link_id = v_link.id
   where e.provider = p_provider and e.event_id = v_event_id;

  if v_status <> 'paid' then
    -- failed and abandoned links are LNK-05's (not built): kept as an event only
    update app.payment_webhook_events e set outcome = 'not_handled' where e.provider = p_provider and e.event_id = v_event_id;
    return jsonb_build_object('status', 'ignored');
  end if;
  if v_link.status = 'paid' and v_link.provider_payment_id = v_payment_ref then
    update app.payment_webhook_events e set outcome = 'already_paid' where e.provider = p_provider and e.event_id = v_event_id;
    return jsonb_build_object('status', 'duplicate');
  end if;
  if v_link.status <> 'pending' then
    update app.payment_webhook_events e set outcome = 'paid_not_open' where e.provider = p_provider and e.event_id = v_event_id;
    perform app.payment_link_notice(v_link.organization_id, null, 'שולם קישור תשלום שכבר לא היה פתוח',
      'ספק הסליקה דיווח על תשלום בקישור' || coalesce(' "' || left(v_link.title, 120) || '"', '')
      || ', שכבר לא היה פתוח (בוטל, פג תוקף או שולם). התשלום לא נרשם במערכת. בדקו אצל ספק הסליקה, ורשמו את התשלום ידנית או החזירו אותו.');
    return jsonb_build_object('status', 'ignored');
  end if;
  -- review 1: exactly the link's amount, in ILS, within its instalments; anything else is not taken
  if v_currency <> 'ILS' or v_paid <> v_link.amount_agorot or coalesce(v_installments, 1) > v_link.max_installments then
    update app.payment_webhook_events e set outcome = 'amount_mismatch' where e.provider = p_provider and e.event_id = v_event_id;
    perform app.payment_link_notice(v_link.organization_id, null, 'תשלום בקישור לא תאם את הקישור',
      'ספק הסליקה דיווח על תשלום בקישור' || coalesce(' "' || left(v_link.title, 120) || '"', '')
      || ' בסכום, במטבע או במספר תשלומים שלא תואמים את הקישור. התשלום לא נרשם במערכת. בדקו אצל ספק הסליקה, ורשמו את התשלום ידנית או החזירו אותו.');
    return jsonb_build_object('status', 'ignored');
  end if;

  -- the payment, as the server, on the link's source
  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = v_link.organization_id;
  if v_link.quote_id is not null then
    select q.deal_id, q.contact_id into v_deal, v_contact from public.quotes q
     where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
    v_quote := v_link.quote_id;
  elsif v_link.order_id is not null then
    select o.deal_id, o.contact_id into v_deal, v_contact from public.orders o
     where o.organization_id = v_link.organization_id and o.id = v_link.order_id;
    v_order := v_link.order_id;
  elsif v_link.accounting_document_id is not null then
    select d.deal_id, d.contact_id into v_deal, v_contact from public.accounting_documents d
     where d.organization_id = v_link.organization_id and d.id = v_link.accounting_document_id;
  else
    v_contact := v_link.contact_id;
  end if;
  begin
    insert into public.payments
      (organization_id, deal_id, contact_id, amount_agorot, paid_on, method, installments, reference, note, status,
       order_id, is_advance, advance_quote_id)
    values
      (v_link.organization_id, v_deal, v_contact, v_paid, coalesce(v_today, current_date), 'credit',
       coalesce(v_installments, 1), left(v_payment_ref, 100), 'שולם בקישור תשלום', 'confirmed',
       v_order, v_quote is not null, v_quote)
    returning id into v_payment;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    -- a deadlock, a serialization failure or a lock not taken: the provider sends the event again
    if v_state in ('40P01', '40001', '55P03') then
      raise;
    end if;
    v_payment := null;
  end;
  if v_payment is not null and v_link.accounting_document_id is not null then
    v_balance := app.document_balance(v_link.organization_id, v_link.accounting_document_id);
    if coalesce(v_balance, 0) > 0 then
      begin
        insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot)
        values (v_link.organization_id, v_payment, v_link.accounting_document_id, least(v_balance, v_paid));
      exception when others then
        get stacked diagnostics v_state = returned_sqlstate;
        if v_state in ('40P01', '40001', '55P03') then
          raise;
        end if;
      end;
    end if;
  end if;

  v_server := current_setting('app.payment_link_server', true);
  perform set_config('app.payment_link_server', 'on', true);
  update public.payment_links l
     set status = 'paid', payment_id = v_payment, paid_at = now(), provider_payment_id = v_payment_ref
   where l.organization_id = v_link.organization_id and l.id = v_link.id;
  perform set_config('app.payment_link_server', coalesce(v_server, ''), true);
  update app.payment_webhook_events e
     set outcome = case when v_payment is null then 'paid_unrecorded' else 'recorded' end, payment_id = v_payment
   where e.provider = p_provider and e.event_id = v_event_id;
  if v_payment is null then
    perform app.payment_link_notice(v_link.organization_id, null, 'תשלום בקישור לא נרשם',
      'הלקוח שילם בקישור' || coalesce(' "' || left(v_link.title, 120) || '"', '')
      || ', אבל לא הצלחנו לרשום את התשלום (המסמך או הלקוח כבר לא מקושרים). רשמו את התשלום ידנית.');
    return jsonb_build_object('status', 'paid_unrecorded');
  end if;
  -- LNK-04b (owner (422) א): recorded while the business is closed: the owners are told; never fails the webhook
  if not app.org_writable(v_link.organization_id) then
    begin
      perform app.payment_link_owner_notice(v_link.organization_id, 'התקבל תשלום בקישור בזמן שהעסק סגור',
        'הלקוח שילם בקישור' || coalesce(' "' || left(v_link.title, 120) || '"', '')
        || ', והתשלום נרשם במערכת. העסק סגור כרגע (מושעה, מבוטל, לקריאה בלבד או ממתין למחיקה). בדקו את התשלום, ואם צריך החזירו אותו אצל ספק הסליקה.');
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate;
      if v_state in ('40P01', '40001', '55P03') then
        raise;
      end if;
    end;
  end if;
  return jsonb_build_object('status', 'recorded');
end;
$$;
revoke all on function public.payment_link_webhook(text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_link_webhook(text, jsonb) to service_role;
