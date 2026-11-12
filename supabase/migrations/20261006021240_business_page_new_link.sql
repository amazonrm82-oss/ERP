-- =============================================================================
-- 021240 BIZ-01: a new link for the business page (owner, 12 November 2026, answer (316) ב)
-- =============================================================================
-- Owners and admins of a writable business may replace the page's secret link ("קישור חדש"): the server makes a new token
-- and the old link answers "not found" at once (every public function looks the page up by its current token). The page's
-- settings, its form and its counters stay; QR codes printed with the old link stop working (the screen says so first).
-- * public.business_page_link_create(org) (definer, authenticated): app.is_admin and app.org_writable, a page that exists
--   (P0002 otherwise); answers the new token; writes one audit entry, action business_page_link, {link: 'created'},
--   without the token (like the other link_create functions).
-- * The row's own audit trigger never sees the token: business_pages_audit is now insert or delete only, and the new
--   business_pages_audit_update runs on an update only when the token is unchanged (only this function changes it; no
--   client holds a grant on the column). An update that changes the token alone is recorded by the function's own entry.
-- Safe to run twice. No drop statement, no row removal.

create or replace function public.business_page_link_create(p_org uuid) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_page uuid;
  v_token text;
begin
  if not app.is_admin(p_org) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_writable(p_org) then
    raise exception 'the organization is read-only' using errcode = 'P0001', hint = 'org:read_only';
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '');
  update public.business_pages b set token = v_token
   where b.organization_id = p_org
  returning b.id into v_page;
  if v_page is null then
    raise exception 'the business has no page yet' using errcode = 'P0002';
  end if;
  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, auth.uid(), 'business_page_link', 'business_pages', v_page, jsonb_build_object('link', 'created'));
  return v_token;
end;
$$;
revoke all on function public.business_page_link_create(uuid) from public, anon;
grant execute on function public.business_page_link_create(uuid) to authenticated;

-- the row's audit never carries the token
create or replace trigger business_pages_audit after insert or delete on public.business_pages
  for each row execute function app.audit_row();
create or replace trigger business_pages_audit_update after update on public.business_pages
  for each row when (old.token is not distinct from new.token) execute function app.audit_row();
