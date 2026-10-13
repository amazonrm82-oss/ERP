-- =============================================================================
-- 0115 Campaign, UTM and budget are edited on the lead card (LEAD-01)
-- =============================================================================
-- The lead form and the lead card now edit leads.campaign, leads.budget_agorot
-- and the five classic utm_* values kept in leads.utm. Those columns already have
-- the insert/update grant of authenticated (migration 0038); no grant changes.
--
-- leads.utm also holds what only the visit can bring: since CAP-02 (0092, 0098)
-- the extra campaign parameters and ad click ids under utm.extra. Trigger
-- leads_utm_merge (before insert or update of utm, app.merge_lead_utm(),
-- security invoker) enforces:
-- * Every writer: an insert may not carry a top-level "$merge" key (22023).
-- * Every writer: an update may send utm = {"$merge": {key: value | null}}. It is
--   merged into the row as it is now, inside the same statement and row lock (a
--   null removes the key); only the five classic keys utm_source, utm_medium,
--   utm_campaign, utm_term, utm_content may be patched, each a string of at most
--   200 characters or null. utm.extra and any other key stay as they were.
-- * Browser writes (current_user authenticated or anon, as in
--   app.check_custom_fields()): utm must be an object; on insert it may hold only
--   the five classic keys; on an update without "$merge" every key other than
--   the five must stay exactly as it was (utm.extra cannot be added, changed or
--   removed); every classic value must be a string of at most 200 characters
--   (code points) or null. Anything else is refused (22023).
-- * Server writers (intake_submit and merge_records are security definer;
--   service_role) write plain objects as before.
--
-- Click ids, referrer and landing page stay server-only (no grant, 0051).
-- create or replace only; safe to run twice.

create or replace function app.merge_lead_utm() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_classic constant text[] := array['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  v_patch jsonb;
  v_key text;
  v_value jsonb;
  v_remove text[] := '{}';
  v_browser boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if jsonb_typeof(new.utm) = 'object' and new.utm ? '$merge' then
      raise exception 'utm patch is only for updates' using errcode = '22023';
    end if;
  elsif jsonb_typeof(new.utm) = 'object' and new.utm ? '$merge' then
    v_patch := new.utm -> '$merge';
    if jsonb_typeof(v_patch) <> 'object' then
      raise exception 'utm patch must be an object' using errcode = '22023';
    end if;
    for v_key, v_value in select e.key, e.value from jsonb_each(v_patch) e loop
      if v_key <> all (v_classic) then
        raise exception 'utm patch key % is not editable', v_key using errcode = '22023';
      end if;
      if v_value = 'null'::jsonb then
        v_remove := v_remove || v_key;
      elsif jsonb_typeof(v_value) <> 'string' or char_length(v_value #>> '{}') > 200 then
        raise exception 'utm value for % must be text of at most 200 characters', v_key using errcode = '22023';
      end if;
    end loop;
    new.utm := (coalesce(old.utm, '{}'::jsonb) || jsonb_strip_nulls(v_patch)) - v_remove;
    return new;
  end if;

  if v_browser then
    if new.utm is null or jsonb_typeof(new.utm) <> 'object' then
      raise exception 'utm must be an object' using errcode = '22023';
    end if;
    if tg_op = 'INSERT' then
      if (new.utm - v_classic) <> '{}'::jsonb then
        raise exception 'utm may hold only the five utm_* values' using errcode = '22023';
      end if;
    elsif (new.utm - v_classic) is distinct from (coalesce(old.utm, '{}'::jsonb) - v_classic) then
      raise exception 'only the five utm_* values of utm are editable' using errcode = '22023';
    end if;
    foreach v_key in array v_classic loop
      v_value := new.utm -> v_key;
      if v_value is not null and v_value <> 'null'::jsonb
         and (jsonb_typeof(v_value) <> 'string' or char_length(v_value #>> '{}') > 200) then
        raise exception 'utm value for % must be text of at most 200 characters', v_key using errcode = '22023';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function app.merge_lead_utm() from public, anon, authenticated;

create or replace trigger leads_utm_merge before insert or update of utm on public.leads
  for each row execute function app.merge_lead_utm();
