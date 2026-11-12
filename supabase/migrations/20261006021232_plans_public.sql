-- =============================================================================
-- Public price list of the landing page (LND-13 / WEB-01)
-- =============================================================================
-- Owner, 11 November 2026: the landing page's price list reads ONE anon-callable
-- function that returns only the public fields of the plans that are available or
-- coming soon, cached for an hour like the subprocessors page. It is the second
-- function anon may execute, beside public.health_check (tests/db/01-schema-guards
-- names both; tests/db/344-plans-public.test.ts pins this body, its settings and
-- its grants; a change needs a fresh review).
--
-- What it answers, per plan, ordered by position then key:
--   key, name (the Hebrew display name), price_monthly_agorot, price_annual_agorot
--   (before VAT, per price_unit), price_unit (org | seat), availability
--   (available | coming_soon), position,
--   the three quota lines the plan cards already show (src/features/plans/
--   components/plan-cards.tsx): max_users, max_records, storage_gb (a number,
--   null = no cap, absent = the plan does not say),
--   features: from a CLOSED list only, the capability keys of PLAN_CAPABILITIES
--   (src/features/plans/capabilities.ts) that are built and not core, in that
--   file's order; a key is named only when the plan's flag is true. Any other
--   flag (an internal one, an unbuilt capability, a flag that is off) is never
--   named. tests/unit/plans-public.test.ts compares the array below with
--   capabilities.ts, so flipping `built` (or adding a built capability) there
--   needs a new migration that redefines this function, and a fresh review of the
--   pinned body.
-- Never: a hidden plan, name_en, is_public, any other limit or quota (AI credits,
-- automation runs, PDFs, emails, products and the like), a flag outside the list
-- or off, or anything about a business or a subscription.
--
-- Security definer because anon has no grant on public.plans (test 01: anon reads
-- no table) and gets none here; sql, stable, no argument, search_path ''. Executable
-- by anon and authenticated only.
-- The function itself has NO limit in the database: anyone holding the public anon
-- key can call it as often as they like. That is accepted because it reads about 5
-- rows of one table, takes no input and answers the same public fields to everyone.
-- The landing page reads it through an hour-long cache (unstable_cache, tag
-- plans-public, expired by the platform's plan actions); that cache protects only
-- the page, not the function. Safe to run twice.

create or replace function public.plans_public()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', p.key,
        'name', p.name_he,
        'price_monthly_agorot', p.price_monthly_agorot,
        'price_annual_agorot', p.price_annual_agorot,
        'price_unit', p.price_unit,
        'availability', p.availability,
        'position', p.position,
        'limits', (
          select coalesce(jsonb_object_agg(l.key, l.value), '{}'::jsonb)
            from jsonb_each(case when jsonb_typeof(p.limits) = 'object' then p.limits else '{}'::jsonb end) l
           where l.key in ('max_users', 'max_records', 'storage_gb')
             and jsonb_typeof(l.value) in ('number', 'null')
        ),
        'features', (
          select coalesce(jsonb_agg(c.key order by c.n), '[]'::jsonb)
            from unnest(array[
              -- landing-capabilities: built, non-core keys of PLAN_CAPABILITIES (unit test compares)
              'products', 'discounts', 'quotes', 'documents', 'payments', 'collection', 'balances',
              'booking_page', 'business_card', 'qr_codes', 'site_widget', 'money_waiting', 'instant_reply',
              'goals', 'campaign_costs', 'punch_cards', 'segments', 'auto_reassign', 'lead_distribution',
              'meta_leads', 'meeting_reminders', 'signatures', 'sms', 'orders', 'goals_per_rep',
              'granular_permissions', 'view_seats', 'remove_built_with'
              -- end landing-capabilities
            ]::text[]) with ordinality c(key, n)
           where jsonb_typeof(p.features) = 'object'
             and p.features -> c.key = 'true'::jsonb
        )
      )
      order by p.position, p.key
    ),
    '[]'::jsonb
  )
  from public.plans p
  where p.availability in ('available', 'coming_soon')
$$;

comment on function public.plans_public() is
  'LND-13: the public fields of available and coming-soon plans for the landing page price list; anon may execute it (owner, 11 November 2026).';

-- anon and authenticated only (owner, 11 November 2026); test 01 names it beside health_check
revoke all on function public.plans_public() from public, anon, authenticated, service_role;
grant execute on function public.plans_public() to anon, authenticated;
