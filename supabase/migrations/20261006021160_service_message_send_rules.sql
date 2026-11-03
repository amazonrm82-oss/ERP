-- =============================================================================
-- MSG-02 follow-up: message rules at send time and the business's own website (owner's answers (96)-(98) and (102)-(105),
-- 3 November 2026; the independent review of the first version, items 1-7)
-- =============================================================================
-- (96) א + ג, (102) ג: the length is ALSO checked after the fields are filled, at send time; over the cap = the message is
--   not sent, it is logged as "too long" ("ארוכה מדי") and the owners and admins get a notice; never truncated.
--   * app.message_filled_problem(channel, message_type, filled_subject, filled_body): null or 'too_long', on the body
--     exactly as it goes out. A service type against app.message_service_body_max (SMS 300, WhatsApp 1,000, email 2,000);
--     every other type (marketing, or none) against app.message_marketing_body_max (SMS 600, WhatsApp 2,000, email 20,000),
--     and for marketing the body is the ENVELOPED one (marketingEnvelope(): "פרסומת: " in front on SMS and WhatsApp, the
--     sender line and the unsubscribe line), so what the system adds is counted. On email "פרסומת: " goes in the subject,
--     which is not counted (the template's subject has its own cap). Characters = code points. Mirrored by
--     messageFilledProblem() / envelopedFilledProblem() in src/features/message-templates/service-rule.ts; both run
--     tests/unit/fixtures/message-filled-problems.json.
--   * app.message_send_refused(org, template, reason): THE notice of a message that was not sent (reason: too_long,
--     field_not_allowed, external_link or inactive). One `system` notice to every active owner and admin, naming the
--     template by its name (no name when the template is unknown or gone), never anything about the customer; at most ONE
--     per business, template and reason a day in the business's zone (app.message_refusal_notices, no grants, one row per
--     business, template and reason). Never raises; answers how many notices it wrote. Definer, no grants.
--   * (103) ב: the database sends that notice for the OPS-04 queue. app.jobs_record_message (the one trigger on app.jobs,
--     fired by public.finish_job's own update when a message.send job ends; pinned by test 284) calls
--     app.message_send_refused(org, payload template_id, 'too_long') when the outcome is 'failed' with provider_error_code
--     'too_long' and NO provider (the system's own refusal, not a provider's code), in its own exception block, so the
--     finish never fails. The trigger is the narrower place: it runs only for message.send with an outcome, once per job
--     (old.message_outcome is null), it already never fails the finish, and finish_job (every worker call, also every
--     success) stays as reviewed. The message.send payload takes an optional `template_id` (a uuid; ids and codes only)
--     in app.job_payload_ok. The worker records a refusal with
--     public.finish_job(job, lease, false, 'too_long', true, true, null, null, 'too_long'): the job ends dead,
--     public.messages gets status failed, no provider, code 'too_long', the timeline shows "לא נשלחה: ארוכה מדי.", and
--     the owners and admins are told.
--   * EVERY sender, right before it sends one message from a template: asks app.message_template_sendable(org, template),
--     fills the fields (marketing: after marketingEnvelope()), asks app.message_filled_problem on the result, and on any
--     code sends nothing and records it: through finish_job on the queue, else by calling app.message_send_refused.
-- (97) ב, (104) ב, (105) ב: a bare domain is an external link too; the business's own domain is allowed.
--   * organizations.website (the business details page; owners and admins through the update policy and a column grant,
--     like phone), checked by trigger organizations_website_check (definer, pure, a new or changed value; 23514 hint
--     `org:website`): 300 characters, a usable domain by app.website_domain, and app.message_own_domain_ok: it has a
--     registered domain (app.registered_domain, so not a public suffix like co.il), it is not itself a shared site host
--     (app.message_shared_site_host, or CON-09's app.public_email_domain) and not a URL shortener
--     (app.message_url_shortener), and not under a big platform a business never owns (app.message_platform_domain:
--     google.com, facebook.com, ...); only http(s) or a bare host (javascript:, ftp:, data: and every other scheme are
--     refused; a bare host with a port reads as a scheme and is refused too): app.message_website_ok = websiteOk().
--     Mirrored by ownDomainOk().
--   * The own host is app.website_domain(website) (www dropped). Allowed (app.message_host_own, never for a host that fails
--     app.message_own_domain_ok): its REGISTERED domain and every host under it ("shop.biz.co.il" allows biz.co.il and
--     www.biz.co.il); but when the own host sits under a shared site host (mybiz.wixsite.com) only that exact host and its
--     www. Mirrored by isOwnHost().
--   * app.message_external_link(text, own_host) is the link rule. The text is NFKC-normalised (fullwidth Latin becomes
--     ASCII), invisible format characters are taken out (soft hyphen, zero-width characters, word joiner, BOM, direction
--     marks, embeddings and isolates) and ideographic dots (。．｡) count as dots.
--     (1) After every "http://" or "https://" (any case) the authority runs to whitespace (space, tab, CR, LF) or / ? # \,
--         less a trailing . , ; : ! ) ' or ": any character outside ASCII letters, digits and . - : [ ] @, any "@", a "[",
--         or a port that is not 1..5 digits = a link (a character a browser drops or maps hides another host); else the
--         host is a link unless it is allowed.
--     (2) Every run of ASCII letters and digits, Hebrew and Arabic letters, "." "-" and "@" is a token ("_" and every other
--         character split tokens; a Hebrew or Arabic prefix joined by a hyphen, "ב-", is cut off). A token that is exactly local@domain with a domain on the right is an email address and
--         is not judged. Else each "@"-free part, trimmed of "." and "-" at both ends and lower-cased, is a link when it
--         starts with "www." (unless allowed), is an IPv4 address (four numbers 0..255), or ends in a domain: the
--         right-most labels (letters of those scripts, digits, inner hyphens; 1..63 each, 253 in all) before a last label
--         of 2..63 ASCII letters (also when Hebrew or Arabic letters follow it directly: "evil.comשלום"), or a punycode
--         label xn--..., that is not a common file extension (app.message_file_extension: pdf, doc, ..., so
--         "invoice.pdf" is not a link; zip and mov are real TLDs and stay links), unless allowed.
--     Linear: two global scans, each part split once and walked once. Never links: 3.5, 10.30, 1.12.2026, e.g., v2.0,
--     invoice.pdf, a well-formed email address. Links: example.co.il, ב-example.co.il, באתרexample.com, x_evil.com,
--     evil.com@, @evil.com, 1.2.3.4, דוגמה.com, a long run ending in .evil.com.
--     Accepted (conservative misses and false alarms, the template shows the reason): a word.word pair of ASCII letters
--     (Mr.Cohen, St.Louis) is a link; a domain written in another script than Latin, Hebrew or Arabic, or with a non-Latin
--     top-level label, is not seen; a hostname that is only digits other than an IPv4 is not seen; the local part of a
--     well-formed email address is not judged (evil.com@x.com is allowed as an address).
--   * app.message_template_problem gains p_own_domain (default null, the old meaning); the 4-argument version is renamed
--     app.message_template_problem_021160_retired (or _021160_retired_<n> when 021159 was re-run after this file) with
--     every grant revoked (CLAUDE.md, "Changing a function's signature without drop"). RE-RUNNING 021159 requires
--     re-running this file after it. app.message_template_sendable passes app.website_domain(organizations.website).
-- (98) א: no change; the verification code template holds only {שם העסק} and {קוד אימות} (test 291 pins it).
-- Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- The closed lists (each mirrored between its markers in service-rule.ts; unit test)
-- ----------------------------------------------------------------------------
-- Hosts where many businesses get their own sub-site. CON-09's app.public_email_domain counts too.
create or replace function app.message_shared_site_host(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p = any (array[
    -- shared-site-hosts:start
    'wixsite.com', 'wix.com', 'editorx.io', 'wixstudio.io', 'wordpress.com', 'wpcomstaging.com', 'weebly.com',
    'godaddysites.com', 'business.site', 'square.site', 'squarespace.com', 'webflow.io', 'netlify.app', 'vercel.app',
    'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'azurewebsites.net', 'onrender.com',
    'github.io', 'gitlab.io', 'blogspot.com', 'blogspot.co.il', 'myshopify.com', 'tumblr.com', 'carrd.co', 'linktr.ee',
    'sites.google.com', 'notion.site', 'framer.website', 'framer.app', 'tilda.ws', 'jimdosite.com', 'webnode.page',
    'mystrikingly.com', 'site123.me', 'canva.site', 'amazonaws.com', 'cloudfront.net', 'appspot.com', 'fly.dev', 'r2.dev',
    'ngrok-free.app', 'ngrok.io', 'blob.core.windows.net', 'glitch.me', 'repl.co', 'surge.sh', 'translate.goog'
    -- shared-site-hosts:end
  ]::text[]);
$$;
revoke all on function app.message_shared_site_host(text) from public, anon, authenticated;

-- URL shorteners: never a business's own domain
create or replace function app.message_url_shortener(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p = any (array[
    -- url-shorteners:start
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'cutt.ly', 'rebrand.ly', 'buff.ly', 'tiny.cc', 'rb.gy',
    'shorturl.at', 'lnkd.in'
    -- url-shorteners:end
  ]::text[]);
$$;
revoke all on function app.message_url_shortener(text) from public, anon, authenticated;

-- Big platforms a business has a page on but never owns (review 2): neither they nor any host under them is own
create or replace function app.message_platform_domain(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p = any (array[
    -- platform-domains:start
    'google.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'youtube.com', 'wa.me', 't.me', 'x.com',
    'twitter.com', 'whatsapp.com'
    -- platform-domains:end
  ]::text[]);
$$;
revoke all on function app.message_platform_domain(text) from public, anon, authenticated;

-- Last labels that name a file, not a site ("invoice.pdf"); zip and mov are real top-level domains and are not here
create or replace function app.message_file_extension(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p = any (array[
    -- file-extensions:start
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'txt', 'csv', 'heic', 'webp', 'mp3',
    'mp4', 'rar'
    -- file-extensions:end
  ]::text[]);
$$;
revoke all on function app.message_file_extension(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- (105) The own domain
-- ----------------------------------------------------------------------------
-- a domain may be a business's own: it has a registered domain and is not a shared host, free mail or a shortener
create or replace function app.message_own_domain_ok(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p, '') <> ''
     and app.registered_domain(p) is not null
     and not app.message_shared_site_host(p)
     and not app.public_email_domain(p)
     and not app.message_url_shortener(p)
     and not app.message_url_shortener(app.registered_domain(p))
     and not app.message_platform_domain(app.registered_domain(p));
$$;
revoke all on function app.message_own_domain_ok(text) from public, anon, authenticated;

-- a website a business may save (review 2, item 4): http(s) or a bare host, 300 characters, a domain that can be its own.
-- Mirrors websiteOk().
create or replace function app.message_website_ok(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p is not null and char_length(p) <= 300
     and (btrim(p, ' ' || chr(9) || chr(10) || chr(13)) ~* '^https?://'
          or btrim(p, ' ' || chr(9) || chr(10) || chr(13)) !~* '^[a-z][a-z0-9+.-]*:')
     and coalesce(app.message_own_domain_ok(app.website_domain(p)), false);
$$;
revoke all on function app.message_website_ok(text) from public, anon, authenticated;

-- the own host sits under a shared host (or free mail): some level of it, two labels or more, is on a list
create or replace function app.message_under_shared_host(p text) returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (select 1
                   from (select string_to_array(p, '.') as l) x,
                        generate_series(1, greatest(cardinality(x.l) - 1, 1)) i
                  where app.message_shared_site_host(array_to_string(x.l[i:cardinality(x.l)], '.'))
                     or app.public_email_domain(array_to_string(x.l[i:cardinality(x.l)], '.')));
$$;
revoke all on function app.message_under_shared_host(text) from public, anon, authenticated;

-- a host is one of the business's own: under its registered domain, or exactly it (and its www) under a shared host
create or replace function app.message_host_own(p_host text, p_own text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_host is null or not app.message_own_domain_ok(p_own) then false
    when app.message_under_shared_host(p_own) then p_host = p_own or p_host = 'www.' || p_own
    else p_host = app.registered_domain(p_own)
         or right(p_host, char_length(app.registered_domain(p_own)) + 1) = '.' || app.registered_domain(p_own)
  end;
$$;
revoke all on function app.message_host_own(text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The business's website (owner (104) ב: on the business details)
-- ----------------------------------------------------------------------------
alter table public.organizations add column if not exists website text;

comment on column public.organizations.website is
  'MSG-02 (104): the business''s website; its registered domain (app.message_host_own) may appear in a service message.';

grant update (website) on public.organizations to authenticated;

-- a new or changed website must be one that can be the business's own (review item 3); definer only to call the
-- closed-list helpers, which have no grants (it reads nothing)
create or replace function app.organizations_website_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.website is not null and (tg_op = 'INSERT' or new.website is distinct from old.website)
     and not app.message_website_ok(new.website) then
    raise exception 'כתובת האתר לא מתאימה'
      using errcode = '23514', hint = 'org:website';
  end if;
  return new;
end;
$$;
revoke all on function app.organizations_website_check() from public, anon, authenticated;

create or replace trigger organizations_website_check before insert or update of website on public.organizations
  for each row execute function app.organizations_website_check();

-- ----------------------------------------------------------------------------
-- The link rule
-- ----------------------------------------------------------------------------
-- the domain a lower-case part ends in: the right-most valid labels before a last label of 2..63 ASCII letters that is
-- not a file extension; null when there is none
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
  if v_labels[v_n] !~ '^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$' or app.message_file_extension(v_labels[v_n]) then
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

-- one "@"-free part of a token: a link?
create or replace function app.message_part_link(p_part text, p_own text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  -- a Hebrew or Arabic prefix joined by a hyphen ("ב-biz.co.il") is not part of the host
  v text := regexp_replace(lower(btrim(coalesce(p_part, ''), '.-')), '^[א-תء-ي]+-', '');
  v_domain text;
begin
  if v like 'www.%' then
    return not app.message_host_own(v, p_own);
  end if;
  if v ~ '^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$'
     and (select bool_and(o::integer <= 255) from unnest(string_to_array(v, '.')) o) then
    return true;
  end if;
  v_domain := app.message_domain_suffix(v);
  return v_domain is not null and not app.message_host_own(v_domain, p_own);
end;
$$;
revoke all on function app.message_part_link(text, text) from public, anon, authenticated;

-- one token: a well-formed email address is not judged; else each "@"-free part
create or replace function app.message_token_link(p_token text, p_own text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_token ~ '^[^@]+@[^@]+$'
         and app.message_domain_suffix(lower(btrim(split_part(p_token, '@', 2), '.-'))) = lower(btrim(split_part(p_token, '@', 2), '.-'))
      then false
    else exists (select 1 from unnest(string_to_array(p_token, '@')) part where app.message_part_link(part, p_own))
  end;
$$;
revoke all on function app.message_token_link(text, text) from public, anon, authenticated;

-- the authority after "http(s)://": a link?
create or replace function app.message_authority_link(p_raw text, p_own text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    -- review 2, item 1: a character browsers drop or map (U+00AD, a zero-width space, fullwidth or letter-like forms)
    -- hides a different host, so anything outside the plain set is a link
    when p_authority !~ '^[A-Za-z0-9.:@[\]-]*$' then true
    when position('@' in p_authority) > 0 or left(p_authority, 1) = '[' then true
    when position(':' in p_authority) > 0
         and substr(p_authority, position(':' in p_authority) + 1) !~ '^[0-9]{1,5}$' then true
    else not app.message_host_own(lower(rtrim(split_part(p_authority, ':', 1), '.')), p_own)
  end
  -- the authority runs to whitespace or / ? # \; punctuation that ends a sentence is not part of it
  from (select rtrim(coalesce(p_raw, ''), '.,;:!)''"') as p_authority) a;
$$;
revoke all on function app.message_authority_link(text, text) from public, anon, authenticated;

-- true when the text holds a link that is not the business's own domain. Mirrors messageExternalLink().
create or replace function app.message_external_link(p_text text, p_own_domain text default null) returns boolean
language sql immutable
set search_path = ''
as $$
  -- NFKC first (fullwidth Latin and digits become ASCII), then invisible format characters are taken out (soft hyphen,
  -- zero-width space and joiners, word joiner, BOM, the direction marks, embeddings and isolates: browsers drop them), and
  -- the ideographic dots are dots
  with t as (select translate(translate(normalize(coalesce(p_text, ''), NFKC),
                                        chr(173) || chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207) || chr(8234)
                                          || chr(8235) || chr(8236) || chr(8237) || chr(8238) || chr(8288) || chr(8294)
                                          || chr(8295) || chr(8296) || chr(8297) || chr(65279), ''),
                              '。．｡', '...') as v,
                    lower(btrim(coalesce(p_own_domain, ''))) as own)
  select exists (select 1 from t, regexp_matches(t.v, 'https?://([^ \t\r\n/?#\\]*)', 'gi') as m
                  where app.message_authority_link(m[1], t.own))
      or exists (select 1 from t, regexp_matches(t.v, '[A-Za-z0-9.@א-תء-ي-]+', 'g') as k
                  where app.message_token_link(k[1], t.own));
$$;
revoke all on function app.message_external_link(text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- The template rule, now with the own domain
-- ----------------------------------------------------------------------------
-- the 4-argument version is retired; idempotent, also after 021159 was run again and made it once more
do $$
declare
  v_name text := 'message_template_problem_021160_retired';
  v_i integer := 1;
begin
  if to_regprocedure('app.message_template_problem(text, text, text, text)') is not null then
    while to_regprocedure(format('app.%I(text, text, text, text)', v_name)) is not null loop
      v_i := v_i + 1;
      v_name := 'message_template_problem_021160_retired_' || v_i;
    end loop;
    execute format('alter function app.message_template_problem(text, text, text, text) rename to %I', v_name);
    execute format('revoke all on function app.%I(text, text, text, text) from public, anon, authenticated, service_role', v_name);
  end if;
end;
$$;

create or replace function app.message_template_problem(p_channel text, p_message_type text, p_subject text, p_body text,
                                                        p_own_domain text default null)
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
  if app.message_external_link(v_text, p_own_domain) then
    return 'external_link';
  end if;
  if char_length(coalesce(p_body, '')) > coalesce(app.message_service_body_max(p_channel), 0) then
    return 'too_long';
  end if;
  return null;
end;
$$;
revoke all on function app.message_template_problem(text, text, text, text, text) from public, anon, authenticated;

create or replace function app.message_template_sendable(p_org uuid, p_template uuid) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row public.message_templates;
  v_own text;
begin
  select * into v_row from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  if not found then
    return 'not_found';
  end if;
  if not v_row.is_active then
    return 'inactive';
  end if;
  select app.website_domain(o.website) into v_own from public.organizations o where o.id = p_org;
  return app.message_template_problem(v_row.channel, v_row.message_type, v_row.subject, v_row.body, v_own);
end;
$$;
revoke all on function app.message_template_sendable(uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- (96) + (102) The filled text, at send time
-- ----------------------------------------------------------------------------
-- A marketing message's body cap by channel (characters), counted on the enveloped, filled body. Mirrors MARKETING_BODY_MAX.
create or replace function app.message_marketing_body_max(p_channel text) returns integer
language sql immutable
set search_path = ''
as $$
  select case p_channel when 'sms' then 600 when 'whatsapp' then 2000 when 'email' then 20000 end
$$;
revoke all on function app.message_marketing_body_max(text) from public, anon, authenticated;

-- null when the filled message may go out; 'too_long' when its body passes its channel's cap (service: the service cap;
-- any other type: the marketing cap, on the enveloped body). Mirrors messageFilledProblem().
create or replace function app.message_filled_problem(p_channel text, p_message_type text, p_filled_subject text,
                                                      p_filled_body text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when char_length(coalesce(p_filled_body, '')) >
         coalesce(case when coalesce(p_message_type, '') = any (app.service_message_types())
                       then app.message_service_body_max(p_channel)
                       else app.message_marketing_body_max(p_channel) end, 0)
      then 'too_long'
  end;
$$;
revoke all on function app.message_filled_problem(text, text, text, text) from public, anon, authenticated;

-- the notice's words for a reason a sender did not send; null for any other code
create or replace function app.message_send_refusal_text(p_reason text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_reason
    when 'too_long' then 'ארוכה מדי: אחרי מילוי השדות היא עוברת את מספר התווים המותר בערוץ הזה'
    when 'field_not_allowed' then 'יש בתבנית שדה שלא מתאים לסוג ההודעה'
    when 'external_link' then 'יש בתבנית קישור חיצוני'
    when 'inactive' then 'התבנית כבויה'
  end;
$$;
revoke all on function app.message_send_refusal_text(text) from public, anon, authenticated;

-- One row per business, template and reason: the business day its owners and admins were last told. A refusal without a
-- known template is kept under the nil uuid. No grants; read and written only by app.message_send_refused.
create table if not exists app.message_refusal_notices (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  template_key    uuid not null,
  reason          text not null,
  notified_on     date not null,
  primary key (organization_id, template_key, reason)
);
alter table app.message_refusal_notices enable row level security;
revoke all on app.message_refusal_notices from public, anon, authenticated, service_role;

-- One system notice per active owner and admin that a message was not sent, and why: at most one per business, template
-- and reason a day (business zone). Names the template only; nothing about the customer. Never raises; answers how many
-- notices it wrote.
create or replace function app.message_send_refused(p_org uuid, p_template uuid, p_reason text) returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text;
  v_reason text := app.message_send_refusal_text(p_reason);
  v_today date;
  v_body text;
  v_count integer := 0;
begin
  if v_reason is null or p_org is null then
    return 0;
  end if;
  select (now() at time zone app.intake_zone(o.timezone))::date into v_today from public.organizations o where o.id = p_org;
  if not found then
    return 0;
  end if;
  insert into app.message_refusal_notices as r (organization_id, template_key, reason, notified_on)
  values (p_org, coalesce(p_template, '00000000-0000-0000-0000-000000000000'::uuid), p_reason, v_today)
  on conflict (organization_id, template_key, reason)
    do update set notified_on = excluded.notified_on where r.notified_on < excluded.notified_on;
  if not found then
    -- told already today
    return 0;
  end if;
  if p_template is not null then
    select t.name into v_name from public.message_templates t where t.organization_id = p_org and t.id = p_template;
  end if;
  v_body := case when v_name is not null
                 then format('ההודעה מהתבנית "%s" לא נשלחה. %s. אפשר לתקן את התבנית בהגדרות, בתבניות הודעה.', v_name, v_reason)
                 else format('הודעה ללקוח לא נשלחה. %s. אפשר לבדוק את התבניות בהגדרות, בתבניות הודעה.', v_reason) end;
  insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
  select m.organization_id, m.user_id, 'system', 'הודעה ללקוח לא נשלחה', v_body, 'message_template',
         case when v_name is not null then p_template end
    from public.memberships m
   where m.organization_id = p_org and m.status = 'active' and m.role in ('owner', 'admin');
  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  raise warning 'message_send_refused: % (template %)', sqlstate, p_template;
  return 0;
end;
$$;
revoke all on function app.message_send_refused(uuid, uuid, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- (103) The queue: the payload names its template, and a "too long" failure tells the business
-- ----------------------------------------------------------------------------
-- 021153's rule plus an optional template_id (a uuid)
create or replace function app.job_payload_ok(p_kind text, p_payload jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_payload is null or jsonb_typeof(p_payload) <> 'object' then false
    when p_kind = 'message.send' then
      coalesce(
        (select bool_and(k in ('channel', 'lead_id', 'contact_id', 'event_at', 'message_type', 'template_id'))
           from jsonb_object_keys(p_payload) k), false)
      and jsonb_typeof(p_payload -> 'channel') = 'string'
      and (p_payload ->> 'channel') in ('email', 'sms', 'whatsapp')
      and ((p_payload ? 'lead_id') <> (p_payload ? 'contact_id'))
      and jsonb_typeof(coalesce(p_payload -> 'lead_id', p_payload -> 'contact_id')) = 'string'
      and coalesce(p_payload ->> 'lead_id', p_payload ->> 'contact_id')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      -- CNS-07: the message's type, from the closed list (enqueue_job requires it; a job queued before 021147 has none and is
      -- judged as marketing)
      and (not (p_payload ? 'message_type')
           or (jsonb_typeof(p_payload -> 'message_type') = 'string'
               and (p_payload ->> 'message_type') = any (app.message_types())))
      -- MSG-02 (103): the template the message is made from, so a refusal names it
      and (not (p_payload ? 'template_id')
           or (jsonb_typeof(p_payload -> 'template_id') = 'string'
               and (p_payload ->> 'template_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
      and (not (p_payload ? 'event_at')
           or (jsonb_typeof(p_payload -> 'event_at') = 'string'
               and (p_payload ->> 'event_at')
                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'))
    else false
  end
$$;
revoke all on function app.job_payload_ok(text, jsonb) from public, anon, authenticated;

-- 021152's body plus the notice of a "too long" failure, in its own exception block (pinned by test 284)
create or replace function app.jobs_record_message() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_lead uuid;
  v_contact uuid;
  v_status text := new.message_outcome;
  v_provider_id text := new.provider_message_id;
begin
  if new.kind <> 'message.send' or v_status is null then
    return null;
  end if;
  -- MSG-02 (103): a message refused for its filled length tells the owners and admins (once per template a day); never
  -- fails the finish
  if v_status = 'failed' and new.provider_error_code = 'too_long' and new.provider is null then
    begin
      perform app.message_send_refused(new.organization_id,
                                       case when new.payload ? 'template_id' then (new.payload ->> 'template_id')::uuid end,
                                       'too_long');
    exception when others then
      raise warning 'jobs_record_message: the refusal notice of job % was not written (%)', new.id, sqlstate;
    end;
  end if;
  if new.payload ? 'lead_id' then
    v_lead := (new.payload ->> 'lead_id')::uuid;
  else
    v_contact := (new.payload ->> 'contact_id')::uuid;
  end if;
  for v_try in 1..2 loop
    begin
      insert into public.messages (organization_id, lead_id, contact_id, channel, direction, status, provider,
                                   provider_message_id, provider_error_code, job_id, occurred_at, sent_at)
      values (new.organization_id, v_lead, v_contact, new.payload ->> 'channel', 'outbound', v_status, new.provider,
              v_provider_id, new.provider_error_code, new.id, now(), case when v_status = 'sent' then now() end)
      on conflict (job_id) do update
        set status = excluded.status, provider = excluded.provider, provider_message_id = excluded.provider_message_id,
            provider_error_code = excluded.provider_error_code, occurred_at = excluded.occurred_at, sent_at = excluded.sent_at;
      return null;
    exception
      -- the lead or contact was purged since the send check: there is no timeline to show it on
      when foreign_key_violation then
        return null;
      -- another message of this business already holds the provider's id: kept without it
      when unique_violation then
        if v_provider_id is null then
          return null;
        end if;
        v_provider_id := null;
      -- recording never fails the finish (a refused finish would send the message again): one warning, the job id only
      when others then
        raise warning 'jobs_record_message: the message of job % was not recorded (%)', new.id, sqlstate;
        return null;
    end;
  end loop;
  return null;
end;
$$;
revoke all on function app.jobs_record_message() from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
