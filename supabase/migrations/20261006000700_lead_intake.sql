-- =============================================================================
-- 0007 Lead intake: public forms and incoming webhooks
-- =============================================================================
-- A "form" row is either a public web form (kind 'form', its token appears in
-- the embed code, so it is not a secret) or an incoming webhook (kind
-- 'webhook', its token is the secret in the URL). Submissions arrive at a
-- server route of the app, which calls public.intake_submit() with the
-- service-role key. Nothing here is reachable by anon.

create table public.forms (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind            text not null default 'form' check (kind in ('form', 'webhook')),
  name            text not null check (char_length(btrim(name)) between 1 and 80),
  -- 32 hex characters (122 random bits), generated here, never written by a client
  token           text not null unique default replace(gen_random_uuid()::text, '-', ''),
  -- what the public form shows
  title           text check (title is null or char_length(title) <= 120),
  intro           text check (intro is null or char_length(intro) <= 500),
  submit_label    text check (submit_label is null or char_length(submit_label) <= 40),
  success_message text check (success_message is null or char_length(success_message) <= 300),
  redirect_url    text check (redirect_url is null or redirect_url ~ '^https://'),
  -- [{"key": "full_name", "required": true}, ...] in display order
  fields          jsonb not null default '[{"key":"full_name","required":true},{"key":"phone","required":true},{"key":"email","required":false},{"key":"message","required":false}]'::jsonb
                  check (jsonb_typeof(fields) = 'array'),
  -- what a new lead gets
  source_id       uuid,
  owner_id        uuid,
  team_id         uuid,
  is_active       boolean not null default true,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, source_id) references public.lead_sources (organization_id, id) on delete set null (source_id),
  foreign key (organization_id, owner_id) references public.memberships (organization_id, user_id) on delete set null (owner_id),
  foreign key (organization_id, team_id) references public.teams (organization_id, id) on delete set null (team_id)
);

create index forms_org_idx on public.forms (organization_id);

create table public.form_submissions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  form_id         uuid not null,
  -- accepted: a lead was created; spam: caught by the honeypot, nothing created
  status          text not null check (status in ('accepted', 'spam')),
  lead_id         uuid,
  payload         jsonb not null default '{}'::jsonb,
  -- SHA-256 of the sender's IP address with a per-form salt, for rate limiting only
  ip_hash         text,
  user_agent      text check (user_agent is null or char_length(user_agent) <= 300),
  created_at      timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, form_id) references public.forms (organization_id, id) on delete cascade,
  foreign key (organization_id, lead_id) references public.leads (organization_id, id) on delete set null (lead_id)
);

create index form_submissions_form_idx on public.form_submissions (form_id, created_at desc);
create index form_submissions_rate_idx on public.form_submissions (form_id, ip_hash, created_at desc);

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------
create trigger forms_touch before insert or update on public.forms
  for each row execute function app.touch_row();
create trigger forms_audit after insert or update or delete on public.forms
  for each row execute function app.audit_row();

-- Plan rules for forms: the number of web forms (max_forms) and webhooks (feature 'api').
create or replace function app.guard_form() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_limit numeric;
  v_count bigint;
begin
  if new.kind = 'webhook' then
    if not app.org_has_feature(new.organization_id, 'api') then
      raise exception 'webhooks are not included in this plan' using errcode = 'P0001', hint = 'feature:api';
    end if;
    return new;
  end if;
  v_limit := app.org_limit(new.organization_id, 'max_forms');
  if v_limit is not null then
    select count(*) into v_count from public.forms f
      where f.organization_id = new.organization_id and f.kind = 'form' and f.id <> new.id;
    if v_count + 1 > v_limit then
      raise exception 'plan limit reached (max_forms = %)', v_limit using errcode = 'P0001', hint = 'limit:max_forms';
    end if;
  end if;
  return new;
end;
$$;

create trigger forms_guard before insert on public.forms
  for each row execute function app.guard_form();

-- ----------------------------------------------------------------------------
-- Row Level Security: admins manage forms and read submissions. Submissions
-- are written only by intake_submit().
-- ----------------------------------------------------------------------------
alter table public.forms enable row level security;
alter table public.form_submissions enable row level security;

revoke all on public.forms, public.form_submissions from anon, authenticated;
grant all on public.forms, public.form_submissions to service_role;

grant select, delete on public.forms to authenticated;
grant insert (organization_id, kind, name, title, intro, submit_label, success_message, redirect_url, fields,
              source_id, owner_id, team_id, is_active)
  on public.forms to authenticated;
grant update (name, title, intro, submit_label, success_message, redirect_url, fields, source_id, owner_id, team_id, is_active)
  on public.forms to authenticated;
grant select on public.form_submissions to authenticated;

create policy forms_select on public.forms for select to authenticated
  using (app.is_admin(organization_id));
create policy forms_insert on public.forms for insert to authenticated
  with check (app.is_admin(organization_id) and app.org_writable(organization_id));
create policy forms_update on public.forms for update to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id))
  with check (app.is_admin(organization_id));
create policy forms_delete on public.forms for delete to authenticated
  using (app.is_admin(organization_id) and app.org_writable(organization_id));

create policy form_submissions_select on public.form_submissions for select to authenticated
  using (app.is_admin(organization_id));

-- ----------------------------------------------------------------------------
-- intake_submit: one submission in, one lead out. Called only by the app's
-- server routes with the service-role key (never by a browser).
-- ----------------------------------------------------------------------------
create or replace function public.intake_submit(
  p_token      text,
  p_kind       text,
  p_payload    jsonb,
  p_ip_hash    text default null,
  p_user_agent text default null,
  p_is_spam    boolean default false
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_form public.forms%rowtype;
  v_status uuid;
  v_owner uuid;
  v_lead uuid;
  v_field jsonb;
  v_key text;
  v_full_name text := nullif(left(btrim(coalesce(p_payload ->> 'full_name', '')), 200), '');
  v_phone text := nullif(left(btrim(coalesce(p_payload ->> 'phone', '')), 40), '');
  v_email text := nullif(lower(left(btrim(coalesce(p_payload ->> 'email', '')), 254)), '');
  v_company text := nullif(left(btrim(coalesce(p_payload ->> 'company_name', '')), 200), '');
  v_message text := nullif(left(btrim(coalesce(p_payload ->> 'message', '')), 5000), '');
begin
  select * into v_form from public.forms f
   where f.token = coalesce(p_token, '') and f.kind = p_kind;
  if not found or not v_form.is_active then
    raise exception 'form not found' using errcode = 'P0002';
  end if;
  if not app.org_writable(v_form.organization_id) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;

  -- rate limits: per sender (10 in 10 minutes) and per form (500 an hour)
  if p_ip_hash is not null and (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.ip_hash = p_ip_hash and s.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (
    select count(*) from public.form_submissions s
     where s.form_id = v_form.id and s.created_at > now() - interval '1 hour'
  ) >= 500 then
    raise exception 'too many submissions' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if p_is_spam then
    insert into public.form_submissions (organization_id, form_id, status, payload, ip_hash, user_agent)
    values (v_form.organization_id, v_form.id, 'spam', coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));
    return jsonb_build_object('status', 'spam', 'success_message', v_form.success_message, 'redirect_url', v_form.redirect_url);
  end if;

  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email address' using errcode = '22023';
  end if;
  if v_full_name is null and v_phone is null and v_email is null then
    raise exception 'a name, phone or email is required' using errcode = '22023';
  end if;
  if v_form.kind = 'form' then
    for v_field in select * from jsonb_array_elements(v_form.fields) loop
      v_key := v_field ->> 'key';
      if coalesce((v_field ->> 'required')::boolean, false)
         and nullif(btrim(coalesce(p_payload ->> v_key, '')), '') is null then
        raise exception 'required field missing: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  select s.id into v_status from public.lead_statuses s
   where s.organization_id = v_form.organization_id and s.kind = 'open'
   order by s.is_default desc, s.position
   limit 1;
  if v_status is null then
    raise exception 'the organization has no open lead status' using errcode = 'P0001';
  end if;

  select m.user_id into v_owner from public.memberships m
   where m.organization_id = v_form.organization_id and m.user_id = v_form.owner_id
     and m.status = 'active' and m.role <> 'viewer';

  insert into public.leads (organization_id, status_id, source_id, owner_id, team_id,
                            full_name, phone, email, company_name, message)
  values (v_form.organization_id, v_status, v_form.source_id, v_owner, v_form.team_id,
          v_full_name, v_phone, v_email, v_company, v_message)
  returning id into v_lead;

  insert into public.form_submissions (organization_id, form_id, status, lead_id, payload, ip_hash, user_agent)
  values (v_form.organization_id, v_form.id, 'accepted', v_lead, coalesce(p_payload, '{}'::jsonb), p_ip_hash, left(p_user_agent, 300));

  return jsonb_build_object(
    'status', 'accepted',
    'lead_id', v_lead,
    'success_message', v_form.success_message,
    'redirect_url', v_form.redirect_url);
end;
$$;

revoke all on function public.intake_submit(text, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.intake_submit(text, text, jsonb, text, text, boolean) to service_role;

revoke all on function app.guard_form() from public, anon;
grant execute on function app.guard_form() to authenticated, service_role;
