-- =============================================================================
-- 021249 The free plan: quotes with a monthly cap, money waiting read-only
-- =============================================================================
-- Owner, 12 November 2026, answers (330) א and (331) א (the free plan, plans.key = 'free', hidden today):
-- * (331) א: 3 quotes a month in the free plan. A new quota key `max_quotes_per_month`: the quotes a business SENDS in a
--   calendar month of its own time zone (app.automation_run_month). Counted when a quote leaves draft (public.quote_send
--   numbers it), by the AFTER trigger quotes_month_quota (app.quotes_month_take, definer, no grants), so every path that
--   sends a quote is counted and a draft never is: a duplicate (quote_duplicate), an addendum or an automation's
--   create_quote counts only when it is sent; a new version never does (336) ב, below. The counter row of the business and month
--   (app.quote_months, RLS on, no grants) is taken FOR UPDATE first, so parallel sends never pass the cap; at the cap the
--   send is refused, P0001 hint limit:max_quotes_per_month, and the whole send rolls back (the running number too, since
--   app.next_document_number is gap-free on rollback). A refused send counts nothing. Nothing is ever given back (a sent
--   quote stays sent). The sold plans hold the key as null (no cap; the owner's pricing has none); the free plan 3; a plan
--   that does not hold it (one added in the panel) falls back to 0, the wave 2 rule (app.plan_key_defaults). The free
--   plan's `quotes` flag is turned on. public.org_plan_usage (020735's body) lists max_quotes_per_month while the plan
--   has quotes and a cap (an unlimited plan shows no row), used = this month's sent quotes (app.quotes_sent_this_month).
-- * (330) א: "כסף שמחכה" read-only in the free plan. A new flag `money_waiting_actions`: on in every sold plan, off in
--   the free plan (and, by the fallback, in a plan that does not hold it). The free plan keeps `money_waiting` on, so it
--   sees the report's numbers and lists; without `money_waiting_actions` the screen offers no row action (task, hand to
--   a rep, WhatsApp). The screen has no server action of its own: its buttons open the ordinary record actions (a task,
--   the owner change of a list cell, the WhatsApp log), which every plan keeps on the record pages, so nothing in the
--   database is refused by this flag; the screen only stops offering them.
-- * app.plan_key_defaults (021237's body) plus "money_waiting_actions": false and "max_quotes_per_month": 0.
-- * (336) ב: a new VERSION of a sent quote (previous_id set) is not counted: only a quote that starts a new chain
--   (previous_id null) counts when it is sent. An addendum (addendum_of set, previous_id null) is a new quote and counts
--   (lead's choice); a version of an addendum does not.
-- * (335) ב, then (337) א: a quote's PDF (as sent, signed, or made again) is never counted in max_pdf_per_month and never
--   refused by it, in EVERY plan: app.files_quote_pdf (021187's body) no longer calls app.pdf_take (its 30-a-minute rate
--   goes with it; a quote's PDF is made once per sent quote and remakes are claimed one at a time), and
--   app.files_quote_pdf_return (021187's body) gives nothing back (the recipient-erasure credit still comes back). The
--   legacy remake (021015) never counted. app.pdf_months now counts report and order PDFs only; its 80% notice (in
--   app.pdf_take) follows. The free plan's max_pdf_per_month becomes 0, so report and order PDFs stay refused there; the app
--   shows "זמין מחבילת אישית" on those buttons while the quota is zero.
-- public.plans_public is not redefined: no capability of PLAN_CAPABILITIES changes and its three limits are unchanged.
--
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The plan keys
-- ----------------------------------------------------------------------------
with delta as (
  select e.key, e.value as v
    from jsonb_each($delta$
{
  "personal": { "limits": { "max_quotes_per_month": null }, "features": { "money_waiting_actions": true } },
  "basic": { "limits": { "max_quotes_per_month": null }, "features": { "money_waiting_actions": true } },
  "pro": { "limits": { "max_quotes_per_month": null }, "features": { "money_waiting_actions": true } },
  "business": { "limits": { "max_quotes_per_month": null }, "features": { "money_waiting_actions": true } }
}
$delta$::jsonb) e
)
update public.plans p
   set limits = p.limits || (d.v -> 'limits'),
       features = p.features || (d.v -> 'features')
  from delta d
 where p.key = d.key
   and (p.limits, p.features) is distinct from (p.limits || (d.v -> 'limits'), p.features || (d.v -> 'features'));

-- the free plan (hidden): 3 quotes a month, quotes on, money waiting to read only
update public.plans p
   set limits = coalesce(p.limits, '{}'::jsonb) || '{"max_quotes_per_month": 3, "max_pdf_per_month": 0}'::jsonb,
       features = coalesce(p.features, '{}'::jsonb) || '{"quotes": true, "money_waiting": true, "money_waiting_actions": false}'::jsonb
 where p.key = 'free'
   and (p.limits, p.features) is distinct from (
         coalesce(p.limits, '{}'::jsonb) || '{"max_quotes_per_month": 3, "max_pdf_per_month": 0}'::jsonb,
         coalesce(p.features, '{}'::jsonb) || '{"quotes": true, "money_waiting": true, "money_waiting_actions": false}'::jsonb);

-- 021237's fallback with the two keys (a plan that does not hold them: no actions, no quotes)
create or replace function app.plan_key_defaults() returns jsonb
language sql immutable
set search_path = ''
as $$
  select $json$
{
  "features": {
    "products": false,
    "price_lists": false,
    "discounts": false,
    "quotes": false,
    "orders": false,
    "documents": false,
    "payments": false,
    "balances": false,
    "collection": false,
    "money_waiting": false,
    "consents": false,
    "segments": false,
    "goals": false,
    "granular_permissions": false,
    "booking_page": false,
    "business_card": false,
    "qr_codes": false,
    "site_widget": false,
    "retention": false,
    "remove_built_with": false,
    "payment_links": false,
    "instant_reply": false,
    "auto_reassign": false,
    "dashboards": false,
    "goals_per_rep": false,
    "booking_team_pages": false,
    "lead_distribution": false,
    "campaign_costs": false,
    "punch_cards": false,
    "meta_leads": false,
    "meeting_reminders": false,
    "signatures": false,
    "sms": false,
    "review_requests": false,
    "public_page": false,
    "money_waiting_actions": false
  },
  "limits": {
    "max_products": 0,
    "max_price_lists": 0,
    "max_quote_templates": 0,
    "max_booking_pages": 0,
    "max_booking_pages_per_user": 0,
    "max_segments": 0,
    "max_qr_codes": 0,
    "max_pdf_per_month": 0,
    "max_customer_emails_per_month": 0,
    "max_customer_emails_per_day": 0,
    "max_custom_reports": 0,
    "max_custom_objects": 0,
    "max_teams": 0,
    "max_whatsapp_numbers": 0,
    "view_seats_per_paid_seat": 0,
    "max_site_widgets": 0,
    "max_business_cards_per_user": 0,
    "max_booking_team_pages": 0,
    "ai_credits_per_month": 0,
    "ai_credits_per_user_per_month": 0,
    "max_signatures_per_month": 0,
    "max_sms_per_month": 0,
    "max_quotes_per_month": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The quote quota: one counter row per business and month (its own time zone), no grants
-- ----------------------------------------------------------------------------
create table if not exists app.quote_months (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  month           date not null,
  sent            integer not null default 0 check (sent >= 0),
  primary key (organization_id, month)
);
alter table app.quote_months enable row level security;
revoke all on app.quote_months from public, anon, authenticated, service_role;

-- this month's sent quotes of a business (0 when none)
create or replace function app.quotes_sent_this_month(p_org uuid) returns integer
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select m.sent from app.quote_months m
                    where m.organization_id = p_org and m.month = app.automation_run_month(p_org)), 0)
$$;
revoke all on function app.quotes_sent_this_month(uuid) from public, anon, authenticated, service_role;

-- counts one sent quote, or refuses at the cap (the month row locked first, so parallel sends never pass it)
create or replace function app.quotes_month_take(p_org uuid) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_month date := app.automation_run_month(p_org);
  v_limit numeric := app.org_limit(p_org, 'max_quotes_per_month');
  v_used  integer;
begin
  insert into app.quote_months (organization_id, month) values (p_org, v_month) on conflict (organization_id, month) do nothing;
  select m.sent into v_used from app.quote_months m where m.organization_id = p_org and m.month = v_month for update;
  if v_limit is not null and v_used >= v_limit then
    raise exception 'monthly quote limit reached (%)', v_limit using errcode = 'P0001', hint = 'limit:max_quotes_per_month';
  end if;
  update app.quote_months m set sent = m.sent + 1
   where m.organization_id = p_org and m.month = v_month
  returning m.sent into v_used;
  return v_used;
end;
$$;
revoke all on function app.quotes_month_take(uuid) from public, anon, authenticated, service_role;

-- a quote that leaves draft (quote_send) is counted, whatever the path; after every BEFORE trigger accepted the change
create or replace function app.quotes_month_quota() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform app.quotes_month_take(new.organization_id);
  return null;
end;
$$;
revoke all on function app.quotes_month_quota() from public, anon, authenticated, service_role;

-- (336) ב: a new version of a sent quote (previous_id set) is not counted; a quote that starts a chain is
create or replace trigger quotes_month_quota
  after update of status on public.quotes
  for each row when (old.status = 'draft' and new.status is distinct from 'draft' and new.previous_id is null)
  execute function app.quotes_month_quota();

-- ----------------------------------------------------------------------------
-- (335) ב, (337) א: a quote's PDF is outside max_pdf_per_month in every plan
-- ----------------------------------------------------------------------------
create or replace function app.files_quote_pdf() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
  v_sent  public.files;
begin
  if new.quote_id is null then
    return new;
  end if;
  select * into v_quote from public.quotes q where q.organization_id = new.organization_id and q.id = new.quote_id;
  if auth.uid() is not null
     and not (found and app.can_write(new.organization_id) and app.org_writable(new.organization_id)
              and v_quote.status in ('sent', 'viewed')
              and app.quote_editable(v_quote.organization_id, v_quote.deal_id, v_quote.contact_id)) then
    return new;
  end if;
  if v_quote.id is null or v_quote.status = 'draft' then
    raise exception 'a draft quote has no PDF' using errcode = 'P0001', hint = 'quote_pdf:draft';
  end if;
  if coalesce(new.quote_signed, false) then
    -- QUO-09 (answer (33) ב): the signed PDF of an accepted quote whose acceptance was not erased
    if v_quote.status <> 'accepted' or v_quote.customer_deleted_at is not null
       or not exists (select 1 from public.quote_decisions d
                       where d.organization_id = v_quote.organization_id and d.quote_id = v_quote.id
                         and d.decision = 'accepted' and d.erased_at is null) then
      raise exception 'a signed PDF is made for an accepted quote' using errcode = 'P0001', hint = 'quote_pdf:not_accepted';
    end if;
    -- it follows the quote's as-sent file when there is one (else it is the first file)
    select * into v_sent from public.files f
     where f.organization_id = new.organization_id and f.quote_id = new.quote_id and f.quote_signed is null;
    if new.previous_id is distinct from v_sent.id then
      raise exception 'a signed PDF follows the quote''s PDF as sent' using errcode = 'P0001', hint = 'quote_pdf:version';
    end if;
  else
    -- a PDF as sent is never a version, but (021187, owner (172) ב) one made again after a recipient's erasure follows the
    -- quote's signed PDF, which that erasure left as the first file
    if new.previous_id is not null
       and not (app.recipient_pdf_credit_open(new.organization_id, new.quote_id, null)
                and exists (select 1 from public.files f
                             where f.organization_id = new.organization_id and f.id = new.previous_id
                               and f.quote_id = new.quote_id and f.quote_signed)) then
      raise exception 'a quote''s PDF as sent is its first file' using errcode = 'P0001', hint = 'quote_pdf:version';
    end if;
    -- review L3: made later only while the quote is still the open offer that was sent (sent or viewed), so a file made
    -- after an answer, an expiry or a cancel is never taken for the version that was sent; 021187: except the remake after a
    -- service recipient's erasure (a credit not used yet, the customer not erased)
    if v_quote.status not in ('sent', 'viewed')
       and not (v_quote.customer_deleted_at is null and app.recipient_pdf_credit_open(new.organization_id, new.quote_id, null)) then
      raise exception 'a quote''s PDF is made while it is sent or viewed' using errcode = 'P0001', hint = 'quote_pdf:closed';
    end if;
  end if;
  if not app.org_has_feature(new.organization_id, 'quotes') then
    raise exception 'quotes are not in the plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  -- 021187 (owner (167) ב): the PDF as sent made again after a service recipient's erasure uses its credit (so the closed
  -- quote's remake is allowed once)
  if not coalesce(new.quote_signed, false) then
    perform app.recipient_pdf_credit_use(new.organization_id, new.quote_id, null, new.id);
  end if;
  -- 021249 (owner (337) א): a quote's PDF (as sent, signed, or made again) is never counted in max_pdf_per_month and never
  -- refused by it, in every plan; app.pdf_take is not called
  return new;
end;
$$;
revoke all on function app.files_quote_pdf() from public, anon, authenticated;

create or replace function app.files_quote_pdf_return() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.quote_id is not null and old.unconfirmed_since is not null then
    -- an unused credit comes back; 021249 (owner (337) א): a quote's PDF was never counted, so nothing is given back
    perform app.recipient_pdf_credit_return(old.organization_id, old.id);
  end if;
  return old;
end;
$$;
revoke all on function app.files_quote_pdf_return() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Plan and usage: 020735's body, plus this month's sent quotes while the plan caps them
-- ----------------------------------------------------------------------------
create or replace function public.org_plan_usage(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not app.is_member(p_org) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'plan_key', s.plan_key,
    'plan_name', p.name_he,
    'status', s.status,
    'trial_ends_at', s.trial_ends_at,
    'seats', s.seats,
    'usage', jsonb_build_array(
      jsonb_build_object('key', 'max_users', 'limit', app.org_limit(p_org, 'max_users'),
        'used', (select count(*) from public.memberships m
                  where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'full')),
      jsonb_build_object('key', 'max_records', 'limit', app.org_limit(p_org, 'max_records'),
        'used', coalesce((select u.records_count from public.org_usage u where u.organization_id = p_org), 0)),
      jsonb_build_object('key', 'max_pipelines', 'limit', app.org_limit(p_org, 'max_pipelines'),
        'used', (select count(*) from public.pipelines pl where pl.organization_id = p_org and pl.deleted_at is null)),
      jsonb_build_object('key', 'max_forms', 'limit', app.org_limit(p_org, 'max_forms'),
        'used', (select count(*) from public.forms f where f.organization_id = p_org and f.kind = 'form')),
      jsonb_build_object('key', 'max_active_automations', 'limit', app.org_limit(p_org, 'max_active_automations'),
        'used', (select count(*) from public.automations a where a.organization_id = p_org and a.is_active)),
      jsonb_build_object('key', 'storage_gb', 'limit', app.org_limit(p_org, 'storage_gb'),
        'used', round(coalesce((select sum(fl.size_bytes) from public.files fl where fl.organization_id = p_org), 0) / 1073741824.0, 3)),
      jsonb_build_object('key', 'max_products', 'limit', app.org_limit(p_org, 'max_products'),
        'used', (select count(*) from public.products pr where pr.organization_id = p_org)),
      jsonb_build_object('key', 'max_price_lists', 'limit', app.org_limit(p_org, 'max_price_lists'),
        'used', (select count(*) from public.price_lists pli where pli.organization_id = p_org)),
      -- AUT-07: this month's counted automation runs (the month in the business's time zone)
      jsonb_build_object('key', 'max_automation_runs_per_month', 'limit', app.org_limit(p_org, 'max_automation_runs_per_month'),
        'used', app.automation_runs_this_month(p_org))
    )
    -- PRM-02: view seats, while the plan has them (limit = per paid seat x active paid seats; null = no limit)
    || case when app.org_has_feature(p_org, 'view_seats') then jsonb_build_array(
         jsonb_build_object('key', 'view_seats', 'limit', app.view_seat_cap(p_org, null),
           'used', (select count(*) from public.memberships m
                     where m.organization_id = p_org and m.status = 'active' and m.seat_type = 'view')))
       else '[]'::jsonb end
    -- (331) א: this month's sent quotes, while the plan has quotes and caps them (no cap = no row)
    || case when app.org_has_feature(p_org, 'quotes') and app.org_limit(p_org, 'max_quotes_per_month') is not null then jsonb_build_array(
         jsonb_build_object('key', 'max_quotes_per_month', 'limit', app.org_limit(p_org, 'max_quotes_per_month'),
           'used', app.quotes_sent_this_month(p_org)))
       else '[]'::jsonb end
  )
  into v_result
  from public.subscriptions s
  join public.plans p on p.key = s.plan_key
  where s.organization_id = p_org;

  return v_result;
end;
$$;
revoke all on function public.org_plan_usage(uuid) from public, anon;
grant execute on function public.org_plan_usage(uuid) to authenticated;

notify pgrst, 'reload schema';
