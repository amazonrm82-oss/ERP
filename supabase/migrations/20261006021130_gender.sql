-- =============================================================================
-- HEB-01: an optional gender on leads and contacts, and gender wordings in WhatsApp templates
-- =============================================================================
-- Spec (SPEC-ADDITIONS, HEB-01, wave 3): an optional gender field on lead and contact: male, female or
-- unknown. A message template may hold a male and a female wording, and the system picks; when the gender
-- is unknown a neutral wording is sent, which the template must include. The system never guesses gender
-- from a name.
-- * leads.gender / contacts.gender: null (not set) | 'male' | 'female' | 'unknown'; check constraints
--   mirrored by GENDERS in src/features/gender/gender.ts (tests/unit/gender.test.ts reads this file).
--   Column grants (leads and contacts have column-level grants: 0038, 0073). Written only by a person
--   (forms, card) or a mapped import column with a closed value list; nothing fills it automatically and
--   no public form asks it. Core: every plan, no plan key (a field, like CON-10's preferences).
-- * Conversion: trigger leads_convert_gender (after converted_at is first set) copies the lead's gender to
--   the contact only when the contact has none (as leads_convert_preferred_channel). convert_lead() unchanged.
-- * Nullable columns: app.sample_row() needs nothing (0121). Merge picks (app.merge_columns,
--   app.merge_move_links) are shared ground and NOT changed here: a follow-up, like preferred_channel.
-- * Card layout: 'gender' joins the built-in keys of leads and contacts (app.card_layout_builtin_keys,
--   redefined from the body of lead_distribution_rules_more 019620 with the one key added per type;
--   CARD_LAYOUT_BUILT_IN mirrors it, test 99).
-- * Template wordings: a block {זכר: ... | נקבה: ... | ניטרלי: ...} (parts in any order, each label once,
--   one level of placeholders inside, no block inside a block). app.template_variant_problem(text) answers
--   null, 'variant' (a malformed block) or 'neutral' (a block without the neutral part); it mirrors
--   templateVariantProblem() in src/features/whatsapp/variants.ts, both run
--   tests/unit/fixtures/gender-variants.json. Trigger whatsapp_templates_variants refuses a new or changed
--   body with a problem, for every writer (hints whatsapp_template:variant | whatsapp_template:neutral).
--   Stored bodies are not judged again; the seeded defaults hold no block. The pick itself is app-only
--   (pickVariants, inside fillTemplate): the message is sent by a person through a wa.me link.
-- Every statement is safe to run twice.

alter table public.leads add column if not exists gender text;
alter table public.contacts add column if not exists gender text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_gender_check' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_gender_check
      check (gender in ('male', 'female', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'contacts_gender_check' and conrelid = 'public.contacts'::regclass) then
    alter table public.contacts add constraint contacts_gender_check
      check (gender in ('male', 'female', 'unknown'));
  end if;
end;
$$;

comment on column public.leads.gender is
  'HEB-01: null (not set) or male | female | unknown (GENDERS in src/features/gender/gender.ts); set only by a person or a mapped import column, never guessed';
comment on column public.contacts.gender is
  'HEB-01: null (not set) or male | female | unknown (GENDERS in src/features/gender/gender.ts); set only by a person or a mapped import column, never guessed';

grant insert (gender), update (gender) on public.leads to authenticated;
grant insert (gender), update (gender) on public.contacts to authenticated;

-- ----------------------------------------------------------------------------
-- Conversion carries the lead's gender to a contact that has none
-- ----------------------------------------------------------------------------
create or replace function app.convert_gender() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.gender is null or new.converted_contact_id is null then
    return null;
  end if;
  update public.contacts c
     set gender = new.gender
   where c.organization_id = new.organization_id
     and c.id = new.converted_contact_id
     and c.gender is null;
  return null;
end;
$$;
revoke all on function app.convert_gender() from public, anon, authenticated;

create or replace trigger leads_convert_gender after update of converted_at on public.leads
  for each row
  when (old.converted_at is null and new.converted_at is not null)
  execute function app.convert_gender();

-- ----------------------------------------------------------------------------
-- Card layout: the built-in keys (body of 019620, plus 'gender' for leads and contacts)
-- ----------------------------------------------------------------------------
create or replace function app.card_layout_builtin_keys(p_type text) returns text[]
language sql immutable
set search_path = ''
as $$
  select case p_type
    when 'lead' then array['full_name', 'phone', 'email', 'company_name', 'source_id', 'requested_product_id',
                           'preferred_channel', 'preferred_locale', 'gender', 'owner_id', 'budget', 'last_contacted_at', 'created_at', 'disqualify_reason']
    when 'contact' then array['full_name', 'phone', 'email', 'job_title', 'company_id', 'type', 'birth_date',
                              'preferred_locale', 'preferred_channel', 'gender', 'source_id', 'owner_id', 'created_at']
    when 'company' then array['type', 'parent_company_id', 'country', 'tax_id', 'industry', 'phone', 'email',
                              'website', 'city', 'address_line', 'owner_id', 'created_at']
    when 'deal' then array['amount', 'contact_id', 'company_id', 'expected_close_date', 'recurring_kind',
                           'recurring_amount', 'recurring_start', 'renewal_date', 'closed_at', 'lost_reason',
                           'competitor', 'owner_id', 'created_at']
    else array[]::text[]
  end
$$;
revoke all on function app.card_layout_builtin_keys(text) from public, anon;
grant execute on function app.card_layout_builtin_keys(text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Gender wordings in a template: the shape rule (= templateVariantProblem in variants.ts)
-- ----------------------------------------------------------------------------
-- A block starts at "{", optional spaces (U+0020 only), a label, optional spaces and ":". Its body runs to
-- the "}" that closes it; one level of other braces (a placeholder) may sit inside, a second level or a
-- block start inside is 'variant'. The body splits on "|" outside a placeholder; each part must start with
-- optional spaces, a label and ":", each label at most once ('variant'); a block without the neutral label
-- is 'neutral'. The first problem in reading order is answered.
create or replace function app.template_variant_problem(p_text text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_start constant text := '^[{] *(זכר|נקבה|ניטרלי) *:';
  v_part constant text := '^ *(זכר|נקבה|ניטרלי) *:';
  v_n integer := char_length(coalesce(p_text, ''));
  v_i integer := 1;
  v_j integer;
  v_depth integer;
  v_close integer;
  v_ch text;
  v_bounds integer[];
  v_k integer;
  v_label text;
  v_seen text[];
begin
  while v_i <= v_n loop
    if substr(p_text, v_i, 1) <> '{' or substr(p_text, v_i) !~ v_start then
      v_i := v_i + 1;
      continue;
    end if;
    v_depth := 0;
    v_close := 0;
    v_bounds := array[v_i];
    v_j := v_i + 1;
    while v_j <= v_n loop
      v_ch := substr(p_text, v_j, 1);
      if v_ch = '{' then
        if v_depth > 0 or substr(p_text, v_j) ~ v_start then
          return 'variant';
        end if;
        v_depth := 1;
      elsif v_ch = '}' then
        if v_depth = 0 then
          v_close := v_j;
          exit;
        end if;
        v_depth := 0;
      elsif v_ch = '|' and v_depth = 0 then
        v_bounds := v_bounds || v_j;
      end if;
      v_j := v_j + 1;
    end loop;
    if v_close = 0 then
      return 'variant';
    end if;
    v_bounds := v_bounds || v_close;
    v_seen := array[]::text[];
    for v_k in 1 .. array_length(v_bounds, 1) - 1 loop
      v_label := substring(substr(p_text, v_bounds[v_k] + 1, v_bounds[v_k + 1] - v_bounds[v_k] - 1) from v_part);
      if v_label is null or v_label = any (v_seen) then
        return 'variant';
      end if;
      v_seen := v_seen || v_label;
    end loop;
    if not ('ניטרלי' = any (v_seen)) then
      return 'neutral';
    end if;
    v_i := v_close + 1;
  end loop;
  return null;
end;
$$;
revoke all on function app.template_variant_problem(text) from public, anon, authenticated;

-- security invoker: a pure check of the row's own text, the same for every writer
create or replace function app.whatsapp_templates_variants() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_problem text;
begin
  if tg_op = 'UPDATE' and new.body is not distinct from old.body then
    return new;
  end if;
  v_problem := app.template_variant_problem(new.body);
  if v_problem = 'neutral' then
    raise exception 'a gender wording needs its neutral part' using errcode = 'P0001', hint = 'whatsapp_template:neutral';
  elsif v_problem is not null then
    raise exception 'a gender wording is malformed' using errcode = 'P0001', hint = 'whatsapp_template:variant';
  end if;
  return new;
end;
$$;
revoke all on function app.whatsapp_templates_variants() from public, anon, authenticated;
-- the trigger runs as the writer (a person), who must be able to call the pure check
grant execute on function app.template_variant_problem(text) to authenticated;

create or replace trigger whatsapp_templates_variants before insert or update of body on public.whatsapp_templates
  for each row execute function app.whatsapp_templates_variants();

notify pgrst, 'reload schema';
