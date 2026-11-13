-- =============================================================================
-- BIZ-05 part two: the personal link and the customer's page (hard rule 5's approved pattern for secret-link pages; owner,
-- 11 November 2026, answer (271) ב)
-- =============================================================================
-- The page's server file (src/features/prefill-links/public-server.ts) calls one security definer function per need, granted
-- to service_role only, which checks the token and does only what the page needs; no table is reached with the service key.
--
-- * app.prefill_links (schema app, RLS on, no grants): one personal link of one template (public.prefill_forms) to one record
--   (a lead or a contact, exactly one; composite FKs cascade with the template and the record), the SHA-256 of its token only
--   (the token is answered once, when made), its maker, 14 days of validity (expires_at), one submission (submitted_at), and
--   whether it was turned off (revoked_at). Counters: the link's 10-minute call window (120), its 10-minute submit window (10),
--   and app.prefill_link_view_counts (1,024 reused buckets per link for 60 calls per sender; no hash stored; the sender is the
--   keyed IP hash with scope "prefill", re-scoped to the link by app.prefill_link_sender).
-- * Staff (definer, authenticated):
--   - public.prefill_link_create(org, form, record_type, record_id): whoever writes in a writable business (app.can_write),
--     who may EDIT the record (app.can_edit_record on its owner and team; the answers change it), a live record (a lead not
--     converted), the plan key `prefill_links`, an active template of the same record type; 100 links per person an hour (hint
--     prefill_link:rate). Answers the token once; audited `prefill_link` on the record without the token.
--   - public.prefill_link_revoke(org, link): its maker, an owner/admin, or whoever may edit the record; only lessens access.
--   - public.prefill_links_for_record(org, record_type, record_id): the record's 20 newest links for whoever reads the record
--     (the select policy's rule, app.library_link_caller_reads): template name, maker, dates and state
--     (open|submitted|expired|revoked), never the token.
-- * The one rule (app.prefill_link_usable): "not found" (P0002) for an unknown or turned-off token, a link past its 14 days, a
--   business whose public pages are closed (app.org_public_pages_open), no plan key, a template switched off, a record in the
--   bin, gone, or (a lead) converted. A link already sent answers only {status: 'done'} with the business's display fields.
-- * public.prefill_public(token, ip_hash) (service_role): 120 calls per link and 60 per sender in 10 minutes, counted right
--   after the lookup ({rate_limited: true} past either). Answers only: the business display name (organizations.name), logo,
--   colour, the built-with line, the privacy notice's contact (app.privacy_notice_contact, LEGAL-2), the template's title and
--   intro, and for each field the template asks that may still be asked (app.prefill_field_problem judged again): key,
--   label, type, options, help, required (field_definitions.is_required; built-ins never), read_only (FLD-07: a read-only
--   field that holds a value is shown, not asked) and its CURRENT value on the record. Never an id, never another field.
-- * public.prefill_public_submit(token, ip_hash, values) (service_role): the same lookup, rule and call counters, then 10
--   submissions per link in 10 minutes; the link FOR UPDATE (one submission). Writes ONLY the template's fields, as the server
--   (no session: the audit entry has no actor): a wrong answer is answered {status:'invalid', error} (the check's fixed English
--   message, a key at most), so the try stays counted; an unknown key is refused; an empty answer leaves the stored value
--   (lead's choice: the form adds and changes, never clears); built-ins are checked as a person's write (email shape, a phone
--   that normalizes, a birth date 1900..today, lengths); custom values by app.custom_value_ok (the rule
--   app.check_custom_fields applies to a person's write, which does not run for the server); a read-only field that holds a
--   value is kept and reported as skipped; a unique field (FLD-07) whose value another live record holds is kept and reported
--   as skipped, and a race at write time answers {status:'invalid', reason:'unique'}. Then one `system` timeline entry
--   (kind prefill_submitted, the template's name and the changed and skipped fields' labels only, no values, no author; part
--   three's guard), submitted_at, and one `system` notice (template name only) to the link's maker while an active member who
--   reads the record, else the record's owner while an active non-viewer who reads it, else the active owners and admins.
-- * Review of 13 November 2026 (lead's fixes): a business that cannot write (app.org_writable: read-only, suspended,
--   cancelled, deleted) answers "not found" on the page and the submit, a sent link's "done" page too, and the "done" page
--   only until the link's expires_at; the link keeps a server-only copy of the template's fields when made
--   (app.prefill_links.fields), and the page shows and the submit accepts only that copy's keys still on the template and
--   still allowed (removing a field narrows an open link, adding one never widens it); the submit judges the locked link again;
--   the built-in email and phone are filled only when the record holds none (a typed value that differs from a stored one is
--   kept as skipped, and the page shows a stored one read-only); built-in text with control, direction or zero-width
--   characters is refused (app.document_invisible_class, SGN-02's class); any other error of the write is answered
--   {status:'error'} so the counters stay; a link on a sample record keeps it (app.sample_untouched, part three).
-- * Merge: a duplicate's links move to the kept record on the `merged` entry (app.merge_prefill_links, as LIB-02;
--   accepted by the review of 13 November 2026: the link follows the person to the kept record).
-- Every statement is safe to run twice. No statement starts with drop; no row removal.

-- ----------------------------------------------------------------------------
-- The links (schema app, no grants)
-- ----------------------------------------------------------------------------
create table if not exists app.prefill_links (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid not null references public.organizations (id) on delete cascade,
  prefill_form_id            uuid not null,
  lead_id                    uuid,
  contact_id                 uuid,
  token_hash                 text unique,
  -- the template's fields when the link was made (server only): the page shows and the submit accepts only these keys
  -- that are still on the template and still allowed
  fields                     text[] not null default '{}',
  created_by                 uuid references auth.users (id) on delete set null,
  created_at                 timestamptz not null default now(),
  expires_at                 timestamptz not null default now() + interval '14 days',
  submitted_at               timestamptz,
  revoked_at                 timestamptz,
  revoked_by                 uuid references auth.users (id) on delete set null,
  window_started_at          timestamptz,
  window_count               integer not null default 0,
  submit_window_started_at   timestamptz,
  submit_count               integer not null default 0,
  unique (organization_id, id),
  constraint prefill_links_one_record check (num_nonnulls(lead_id, contact_id) = 1),
  constraint prefill_links_form_fk foreign key (organization_id, prefill_form_id)
    references public.prefill_forms (organization_id, id) on delete cascade,
  constraint prefill_links_lead_fk foreign key (organization_id, lead_id)
    references public.leads (organization_id, id) on delete cascade,
  constraint prefill_links_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade
);
create index if not exists prefill_links_form_idx on app.prefill_links (organization_id, prefill_form_id);
create index if not exists prefill_links_lead_idx on app.prefill_links (organization_id, lead_id);
create index if not exists prefill_links_contact_idx on app.prefill_links (organization_id, contact_id);
create index if not exists prefill_links_maker_idx on app.prefill_links (organization_id, created_by, created_at);
alter table app.prefill_links enable row level security;
revoke all on app.prefill_links from public, anon, authenticated, service_role;

create table if not exists app.prefill_link_view_counts (
  link_id       uuid not null references app.prefill_links (id) on delete cascade,
  bucket        integer not null check (bucket between 0 and 1023),
  window_start  timestamptz not null,
  views         integer not null,
  primary key (link_id, bucket)
);
alter table app.prefill_link_view_counts enable row level security;
revoke all on app.prefill_link_view_counts from public, anon, authenticated, service_role;

-- The sender, scoped to one link: nothing matches across links or businesses
create or replace function app.prefill_link_sender(p_link uuid, p_hash text) returns text
language sql immutable
set search_path = ''
as $$
  select case when p_hash is null or p_link is null then null
              else encode(sha256(convert_to('prefill:' || p_link::text || ':' || p_hash, 'UTF8')), 'hex') end
$$;
revoke all on function app.prefill_link_sender(uuid, text) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The rules
-- ----------------------------------------------------------------------------
-- The record of a link is live: of the business, not in the bin, and a lead not converted
create or replace function app.prefill_record_live(p_org uuid, p_lead uuid, p_contact uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when p_lead is not null then exists (select 1 from public.leads r where r.organization_id = p_org and r.id = p_lead
                                                                         and r.deleted_at is null and r.converted_at is null)
    when p_contact is not null then exists (select 1 from public.contacts r where r.organization_id = p_org and r.id = p_contact
                                                                               and r.deleted_at is null)
    else false end
$$;
revoke all on function app.prefill_record_live(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- The one rule for a link (submitted links are judged by the caller: they answer only "done")
create or replace function app.prefill_link_usable(p_link app.prefill_links) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_link.id is not null
     and p_link.token_hash is not null
     and p_link.revoked_at is null
     and p_link.expires_at > now()
     and app.org_public_pages_open(p_link.organization_id)
     -- a business that cannot write (read-only, suspended, cancelled, deleted): a customer's answers change nothing
     and app.org_writable(p_link.organization_id)
     and app.org_has_feature(p_link.organization_id, 'prefill_links')
     and exists (select 1 from public.prefill_forms f
                  where f.organization_id = p_link.organization_id and f.id = p_link.prefill_form_id and f.is_active)
     and app.prefill_record_live(p_link.organization_id, p_link.lead_id, p_link.contact_id)
$$;
revoke all on function app.prefill_link_usable(app.prefill_links) from public, anon, authenticated, service_role;

-- The record's owner and team
create or replace function app.prefill_record_owner(p_org uuid, p_lead uuid, p_contact uuid, out owner_id uuid, out team_id uuid)
language sql stable security definer
set search_path = ''
as $$
  select r.owner_id, r.team_id from public.leads r where p_lead is not null and r.organization_id = p_org and r.id = p_lead
  union all
  select r.owner_id, r.team_id from public.contacts r where p_lead is null and r.organization_id = p_org and r.id = p_contact
$$;
revoke all on function app.prefill_record_owner(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- A built-in field's Hebrew label and input type (= PREFILL_BUILT_IN in src/features/prefill-links/fields.ts)
create or replace function app.prefill_builtin_label(p_key text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_key
    when 'full_name' then 'שם מלא' when 'first_name' then 'שם פרטי' when 'last_name' then 'שם משפחה'
    when 'phone' then 'טלפון' when 'email' then 'אימייל' when 'company_name' then 'שם החברה'
    when 'job_title' then 'תפקיד' when 'address_line' then 'כתובת' when 'city' then 'עיר'
    when 'birth_date' then 'תאריך לידה' end
$$;
revoke all on function app.prefill_builtin_label(text) from public, anon, authenticated, service_role;

create or replace function app.prefill_builtin_type(p_key text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_key when 'phone' then 'phone' when 'email' then 'email' when 'birth_date' then 'date' else 'text' end
$$;
revoke all on function app.prefill_builtin_type(text) from public, anon, authenticated, service_role;

-- The fields a link's page shows now: the template's keys that may still be asked, with label, type and the record's value
create or replace function app.prefill_link_fields(p_link app.prefill_links) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_form public.prefill_forms;
  v_type text := case when p_link.lead_id is not null then 'lead' else 'contact' end;
  v_row jsonb;
  v_custom jsonb;
  v_key text;
  v_def public.field_definitions;
  v_value jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  select * into v_form from public.prefill_forms f where f.organization_id = p_link.organization_id and f.id = p_link.prefill_form_id;
  if p_link.lead_id is not null then
    select to_jsonb(r) into v_row from public.leads r where r.organization_id = p_link.organization_id and r.id = p_link.lead_id;
  else
    select to_jsonb(r) into v_row from public.contacts r where r.organization_id = p_link.organization_id and r.id = p_link.contact_id;
  end if;
  v_custom := case when jsonb_typeof(v_row -> 'custom_fields') = 'object' then v_row -> 'custom_fields' else '{}'::jsonb end;
  -- the link's copy of the fields, in its order, only those still on the template and still allowed
  foreach v_key in array coalesce(p_link.fields, array[]::text[]) loop
    continue when not (v_key = any (coalesce(v_form.fields, array[]::text[])));
    continue when app.prefill_field_problem(p_link.organization_id, v_type, v_key) is not null;
    if v_key like 'cf:%' then
      select * into v_def from public.field_definitions d
       where d.organization_id = p_link.organization_id and d.object_type = v_type and d.key = substr(v_key, 4);
      v_value := v_custom -> v_def.key;
      if v_value is not null and jsonb_typeof(v_value) = 'null' then
        v_value := null;
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', v_key,
        'label', v_def.label,
        'type', v_def.field_type,
        'options', case when jsonb_typeof(v_def.options) = 'array' then v_def.options else '[]'::jsonb end,
        'help', v_def.help_text,
        'required', v_def.is_required,
        'read_only', v_def.is_read_only and v_value is not null,
        'value', v_value));
    else
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', v_key,
        'label', app.prefill_builtin_label(v_key),
        'type', app.prefill_builtin_type(v_key),
        'options', '[]'::jsonb,
        'help', null,
        'required', false,
        -- the email and phone are filled only when the record holds none (review of 13 November 2026)
        'read_only', v_key in ('email', 'phone') and coalesce(btrim(v_row ->> v_key), '') <> '',
        'value', case when v_row ->> v_key is null or btrim(v_row ->> v_key) = '' then null else to_jsonb(v_row ->> v_key) end));
    end if;
  end loop;
  return v_out;
end;
$$;
revoke all on function app.prefill_link_fields(app.prefill_links) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Staff: making, turning off and listing links
-- ----------------------------------------------------------------------------
create or replace function public.prefill_link_create(p_org uuid, p_form uuid, p_record_type text, p_record_id uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_owner record;
  v_form public.prefill_forms;
  v_lead uuid := case when p_record_type = 'lead' then p_record_id end;
  v_contact uuid := case when p_record_type = 'contact' then p_record_id end;
  v_link uuid;
  v_token text;
begin
  if p_record_type is null or p_record_type not in ('lead', 'contact') or p_record_id is null or p_form is null then
    raise exception 'name a record and a form' using errcode = '22023';
  end if;
  -- a member of a business that cannot write hears why; an outsider learns nothing about the business's state
  if app.role_in(p_org) is not null and not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  if not app.can_write(p_org) or not app.library_link_caller_reads(p_org, p_record_type, p_record_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  -- the answers change the record: whoever may edit it
  v_owner := app.prefill_record_owner(p_org, v_lead, v_contact);
  if not coalesce(app.can_edit_record(p_org, v_owner.owner_id, v_owner.team_id), false) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.prefill_record_live(p_org, v_lead, v_contact) then
    raise exception 'the record is in the recycle bin or converted' using errcode = 'P0001', hint = 'prefill_link:record';
  end if;
  if not app.org_has_feature(p_org, 'prefill_links') then
    raise exception 'prefill links are not in the plan' using errcode = 'P0001', hint = 'feature:prefill_links';
  end if;
  select * into v_form from public.prefill_forms f where f.organization_id = p_org and f.id = p_form;
  if v_form.id is null or not v_form.is_active or v_form.record_type <> p_record_type then
    raise exception 'the form cannot be sent to this record' using errcode = 'P0001', hint = 'prefill_link:form';
  end if;
  -- at most 100 links per person per hour in a business
  perform pg_advisory_xact_lock(hashtextextended('prefill_links:' || p_org::text || ':' || auth.uid()::text, 0));
  if (select count(*) from app.prefill_links l
       where l.organization_id = p_org and l.created_by = auth.uid() and l.created_at > now() - interval '1 hour') >= 100 then
    raise exception 'too many links in an hour' using errcode = 'P0001', hint = 'prefill_link:rate';
  end if;

  -- 48 random bytes from three UUIDs, base64url: 64 characters
  v_token := translate(
    encode(decode(replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
    E'+/=\n', '-_');
  insert into app.prefill_links (organization_id, prefill_form_id, lead_id, contact_id, token_hash, created_by, fields)
  values (p_org, p_form, v_lead, v_contact, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), v_form.fields)
  returning id into v_link;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'prefill_link', case when v_lead is not null then 'leads' else 'contacts' end, p_record_id,
          jsonb_build_object('link', 'created', 'form', p_form));
  return v_token;
end;
$$;
revoke all on function public.prefill_link_create(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.prefill_link_create(uuid, uuid, text, uuid) to authenticated;

-- Turning a link off only lessens access: its maker, an owner or admin, or whoever may edit the record, for a record they read
create or replace function public.prefill_link_revoke(p_org uuid, p_link uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.prefill_links;
  v_type text;
  v_id uuid;
  v_owner record;
begin
  select * into v_link from app.prefill_links l where l.organization_id = p_org and l.id = p_link;
  if v_link.id is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  v_type := case when v_link.lead_id is not null then 'lead' else 'contact' end;
  v_id := coalesce(v_link.lead_id, v_link.contact_id);
  v_owner := app.prefill_record_owner(p_org, v_link.lead_id, v_link.contact_id);
  if app.role_in(p_org) is null or app.role_in(p_org)::text = 'viewer'
     or not app.library_link_caller_reads(p_org, v_type, v_id)
     or not (v_link.created_by = auth.uid() or app.is_admin(p_org)
             or coalesce(app.can_edit_record(p_org, v_owner.owner_id, v_owner.team_id), false)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_link.revoked_at is not null then
    return false;
  end if;
  update app.prefill_links l
     set revoked_at = now(), revoked_by = auth.uid(), token_hash = null, window_started_at = null, window_count = 0
   where l.organization_id = p_org and l.id = p_link and l.revoked_at is null;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'prefill_link', case when v_type = 'lead' then 'leads' else 'contacts' end, v_id,
          jsonb_build_object('link', 'revoked', 'form', v_link.prefill_form_id));
  return true;
end;
$$;
revoke all on function public.prefill_link_revoke(uuid, uuid) from public, anon;
grant execute on function public.prefill_link_revoke(uuid, uuid) to authenticated;

-- The record's links for its card: whoever reads the record; never the token
create or replace function public.prefill_links_for_record(p_org uuid, p_record_type text, p_record_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_owner record;
  v_edit boolean;
  v_admin boolean;
  v_viewer boolean;
begin
  if p_record_type not in ('lead', 'contact') or p_record_id is null or app.role_in(p_org) is null
     or not app.library_link_caller_reads(p_org, p_record_type, p_record_id) then
    return '[]'::jsonb;
  end if;
  v_owner := app.prefill_record_owner(p_org, case when p_record_type = 'lead' then p_record_id end,
                                      case when p_record_type = 'contact' then p_record_id end);
  v_edit := coalesce(app.can_edit_record(p_org, v_owner.owner_id, v_owner.team_id), false);
  v_admin := app.is_admin(p_org);
  v_viewer := app.role_in(p_org)::text = 'viewer';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.id,
             'form_name', f.name,
             'created_by', l.created_by,
             'created_at', l.created_at,
             'expires_at', l.expires_at,
             'submitted_at', l.submitted_at,
             'revoked_at', l.revoked_at,
             'state', case when l.revoked_at is not null then 'revoked'
                           when l.submitted_at is not null then 'submitted'
                           when l.expires_at <= now() then 'expired'
                           else 'open' end,
             'can_revoke', l.revoked_at is null and l.submitted_at is null and l.expires_at > now() and not v_viewer
                           and (l.created_by = auth.uid() or v_admin or v_edit))
           order by l.created_at desc, l.id desc)
      from (select * from app.prefill_links l
             where l.organization_id = p_org
               and ((p_record_type = 'lead' and l.lead_id = p_record_id) or (p_record_type = 'contact' and l.contact_id = p_record_id))
             order by l.created_at desc, l.id desc
             limit 20) l
      join public.prefill_forms f on f.organization_id = l.organization_id and f.id = l.prefill_form_id), '[]'::jsonb);
end;
$$;
revoke all on function public.prefill_links_for_record(uuid, text, uuid) from public, anon;
grant execute on function public.prefill_links_for_record(uuid, text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- The customer's page
-- ----------------------------------------------------------------------------
-- The lookup and the call limits: the link (or not found); verdict 'rate' past a limit, 'done' when already sent, else 'ok'
create or replace function app.prefill_link_take(p_token text, p_ip_hash text, out link app.prefill_links, out verdict text)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_bucket integer;
  v_views integer;
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  select * into link from app.prefill_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if link.id is null then
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  -- a link already sent shows only "done" while the business may write and until the link's last day (its record may
  -- since be gone)
  if link.submitted_at is not null then
    if link.revoked_at is null and link.expires_at > now()
       and app.org_public_pages_open(link.organization_id) and app.org_writable(link.organization_id) then
      verdict := 'done';
      return;
    end if;
    raise exception 'link not found' using errcode = 'P0002';
  end if;
  if not app.prefill_link_usable(link) then
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
  verdict := 'ok';
end;
$$;
revoke all on function app.prefill_link_take(text, text) from public, anon, authenticated, service_role;

-- The business's display fields (every answer but "not found" and "rate limited")
create or replace function app.prefill_business(p_org uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org public.organizations;
  v_built_with boolean;
begin
  select * into v_org from public.organizations o where o.id = p_org;
  begin
    v_built_with := coalesce(app.show_built_with(p_org), true);
  exception when others then
    v_built_with := true;
  end;
  return jsonb_build_object(
    'business', v_org.name,
    'brand', jsonb_build_object('logo', v_org.logo_path, 'color', v_org.brand_color),
    'built_with', v_built_with);
end;
$$;
revoke all on function app.prefill_business(uuid) from public, anon, authenticated, service_role;

create or replace function public.prefill_public(p_token text, p_ip_hash text default null) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_take record;
  v_link app.prefill_links;
  v_form public.prefill_forms;
begin
  v_take := app.prefill_link_take(p_token, p_ip_hash);
  if v_take.verdict = 'rate' then
    return jsonb_build_object('rate_limited', true);
  end if;
  v_link := v_take.link;
  if v_take.verdict = 'done' then
    return jsonb_build_object('status', 'done') || app.prefill_business(v_link.organization_id);
  end if;
  select * into v_form from public.prefill_forms f where f.organization_id = v_link.organization_id and f.id = v_link.prefill_form_id;
  return jsonb_build_object(
    'status', 'open',
    'title', v_form.title,
    'intro', v_form.intro,
    -- LEGAL-2 (4): the business's display name and contact for the privacy notice under the form (section 11)
    'notice', app.privacy_notice_contact(v_link.organization_id),
    'fields', app.prefill_link_fields(v_link))
    || app.prefill_business(v_link.organization_id);
end;
$$;
revoke all on function public.prefill_public(text, text) from public, anon, authenticated;
grant execute on function public.prefill_public(text, text) to service_role;

-- Who hears of a submission: the maker while an active member who reads the record, else the record's owner while an active
-- non-viewer who reads it, else the active owners and admins (LIB-02's rule of 021241)
create or replace function app.prefill_notice_targets(p_link app.prefill_links) returns setof uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_type text := case when p_link.lead_id is not null then 'lead' else 'contact' end;
  v_id uuid := coalesce(p_link.lead_id, p_link.contact_id);
  v_owner record;
begin
  v_owner := app.prefill_record_owner(p_link.organization_id, p_link.lead_id, p_link.contact_id);
  if p_link.created_by is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_link.organization_id and m.user_id = p_link.created_by and m.status = 'active')
     and (coalesce(app.user_can_read_record(p_link.organization_id, p_link.created_by, v_owner.owner_id, v_owner.team_id), false)
          or app.user_deputy_reads(p_link.organization_id, p_link.created_by, v_type, v_id)) then
    return next p_link.created_by;
    return;
  end if;
  if v_owner.owner_id is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_link.organization_id and m.user_id = v_owner.owner_id
                    and m.status = 'active' and m.role <> 'viewer')
     and coalesce(app.user_can_read_record(p_link.organization_id, v_owner.owner_id, v_owner.owner_id, v_owner.team_id), false) then
    return next v_owner.owner_id;
    return;
  end if;
  return query
    select m.user_id from public.memberships m
     where m.organization_id = p_link.organization_id and m.status = 'active' and m.role in ('owner', 'admin');
end;
$$;
revoke all on function app.prefill_notice_targets(app.prefill_links) from public, anon, authenticated, service_role;

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
        if v_date < date '1900-01-01' or v_date > (now() at time zone 'Asia/Jerusalem')::date then
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

-- ----------------------------------------------------------------------------
-- Merge: the duplicate's links go to the kept record (before the duplicate is deleted), as app.merge_library_links
-- ----------------------------------------------------------------------------
create or replace function app.merge_prefill_links() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.lead_id is not null and v_merged <> new.lead_id then
    update app.prefill_links l set lead_id = new.lead_id
     where l.organization_id = new.organization_id and l.lead_id = v_merged;
  elsif new.contact_id is not null and v_merged <> new.contact_id then
    update app.prefill_links l set contact_id = new.contact_id
     where l.organization_id = new.organization_id and l.contact_id = v_merged;
  end if;
  return null;
end;
$$;
revoke all on function app.merge_prefill_links() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_prefill_links after insert on public.activities
  for each row
  when (new.type = 'system' and (new.lead_id is not null or new.contact_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_prefill_links();
