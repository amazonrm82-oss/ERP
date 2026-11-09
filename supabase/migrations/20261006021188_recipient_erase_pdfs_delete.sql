-- =============================================================================
-- PKG-06, owner's answer (167) ב: a service recipient's erasure removes the payer's quote PDF as sent and the order's PDF,
-- never the signed quote PDF (pasted by hand in the SQL Editor: it holds a row removal)
-- =============================================================================
-- Gives app.recipient_pdf_drop (a no-op in 20261006021187) its body. Called only by app.punch_cards_erase, for the quotes and
-- orders whose lines named the erased recipient. Trigger files_keep_attached lets this one path through only while the
-- transaction-local settings app.quote_pdf_erase / app.order_pdf_erase name the business, set here around the removal. Safe
-- to run twice. Paste it after 20261006021187 has been applied.

create or replace function app.recipient_pdf_drop(p_org uuid, p_quotes uuid[], p_orders uuid[]) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote text := coalesce(current_setting('app.quote_pdf_erase', true), '');
  v_order text := coalesce(current_setting('app.order_pdf_erase', true), '');
begin
  if p_org is null then
    return;
  end if;
  perform set_config('app.quote_pdf_erase', p_org::text, true);
  perform set_config('app.order_pdf_erase', p_org::text, true);
  delete from public.files f
   where f.organization_id = p_org
     and ((f.quote_id = any (coalesce(p_quotes, '{}')) and f.quote_signed is null)
          or f.order_id = any (coalesce(p_orders, '{}')));
  perform set_config('app.quote_pdf_erase', v_quote, true);
  perform set_config('app.order_pdf_erase', v_order, true);
end;
$$;
revoke all on function app.recipient_pdf_drop(uuid, uuid[], uuid[]) from public, anon, authenticated, service_role;
