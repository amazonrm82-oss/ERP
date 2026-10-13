-- SPD-06, owner's decision of 13 October 2026: the response target is 60
-- minutes by default, until every organization can set a target of its own.
--
-- app.response_target_minutes(org) is the one place the target comes from
-- (report_response_time and report_response_breakdown read it, migration
-- 20261006011400). Only the value changes, from 15 to 60; language, search
-- path, grants and revokes are the same as before.
--
-- When CAP-10 (wave 2) adds a per-organization setting, 60 is its initial
-- value and the business can change it; this function then reads that setting.
-- Time is still wall-clock time, nights and days of rest included, until
-- business hours (CAP-09) come in wave 2.

create or replace function app.response_target_minutes(p_org uuid) returns integer
language sql stable
set search_path = ''
as $$
  select 60;
$$;

revoke all on function app.response_target_minutes(uuid) from public, anon;
grant execute on function app.response_target_minutes(uuid) to authenticated, service_role;
