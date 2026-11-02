-- =============================================================================
-- Support requests on the platform panel (ADM-05)
-- =============================================================================
-- SPEC-ADDITIONS chapter 15 (wave 3): "פניות תמיכה מלקוחות (מטופס הפנייה, USR-12), עם קישור לכרטיס הארגון".
--
-- Platform staff read and handle the requests businesses send from USR-12's form. Every function starts with
-- app.require_platform(['support']) (the platform owner or support, aal2); finance and read-only staff do not read
-- request texts.
--   platform_list_support_requests(status?, limit, offset)  {total, counts {open, in_progress, closed}, rows [...]}:
--       the business's id and name (the screen links to its admin card), the requester's name and email, category,
--       subject, message, page, status, times and the internal notes
--   platform_set_support_request_status(id, status)  open | in_progress | closed; logged 'support_request.status';
--       the requester, while still an active member of that business, gets one 'system' notification that names
--       nothing (no subject, no text): "עדכון בפנייה שלכם לתמיכה" with the new state, linked to the support page
--   platform_add_support_request_note(id, body)  an internal note (1..2,000), app.support_request_notes; never shown to
--       the business; logged 'support_request.note' with its length only
--
-- No support session (FXS-08) is needed to read a request: the customer wrote it TO the platform's support, on
-- purpose, knowing who reads it (the form says so). A support session guards the business's own CRM data, which a
-- request does not open: the screen shows the request and links to the business's admin card, nothing more.
-- Reading is limited to the platform owner and support, and every change is logged.
-- Every statement is safe to run twice. No drops, no deletes.

create table if not exists app.support_request_notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_id      uuid not null,
  author_id       uuid references auth.users (id) on delete set null,
  body            text not null
                  constraint support_request_notes_body_check check (char_length(btrim(body)) between 1 and 2000),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, request_id) references public.support_requests (organization_id, id) on delete cascade
);
create index if not exists support_request_notes_request_idx on app.support_request_notes (organization_id, request_id, created_at);

alter table app.support_request_notes enable row level security;
revoke all on app.support_request_notes from public, anon, authenticated;

create or replace function public.platform_list_support_requests(
  p_status text default null, p_limit integer default 100, p_offset integer default 0
) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform app.require_platform(array['support']);
  if p_status is not null and p_status not in ('open', 'in_progress', 'closed') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from public.support_requests r where p_status is null or r.status = p_status),
    'counts', jsonb_build_object(
      'open', (select count(*) from public.support_requests r where r.status = 'open'),
      'in_progress', (select count(*) from public.support_requests r where r.status = 'in_progress'),
      'closed', (select count(*) from public.support_requests r where r.status = 'closed')),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'organization_id', r.organization_id, 'organization_name', o.name,
               'requester_id', r.user_id, 'requester_name', p.full_name, 'requester_email', p.email,
               'category', r.category, 'subject', r.subject, 'message', r.message, 'page_path', r.page_path,
               'status', r.status, 'created_at', r.created_at, 'status_changed_at', r.status_changed_at,
               'notes', coalesce((
                 select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'author_name', coalesce(ap.full_name, ap.email),
                                                     'created_at', n.created_at) order by n.created_at, n.id)
                   from app.support_request_notes n
                   left join public.profiles ap on ap.id = n.author_id
                  where n.organization_id = r.organization_id and n.request_id = r.id), '[]'::jsonb))
             order by r.created_at desc, r.id)
        from (
          select * from public.support_requests r
           where p_status is null or r.status = p_status
           order by r.created_at desc, r.id
           limit v_limit offset v_offset
        ) r
        join public.organizations o on o.id = r.organization_id
        left join public.profiles p on p.id = r.user_id
    ), '[]'::jsonb));
end;
$$;
revoke all on function public.platform_list_support_requests(text, integer, integer) from public, anon;
grant execute on function public.platform_list_support_requests(text, integer, integer) to authenticated;

create or replace function public.platform_set_support_request_status(p_id uuid, p_status text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.support_requests%rowtype;
  v_body text;
begin
  perform app.require_platform(array['support']);
  if p_status is null or p_status not in ('open', 'in_progress', 'closed') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  select * into v from public.support_requests r where r.id = p_id for update;
  if not found then
    raise exception 'support request not found' using errcode = 'P0002';
  end if;
  if v.status = p_status then
    return;
  end if;
  update public.support_requests set status = p_status, status_changed_at = now() where id = v.id;
  perform app.log_platform('support_request.status', v.organization_id,
    jsonb_build_object('id', v.id, 'old', v.status, 'new', p_status));

  v_body := case p_status
              when 'in_progress' then 'הפנייה בטיפול'
              when 'closed' then 'הפנייה טופלה'
              else 'הפנייה נפתחה מחדש'
            end;
  -- only to the requester, while still an active member of that business
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v.organization_id, v.user_id, 'system', 'עדכון בפנייה שלכם לתמיכה', v_body, 'support_request', v.id
    from public.memberships m
   where v.user_id is not null
     and m.organization_id = v.organization_id and m.user_id = v.user_id and m.status = 'active';
end;
$$;
revoke all on function public.platform_set_support_request_status(uuid, text) from public, anon;
grant execute on function public.platform_set_support_request_status(uuid, text) to authenticated;

create or replace function public.platform_add_support_request_note(p_id uuid, p_body text) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.support_requests%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  perform app.require_platform(array['support']);
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'a note is 1 to 2,000 characters' using errcode = '22023';
  end if;
  select * into v from public.support_requests r where r.id = p_id;
  if not found then
    raise exception 'support request not found' using errcode = 'P0002';
  end if;
  insert into app.support_request_notes (organization_id, request_id, author_id, body)
  values (v.organization_id, v.id, auth.uid(), v_body)
  returning id into v_id;
  perform app.log_platform('support_request.note', v.organization_id,
    jsonb_build_object('id', v.id, 'note_id', v_id, 'length', char_length(v_body)));
  return v_id;
end;
$$;
revoke all on function public.platform_add_support_request_note(uuid, text) from public, anon;
grant execute on function public.platform_add_support_request_note(uuid, text) to authenticated;
