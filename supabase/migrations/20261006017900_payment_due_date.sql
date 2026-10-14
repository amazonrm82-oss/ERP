-- =============================================================================
-- One due-date rule for payment terms (CON-08 follow-up, owner 14 October 2026)
-- =============================================================================
-- DECISIONS.md "תנאי תשלום": the due date of a document is computed in one place,
-- by the Gregorian calendar, without skipping rest days (a due date on a rest day
-- is shown as it is):
--   immediate  the document date (no days)
--   net        the document date + N days
--   eom        the last day of the document's month + N days (שוטף + N; שוטף = שוטף + 0)
-- N is 0..365 and required for net and eom, and must be empty for immediate: the
-- same shape as the constraint *_payment_terms_shape on companies and contacts.
-- Anything else (unknown kind, N out of range, N given for immediate, a null date or
-- kind, a document date or due date outside 0001-01-01..9999-12-31, infinity included)
-- raises 22023 with hint 'payment_terms:invalid'.
--
-- Mirrored by paymentDueDate() in src/features/billing/terms.ts;
-- tests/db/105-payment-due-date.test.ts compares the two day by day.
-- Pure and immutable: no table, no time zone (date arithmetic only; date_trunc is
-- avoided because a date would pick its timestamptz form, which depends on the
-- session time zone). COL-02 and the documents will call it.

create or replace function app.payment_due_date(p_doc_date date, p_terms text, p_days integer)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_first date;
  v_due date;
begin
  -- the TS mirror works on "YYYY-MM-DD" days: years 0001..9999 only (no infinity, no BC)
  if p_doc_date is null or p_doc_date < date '0001-01-01' or p_doc_date > date '9999-12-31'
     or p_terms is null or p_terms not in ('immediate', 'net', 'eom') then
    raise exception 'payment terms are invalid' using errcode = '22023', hint = 'payment_terms:invalid';
  end if;
  if p_terms = 'immediate' then
    if p_days is not null then
      raise exception 'payment terms are invalid' using errcode = '22023', hint = 'payment_terms:invalid';
    end if;
    return p_doc_date;
  end if;
  if p_days is null or p_days < 0 or p_days > 365 then
    raise exception 'payment terms are invalid' using errcode = '22023', hint = 'payment_terms:invalid';
  end if;
  if p_terms = 'net' then
    v_due := p_doc_date + p_days;
  else
    -- eom: the first of the month, one month on, one day back = the month's last day
    v_first := p_doc_date - (extract(day from p_doc_date)::integer - 1);
    v_due := (v_first + interval '1 month')::date - 1 + p_days;
  end if;
  if v_due > date '9999-12-31' then
    raise exception 'payment terms are invalid' using errcode = '22023', hint = 'payment_terms:invalid';
  end if;
  return v_due;
end;
$$;

revoke all on function app.payment_due_date(date, text, integer) from public, anon;
grant execute on function app.payment_due_date(date, text, integer) to authenticated, service_role;
