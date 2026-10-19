-- RVW-34 (review of 19 October 2026, medium): the notices about a quote (accepted or declined, viewed, expired) went only to
-- the quote's owner while an active member, so after a rep left nobody heard of a customer's answer.
--
-- app.quote_notice_recipients(quote) is the one rule: the quote's owner while an active member; else the current owner of the
-- quote's deal; else, for a quote with no deal only, the current owner of its contact (with a deal, quotes_select decides by
-- the deal, so the contact's owner might not read the quote); each while an active member and, at those two steps, not a
-- viewer; else every active owner and admin of the business (the SPD-01 fallback). public.quote_public_decide (from 020420), app.quote_mark_viewed (from 020390) and app.expire_quotes (from 020415)
-- send to it; the content is unchanged (number and title, no customer name, no amounts).

create or replace function app.quote_notice_recipients(p_quote public.quotes) returns setof uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  -- the quote's owner, else the deal's current owner, else (a quote with no deal only: quotes_select decides by the deal when
  -- there is one, so the contact's owner might not read it) the contact's: the first that is an active member, and at the
  -- deal and contact steps not a viewer
  select u into v_user
    from (values (1, p_quote.owner_id),
                 (2, (select d.owner_id from public.deals d where d.organization_id = p_quote.organization_id and d.id = p_quote.deal_id)),
                 (3, (select c.owner_id from public.contacts c
                       where p_quote.deal_id is null and c.organization_id = p_quote.organization_id and c.id = p_quote.contact_id))
         ) as c(n, u)
   where u is not null
     and exists (select 1 from public.memberships m
                  where m.organization_id = p_quote.organization_id and m.user_id = c.u and m.status = 'active'
                    and (c.n = 1 or m.role <> 'viewer'))
   order by n
   limit 1;
  if v_user is not null then
    return next v_user;
    return;
  end if;
  return query
    select m.user_id from public.memberships m
     where m.organization_id = p_quote.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
     order by m.user_id;
end;
$$;
revoke all on function app.quote_notice_recipients(public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The customer's answer (the body of 020420)
-- ----------------------------------------------------------------------------
create or replace function public.quote_public_decide(
  p_token text, p_decision text, p_fingerprint text,
  p_signer_name text default null, p_id_number text default null,
  p_signature_kind text default null, p_signature_image text default null,
  p_wording_version text default null, p_agreed boolean default false,
  p_decline_reason text default null, p_ip text default null, p_user_agent text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_link app.quote_links;
  v_quote public.quotes;
  v_views integer;
  v_tries integer;
  v_shown public.quotes;
  v_name text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_id text := nullif(regexp_replace(coalesce(p_id_number, ''), '[^0-9]', '', 'g'), '');
  v_reason text := nullif(btrim(coalesce(p_decline_reason, '')), '');
begin
  if coalesce(p_token, '') !~ '^[A-Za-z0-9_-]{64}$' then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_link from app.quote_links l where l.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_link.organization_id and q.id = v_link.quote_id;
  if not found or not app.quote_link_open(v_quote)
     or not app.org_public_pages_open(v_quote.organization_id)
     or not app.org_has_feature(v_quote.organization_id, 'quotes') then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;

  -- counted first, in the link's view window and in a window of its own (10 tries in 10 minutes)
  update app.quote_links l
     set window_started_at = case when l.window_started_at > now() - interval '10 minutes' then l.window_started_at else now() end,
         window_count = case when l.window_started_at > now() - interval '10 minutes' then l.window_count + 1 else 1 end,
         decide_window_started_at = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_window_started_at else now() end,
         decide_count = case when l.decide_window_started_at > now() - interval '10 minutes' then l.decide_count + 1 else 1 end
   where l.quote_id = v_link.quote_id
  returning l.window_count, l.decide_count into v_views, v_tries;
  if v_views > 120 or v_tries > 10 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  -- the version the page shows (QUO-12), locked against a second decision in parallel; a newer version that was sent and is
  -- now closed closes the old link too (QUO-11 review): the superseded quote is never decided on
  v_shown := app.quote_shown_version(v_quote);
  if not app.quote_link_shows(v_quote, v_shown) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  select * into v_quote from public.quotes q where q.organization_id = v_shown.organization_id and q.id = v_shown.id for update;
  if not app.quote_link_open(v_quote) then
    raise exception 'quote not found' using errcode = 'P0002';
  end if;
  -- re-read after the lock: a newer version sent while this call waited (its send held this quote FOR SHARE) means the page
  -- the customer answered is no longer the one shown
  if (app.quote_shown_version(v_quote)).id is distinct from v_quote.id then
    return jsonb_build_object('status', 'changed');
  end if;
  if v_quote.status not in ('sent', 'viewed') then
    return jsonb_build_object('status', 'already_decided', 'decision', v_quote.status);
  end if;
  if p_fingerprint is distinct from app.quote_fingerprint(v_quote) then
    return jsonb_build_object('status', 'changed');
  end if;

  if p_decision = 'accepted' then
    if not coalesce(p_agreed, false) or v_name is null or char_length(v_name) not between 2 and 120
       or coalesce(p_wording_version, '') !~ '^[a-z0-9-]{1,40}$'
       or p_signature_kind not in ('drawn', 'typed')
       or (p_signature_kind = 'drawn' and (p_signature_image is null or char_length(p_signature_image) > 300000
                                           or p_signature_image !~ '^data:image/png;base64,[A-Za-z0-9+/]+=*$'))
       or (v_id is not null and not app.valid_israeli_id(v_id)) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, signer_id_number, signature_kind,
                                        signature_image, wording_version, content_sha256, ip, user_agent)
    values (v_quote.organization_id, v_quote.id, 'accepted', v_name, v_id, p_signature_kind,
            case when p_signature_kind = 'drawn' then p_signature_image end, p_wording_version, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500));
  elsif p_decision = 'rejected' then
    if (v_reason is not null and char_length(v_reason) > 1000) or (v_name is not null and char_length(v_name) not between 2 and 120) then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.quote_decisions (organization_id, quote_id, decision, signer_name, content_sha256, ip, user_agent, decline_reason)
    values (v_quote.organization_id, v_quote.id, 'rejected', v_name, p_fingerprint,
            left(nullif(btrim(coalesce(p_ip, '')), ''), 64), left(nullif(btrim(coalesce(p_user_agent, '')), ''), 500), v_reason);
  else
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.quotes q set status = p_decision
   where q.organization_id = v_quote.organization_id and q.id = v_quote.id;

  -- the quote's owner hears of it (kind `quote`, coordinator 18 October 2026): number and title, no amounts
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_quote.organization_id, r.user_id, 'quote',
         left(case when p_decision = 'accepted' then 'הצעת מחיר אושרה: ' else 'הצעת מחיר נדחתה: ' end || v_quote.title, 200),
         case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end,
         'quote', v_quote.id
    from app.quote_notice_recipients(v_quote) r(user_id);
  return jsonb_build_object('status', p_decision);
end;
$$;
revoke all on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.quote_public_decide(text, text, text, text, text, text, text, text, boolean, text, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- The first view (the body of 020390)
-- ----------------------------------------------------------------------------
create or replace function app.quote_mark_viewed(p_quote public.quotes) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_first public.quotes;
begin
  if p_quote.id is null then
    return false;
  end if;
  insert into public.quote_views as v (organization_id, quote_id)
  values (p_quote.organization_id, p_quote.id)
  on conflict (organization_id, quote_id) do update
    set last_viewed_at = now(), view_count = v.view_count + 1;

  -- the first view of a sent quote: once, even when two views arrive together
  update public.quotes q set status = 'viewed'
   where q.organization_id = p_quote.organization_id and q.id = p_quote.id and q.status = 'sent'
  returning q.* into v_first;
  if v_first.id is null then
    return false;
  end if;

  -- RVW-34: the owner, else the record's current owner, else the owners and admins (app.quote_notice_recipients)
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select v_first.organization_id, r.user_id, 'quote_viewed',
         'הלקוח פתח את הצעת המחיר' || coalesce(' ' || v_first.number_display, ''),
         -- no personal data: a later privacy erasure does not reach notification bodies
         nullif(btrim(coalesce(v_first.title, '')), ''),
         'quote', v_first.id
    from app.quote_notice_recipients(v_first) r(user_id);
  return true;
end;
$$;
revoke all on function app.quote_mark_viewed(public.quotes) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Expiry (the body of 020415)
-- ----------------------------------------------------------------------------
create or replace function app.expire_quotes() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_quote public.quotes;
  v_done integer := 0;
begin
  for v_row in
    select d.organization_id, d.id
      from (
        select q.organization_id, q.id, q.valid_until,
               row_number() over (partition by q.organization_id order by q.valid_until, q.id) as n
          from public.quotes q
          join public.organizations o on o.id = q.organization_id
         where q.status in ('sent', 'viewed')
           and q.valid_until is not null
           and q.valid_until < (now() at time zone app.intake_zone(o.timezone))::date
           and not exists (select 1 from app.quote_expiry_retry r where r.quote_id = q.id and r.done_at is null and r.retry_at > now())
      ) d
     where d.n <= app.quote_expiry_per_org()
     order by d.valid_until, d.id
     limit app.quote_expiry_limit()
  loop
    begin
      -- a quote being decided or cancelled right now is left for the next run
      select * into v_quote from public.quotes q
       where q.organization_id = v_row.organization_id and q.id = v_row.id and q.status in ('sent', 'viewed')
       for update skip locked;
      if found then
        update public.quotes q set status = 'expired' where q.organization_id = v_quote.organization_id and q.id = v_quote.id;
        insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
        select v_quote.organization_id, r.user_id, 'quote', left('פג תוקפה של הצעת מחיר: ' || v_quote.title, 200),
               case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end, 'quote', v_quote.id
          from app.quote_notice_recipients(v_quote) r(user_id);
        update app.quote_expiry_retry r set done_at = now() where r.quote_id = v_quote.id and r.done_at is null;
        v_done := v_done + 1;
      end if;
    exception when others then
      -- this quote's changes are rolled back; it waits an hour, the others go on
      insert into app.quote_expiry_retry (quote_id, retry_at) values (v_row.id, now() + interval '1 hour')
      on conflict (quote_id) do update set retry_at = excluded.retry_at, done_at = null;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.expire_quotes() from public, anon, authenticated, service_role;
