-- =============================================================================
-- 0056 Summary at the top of a contact or company card (REC-10)
-- =============================================================================
-- public.record_summary(org, type, id) answers, for one contact or company:
-- * deals: count and sum of open and of won deals, per currency (a deal keeps its
--   own currency; amounts in different currencies are never added together);
-- * last_touch: the most recent logged note / call / meeting / email / WhatsApp /
--   SMS that has already happened (occurred_at <= now()), with its type and time;
-- * next_task: the open task with the nearest due date (undated ones last), and
--   the number of open tasks.
-- For a company it counts what is linked to the company itself plus what is
-- linked to its live contacts (contacts.company_id), each deal / activity / task
-- once even when it is linked both ways. Extra contacts of a deal kept in
-- public.deal_contacts are not counted: a deal counts through its own
-- contact_id / company_id only.
--
-- * security invoker on purpose, like the reports: every row is read with the
--   caller's rights, so RLS decides what is counted. A member who sees only
--   their own deals gets the sums of their own deals.
-- * Why a function and not app queries: the sums must be exact. In the app this
--   needed every deal row (PostgREST caps a read at max_rows and has no
--   aggregates) and, for a company, the ids of all its contacts in the URL.
--   Here it is one round trip with no cap.
-- Every statement is safe to run twice.

create or replace function public.record_summary(p_org uuid, p_type text, p_id uuid) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_contacts uuid[];
  v_company uuid;
begin
  if p_type = 'contact' then
    v_contacts := array[p_id];
    v_company := null;
  elsif p_type = 'company' then
    select coalesce(array_agg(c.id), '{}') into v_contacts
      from public.contacts c
     where c.organization_id = p_org and c.company_id = p_id and c.deleted_at is null;
    v_company := p_id;
  else
    raise exception 'record_summary: unknown type %', p_type using errcode = '22023';
  end if;

  return jsonb_build_object(
    'deals', (
      select coalesce(jsonb_agg(jsonb_build_object('status', x.status, 'currency', x.currency, 'count', x.n, 'sum', x.total)
                                order by x.status, x.currency), '[]'::jsonb)
        from (select d.status, d.currency, count(*) as n, sum(d.amount_agorot) as total
                from public.deals d
               where d.organization_id = p_org
                 and d.deleted_at is null
                 and d.status in ('open', 'won')
                 and (d.contact_id = any(v_contacts) or d.company_id = v_company)
               group by d.status, d.currency) x
    ),
    'last_touch', (
      select jsonb_build_object('type', a.type, 'occurred_at', a.occurred_at)
        from public.activities a
       where a.organization_id = p_org
         and a.type in ('note', 'call', 'meeting', 'email', 'whatsapp', 'sms')
         and a.occurred_at <= now()
         and (a.contact_id = any(v_contacts) or a.company_id = v_company)
       order by a.occurred_at desc, a.id desc
       limit 1
    ),
    'next_task', (
      select jsonb_build_object('id', t.id, 'title', t.title, 'task_type', t.task_type, 'due_at', t.due_at)
        from public.tasks t
       where t.organization_id = p_org
         and t.deleted_at is null
         and t.status = 'open'
         and (t.contact_id = any(v_contacts) or t.company_id = v_company)
       order by t.due_at asc nulls last, t.created_at asc, t.id asc
       limit 1
    ),
    'open_tasks', (
      select count(*)
        from public.tasks t
       where t.organization_id = p_org
         and t.deleted_at is null
         and t.status = 'open'
         and (t.contact_id = any(v_contacts) or t.company_id = v_company)
    )
  );
end;
$$;

-- The company card filters tasks by company_id; without this index that part of
-- the OR read the whole tasks table (contact_id, lead_id and deal_id have one).
create index if not exists tasks_company_idx on public.tasks (company_id) where company_id is not null;

revoke all on function public.record_summary(uuid, text, uuid) from public, anon;
grant execute on function public.record_summary(uuid, text, uuid) to authenticated;
