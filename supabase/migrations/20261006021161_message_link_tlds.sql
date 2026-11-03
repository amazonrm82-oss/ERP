-- =============================================================================
-- MSG-02 follow-up: which endings make a link, and the business's email in a service message (owner's answers (110) ב and
-- (111) ב, 3 November 2026)
-- =============================================================================
-- (110) ב: only a domain ending from a CLOSED LIST counts as a link. Until now app.message_domain_suffix took any last label
--   of 2..63 ASCII letters, so "Mr.Cohen", "St.Louis" and "today.Tomorrow" were links (021160 listed them as accepted false
--   alarms). Now the last label must be on app.message_link_tld (generic endings and country codes common in Israel and the
--   world, mirrored by LINK_TLDS between the markers link-tlds:start/end in src/features/message-templates/service-rule.ts;
--   unit test), or be a punycode label xn--... (never ordinary text, so it stays a link). Israel's second levels (co.il,
--   org.il, net.il, ac.il, gov.il, muni.il, k12.il, idf.il) need no entry: "il" is on the list, and the own domain's
--   registered domain is still app.registered_domain. Unchanged: "www." and every "http(s)://" are judged whatever the
--   ending (so www.x.pdf and https://x.local are links), an IPv4 address is a link, an ending glued to Hebrew or Arabic
--   letters ("evil.comשלום") is its ASCII part, and app.message_file_extension still names a file (none of its entries is on
--   the list). The list is generous but closed: a new ending is added by a migration and in the TS list together.
--   Accepted: a domain whose ending is not on the list ("x.museum", "x.ninja") is not seen without "www." or a scheme.
-- (111) ב: an email address in a SERVICE message is allowed only when its domain is the business's own (the (105) rule,
--   app.message_host_own: the website's registered domain and every host under it, or exactly the site under a shared
--   host) or it is the business's own email from its business details (org_document_settings.email; organizations has
--   no email column). Any other well-formed address is an external link. Marketing templates are still not judged.
--   * A token that is exactly local@domain (app.message_token_link) is a link when its local part looks like a host
--     (app.message_local_host: "www.", IPv4, or a label after a dot starting with a listed ending: "evil.com@",
--     "evil.com.@", "evil.com-x@", "evil..com@", "1.2.3.4@"); else it is allowed when its domain is the business's own, or when
--     it equals, ASCII letters folded (app.message_ascii_lower = asciiLower()), the business's email, and that email is a
--     plain address (app.message_plain_email = plainBusinessEmail(): local part of letters, digits, "." and "-", no "..",
--     that does not look like a host, domain on the ending list). A stored email that is not plain ("https://evil.com/x@y.co", one with "_"
--     or "+" in the local part) never counts, and the scheme scan runs first and knows nothing of it, so
--     "https://info@gmail.com" stays a link. Accepted: a business email with "_", "%" or "+" is not recognized (its
--     address stays a link unless it is on the own domain), since those characters split tokens.
--   * The full rules take the business email as a new last argument, with no defaults: app.message_external_link(text,
--     own_domain, business_email), app.message_token_link(token, own, business_email) and app.message_template_problem(channel, type, subject, body, own_domain,
--     business_email). 021160's forms stay, as thin wrappers that pass no business email (two forms of one name, never
--     both able to take the same call). Not the rename of CLAUDE.md "Changing a function's signature without drop" on
--     purpose: the database tests re-run 021160 through rerunClosure (it grants on organizations), and a re-run would
--     bring the old signatures back as new functions after every rename; with the wrappers a re-run of 021160 only puts
--     its old bodies back, and re-running this file after it restores the wrappers. RE-RUNNING 021159 OR 021160
--     REQUIRES RE-RUNNING THIS FILE AFTER IT. app.message_template_sendable passes the website's domain and
--     org_document_settings.email.
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- (110) The closed list of endings (mirrored between its markers in service-rule.ts; unit test)
-- ----------------------------------------------------------------------------
create or replace function app.message_link_tld(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p = any (array[
    -- link-tlds:start
    'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'app', 'dev', 'ai', 'me', 'tv', 'xyz', 'online', 'site', 'website',
    'store', 'shop', 'tech', 'link', 'live', 'club', 'top', 'pro', 'cloud', 'edu', 'gov', 'mil', 'int', 'mobi', 'name',
    'space', 'blog', 'news', 'media', 'agency', 'digital', 'email', 'solutions', 'services', 'studio', 'design', 'page',
    'network', 'group', 'company', 'center', 'academy', 'software', 'systems', 'marketing', 'business', 'finance', 'bank',
    'health', 'travel', 'games', 'social', 'wiki', 'host', 'vip', 'global', 'zip', 'mov', 'ly', 'gg', 'cc', 'ws', 'to',
    'la', 'fm', 'sh', 'ac', 'gl', 'gd', 'gy', 'im', 'nu', 'tk', 'il', 'us', 'uk', 'de', 'fr', 'ru', 'ua', 'es', 'it', 'nl',
    'eu', 'ca', 'au', 'in', 'cn', 'jp', 'br', 'ch', 'at', 'be', 'se', 'no', 'dk', 'fi', 'pl', 'pt', 'gr', 'tr', 'ie', 'cz',
    'hu', 'ro', 'bg', 'sk', 'si', 'hr', 'rs', 'lt', 'lv', 'ee', 'by', 'kz', 'ge', 'am', 'az', 'md', 'ae', 'sa', 'eg', 'jo',
    'ma', 'za', 'ng', 'ke', 'mx', 'ar', 'cl', 'pe', 've', 'nz', 'sg', 'hk', 'tw', 'kr', 'th', 'vn', 'my', 'id', 'ph', 'pk',
    'cy', 'mt', 'lu', 'is', 'li', 'ps', 'su', 'uz', 'icu', 'cfd', 'sbs', 'lat', 'pw', 'ml', 'ga', 'cf', 'gq', 'cam', 'cyou',
    'ir', 'iq', 'lb'
    -- link-tlds:end
  ]::text[]);
$$;
revoke all on function app.message_link_tld(text) from public, anon, authenticated;

-- the domain a lower-case part ends in: the right-most valid labels before a last label on the closed list (or a punycode
-- label) that is not a file extension; null when there is none (021160's body with the closed list)
create or replace function app.message_domain_suffix(p text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_labels text[] := string_to_array(coalesce(p, ''), '.');
  v_n integer := cardinality(string_to_array(coalesce(p, ''), '.'));
  v_len integer;
  v_from integer;
begin
  if v_n < 2 then
    return null;
  end if;
  -- a top-level label glued to Hebrew or Arabic letters ("evil.comשלום") is its ASCII part
  v_labels[v_n] := regexp_replace(v_labels[v_n], '^([a-z]{2,63})[א-תء-ي]+$', '\1');
  -- owner (110) ב: only an ending on the closed list, or punycode
  if not (app.message_link_tld(v_labels[v_n]) or v_labels[v_n] ~ '^xn--[a-z0-9-]{1,59}$')
     or app.message_file_extension(v_labels[v_n]) then
    return null;
  end if;
  v_len := char_length(v_labels[v_n]);
  v_from := v_n;
  for i in reverse v_n - 1 .. 1 loop
    exit when char_length(v_labels[i]) not between 1 and 63
           or v_labels[i] !~ '^[a-z0-9א-תء-ي]([a-z0-9א-תء-ي-]*[a-z0-9א-תء-ي])?$'
           or v_len + 1 + char_length(v_labels[i]) > 253;
    v_len := v_len + 1 + char_length(v_labels[i]);
    v_from := i;
  end loop;
  if v_from = v_n then
    return null;
  end if;
  return array_to_string(v_labels[v_from:v_n], '.');
end;
$$;
revoke all on function app.message_domain_suffix(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- (111) Email addresses
-- ----------------------------------------------------------------------------
-- ASCII letters to lower case, nothing else (one to one, the same in every locale). Mirrors asciiLower().
create or replace function app.message_ascii_lower(p text) returns text
language sql immutable
set search_path = ''
as $$
  select translate(p, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
$$;
revoke all on function app.message_ascii_lower(text) from public, anon, authenticated;

-- an address's local part looks like a host (re-review of 5fb474a): trimmed of "." and "-", it starts with "www.", is an
-- IPv4 address, or a label after a dot starts with a listed ending (its leading letters and digits) or with xn--
-- ("evil.com.", "evil.com-x", "evil..com", "evil.com.x", "1.2.3.4"). Mirrors localPartHost().
create or replace function app.message_local_host(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select x.v like 'www.%'
      or (x.v ~ '^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$'
          and (select bool_and(o::integer <= 255) from unnest(string_to_array(x.v, '.')) o))
      or exists (select 1 from unnest((string_to_array(x.v, '.'))[2:]) l
                  where l like 'xn--%' or coalesce(app.message_link_tld(substring(l from '^[a-z0-9]+')), false))
  from (select btrim(app.message_ascii_lower(coalesce(p, '')), '.-') as v) x;
$$;
revoke all on function app.message_local_host(text) from public, anon, authenticated;

-- the business's email, ASCII letters folded, when it is a plain address: a local part of letters, digits, "." and "-"
-- (not at either end) that is no host itself (no "www.", no domain on the ending list), and a domain on the ending list;
-- else null (review of 7fe2fa4, items 1 and 2: a stored "https://evil.com/x@y.co" never counts). Mirrors plainBusinessEmail().
create or replace function app.message_plain_email(p text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when x.v ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?@[^@]+$'
         and app.message_domain_suffix(split_part(x.v, '@', 2)) = split_part(x.v, '@', 2)
         and position('..' in x.v) = 0
         and not app.message_local_host(split_part(x.v, '@', 1))
         and app.message_domain_suffix(split_part(x.v, '@', 1)) is null
      then x.v
  end
  from (select app.message_ascii_lower(btrim(coalesce(p, ''))) as v) x;
$$;
revoke all on function app.message_plain_email(text) from public, anon, authenticated;

-- one token: an email address (exactly local@domain, a Hebrew or Arabic prefix with a hyphen and "." "-" at both ends cut
-- off) is a link when its local part is itself a host ("www.", or a domain on the ending list), else allowed when it is
-- the business's plain email (p_business_email, already through app.message_plain_email) or its domain is the
-- business's own; any other token: each "@"-free part. Mirrors tokenLink(). (The full rule; three arguments and no
-- defaults, beside 021160's two-argument form below.)
create or replace function app.message_token_link(p_token text, p_own text, p_business_email text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v text := btrim(regexp_replace(app.message_ascii_lower(coalesce(p_token, '')), '^[א-תء-ي]+-', ''), '.-');
  v_local text;
  v_domain text;
begin
  if v ~ '^[^@]+@[^@]+$' then
    v_local := split_part(v, '@', 1);
    v_domain := split_part(v, '@', 2);
    if app.message_domain_suffix(v_domain) = v_domain then
      if app.message_local_host(v_local) or app.message_domain_suffix(v_local) is not null then
        return true;
      end if;
      if v = p_business_email then
        return false;
      end if;
      return not app.message_host_own(v_domain, p_own);
    end if;
  end if;
  return exists (select 1 from unnest(string_to_array(p_token, '@')) part where app.message_part_link(part, p_own));
end;
$$;
revoke all on function app.message_token_link(text, text, text) from public, anon, authenticated;

-- 021160's form, kept for its callers: no business email
create or replace function app.message_token_link(p_token text, p_own text) returns boolean
language sql immutable
set search_path = ''
as $$
  select app.message_token_link(p_token, p_own, null::text);
$$;
revoke all on function app.message_token_link(text, text) from public, anon, authenticated;

-- true when the text holds a link that is not the business's own domain or its own email. Mirrors messageExternalLink().
-- (the full rule; three arguments and no defaults, so it never competes with 021160's two-argument form below)
create or replace function app.message_external_link(p_text text, p_own_domain text, p_business_email text)
returns boolean
language sql immutable
set search_path = ''
as $$
  -- NFKC first (fullwidth Latin and digits become ASCII), then invisible format characters are taken out (soft hyphen,
  -- zero-width space and joiners, word joiner, BOM, the direction marks, embeddings and isolates: browsers drop them), and
  -- the ideographic dots are dots. The scheme scan comes first and knows nothing of the business email, so
  -- "https://info@gmail.com" stays a link; only a token judged by app.message_token_link may be the business email.
  with t as (select translate(translate(normalize(coalesce(p_text, ''), NFKC),
                                        chr(173) || chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207) || chr(8234)
                                          || chr(8235) || chr(8236) || chr(8237) || chr(8238) || chr(8288) || chr(8294)
                                          || chr(8295) || chr(8296) || chr(8297) || chr(65279), ''),
                              '。．｡', '...') as v,
                    lower(btrim(coalesce(p_own_domain, ''))) as own,
                    app.message_plain_email(p_business_email) as email)
  select exists (select 1 from t, regexp_matches(t.v, 'https?://([^ \t\r\n/?#\\]*)', 'gi') as m
                  where app.message_authority_link(m[1], t.own))
      or exists (select 1 from t, regexp_matches(t.v, '[A-Za-z0-9.@א-תء-ي-]+', 'g') as k
                  where app.message_token_link(k[1], t.own, t.email));
$$;
revoke all on function app.message_external_link(text, text, text) from public, anon, authenticated;

-- 021160's form, kept for its callers: no business email
create or replace function app.message_external_link(p_text text, p_own_domain text default null) returns boolean
language sql immutable
set search_path = ''
as $$
  select app.message_external_link(p_text, p_own_domain, null::text);
$$;
revoke all on function app.message_external_link(text, text) from public, anon, authenticated;

-- THE template rule, now with the business email (six arguments and no defaults, beside 021160's five-argument form)
create or replace function app.message_template_problem(p_channel text, p_message_type text, p_subject text, p_body text,
                                                        p_own_domain text, p_business_email text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_fields text[];
  v_text text := coalesce(p_subject, '') || chr(10) || coalesce(p_body, '');
begin
  if not (coalesce(p_message_type, '') = any (app.service_message_types())) then
    return null;
  end if;
  v_fields := coalesce(app.message_type_fields(p_message_type), '{}'::text[]);
  -- the same field pattern as app.message_unknown_field / MERGE_FIELD_PATTERN (a gender block always holds ":")
  if exists (select 1
               from regexp_matches(v_text, '\{([^{}:|\n]{1,30})\}', 'g') as m
              where not (m[1] = any (v_fields))) then
    return 'field_not_allowed';
  end if;
  if app.message_external_link(v_text, p_own_domain, p_business_email) then
    return 'external_link';
  end if;
  if char_length(coalesce(p_body, '')) > coalesce(app.message_service_body_max(p_channel), 0) then
    return 'too_long';
  end if;
  return null;
end;
$$;
revoke all on function app.message_template_problem(text, text, text, text, text, text) from public, anon, authenticated;

-- 021160's form, kept for its callers: no business email
create or replace function app.message_template_problem(p_channel text, p_message_type text, p_subject text, p_body text,
                                                        p_own_domain text default null)
returns text
language sql immutable
set search_path = ''
as $$
  select app.message_template_problem(p_channel, p_message_type, p_subject, p_body, p_own_domain, null::text);
$$;
revoke all on function app.message_template_problem(text, text, text, text, text) from public, anon, authenticated;

create or replace function app.message_template_sendable(p_org uuid, p_template uuid) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row public.message_templates;
  v_own text;
  v_email text;
begin
  select * into v_row from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    return 'not_found';
  end if;
  if not v_row.is_active then
    return 'inactive';
  end if;
  select app.website_domain(o.website) into v_own from public.organizations o where o.id = p_org;
  -- owner (111) ב: the business's email from its business details
  select s.email into v_email from public.org_document_settings s where s.organization_id = p_org;
  return app.message_template_problem(v_row.channel, v_row.message_type, v_row.subject, v_row.body, v_own, v_email);
end;
$$;
revoke all on function app.message_template_sendable(uuid, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
