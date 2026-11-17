-- =============================================================================
-- Weekly review of 17 November 2026: RVW-109 and RVW-115 (BIZ-05, the prefill link's public functions)
-- =============================================================================
-- RVW-109: app.prefill_link_take answered "done" for a link already sent before its two limits, so a sent link's answer
-- (the business's display fields) was served without any cap until it expired. The "done" verdict is now given after the
-- link's 120 calls and the sender's 60 calls in 10 minutes, counted on the same rows as every other answer; nothing else
-- changes (the same not-found rule for a sent link, the same order of checks for an open one).
-- RVW-115: public.prefill_public_submit judged a birth date against today in Asia/Jerusalem; it now reads today in the
-- business's own zone through app.intake_zone(organizations.timezone), as every other date rule. Its body is otherwise
-- 021265's, unchanged.
-- Safe to run twice (create or replace, the same revokes and grant).

create or replace function app.prefill_link_take(p_token text, p_ip_hash text, out link app.prefill_links, out verdict text)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_bucket integer;
  v_views integer;
  v_done boolean := false;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  select * into link from app.prefill_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if link.id is null then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  -- a link already sent shows only "done" while the business may write and until the link's last day (its record may
  -- since be gone); RVW-109: that answer is counted by both limits below like every other one
  if link.submitted_at is not null then
    if not (link.revoked_at is null and link.expires_at > now()
            and app.org_public_pages_open(link.organization_id) and app.org_writable(link.organization_id)) then
      raise exception 'link not found' using errcode = 'P0002';
    end if;
    v_done := true;
  elsif not app.prefill_link_usable(link) then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  -- 120 calls per link in 10 minutes, counted before the page's data is read
  update app.prefill_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end
   where l.id = link.id
  returning l.window_count into v_count;
  if v_count > 120 then
    verdict := 'rate';
    return;
  end if;
  -- FXS-11: 60 calls per sender in 10 minutes, by the server's keyed IP hash scoped to this link
  if p_ip_hash is not null then
    v_bucket := ((hashtextextended(app.prefill_link_sender(link.id, p_ip_hash), 0) % 1024) + 1024) % 1024;
    insert into app.prefill_link_view_counts as vc (link_id, bucket, window_start, views)
    values (link.id, v_bucket, now(), 1)
    on conflict (link_id, bucket) do update
      set window_start = case when vc.window_start > now() - interval '10 minutes' then vc.window_start else now() end,
          views = case when vc.window_start > now() - interval '10 minutes' then vc.views + 1 else 1 end
    returning vc.views into v_views;
    if v_views > 60 then
      verdict := 'rate';
      return;
    end if;
  end if;
  verdict := case when v_done then 'done' else 'ok' end;
end;
$$;
revoke all on function app.prefill_link_take(text, text) from public, anon, authenticated, service_role;

create or replace function public.prefill_public_submit(p_token text, p_ip_hash text default null, p_values jsonb default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_take record;
  v_link app.prefill_links;
  v_form public.prefill_forms;
  v_type text;
  v_row jsonb;
  v_custom_now jsonb;
  v_fields jsonb;
  v_field jsonb;
  v_key text;
  v_value jsonb;
  v_text text;
  v_def public.field_definitions;
  v_set jsonb := '{}'::jsonb;
  v_custom jsonb := '{}'::jsonb;
  v_changed text[] := '{}';
  v_skipped text[] := '{}';
  v_count integer;
  v_norm text;
  v_date date;
  v_body text;
begin
  v_take := app.prefill_link_take(p_token, p_ip_hash);
  if v_take.verdict = 'rate' then
    return jsonb_build_object('rate_limited', true);
  end if;
  if v_take.verdict = 'done' then
    return jsonb_build_object('status', 'done');
  end if;
  -- one submission per link: the row lock orders two at once; the second sees it sent
  select * into v_link from app.prefill_links l where l.id = (v_take.link).id for update;
  if v_link.submitted_at is not null then
    return jsonb_build_object('status', 'done');
  end if;
  -- judged again on the locked row (turned off or closed between the lookup and the lock)
  if v_link.revoked_at is not null or not app.prefill_link_usable(v_link) then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  -- 10 submissions per link in 10 minutes (an invalid one counts too)
  update app.prefill_links l
     set submit_window_started_at = case when l.submit_window_started_at > now() - interval '10 minutes' then l.submit_window_started_at else now() end,
         submit_count = case when l.submit_window_started_at > now() - interval '10 minutes' then l.submit_count + 1 else 1 end
   where l.id = v_link.id
  returning l.submit_count into v_count;
  if v_count > 10 then
    return jsonb_build_object('rate_limited', true);
  end if;
  -- a wrong answer is answered, not raised, so the try above stays counted (an exception would roll it back)
  begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'the answers are not an object' using errcode = '22023';
  end if;

  select * into v_form from public.prefill_forms f where f.organization_id = v_link.organization_id and f.id = v_link.prefill_form_id;
  v_type := case when v_link.lead_id is not null then 'lead' else 'contact' end;
  -- the record, locked for the write
  if v_link.lead_id is not null then
    select to_jsonb(r) into v_row from public.leads r where r.organization_id = v_link.organization_id and r.id = v_link.lead_id for update;
  else
    select to_jsonb(r) into v_row from public.contacts r where r.organization_id = v_link.organization_id and r.id = v_link.contact_id for update;
  end if;
  v_custom_now := case when jsonb_typeof(v_row -> 'custom_fields') = 'object' then v_row -> 'custom_fields' else '{}'::jsonb end;
  v_fields := app.prefill_link_fields(v_link);

  -- only the fields the page shows; anything else is refused
  for v_key in select k from jsonb_object_keys(p_values) k loop
    if not exists (select 1 from jsonb_array_elements(v_fields) e where e ->> 'key' = v_key) then
      raise exception 'unknown field: %', left(v_key, 60) using errcode = '22023';
    end if;
  end loop;

  for v_field in select e from jsonb_array_elements(v_fields) e loop
    v_key := v_field ->> 'key';
    v_value := p_values -> v_key;
    if v_value is not null and (jsonb_typeof(v_value) = 'null'
                                or (jsonb_typeof(v_value) = 'string' and btrim(v_value #>> '{}') = '')
                                or (jsonb_typeof(v_value) = 'array' and jsonb_array_length(v_value) = 0)) then
      v_value := null;
    end if;
    if v_key like 'cf:%' then
      select * into v_def from public.field_definitions d
       where d.organization_id = v_link.organization_id and d.object_type = v_type and d.key = substr(v_key, 4);
      if v_value is null then
        if v_def.is_required and coalesce(jsonb_typeof(v_field -> 'value'), 'null') = 'null' then
          raise exception 'required field missing: %', v_key using errcode = '22023';
        end if;
        continue;
      end if;
      if v_def.field_type in ('text', 'address') and jsonb_typeof(v_value) = 'string' then
        v_value := to_jsonb(btrim(v_value #>> '{}'));
        if char_length(v_value #>> '{}') > 500 then
          raise exception 'invalid custom field: %', v_def.key using errcode = '22023';
        end if;
      end if;
      if not app.custom_value_ok(v_def.field_type, v_def.options, v_value) then
        raise exception 'invalid custom field: %', v_def.key using errcode = '22023';
      end if;
      continue when (v_custom_now -> v_def.key) is not distinct from v_value;
      -- FLD-07: a read-only value that is filled stays; a unique value another live record holds stays
      if v_def.is_read_only and coalesce(jsonb_typeof(v_field -> 'value'), 'null') <> 'null' then
        v_skipped := v_skipped || v_def.label;
        continue;
      end if;
      if v_def.is_unique then
        v_norm := app.custom_unique_norm(v_def.field_type, v_value);
        if v_norm is not null and exists (select 1 from app.custom_unique_values u
                                           where u.field_id = v_def.id and u.norm_value = v_norm
                                             and u.record_id <> coalesce(v_link.lead_id, v_link.contact_id)) then
          v_skipped := v_skipped || v_def.label;
          continue;
        end if;
      end if;
      v_custom := v_custom || jsonb_build_object(v_def.key, v_value);
      v_changed := v_changed || v_def.label;
    else
      continue when v_value is null;
      if jsonb_typeof(v_value) <> 'string' then
        raise exception 'invalid field: %', v_key using errcode = '22023';
      end if;
      v_text := btrim(v_value #>> '{}');
      -- control, direction and zero-width characters never enter a built-in field (SGN-02's class)
      if v_text ~ '[[:cntrl:]]' or v_text ~ app.document_invisible_class() then
        raise exception 'invalid field: %', v_key using errcode = '22023';
      end if;
      -- the email and phone are filled only when the record holds none; a different typed value is kept as skipped
      if v_key in ('email', 'phone') and coalesce(btrim(v_row ->> v_key), '') <> '' then
        if lower(btrim(v_row ->> v_key)) is distinct from lower(v_text) then
          v_skipped := v_skipped || app.prefill_builtin_label(v_key);
        end if;
        continue;
      end if;
      if v_key = 'email' then
        v_text := lower(v_text);
        if char_length(v_text) > 254 or v_text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          raise exception 'invalid email address' using errcode = '22023';
        end if;
      elsif v_key = 'phone' then
        if char_length(v_text) > 40 or app.normalize_phone(v_text) is null then
          raise exception 'invalid phone' using errcode = '22023';
        end if;
      elsif v_key = 'birth_date' then
        if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'invalid birth date' using errcode = '22023';
        end if;
        begin
          v_date := v_text::date;
        exception when others then
          raise exception 'invalid birth date' using errcode = '22023';
        end;
        -- RVW-115: "today" in the business's own time zone, as every other date rule
        if v_date < date '1900-01-01' or v_date > (now() at time zone app.intake_zone(
             (select o.timezone from public.organizations o where o.id = v_link.organization_id)))::date then
          raise exception 'invalid birth date' using errcode = '22023';
        end if;
      elsif char_length(v_text) > 200 then
        raise exception 'invalid field: %', v_key using errcode = '22023';
      end if;
      continue when (v_row ->> v_key) is not distinct from v_text;
      v_set := v_set || jsonb_build_object(v_key, v_text);
      v_changed := v_changed || app.prefill_builtin_label(v_key);
    end if;
  end loop;

  if v_set <> '{}'::jsonb or v_custom <> '{}'::jsonb then
    begin
      -- FLD-07: judged now, so a value another transaction took meanwhile answers here instead of failing at commit
      set constraints app.custom_unique_values_value immediate;
      if v_link.lead_id is not null then
        update public.leads r set
          full_name = case when v_set ? 'full_name' then v_set ->> 'full_name' else r.full_name end,
          phone = case when v_set ? 'phone' then v_set ->> 'phone' else r.phone end,
          email = case when v_set ? 'email' then v_set ->> 'email' else r.email end,
          company_name = case when v_set ? 'company_name' then v_set ->> 'company_name' else r.company_name end,
          job_title = case when v_set ? 'job_title' then v_set ->> 'job_title' else r.job_title end,
          custom_fields = case when v_custom <> '{}'::jsonb then coalesce(r.custom_fields, '{}'::jsonb) || v_custom else r.custom_fields end
         where r.organization_id = v_link.organization_id and r.id = v_link.lead_id;
      else
        update public.contacts r set
          first_name = case when v_set ? 'first_name' then v_set ->> 'first_name' else r.first_name end,
          last_name = case when v_set ? 'last_name' then v_set ->> 'last_name' else r.last_name end,
          phone = case when v_set ? 'phone' then v_set ->> 'phone' else r.phone end,
          email = case when v_set ? 'email' then v_set ->> 'email' else r.email end,
          job_title = case when v_set ? 'job_title' then v_set ->> 'job_title' else r.job_title end,
          address_line = case when v_set ? 'address_line' then v_set ->> 'address_line' else r.address_line end,
          city = case when v_set ? 'city' then v_set ->> 'city' else r.city end,
          birth_date = case when v_set ? 'birth_date' then (v_set ->> 'birth_date')::date else r.birth_date end,
          custom_fields = case when v_custom <> '{}'::jsonb then coalesce(r.custom_fields, '{}'::jsonb) || v_custom else r.custom_fields end
         where r.organization_id = v_link.organization_id and r.id = v_link.contact_id;
      end if;
      set constraints app.custom_unique_values_value deferred;
    exception
      when unique_violation then
        set constraints app.custom_unique_values_value deferred;
        return jsonb_build_object('status', 'invalid', 'reason', 'unique');
      when others then
        -- any other refusal of the write (a constraint, a trigger): answered, so the counters stay; nothing personal
        set constraints app.custom_unique_values_value deferred;
        return jsonb_build_object('status', 'error');
    end;
  end if;

  update app.prefill_links l set submitted_at = now() where l.id = v_link.id;

  -- the timeline: the template's name and the fields' labels only, never a value; no author (part three's guard)
  v_body := 'הלקוח מילא את הטופס: ' || v_form.name
            || case when cardinality(v_changed) > 0 then ' · עודכנו: ' || array_to_string(v_changed, ', ') else ' · ללא שינויים' end
            || case when cardinality(v_skipped) > 0 then ' · לא עודכנו: ' || array_to_string(v_skipped, ', ') else '' end;
  insert into public.activities (organization_id, type, lead_id, contact_id, body, metadata, created_by)
  values (v_link.organization_id, 'system', v_link.lead_id, v_link.contact_id, left(v_body, 2000),
          jsonb_build_object('kind', 'prefill_submitted', 'prefill_link_id', v_link.id, 'form_name', v_form.name,
                             'changed', to_jsonb(v_changed), 'skipped', to_jsonb(v_skipped)), null);

  -- the notice: the template's name only
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_link.organization_id, t, 'system', 'הלקוח מילא טופס השלמת פרטים', v_form.name, v_type,
         coalesce(v_link.lead_id, v_link.contact_id)
    from app.prefill_notice_targets(v_link) t;

  return jsonb_build_object('status', 'saved', 'skipped', to_jsonb(v_skipped));
  exception when sqlstate '22023' then
    -- the fixed English messages of the checks above: a field's key at most, never a value
    return jsonb_build_object('status', 'invalid', 'error', sqlerrm);
  end;
end;
$$;
revoke all on function public.prefill_public_submit(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.prefill_public_submit(text, text, jsonb) to service_role;
