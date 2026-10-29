-- =============================================================================
-- COL-03, owner's answers of 29 October 2026 (DECISIONS.md "הבטחת תשלום ללקוח: פרטים"): (5) א, (6) ב, (7) א, (8) ב.
-- =============================================================================
-- * (6) ב: a customer promise covers EVERY open debt document of the customer (BAL-02's scope, app.customer_open_documents),
--   also those the person making it cannot read. The cover trigger app.payment_promises_cover is now security DEFINER, so
--   app.customer_open_documents (invoker) and money_allocation_state read every row; app.payment_promise_cover (definer) still
--   refuses a caller who may not record payments in a writable business and re-checks every id. Neither app function is called
--   by a person any more: their execute grants to authenticated are taken back (app is not in the API anyway).
--   Only the trigger's own refusals are seen by the person: `payment_promise:nothing_open` now means the CUSTOMER has nothing
--   open, whoever reads what.
-- * The person sees how many documents a customer promise covers, never which: public.payment_promise_coverage(org, promises)
--   (invoker; for a caller who records payments, app.can_record_payments) keeps the promises the caller reads under RLS and asks
--   the definer app.payment_promise_covered_counts (counts only, no ids, no amounts) for their sizes. A count tells a recorder
--   that the customer has more open debt documents than they read (the owner asked for it: answer (6)); nothing else.
-- * (5) א: the "ההבטחה לא קוימה" notice of a CUSTOMER promise goes to the contact's or the company's owner while usable (an
--   active member who is not a viewer), else to the person who recorded the promise (`created_by`) while usable, else (no usable
--   one) to every active owner and admin as before. A document promise keeps its rule (MNY-01's owner, else owners and admins).
--   app.send_promise_breaks is otherwise unchanged (copied from 021099).
-- * (7) א: already built (app.document_promise: the newest customer promise covering a document wins); not changed.
-- * (8) ב: app only (the contact's and the company's card record the customer promise); the rights are the table's, unchanged.
-- Every statement is safe to run twice. No object or row is removed.

create or replace function app.payment_promises_cover() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_open uuid[];
begin
  if new.document_id is not null then
    return null;
  end if;
  -- answer (6) ב: every open document of the customer, whoever made the promise (definer: every row is read)
  v_open := app.customer_open_documents(new.organization_id, new.contact_id, new.company_id);
  if cardinality(v_open) = 0 or app.payment_promise_cover(new.organization_id, new.id, v_open) = 0 then
    raise exception 'the customer has no open debt to promise for' using errcode = 'P0001', hint = 'payment_promise:nothing_open';
  end if;
  return null;
end;
$$;
revoke all on function app.payment_promises_cover() from public, anon, authenticated, service_role;

-- the cover trigger is a definer now: nobody else calls these two
revoke all on function app.customer_open_documents(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function app.payment_promise_cover(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;

-- How many documents each customer promise covered (counts only). Definer, for a caller who records payments; called by
-- public.payment_promise_coverage with the promises the caller reads.
create or replace function app.payment_promise_covered_counts(p_org uuid, p_promises uuid[])
returns table (promise_id uuid, documents integer)
language sql stable security definer
set search_path = ''
as $$
  select p.id, (select count(*)::integer from public.payment_promise_documents c
                 where c.organization_id = p_org and c.promise_id = p.id)
    from public.payment_promises p
   where p.organization_id = p_org and p.id = any (coalesce(p_promises, '{}'))
     and p.document_id is null
     and app.can_record_payments(p_org);
$$;
revoke all on function app.payment_promise_covered_counts(uuid, uuid[]) from public, anon, service_role;
-- the invoker public.payment_promise_coverage runs as the person; app is not in the API
grant execute on function app.payment_promise_covered_counts(uuid, uuid[]) to authenticated;

-- The number of documents each customer promise the caller reads covers: [{promise_id, documents}] (never which ones).
-- Invoker: RLS picks the promises; empty for a caller who does not record payments.
create or replace function public.payment_promise_coverage(p_org uuid, p_promises uuid[])
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('promise_id', c.promise_id, 'documents', c.documents) order by c.promise_id), '[]'::jsonb)
    from app.payment_promise_covered_counts(
           p_org,
           array(select p.id from public.payment_promises p
                  where p.organization_id = p_org and p.id = any (coalesce(p_promises, '{}')) and p.document_id is null
                  limit 200)) c;
$$;
revoke all on function public.payment_promise_coverage(uuid, uuid[]) from public, anon;
grant execute on function public.payment_promise_coverage(uuid, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- A promise not kept: answer (5) א for customer promises
-- ----------------------------------------------------------------------------
create or replace function app.send_promise_breaks() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_docs uuid[];
  v_open boolean;
  v_rep uuid;
  v_recorder uuid;
  v_to uuid;
  v_body text;
  v_entity_type text;
  v_entity uuid;
  v_done integer := 0;
begin
  for v_row in
    select z.* from (
      select p.organization_id, p.id, p.promised_date, p.document_id, p.contact_id, p.company_id, p.created_by,
             j.last_attempt_at,
             -- a promise that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by p.organization_id
                                order by j.last_attempt_at nulls first, p.promised_date, p.id) as n
        from public.payment_promises p
        join public.organizations o on o.id = p.organization_id
        left join app.payment_promise_judged j on j.promise_id = p.id and j.promised_date = p.promised_date
       where p.promised_date < (now() at time zone app.intake_zone(o.timezone))::date
         and (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00'
         and app.org_writable(p.organization_id)
         and (j.promise_id is null or (j.kept is null and j.failures < 3))
    ) z
     where z.n <= app.promise_break_per_org()
     order by z.last_attempt_at nulls first, z.organization_id, z.promised_date, z.id
     limit app.promise_break_limit()
  loop
    begin
      -- the documents this promise speaks for: its own document, or the covered ones whose effective promise is still this
      -- one (a covered document with its own promise is judged by that promise)
      v_docs := case when v_row.document_id is not null then array[v_row.document_id]
                     else array(select c.document_id from public.payment_promise_documents c
                                 where c.organization_id = v_row.organization_id and c.promise_id = v_row.id
                                   and app.document_promise(v_row.organization_id, c.document_id) = v_row.id) end;
      -- a proforma billed by an active tax invoice owes through that invoice (PAY-02): judge the invoice's balance
      v_docs := array(select coalesce((select i.id from public.accounting_documents i
                                        where i.organization_id = v_row.organization_id and i.proforma_id = d.id
                                          and i.status = 'active' and d.doc_type = 'proforma'
                                        order by i.created_at, i.id limit 1), d.id)
                        from public.accounting_documents d
                       where d.organization_id = v_row.organization_id and d.id = any (v_docs));
      -- still owed: an active covered document with a balance (money_allocation_state, every allocation counted)
      select exists (
        select 1
          from jsonb_array_elements(public.money_allocation_state(v_row.organization_id,
                 array(select d.id from public.accounting_documents d
                        where d.organization_id = v_row.organization_id and d.id = any (v_docs) and d.status = 'active'),
                 '{}'::uuid[]) -> 'documents') x
         where coalesce((x ->> 'balance')::bigint, 0) > 0)
        into v_open;
      insert into app.payment_promise_judged (promise_id, promised_date, kept, judged_at)
      values (v_row.id, v_row.promised_date, not v_open, now())
      on conflict (promise_id, promised_date) do update set kept = excluded.kept, judged_at = excluded.judged_at;
      if v_open then
        v_recorder := null;
        if v_row.document_id is not null then
          select coalesce(dl.owner_id, ct.owner_id, co.owner_id),
                 app.document_type_label(d.doc_type) || coalesce(' ' || d.number, ''),
                 case when d.deal_id is not null then 'deal' when d.contact_id is not null then 'contact' when d.company_id is not null then 'company' end,
                 coalesce(d.deal_id, d.contact_id, d.company_id)
            into v_rep, v_body, v_entity_type, v_entity
            from public.accounting_documents d
            left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
            left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
            left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
           where d.organization_id = v_row.organization_id and d.id = v_row.document_id;
        elsif v_row.company_id is not null then
          select co.owner_id into v_rep from public.companies co where co.organization_id = v_row.organization_id and co.id = v_row.company_id;
          v_body := 'הבטחת תשלום על החובות של הלקוח';
          v_entity_type := 'company';
          v_entity := v_row.company_id;
          -- answer (5) א: no usable owner = the person who recorded the promise
          v_recorder := v_row.created_by;
        else
          select ct.owner_id into v_rep from public.contacts ct where ct.organization_id = v_row.organization_id and ct.id = v_row.contact_id;
          v_body := 'הבטחת תשלום על החובות של הלקוח';
          v_entity_type := 'contact';
          v_entity := v_row.contact_id;
          v_recorder := v_row.created_by;
        end if;
        -- the first usable one (an active member who is not a viewer): the rep, else (customer promises) the recorder
        v_to := coalesce(
          (select m.user_id from public.memberships m
            where m.organization_id = v_row.organization_id and m.user_id = v_rep and m.status = 'active' and m.role <> 'viewer'),
          (select m.user_id from public.memberships m
            where m.organization_id = v_row.organization_id and m.user_id = v_recorder and m.status = 'active' and m.role <> 'viewer'));
        insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
        select v_row.organization_id, r.user_id, 'payment', 'ההבטחה לא קוימה', v_body, v_entity_type, v_entity
          from (
            select v_to as user_id where v_to is not null
            union
            select m.user_id from public.memberships m
             where v_to is null and m.organization_id = v_row.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
          ) r;
      end if;
      v_done := v_done + 1;
    exception when others then
      -- this promise is judged again on a later run, after the fresh ones; after 3 failures it is skipped. One redacted line:
      -- the promise id and the SQLSTATE only
      insert into app.payment_promise_judged (promise_id, promised_date, failures, last_attempt_at)
      values (v_row.id, v_row.promised_date, 1, now())
      on conflict (promise_id, promised_date)
        do update set failures = app.payment_promise_judged.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-promise-breaks: promise % failed (SQLSTATE %)%', v_row.id, sqlstate,
        case when coalesce((select j.failures from app.payment_promise_judged j
                             where j.promise_id = v_row.id and j.promised_date = v_row.promised_date), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_promise_breaks() from public, anon, authenticated, service_role;
