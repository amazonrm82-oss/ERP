-- QUO-05: the design of a quote as the customer sees it (on paper, and later in the PDF of QUO-06 and the
-- customer page of QUO-08): logo, colour, header and footer, and the business details.
--
-- public.quote_designs   one row per business (no row = the defaults):
--   header_text             a line or two above the quote (≤ 500), e.g. a slogan or "הצעה בתוקף 30 יום"
--   footer_text             the bottom of every page (≤ 1000), e.g. bank details or a thank-you
--   show_logo               the FLD-04 logo of the business (organizations.logo_path), default on
--   show_business_details   the details of TAX-02 (registered name, number, address, phone, email), default on
--   accent_color            '#rrggbb' for the quote only; null = the business colour (organizations.brand_color)
-- The logo, the colour and the business details themselves stay where they are (FLD-04, TAX-02): the design
-- only says whether and how they appear, so a change there shows on every quote that has not been sent yet.
-- Hebrew only; English is wave 4.
--
-- Rights like the other document settings (org_document_settings): every member reads; owners and admins of a
-- writable business write. No plan key: it is part of quotes.
--
-- Every statement is safe to run twice. No drops, no row removal.

create table if not exists public.quote_designs (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  header_text            text check (header_text is null or char_length(btrim(header_text)) between 1 and 500),
  footer_text            text check (footer_text is null or char_length(btrim(footer_text)) between 1 and 1000),
  show_logo              boolean not null default true,
  show_business_details  boolean not null default true,
  accent_color           text check (accent_color is null or accent_color ~ '^#[0-9a-f]{6}$'),
  updated_by             uuid references auth.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id)
);

create or replace trigger quote_designs_touch before insert or update on public.quote_designs
  for each row execute function app.touch_row();
create or replace trigger quote_designs_audit after insert or update or delete on public.quote_designs
  for each row execute function app.audit_row();

alter table public.quote_designs enable row level security;
revoke all on public.quote_designs from anon, authenticated;
grant select on public.quote_designs to authenticated;
grant insert (organization_id, header_text, footer_text, show_logo, show_business_details, accent_color)
  on public.quote_designs to authenticated;
grant update (header_text, footer_text, show_logo, show_business_details, accent_color)
  on public.quote_designs to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_designs' and policyname = 'quote_designs_select') then
    create policy quote_designs_select on public.quote_designs for select to authenticated
      using (app.is_member(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_designs' and policyname = 'quote_designs_insert') then
    create policy quote_designs_insert on public.quote_designs for insert to authenticated
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'quote_designs' and policyname = 'quote_designs_update') then
    create policy quote_designs_update on public.quote_designs for update to authenticated
      using (app.is_admin(organization_id) and app.org_writable(organization_id))
      with check (app.is_admin(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;
