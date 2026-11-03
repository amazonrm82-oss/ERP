-- =============================================================================
-- MSG-02 follow-up: an address glued to text, and a Latin-only business email (owner's answers (113) א and (114) א,
-- 3 November 2026)
-- =============================================================================
-- (113) א: the business email is recognised only in its exact form, with a word boundary. An address glued to text is
--   another address, and a SERVICE template that holds one is stopped with its own code, 'glued_address' ("הכתובת צמודה
--   לטקסט"), not 'external_link'. Marketing templates are still not judged.
--   The text is normalised as app.message_external_link does (NFKC, invisible format characters out, ideographic dots are
--   dots; app.message_link_text) and cut into the SAME tokens (runs of ASCII letters and digits, Hebrew and Arabic
--   letters, "." "-" "@"). A token holding "@" is judged by app.message_glued_token(token, char before, char after, own
--   domain, business email) ('glued', 'other' or null), where v is the token ASCII-lower-cased, a Hebrew or Arabic prefix
--   joined by a hyphen ("ב-") cut off and "." "-" trimmed at both ends (tokenLink()'s value). It is glued when:
--   (a) the business's plain email (app.message_plain_email) is inside v but v is not exactly it, v is not itself an
--       allowed own-domain address (lead's decision: owner (105)/(111) allow any address on the own domain, so
--       "moreinfo@biz.co.il" for info@biz.co.il is allowed; app.message_own_address), and an ASCII letter or
--       digit, or a Hebrew or Arabic letter, touches an occurrence ("xinfo@gmail.com", "info@gmail.comx",
--       "info@gmail.com1", "שלוםinfo@gmail.com" for info@gmail.com); an occurrence touched only by "." or "-" is another
--       address and stays to the link rule ("a.info@gmail.com", "info@gmail.com.il"). Occurrences are found left to right
--       without overlap (replace()/split()); or
--   (b) v is an address, exactly local@domain with app.message_domain_suffix(domain) not null (a domain on the closed
--       ending list, also with Hebrew or Arabic letters glued after its ending), and either
--       (b1) a Hebrew or Arabic letter directly touches an ASCII letter or digit anywhere in v ("שלוםinfo@x.co.il",
--            "info@x.co.ilשלום", "info@קפה1.co.il"), or
--       (b2) on a side where nothing was cut (no "ב-" prefix, no "." or "-" trimmed), the character of the text directly
--            next to the token glues (app.message_glue_char): "{" or "}" (a merge field written right next to it,
--            "{שם}info@...", glues once filled), or any character above ASCII that is not on the closed boundary list
--            app.message_glue_boundary (spaces, punctuation, quotes, dashes, symbols, arrows, currency, emoji: mirrored
--            by GLUE_BOUNDARY_RANGES between the markers glue-boundaries:start/end; unit test). So a letter or digit of
--            any other script (Cyrillic, Greek, Persian/Urdu Arabic letters, CJK, Hebrew points) glued to an address
--            glues it, and so does any character the list does not name (accepted: conservative).
--   'other' (c): v is exactly the business email and not an allowed own-domain address, but, on a side where nothing was
--       cut, an address character the tokens split on touches it: before it one of ! # $ % & + / = ? ^ _ ` |, after it
--       "_" ("dana_info@gmail.com", "x+info@gmail.com", "a/info@gmail.com", "info@gmail.com_x"). That is another, longer
--       address: 'external_link' (not "glued to text", and never the business email). Lead's decision (re-review): "*",
--       "~", "'" and "_" pass only as a PAIR, the same mark on both sides with no address character outside it
--       (app.message_mark_outer_ok: the text's start or end, or a character that is not an ASCII letter or digit, not
--       "." "-" "@", not an address special, not a Hebrew or Arabic letter and does not glue; after the closing mark also
--       "." "!" "?"): "*info@gmail.com*", "_info@gmail.com_", "'info@gmail.com'" are the business email;
--       "*info@gmail.com", "dana*info@gmail.com", "dana_info@gmail.com_", "_info@gmail.com_x", "o'info@gmail.com" are
--       another address. An own-domain address split the same way stays allowed ("dana_info@biz.co.il" on biz.co.il).
--   'other' (d) (review item 4): an address whose domain's ending is followed by "-" and ASCII letters or digits
--       ("dana@evil.com-x", "dana@evil.com-1") is judged as the domain before the hyphen: a link unless it is the own
--       domain. A bare "evil.com-x" without "@" is not judged (as before).
--   (e) (review item 3, fail closed): a token that starts with "." and ends in a listed ending (app.message_domain_suffix of
--       "x" || token), right after a character above ASCII that glues (a letter of another script: "x@café.com",
--       "café.com", "x@evilж.com", "x@例子.com"), is a link: the tokens split on that letter, so the link rule never saw
--       the domain. With a space (". com") or after a boundary (an emoji) it is not. Accepted (re-review item 4): a
--       sentence without a space after a foreign word ("Thé.It was great") is a link.
--   Pieces (review items 3 and 5): a token is cut at every ending followed by Hebrew or Arabic letters, with or without a
--   hyphen between (app.message_token_pieces = tokenPieces(): "info@gmail.com-שלום-תודה" -> "info@gmail.com",
--   "-שלום-תודה"), and each piece is judged on its own, by the glue rule (the next piece's first character is the
--   character after) and by the token rule: app.message_token_link is now that split over app.message_token_piece_link
--   (021161's body unchanged, = tokenPieceLink()). So "info@gmail.com-שלום-תודה" is the business email,
--   "sales@biz.co.il-תודה-רבה" an own-domain address, "x@evil.com-שלום-x", "evil.co.il-שלום-תודה" and
--   "info@gmail.com-שלום-evil.com" links, and "x@evil.comשלום-x" is glued.
--   app.message_address_glue(text, own domain, business email) answers 'glued_address' at the first 'glued' token, else
--   'external_link' when any token is 'other' or (e) holds, else null. Order in the rule: field_not_allowed, then
--   glued_address, then external_link (the link rule, or that answer), then too_long. A glued address is never allowed:
--   it is 'glued_address' even when the same text holds another link. Nothing that was a link becomes allowed.
--   Accepted: an address that mixes Hebrew and Latin in a label is stopped as glued; "כתבו לinfo@..." (a Hebrew prefix
--   without a hyphen) is glued (lead's decision, owner (113) א).
-- Lead's decision (review of this branch): an ending followed by "-" and Hebrew or Arabic letters ("evil.com-שלום") is
--   read as its ASCII part, like the glued ending without the hyphen: app.message_domain_suffix (021161's body, the
--   strip pattern now '-?') = domainSuffix(), so a bare "evil.com-שלום" is a link too.
--   Linear and cheap (review item 2): one plpgsql loop over the tokens that stops at the first glued one; per token a few
--   regex tests, and the domain and own-domain functions only when a rule can still hold. Measured locally: the
--   full-cap template of 250 glued tokens 1,320 ms -> 16 ms; 10,000 plain address tokens 677 ms -> 184 ms.
-- (114) א: an address in non-Latin letters is never the business email: app.message_plain_email (= plainBusinessEmail())
--   now also requires every character to be printable ASCII (a stored "info@קפה.com" never counts). The email of the
--   business details (org_document_settings.email) takes only a Latin address: trigger org_document_settings_email_latin
--   (invoker, every writer) refuses a new or changed value with a character above ASCII (P0001 hint
--   `document_settings:email_latin`; control characters and spaces stay to org_document_settings_details_check, 23514);
--   stored rows are not judged again (hosted had one email, ASCII, 3 November 2026).
-- Redefines app.message_domain_suffix, the three-argument app.message_token_link and the six-argument
-- app.message_template_problem of 021161 (021160's wrapper forms still call them) and app.message_send_refusal_text of
-- 021160 (the new code's line). RE-RUNNING 021159, 021160 OR 021161 REQUIRES RE-RUNNING THIS FILE AFTER IT. Every statement is safe to run twice.

-- ----------------------------------------------------------------------------
-- An ending glued to Hebrew or Arabic letters, with or without a hyphen, is its ASCII part (021161's body)
-- ----------------------------------------------------------------------------
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
  -- a top-level label glued to Hebrew or Arabic letters ("evil.comשלום"), or joined to them by a hyphen
  -- ("evil.com-שלום"), is its ASCII part
  v_labels[v_n] := regexp_replace(v_labels[v_n], '^([a-z]{2,63})-?[א-תء-ي]+$', '\1');
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
-- (114) The business email: plain and Latin only
-- ----------------------------------------------------------------------------
create or replace function app.message_plain_email(p text) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when x.v ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?@[^@]+$'
         and x.v ~ '^[!-~]+$'
         and app.message_domain_suffix(split_part(x.v, '@', 2)) = split_part(x.v, '@', 2)
         and position('..' in x.v) = 0
         and not app.message_local_host(split_part(x.v, '@', 1))
         and app.message_domain_suffix(split_part(x.v, '@', 1)) is null
      then x.v
  end
  from (select app.message_ascii_lower(btrim(coalesce(p, ''))) as v) x;
$$;
revoke all on function app.message_plain_email(text) from public, anon, authenticated;

create or replace function app.org_document_settings_email_latin() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  if new.email is not null and (tg_op = 'INSERT' or new.email is distinct from old.email)
     and new.email ~ ('[^' || chr(1) || '-' || chr(127) || ']') then
    raise exception 'כתובת האימייל של העסק נכתבת באותיות לועזיות בלבד'
      using errcode = 'P0001', hint = 'document_settings:email_latin';
  end if;
  return new;
end;
$$;
revoke all on function app.org_document_settings_email_latin() from public, anon, authenticated;

create or replace trigger org_document_settings_email_latin before insert or update of email on public.org_document_settings
  for each row execute function app.org_document_settings_email_latin();

-- ----------------------------------------------------------------------------
-- (113) Glued addresses
-- ----------------------------------------------------------------------------
-- the text as the link rule reads it (the normalisation of app.message_external_link). Mirrors linkText().
create or replace function app.message_link_text(p_text text) returns text
language sql immutable
set search_path = ''
as $$
  select translate(translate(normalize(coalesce(p_text, ''), NFKC),
                             chr(173) || chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207) || chr(8234)
                               || chr(8235) || chr(8236) || chr(8237) || chr(8238) || chr(8288) || chr(8294)
                               || chr(8295) || chr(8296) || chr(8297) || chr(65279), ''),
                   '。．｡', '...');
$$;
revoke all on function app.message_link_text(text) from public, anon, authenticated;

-- a code point above ASCII that does NOT glue an address: closed ranges, inclusive, in pairs (mirrored by
-- GLUE_BOUNDARY_RANGES; unit test)
create or replace function app.message_glue_boundary(p integer) returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (
    select 1
      from (select array[
              -- glue-boundaries:start
              160, 191,        -- no-break space, Latin-1 punctuation and signs (« » ¿ ° ...)
              215, 215,        -- ×
              247, 247,        -- ÷
              1470, 1470,      -- Hebrew maqaf
              1472, 1472,      -- Hebrew paseq
              1475, 1475,      -- Hebrew sof pasuq
              1523, 1524,      -- Hebrew geresh, gershayim
              1548, 1548,      -- Arabic comma
              1563, 1563,      -- Arabic semicolon
              1567, 1567,      -- Arabic question mark
              1642, 1645,      -- Arabic percent, decimal and thousands separators, star
              1748, 1748,      -- Arabic full stop
              8192, 8303,      -- general punctuation: spaces, dashes, quotes, bullets, ellipsis, primes
              8352, 8399,      -- currency signs (₪)
              8592, 11263,     -- arrows, maths, technical, box drawing, shapes, symbols, dingbats, braille
              12288, 12291,    -- ideographic space and punctuation
              12296, 12305,    -- CJK brackets
              65024, 65039,    -- variation selectors
              126976, 129791   -- emoji and pictographs
              -- glue-boundaries:end
            ]::integer[] as a) x,
           generate_series(1, cardinality(x.a), 2) as i
     where p between x.a[i] and x.a[i + 1]);
$$;
revoke all on function app.message_glue_boundary(integer) from public, anon, authenticated;

-- the text's character directly next to an address glues it: a merge field's brace, or a character above ASCII that is
-- not on the boundary list. Mirrors glueChar().
create or replace function app.message_glue_char(p_char text) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_char is null or p_char = '' then false
    when ascii(p_char) <= 127 then p_char in ('{', '}')
    else not app.message_glue_boundary(ascii(p_char))
  end;
$$;
revoke all on function app.message_glue_char(text) from public, anon, authenticated;

-- v (a lower-cased, cut and trimmed token) is a well-formed address on the business's own domain, the address the link
-- rule allows (app.message_token_link's own-domain branch). Mirrors ownAddress().
create or replace function app.message_own_address(p_value text, p_own text) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p_value ~ '^[^@]+@[^@]+$'
                  and app.message_domain_suffix(split_part(p_value, '@', 2)) = split_part(p_value, '@', 2)
                  and not app.message_local_host(split_part(p_value, '@', 1))
                  and app.message_domain_suffix(split_part(p_value, '@', 1)) is null
                  and app.message_host_own(split_part(p_value, '@', 2), p_own), false);
$$;
revoke all on function app.message_own_address(text, text) from public, anon, authenticated;

-- A token cut into pieces at every ending followed by Hebrew or Arabic letters, with or without a hyphen between
-- ("info@gmail.com-שלום-תודה" -> "info@gmail.com", "-שלום-תודה"; "x@evil.comשלום" -> "x@evil.com", "שלום"): the
-- address or domain is its ASCII run up to there, and the rest of the token is judged on its own (review item 3). One
-- global replace, so linear. Mirrors tokenPieces().
create or replace function app.message_token_pieces(p_token text) returns text[]
language sql immutable
set search_path = ''
as $$
  select string_to_array(regexp_replace(coalesce(p_token, ''), '([.][A-Za-z]{2,63})(-?[א-תء-ي])', '\1' || chr(2) || '\2', 'g'),
                         chr(2));
$$;
revoke all on function app.message_token_pieces(text) from public, anon, authenticated;

-- A character next to a WhatsApp formatting mark or quote around the business email (outside the pair) that ends it:
-- the start or end of the text, or a character that is no address character (not an ASCII letter or digit, not
-- "." "-" "@", not one of ! # $ % & ' * + / = ? ^ _ ` { | } ~, not a Hebrew or Arabic letter, not a character that
-- glues); after the closing mark also "." "!" "?" (the end of a sentence). Mirrors markOuterOk().
create or replace function app.message_mark_outer_ok(p_char text, p_close boolean) returns boolean
language sql immutable
set search_path = ''
as $$
  select case
    when p_char is null or p_char = '' then true
    when ascii(p_char) <= 127 then
      (p_char !~ '[A-Za-z0-9.@-]' and position(p_char in '!#$%&''*+/=?^_`{|}~') = 0)
      or (p_close and p_char in ('.', '!', '?'))
    else p_char !~ '[א-תء-ي]' and not app.message_glue_char(p_char)
  end;
$$;
revoke all on function app.message_mark_outer_ok(text, boolean) from public, anon, authenticated;

-- one piece holding "@" with the text's characters next to it (and the characters outside those, for a formatting
-- pair); p_business_email already through app.message_plain_email, p_own the own domain lower-cased and trimmed.
-- 'glued' = an address glued to text; 'other' = an address that is a link ((c) the business email made into a longer
-- address, (d) an ending followed by "-" and letters or digits); null = neither. Cheap string tests first; the domain and
-- own-domain functions only when a rule can still hold. Mirrors gluedToken().
create or replace function app.message_glued_token(p_token text, p_before text, p_after text, p_outer_before text,
                                                   p_outer_after text, p_own text, p_business_email text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_lower text := app.message_ascii_lower(coalesce(p_token, ''));
  v_cut text;
  v text;
  v_start_kept boolean;
  v_end_kept boolean;
  v_mixed boolean;
  v_side boolean;
  v_other boolean := false;
  v_mark_before boolean;
  v_mark_after boolean;
  v_dash boolean;
  v_domain text;
  v_bare text;
begin
  v_cut := regexp_replace(v_lower, '^[א-תء-ي]+-', '');
  v := btrim(v_cut, '.-');
  -- (a) the business email with a letter or digit touching it, unless the piece is itself an allowed own-domain address
  if p_business_email is not null and v <> p_business_email and position(p_business_email in v) > 0
     and replace(v, p_business_email, chr(1)) ~ ('[a-z0-9א-תء-ي]' || chr(1) || '|' || chr(1) || '[a-z0-9א-תء-ي]')
     and not app.message_own_address(v, p_own) then
    return 'glued';
  end if;
  if v !~ '^[^@]+@[^@]+$' then
    return null;
  end if;
  v_start_kept := v_cut = v_lower and left(v_cut, 1) not in ('.', '-');
  v_end_kept := v_cut <> '' and right(v_cut, 1) not in ('.', '-');
  -- (b1) Hebrew or Arabic letters touching ASCII letters or digits
  v_mixed := v ~ '[א-תء-ي][a-z0-9]|[a-z0-9][א-תء-ي]';
  -- (b2) the text's character next to the piece, on a side where nothing was cut
  v_side := (v_start_kept and app.message_glue_char(p_before)) or (v_end_kept and app.message_glue_char(p_after));
  -- (c) the business email next to an address character. "*", "~", "'" and "_" pass only as a pair: the same mark on
  -- both sides, with no address character outside it (lead's decision on the re-review); any other one, or an unpaired
  -- mark, makes it another address
  if v = p_business_email then
    v_mark_before := v_start_kept and coalesce(p_before, '') <> '' and position(p_before in '*~''_') > 0;
    v_mark_after := v_end_kept and coalesce(p_after, '') <> '' and position(p_after in '*~''_') > 0;
    if v_mark_before or v_mark_after then
      v_other := not (v_mark_before and v_mark_after and p_before = p_after
                      and app.message_mark_outer_ok(p_outer_before, false)
                      and app.message_mark_outer_ok(p_outer_after, true));
    else
      v_other := v_start_kept and coalesce(p_before, '') <> '' and position(p_before in '!#$%&+/=?^`|') > 0;
    end if;
  end if;
  -- (d) an ending followed by "-" and ASCII letters or digits ("dana@evil.com-x"): judged as the domain before it
  v_domain := split_part(v, '@', 2);
  v_dash := v_domain ~ '[.][a-z]{2,63}-[a-z0-9-]+$';
  if not (v_mixed or v_side or v_other or v_dash) then
    return null;
  end if;
  if (v_mixed or v_side) and app.message_domain_suffix(v_domain) is not null then
    return 'glued';
  end if;
  if v_other and app.message_domain_suffix(v_domain) = v_domain and not app.message_own_address(v, p_own) then
    return 'other';
  end if;
  if v_dash then
    v_bare := regexp_replace(v_domain, '-[a-z0-9-]+$', '');
    if app.message_domain_suffix(v_bare) = v_bare and not app.message_host_own(v_bare, p_own) then
      return 'other';
    end if;
  end if;
  return null;
end;
$$;
revoke all on function app.message_glued_token(text, text, text, text, text, text, text) from public, anon, authenticated;

-- owner (113) א: 'glued_address' at the first address glued to text; else 'external_link' when an address is a link the
-- token rule does not see ((c), (d)) or a listed ending follows a letter outside ASCII, Hebrew and Arabic with no space
-- ((e): "x@café.com", "evilж.com", "x@例子.com": the token rule splits on that letter, so the ending is a token of its own
-- that starts with "."; fail closed); else null. One pass over the tokens, stopping at the first glued one; a token
-- holding "@" is judged piece by piece (app.message_token_pieces). Mirrors messageAddressGlue(). A space and one letter
-- are added at the end so the last real token gets the characters after it.
create or replace function app.message_address_glue(p_text text, p_own_domain text, p_business_email text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v text := app.message_link_text(p_text) || ' a';
  v_own text := lower(btrim(coalesce(p_own_domain, '')));
  v_email text := app.message_plain_email(p_business_email);
  m text[];
  v_tok text;
  v_before text;
  v_outer_before text;
  v_last_tok text;
  v_prev text;
  v_prev_before text;
  v_prev_outer text;
  v_after text;
  v_outer_after text;
  v_pieces text[];
  v_n integer;
  v_glue text;
  v_link boolean := false;
begin
  for m in select regexp_matches(v, '([^A-Za-z0-9.@א-תء-ي-]*)([A-Za-z0-9.@א-תء-ي-]+)', 'g') loop
    v_tok := m[2];
    v_before := right(m[1], 1);
    v_outer_before := case when char_length(m[1]) >= 2 then substr(m[1], char_length(m[1]) - 1, 1)
                           else coalesce(right(v_last_tok, 1), '') end;
    if v_prev is not null then
      v_after := left(m[1], 1);
      v_outer_after := case when char_length(m[1]) >= 2 then substr(m[1], 2, 1) else left(v_tok, 1) end;
      v_pieces := app.message_token_pieces(v_prev);
      v_n := cardinality(v_pieces);
      for i in 1 .. v_n loop
        if position('@' in v_pieces[i]) > 0 then
          v_glue := app.message_glued_token(
            v_pieces[i],
            case when i = 1 then v_prev_before else right(v_pieces[i - 1], 1) end,
            case when i = v_n then v_after else left(v_pieces[i + 1], 1) end,
            case when i = 1 then v_prev_outer else '' end,
            case when i = v_n then v_outer_after else '' end,
            v_own, v_email);
          if v_glue = 'glued' then
            return 'glued_address';
          elsif v_glue = 'other' then
            v_link := true;
          end if;
        end if;
      end loop;
    end if;
    -- (e) a listed ending right after a letter of another script
    if not v_link and left(v_tok, 1) = '.' and v_before <> '' and ascii(v_before) > 127
       and app.message_glue_char(v_before)
       and app.message_domain_suffix('x' || app.message_ascii_lower(v_tok)) is not null then
      v_link := true;
    end if;
    if position('@' in v_tok) > 0 then
      v_prev := v_tok;
      v_prev_before := v_before;
      v_prev_outer := v_outer_before;
    else
      v_prev := null;
    end if;
    v_last_tok := v_tok;
  end loop;
  return case when v_link then 'external_link' end;
end;
$$;
revoke all on function app.message_address_glue(text, text, text) from public, anon, authenticated;

-- 021161's token rule for one piece (its body unchanged). Mirrors tokenPieceLink().
create or replace function app.message_token_piece_link(p_token text, p_own text, p_business_email text) returns boolean
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
revoke all on function app.message_token_piece_link(text, text, text) from public, anon, authenticated;

-- the token rule, piece by piece (review items 3 and 5): "info@gmail.com-שלום-תודה" is the business email and a
-- Hebrew word; "x@evil.com-שלום-x" is a link to evil.com. Mirrors tokenLink().
create or replace function app.message_token_link(p_token text, p_own text, p_business_email text) returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (select 1 from unnest(app.message_token_pieces(p_token)) piece
                  where piece <> '' and app.message_token_piece_link(piece, p_own, p_business_email));
$$;
revoke all on function app.message_token_link(text, text, text) from public, anon, authenticated;

-- THE template rule (021161's six-argument body with the glued-address step)
create or replace function app.message_template_problem(p_channel text, p_message_type text, p_subject text, p_body text,
                                                        p_own_domain text, p_business_email text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_fields text[];
  v_text text := coalesce(p_subject, '') || chr(10) || coalesce(p_body, '');
  v_glue text;
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
  -- owner (113) א: an address glued to text is another address, with its own message
  v_glue := app.message_address_glue(v_text, p_own_domain, p_business_email);
  if v_glue = 'glued_address' then
    return 'glued_address';
  end if;
  if v_glue = 'external_link' or app.message_external_link(v_text, p_own_domain, p_business_email) then
    return 'external_link';
  end if;
  if char_length(coalesce(p_body, '')) > coalesce(app.message_service_body_max(p_channel), 0) then
    return 'too_long';
  end if;
  return null;
end;
$$;
revoke all on function app.message_template_problem(text, text, text, text, text, text) from public, anon, authenticated;

-- the owners' notice text per refusal code (021160's body with the new code)
create or replace function app.message_send_refusal_text(p_reason text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_reason
    when 'too_long' then 'ארוכה מדי: אחרי מילוי השדות היא עוברת את מספר התווים המותר בערוץ הזה'
    when 'field_not_allowed' then 'יש בתבנית שדה שלא מתאים לסוג ההודעה'
    when 'glued_address' then 'יש בתבנית כתובת צמודה לטקסט'
    when 'external_link' then 'יש בתבנית קישור חיצוני'
    when 'inactive' then 'התבנית כבויה'
  end;
$$;
revoke all on function app.message_send_refusal_text(text) from public, anon, authenticated;

notify pgrst, 'reload schema';
