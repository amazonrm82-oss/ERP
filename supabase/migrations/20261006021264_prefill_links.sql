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

