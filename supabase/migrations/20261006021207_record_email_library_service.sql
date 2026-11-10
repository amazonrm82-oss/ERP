-- =============================================================================
-- EML-02 follow-up: content-library files with a service template, and an audit entry of what was attached
-- =============================================================================
-- Owner's answer (198) ב (10 November 2026), replacing the lead's interim choice of 021198 (library files on marketing
-- templates only, hint record_email:library_service):
-- * a content-library file (LIB-01) may go with a card's SERVICE template too (requested_document; collection under its
--   own rules), in a person's MANUAL send from the record's card only. app.record_email_enqueue refuses library files while
--   an automation runs (`app.automation_running` = 'on'; hint record_email:library_automation). No automation step sends
--   email today (app.run_automation_actions has no email action); the guard keeps a future one, or a manual-button rule run
--   under the same setting, from passing them.
-- * a service email stays a service email: nothing here wraps it in the marketing envelope; the message type is the
--   template's, and the queue's send check judges it as before (blocklist / erasure for a service type).
-- * the audit log records which files were attached: one server-written entry, action `email_attachments`, per email
--   sent with any file, on the record the message is for (the lead, else the contact; a deal's email on its contact with
--   `deal_id`), changes = {job_id, template_id, message_type, deal_id?, files: [{id, name}], library_files: [{id, name,
--   library_item_id}]}: ids and names only, never content or an address. Being on the person's own entity, a privacy
--   erasure (app.audit_erase_core) erases it with the rest of their history.
-- Every other check of 021198 is unchanged: rights, the record and its address, the template (sendable, card types,
-- collection's right and keys), record files of this record, library files active, valid today and current, 5 files and
-- 10 MB together, 30 emails a person an hour. public.record_email_send (the invoker wrapper) is unchanged.
-- Redefined from 021198's body (the latest). Nothing is removed. Every statement is safe to run twice.

create or replace function app.record_email_enqueue(p_org uuid, p_kind text, p_record uuid, p_template uuid,
                                                    p_files uuid[], p_library_files uuid[])
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
  v_team uuid;
  v_deleted timestamptz;
  v_contact uuid;
  v_c_owner uuid;
  v_c_team uuid;
  v_c_deleted timestamptz;
  v_email text;
  v_tpl public.message_templates%rowtype;
  v_problem text;
  v_files uuid[];
  v_library uuid[];
  v_found integer;
  v_bytes bigint := 0;
  v_more bigint;
  v_today date;
  v_payload jsonb;
  v_job uuid;
begin
  if v_user is null or p_org is null or p_record is null or p_template is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('lead', 'contact', 'deal') then
    raise exception 'unknown record type' using errcode = 'P0001', hint = 'record_email:kind';
  end if;
  -- (193) ב: the activities_insert rule: a member who may write (never a viewer or a support session) in a writable
  -- business, who reads the record
  if not app.can_write(p_org) then
    raise exception 'not permitted' using errcode = '42501', hint = 'record_email:not_permitted';
  end if;

  if p_kind = 'lead' then
    select l.owner_id, l.team_id, l.deleted_at, l.email into v_owner, v_team, v_deleted, v_email
      from public.leads l where l.organization_id = p_org and l.id = p_record;
  elsif p_kind = 'contact' then
    select c.owner_id, c.team_id, c.deleted_at, c.email into v_owner, v_team, v_deleted, v_email
      from public.contacts c where c.organization_id = p_org and c.id = p_record;
    v_contact := p_record;
  else
    select d.owner_id, d.team_id, d.deleted_at, d.contact_id into v_owner, v_team, v_deleted, v_contact
      from public.deals d where d.organization_id = p_org and d.id = p_record;
  end if;
  if not found or v_deleted is not null or not app.record_email_readable(p_org, p_kind, p_record, v_owner, v_team) then
    raise exception 'record not found' using errcode = 'P0001', hint = 'record_email:not_found';
  end if;
  if p_kind = 'deal' then
    -- the deal's message goes to its contact, who must be live and readable by the sender
    if v_contact is null then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_email:no_contact';
    end if;
    select c.owner_id, c.team_id, c.deleted_at, c.email into v_c_owner, v_c_team, v_c_deleted, v_email
      from public.contacts c where c.organization_id = p_org and c.id = v_contact;
    if not found or v_c_deleted is not null
       or not app.record_email_readable(p_org, 'contact', v_contact, v_c_owner, v_c_team) then
      raise exception 'the deal has no contact' using errcode = 'P0001', hint = 'record_email:no_contact';
    end if;
  end if;
  if v_email is null or btrim(v_email) !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception 'the record has no email' using errcode = 'P0001', hint = 'record_email:no_address';
  end if;

  select * into v_tpl from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    raise exception 'template not found' using errcode = 'P0001', hint = 'record_email:template';
  end if;
  if v_tpl.channel <> 'email' then
    raise exception 'not an email template' using errcode = 'P0001', hint = 'record_email:channel';
  end if;
  -- (194) א: marketing, a requested document, or collection for whoever records payments; no other service type
  if v_tpl.message_type = any (app.service_message_types()) and not v_tpl.message_type = any (app.record_email_service_types()) then
    raise exception 'this type is not sent from a card' using errcode = 'P0001', hint = 'record_email:type';
  end if;
  if v_tpl.message_type = 'collection' then
    if not app.can_record_payments(p_org) then
      raise exception 'collection needs the payments right' using errcode = 'P0001', hint = 'record_email:collection';
    end if;
    -- lead's interim choice: the plan keys of every collection feature
    if not app.org_has_feature(p_org, 'collection') then
      raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:collection';
    end if;
    if not app.org_has_feature(p_org, 'documents') then
      raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:documents';
    end if;
    if not app.org_has_feature(p_org, 'payments') then
      raise exception 'feature not in plan' using errcode = 'P0001', hint = 'feature:payments';
    end if;
  end if;
  -- MSG-02: every sender asks right before it sends (inactive included); a refusal names the reason code only
  v_problem := app.message_template_sendable(p_org, p_template);
  if v_problem is not null then
    raise exception 'the template cannot be sent' using errcode = 'P0001', hint = 'record_email:not_sendable', detail = v_problem;
  end if;

  select coalesce(array_agg(distinct f order by f), '{}') into v_files from unnest(coalesce(p_files, '{}'::uuid[])) f where f is not null;
  select coalesce(array_agg(distinct f order by f), '{}') into v_library
    from unnest(coalesce(p_library_files, '{}'::uuid[])) f where f is not null;
  if cardinality(v_files) + cardinality(v_library) > app.record_email_max_files() then
    raise exception 'too many files' using errcode = 'P0001', hint = 'record_email:files_max';
  end if;
  if cardinality(v_files) > 0 then
    select count(*), coalesce(sum(f.size_bytes), 0) into v_found, v_bytes
      from public.files f
     where f.organization_id = p_org and f.id = any (v_files)
       and f.unconfirmed_since is null
       and case p_kind when 'lead' then f.lead_id = p_record when 'contact' then f.contact_id = p_record else f.deal_id = p_record end
       -- a file on a private note is its author's and the admins' (REC-07); the wrapper also read each file under RLS
       and (f.activity_id is null or exists (
             select 1 from public.activities a
              where a.organization_id = f.organization_id and a.id = f.activity_id
                and (not a.is_private or a.created_by = v_user or app.is_admin(p_org))));
    if v_found <> cardinality(v_files) then
      raise exception 'a file is not a file of this record' using errcode = 'P0001', hint = 'record_email:file';
    end if;
  end if;
  -- owner (198) ב: library files go on a marketing template and on a card's service template alike, but only in a
  -- person's manual send from the card, never while an automation runs (no automation step sends email today; this keeps
  -- a future one, or a manual-button rule, from passing them)
  if cardinality(v_library) > 0 and current_setting('app.automation_running', true) = 'on' then
    raise exception 'library files are sent from the card only' using errcode = 'P0001', hint = 'record_email:library_automation';
  end if;
  if cardinality(v_library) > 0 then
    -- (197) ב: the current file (newest confirmed) of an active file item valid today in the business's zone, one per item
    v_today := app.org_zone_today(p_org);
    select count(*), coalesce(sum(f.size_bytes), 0) into v_found, v_more
      from public.files f
      join public.library_items i on i.organization_id = f.organization_id and i.id = f.library_item_id
     where f.organization_id = p_org and f.id = any (v_library)
       and f.unconfirmed_since is null
       and i.kind = 'file' and i.is_active
       and (i.valid_from is null or i.valid_from <= v_today)
       and (i.valid_until is null or i.valid_until >= v_today)
       and not exists (
             select 1 from public.files n
              where n.organization_id = f.organization_id and n.library_item_id = f.library_item_id
                and n.unconfirmed_since is null and (n.created_at, n.id) > (f.created_at, f.id));
    if v_found <> cardinality(v_library) then
      raise exception 'a library file cannot be sent' using errcode = 'P0001', hint = 'record_email:library';
    end if;
    v_bytes := v_bytes + v_more;
  end if;
  if v_bytes > app.record_email_max_bytes() then
    raise exception 'the files are too large' using errcode = 'P0001', hint = 'record_email:files_size';
  end if;

  -- (196) א: at most 30 a person an hour across every business, counted under a lock of the person so two tabs cannot
  -- pass it together
  perform pg_advisory_xact_lock(hashtextextended('record_email:' || v_user::text, 0));
  select count(*) into v_found
    from app.jobs j
   where j.kind = 'message.send' and j.payload ? 'reply_to_user_id'
     and (j.payload ->> 'reply_to_user_id') = v_user::text
     and j.created_at > now() - interval '1 hour';
  if v_found >= app.record_email_hourly_limit() then
    raise exception 'too many emails this hour' using errcode = 'P0001', hint = 'record_email:rate';
  end if;

  v_payload := jsonb_build_object('channel', 'email', 'message_type', v_tpl.message_type, 'template_id', v_tpl.id,
                                  'reply_to_user_id', v_user)
               || case when p_kind = 'lead' then jsonb_build_object('lead_id', p_record)
                       else jsonb_build_object('contact_id', v_contact) end
               || case when p_kind = 'deal' then jsonb_build_object('deal_id', p_record) else '{}'::jsonb end
               || case when cardinality(v_files) > 0 then jsonb_build_object('file_ids', to_jsonb(v_files)) else '{}'::jsonb end
               || case when cardinality(v_library) > 0 then jsonb_build_object('library_file_ids', to_jsonb(v_library))
                       else '{}'::jsonb end;
  v_job := app.enqueue_job(p_org, 'message.send', v_payload, null);

  -- owner (198) ב: the audit log records which files went with the email, ids and names only (no content, no address),
  -- on the record the message is for (the lead, else the contact: a deal's email is recorded on its contact, with the
  -- deal's id), so a privacy erasure of that person erases the entry with the rest of their audit history
  if cardinality(v_files) + cardinality(v_library) > 0 then
    insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
    values (p_org, v_user, 'email_attachments',
            case when p_kind = 'lead' then 'leads' else 'contacts' end,
            case when p_kind = 'lead' then p_record else v_contact end,
            jsonb_build_object('job_id', v_job, 'template_id', v_tpl.id, 'message_type', v_tpl.message_type)
            || case when p_kind = 'deal' then jsonb_build_object('deal_id', p_record) else '{}'::jsonb end
            || jsonb_build_object(
                 'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by f.id)
                                      from public.files f
                                     where f.organization_id = p_org and f.id = any (v_files)), '[]'::jsonb),
                 'library_files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name,
                                                                                'library_item_id', f.library_item_id) order by f.id)
                                              from public.files f
                                             where f.organization_id = p_org and f.id = any (v_library)), '[]'::jsonb)));
  end if;
  return jsonb_build_object('job_id', v_job, 'paused', coalesce(app.customer_sending_paused(p_org), false));
end;
$$;
revoke all on function app.record_email_enqueue(uuid, text, uuid, uuid, uuid[], uuid[]) from public, anon, authenticated;
-- only for public.record_email_send (invoker); schema app is not exposed by the API
grant execute on function app.record_email_enqueue(uuid, text, uuid, uuid, uuid[], uuid[]) to authenticated;
