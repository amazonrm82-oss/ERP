-- =============================================================================
-- Plan prices, states, limits and flags (owner's pricing of 13 October 2026)
-- =============================================================================
-- Replaces the temporary "everything open, high values" defaults of
-- wave2_plan_keys. Only the plan rows change: no subscription and no override
-- is touched, so businesses in their trial (on 'pro') keep everything as it is.
--
-- - plans.price_unit: 'org' (the price is per business) or 'seat' (per user).
--   Prices are before VAT.
-- - plans.availability: 'hidden' | 'coming_soon' | 'available'. is_public is kept
--   for the old readers and always equals availability = 'available' (trigger
--   plans_sync_public; a write of is_public alone is overruled, so the p_is_public
--   argument of platform_update_plan() is now ignored). Only the platform owner
--   changes it, through platform_set_plan_availability(), logged.
-- - New plan 'personal' (אישית): 79 / 69 per business, at most 2 users.
--   basic 89 / 79, pro 139 / 119 per user; business 219 / 189 per user, coming
--   soon; free stays hidden with its own values (this migration does not touch it).
-- - Every limit and flag is its own key. null = no cap. A key that contains
--   "_per_user" is per paid seat; the quota code multiplies it by the paid seats
--   and adds the business-wide key of the same quota (src/lib/plan-keys.ts).
-- - platform_update_subscription refuses a plan that is not available (hidden:
--   hint plan:hidden; coming soon: plan:not_available), except the current one.
-- - app.plan_key_defaults(): a plan without one of the wave 2 keys (a plan added
--   later in the admin panel) now gets the most restrictive value: the flag off,
--   the quota 0. Older keys keep their old meaning when missing.
--
-- The seed below is mirrored by PLAN_VALUES and the defaults by PLAN_KEY_FALLBACK in
-- src/lib/plan-keys.ts (tests/unit/plan-keys.test.ts compares). Every statement is
-- safe to run twice; a second run changes no row.

alter table public.plans add column if not exists price_unit text not null default 'seat';
alter table public.plans add column if not exists availability text not null default 'available';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plans_price_unit_check' and conrelid = 'public.plans'::regclass) then
    alter table public.plans add constraint plans_price_unit_check check (price_unit in ('org', 'seat'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plans_availability_check' and conrelid = 'public.plans'::regclass) then
    alter table public.plans add constraint plans_availability_check check (availability in ('hidden', 'coming_soon', 'available'));
  end if;
end;
$$;

-- a plan already hidden from customers (free) starts hidden
update public.plans set availability = 'hidden' where not is_public and availability = 'available';

create or replace function app.plans_sync_public() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.is_public := new.availability = 'available';
  return new;
end;
$$;
revoke all on function app.plans_sync_public() from public, anon, authenticated;

create or replace trigger plans_sync_public before insert or update on public.plans
  for each row execute function app.plans_sync_public();

insert into public.plans (key, name_he, name_en, price_monthly_agorot, price_annual_agorot, position, price_unit, availability)
values ('personal', 'אישית', 'Personal', 7900, 6900, 1, 'org', 'available')
on conflict (key) do nothing;

-- prices, state, position, limits and flags of the four sold plans (the plan's
-- other keys stay; these overwrite, as the owner decided)
with seed as (
  select e.key, e.value as v
    from jsonb_each($seed$
{
  "personal": {
    "price_monthly_agorot": 7900,
    "price_annual_agorot": 6900,
    "price_unit": "org",
    "availability": "available",
    "position": 1,
    "limits": {
      "max_users": 2,
      "max_records": 10000,
      "max_pipelines": 1,
      "max_custom_fields_per_object": 20,
      "max_active_automations": 5,
      "max_automation_runs_per_month": 1000,
      "max_forms": 2,
      "storage_gb": 2,
      "audit_log_days": 30,
      "ai_credits_per_month": 100,
      "ai_credits_per_user_per_month": 0,
      "max_pdf_per_month": 200,
      "max_customer_emails_per_month": 1000,
      "max_customer_emails_per_day": 100,
      "max_products": 100,
      "max_booking_pages": 2,
      "max_booking_pages_per_user": 0,
      "max_teams": 0,
      "max_whatsapp_numbers": 1,
      "view_seats_per_paid_seat": 0,
      "max_custom_reports": 0,
      "max_custom_objects": 0,
      "max_price_lists": 100000,
      "max_quote_templates": 100000,
      "max_segments": 100000,
      "max_qr_codes": 100000
    },
    "features": {
      "quotes": true,
      "payment_links": true,
      "balances": true,
      "booking_page": true,
      "money_waiting": true,
      "instant_reply": true,
      "email_sync": true,
      "whatsapp_inbox": true,
      "goals": true,
      "auto_reassign": false,
      "orders": false,
      "api": false,
      "custom_reports": false,
      "dashboards": false,
      "goals_per_rep": false,
      "custom_roles": false,
      "view_seats": false,
      "telephony": false,
      "custom_objects": false,
      "remove_built_with": false,
      "booking_team_pages": false,
      "field_permissions": false,
      "sso": false,
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "granular_permissions": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true
    }
  },
  "basic": {
    "price_monthly_agorot": 8900,
    "price_annual_agorot": 7900,
    "price_unit": "seat",
    "availability": "available",
    "position": 2,
    "limits": {
      "max_users": null,
      "max_records": 25000,
      "max_pipelines": 3,
      "max_custom_fields_per_object": 50,
      "max_active_automations": 20,
      "max_automation_runs_per_month": 5000,
      "max_forms": 5,
      "storage_gb": 10,
      "audit_log_days": 30,
      "ai_credits_per_month": 0,
      "ai_credits_per_user_per_month": 300,
      "max_pdf_per_month": 1000,
      "max_customer_emails_per_month": 2000,
      "max_customer_emails_per_day": 200,
      "max_products": 500,
      "max_booking_pages": 0,
      "max_booking_pages_per_user": 1,
      "max_teams": 2,
      "max_whatsapp_numbers": 1,
      "view_seats_per_paid_seat": 0,
      "max_custom_reports": 10,
      "max_custom_objects": 0,
      "max_price_lists": 100000,
      "max_quote_templates": 100000,
      "max_segments": 100000,
      "max_qr_codes": 100000
    },
    "features": {
      "quotes": true,
      "payment_links": true,
      "balances": true,
      "booking_page": true,
      "money_waiting": true,
      "instant_reply": true,
      "email_sync": true,
      "whatsapp_inbox": true,
      "goals": true,
      "auto_reassign": true,
      "orders": true,
      "api": true,
      "custom_reports": true,
      "dashboards": false,
      "goals_per_rep": false,
      "custom_roles": false,
      "view_seats": false,
      "telephony": false,
      "custom_objects": false,
      "remove_built_with": false,
      "booking_team_pages": false,
      "field_permissions": false,
      "sso": false,
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "granular_permissions": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true
    }
  },
  "pro": {
    "price_monthly_agorot": 13900,
    "price_annual_agorot": 11900,
    "price_unit": "seat",
    "availability": "available",
    "position": 3,
    "limits": {
      "max_users": null,
      "max_records": 250000,
      "max_pipelines": 15,
      "max_custom_fields_per_object": 200,
      "max_active_automations": 100,
      "max_automation_runs_per_month": 50000,
      "max_forms": null,
      "storage_gb": 50,
      "audit_log_days": 365,
      "ai_credits_per_month": 0,
      "ai_credits_per_user_per_month": 1000,
      "max_pdf_per_month": 3000,
      "max_customer_emails_per_month": 5000,
      "max_customer_emails_per_day": 500,
      "max_products": 5000,
      "max_booking_pages": 0,
      "max_booking_pages_per_user": 5,
      "max_teams": null,
      "max_whatsapp_numbers": 3,
      "view_seats_per_paid_seat": 1,
      "max_custom_reports": 50,
      "max_custom_objects": 3,
      "max_price_lists": 100000,
      "max_quote_templates": 100000,
      "max_segments": 100000,
      "max_qr_codes": 100000
    },
    "features": {
      "quotes": true,
      "payment_links": true,
      "balances": true,
      "booking_page": true,
      "money_waiting": true,
      "instant_reply": true,
      "email_sync": true,
      "whatsapp_inbox": true,
      "goals": true,
      "auto_reassign": true,
      "orders": true,
      "api": true,
      "custom_reports": true,
      "dashboards": true,
      "goals_per_rep": true,
      "custom_roles": true,
      "view_seats": true,
      "telephony": true,
      "custom_objects": true,
      "remove_built_with": true,
      "booking_team_pages": true,
      "field_permissions": false,
      "sso": false,
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "granular_permissions": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true
    }
  },
  "business": {
    "price_monthly_agorot": 21900,
    "price_annual_agorot": 18900,
    "price_unit": "seat",
    "availability": "coming_soon",
    "position": 4,
    "limits": {
      "max_users": null,
      "max_records": 1000000,
      "max_pipelines": null,
      "max_custom_fields_per_object": 500,
      "max_active_automations": 300,
      "max_automation_runs_per_month": 250000,
      "max_forms": null,
      "storage_gb": 200,
      "audit_log_days": 730,
      "ai_credits_per_month": 0,
      "ai_credits_per_user_per_month": 3000,
      "max_pdf_per_month": 10000,
      "max_customer_emails_per_month": 15000,
      "max_customer_emails_per_day": 1500,
      "max_products": 50000,
      "max_booking_pages": 0,
      "max_booking_pages_per_user": 5,
      "max_teams": null,
      "max_whatsapp_numbers": 10,
      "view_seats_per_paid_seat": 1,
      "max_custom_reports": null,
      "max_custom_objects": 20,
      "max_price_lists": 100000,
      "max_quote_templates": 100000,
      "max_segments": 100000,
      "max_qr_codes": 100000
    },
    "features": {
      "quotes": true,
      "payment_links": true,
      "balances": true,
      "booking_page": true,
      "money_waiting": true,
      "instant_reply": true,
      "email_sync": true,
      "whatsapp_inbox": true,
      "goals": true,
      "auto_reassign": true,
      "orders": true,
      "api": true,
      "custom_reports": true,
      "dashboards": true,
      "goals_per_rep": true,
      "custom_roles": true,
      "view_seats": true,
      "telephony": true,
      "custom_objects": true,
      "remove_built_with": true,
      "booking_team_pages": true,
      "field_permissions": true,
      "sso": true,
      "products": true,
      "price_lists": true,
      "discounts": true,
      "documents": true,
      "payments": true,
      "collection": true,
      "consents": true,
      "segments": true,
      "granular_permissions": true,
      "business_card": true,
      "qr_codes": true,
      "site_widget": true,
      "retention": true
    }
  }
}
$seed$::jsonb) e
)
update public.plans p
   set price_monthly_agorot = (s.v ->> 'price_monthly_agorot')::integer,
       price_annual_agorot = (s.v ->> 'price_annual_agorot')::integer,
       price_unit = s.v ->> 'price_unit',
       availability = s.v ->> 'availability',
       position = (s.v ->> 'position')::integer,
       limits = p.limits || (s.v -> 'limits'),
       features = p.features || (s.v -> 'features')
  from seed s
 where p.key = s.key
   and (p.price_monthly_agorot, p.price_annual_agorot, p.price_unit, p.availability, p.position, p.limits, p.features)
       is distinct from
       ((s.v ->> 'price_monthly_agorot')::integer, (s.v ->> 'price_annual_agorot')::integer, s.v ->> 'price_unit',
        s.v ->> 'availability', (s.v ->> 'position')::integer, p.limits || (s.v -> 'limits'), p.features || (s.v -> 'features'));

-- the value of a wave 2 key that a plan does not hold: the most restrictive
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
    "booking_team_pages": false
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
    "view_seats_per_paid_seat": 0
  }
}
$json$::jsonb
$$;
revoke all on function app.plan_key_defaults() from public, anon, authenticated;

-- platform_update_subscription: the body of hide_free_plan, now by availability
create or replace function public.platform_update_subscription(
  p_org uuid, p_plan_key text, p_seats integer, p_trial_ends_at timestamptz, p_reason text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_availability text;
begin
  perform app.require_platform(array['finance']);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.plans p where p.key = p_plan_key) then
    raise exception 'unknown plan' using errcode = '22023';
  end if;
  select jsonb_build_object('plan_key', s.plan_key, 'seats', s.seats, 'trial_ends_at', s.trial_ends_at)
    into v_old from public.subscriptions s where s.organization_id = p_org;
  if v_old is null then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  -- only an available plan can be chosen; a business already on another may keep it
  if p_plan_key is distinct from (v_old ->> 'plan_key') then
    select p.availability into v_availability from public.plans p where p.key = p_plan_key;
    if v_availability = 'hidden' then
      raise exception 'this plan is no longer offered' using errcode = 'P0001', hint = 'plan:hidden';
    elsif v_availability is distinct from 'available' then
      raise exception 'this plan is not available yet' using errcode = 'P0001', hint = 'plan:not_available';
    end if;
  end if;
  update public.subscriptions
     set plan_key = p_plan_key, seats = p_seats, trial_ends_at = p_trial_ends_at, updated_at = now()
   where organization_id = p_org;
  perform app.log_platform('subscription.update', p_org, jsonb_build_object(
    'old', v_old, 'new', jsonb_build_object('plan_key', p_plan_key, 'seats', p_seats, 'trial_ends_at', p_trial_ends_at),
    'reason', left(p_reason, 500)));
end;
$$;

-- the platform owner moves a plan between hidden, coming soon and available
create or replace function public.platform_set_plan_availability(p_key text, p_availability text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old text;
begin
  perform app.require_platform(array[]::text[]);
  if p_availability is null or p_availability not in ('hidden', 'coming_soon', 'available') then
    raise exception 'invalid availability' using errcode = '22023';
  end if;
  select p.availability into v_old from public.plans p where p.key = p_key;
  if v_old is null then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
  if v_old = p_availability then
    return;
  end if;
  update public.plans set availability = p_availability where key = p_key;
  perform app.log_platform('plan.availability', null, jsonb_build_object('key', p_key, 'old', v_old, 'new', p_availability));
end;
$$;
revoke all on function public.platform_set_plan_availability(text, text) from public, anon;
grant execute on function public.platform_set_plan_availability(text, text) to authenticated;
