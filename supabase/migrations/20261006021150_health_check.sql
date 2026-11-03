-- =============================================================================
-- Health check for external uptime monitoring (OPS-05, part)
-- =============================================================================
-- Owner's answer (72) ב, 3 November 2026: the route GET /api/health checks that the
-- site and the database answer, WITHOUT the service-role key: it calls this
-- function with the anon key and no session. The function answers the constant
-- true and nothing else: no table, no setting, no argument, nothing per visitor,
-- nothing about any business. Numbers (cron runs, queue sizes) belong to the
-- platform screen later, never here.
--
-- It is the ONE function anon may execute (tests/db/01-schema-guards.test.ts names
-- it; tests/db/289-health-check.test.ts pins its body, settings and grants).
-- Invoker, sql, stable, search_path pinned to ''. Safe to run twice.

create or replace function public.health_check()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select true
$$;

comment on function public.health_check() is
  'OPS-05: answers true and reads nothing; the uptime route /api/health calls it with the anon key (owner (72) ב).';

-- The only function in public or app that anon may execute (owner (72) ב, 3 November 2026); test 01 names it.
revoke all on function public.health_check() from public;
grant execute on function public.health_check() to anon, authenticated;
