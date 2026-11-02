-- =============================================================================
-- QUO-09 signed PDF, the owner's answer (38) ב of 2 November 2026 (DECISIONS.md "ה-PDF החתום של הצעה"): the signed PDF prints
-- the customer's billing address, email and tax id, like the PDF as sent
-- =============================================================================
-- The staff path already reads them with the person's session (src/features/quotes/design-server.ts, getQuoteDocumentData:
-- CON-08's effectiveBilling, the contact's own value else its company's; a company quote, the company's own). The customer's
-- route has no session: public.quote_signed_pdf_public answered quote_public's data, which has no billing details. This
-- migration adds a `billing` block to that answer, read inside the definer for THIS quote's customer only:
-- * app.quote_customer_billing(quote) (no grants): exactly three fields, {address, email, tax_id}, by the as-sent PDF's rule:
--   a quote with a contact: the contact (not in the bin) and, per field, its company (not in the bin) when the contact's own
--   value is null (tax_id: contacts.billing_tax_id, else companies.tax_id); else a quote with a company: that company (not in
--   the bin) with billing_address, billing_email and tax_id; else all three null. The customer's NAME stays as printed on the
--   quote when it was sent (quotes.customer_name, already in the page's answer).
-- * public.quote_signed_pdf_public: the body of 021122 with `billing` added to the final answer only (the done, unavailable and
--   rate_limited answers are unchanged). service_role only, as before.
-- This widens what the service-role path returns only into the PDF the customer receives: their own details, which the PDF as
-- sent already holds. Hard rule 5's QUO-09 conditions are unchanged. Every statement is safe to run twice; no drop, no row
-- removal.
-- =============================================================================

create or replace function app.quote_customer_billing(p_quote public.quotes) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_contact public.contacts;
  v_company public.companies;
begin
  if p_quote.contact_id is not null then
    select * into v_contact from public.contacts c
     where c.organization_id = p_quote.organization_id and c.id = p_quote.contact_id and c.deleted_at is null;
    if not found then
      return jsonb_build_object('address', null, 'email', null, 'tax_id', null);
    end if;
    if v_contact.company_id is not null then
      select * into v_company from public.companies co
       where co.organization_id = p_quote.organization_id and co.id = v_contact.company_id and co.deleted_at is null;
    end if;
    return jsonb_build_object(
      'address', coalesce(v_contact.billing_address, v_company.billing_address),
      'email', coalesce(v_contact.billing_email, v_company.billing_email),
      'tax_id', coalesce(v_contact.billing_tax_id, v_company.tax_id));
  end if;
  if p_quote.company_id is not null then
    select * into v_company from public.companies co
     where co.organization_id = p_quote.organization_id and co.id = p_quote.company_id and co.deleted_at is null;
    if found then
      return jsonb_build_object('address', v_company.billing_address, 'email', v_company.billing_email, 'tax_id', v_company.tax_id);
    end if;
  end if;
  return jsonb_build_object('address', null, 'email', null, 'tax_id', null);
end;
$$;
revoke all on function app.quote_customer_billing(public.quotes) from public, anon, authenticated, service_role;

-- 021122's body; the final answer also carries `billing`
create or replace function public.quote_signed_pdf_public(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_quote public.quotes := app.quote_signed_pdf_token_quote(p_token);
  v_block jsonb;
  v_page  jsonb;
begin
  if v_quote.status <> 'accepted' then
    return jsonb_build_object('unavailable', true);
  end if;
  v_block := app.quote_signature_block(v_quote);
  if v_block is null then
    return jsonb_build_object('unavailable', true);
  end if;
  if app.quote_signed_pdf_done(v_quote) then
    return jsonb_build_object('done', true);
  end if;
  -- the document as the customer's page shows it; this read is not a view of the customer's
  perform set_config('app.quote_view_quiet', v_quote.id::text, true);
  v_page := public.quote_public(p_token);
  perform set_config('app.quote_view_quiet', '', true);
  if v_page ? 'rate_limited' then
    return jsonb_build_object('rate_limited', true);
  end if;
  if not (v_page ? 'quote') or v_page #>> '{quote,status}' is distinct from 'accepted' then
    return jsonb_build_object('unavailable', true);
  end if;
  -- owner (38) ב: the customer's own billing details, as the PDF as sent prints them
  return v_page || jsonb_build_object('signature', v_block, 'billing', app.quote_customer_billing(v_quote));
end;
$$;
revoke all on function public.quote_signed_pdf_public(text) from public, anon, authenticated;
grant execute on function public.quote_signed_pdf_public(text) to service_role;
