-- =============================================================================
-- SPD-04 follow-up, owner's answer (305) ב (12 November 2026): the offer rule's word list
-- =============================================================================
-- The bare words "מבצע" ("I perform", "an operation") and "הנחה" ("an assumption", "a laying down") no longer make an
-- instant reply an offer on their own (nor their plurals, below), with or without their up-to-three prefix letters ("המבצע", "ומבצע", "הנחה סבירה").
-- What counts instead (021233's rule otherwise unchanged: NFKC, the strip, the whitespace, the look-alike and digit folds,
-- ₪ $ € £, ש"ח, a bare שח next to a number, % next to a digit, the prefix letters ו ב ל ה ש כ מ and the not-words):
--   - the words "במבצע" (its own list word: "ובמבצע", "שבמבצע" match through the prefix letters before it, "מבצע" does
--     not), "מחיר" and "מחירים" join app.message_offer_words(); "חינם" (so "בחינם") and "הטבה" (so "והטבה") stay;
--   - the phrase "הנחה של": "הנחה", with up to three prefix letters ("בהנחה של", "ההנחה של"), one or more spaces, then
--     the word "של" exactly;
--   - "הנחה" (with up to three prefix letters) right after a percent sign (% or ٪), spaces between allowed ("% הנחה",
--     "%הנחה"; "20% הנחה" was already an offer by the percent-next-to-a-digit rule);
--   - the phrase "רק היום" ("ורק היום"), the same way.
--   A phrase's words are whole words: no Hebrew letter right before the prefix letters or right after the last word.
--   The plurals "מבצעים" ("we carry out") and "הנחות" ("assumptions") leave the list too (lead's choice, the same
--   ambiguity as (305) ב); no other word joins it.
-- Redefined: app.message_offer_words (021233's list with the change above), app.message_offer_not_words (unchanged, kept
-- beside the list so the unit test reads both from one file) and app.message_offer (021233's body plus the three phrase
-- scans marked "owner (305) ב"). = OFFER_WORDS and messageOffer() in
-- src/features/message-templates/service-rule.ts; both run the shared fixture tests/unit/fixtures/message-template-problems.json.
-- No signature changes; every statement is safe to run twice. No drop statement, no delete.

create or replace function app.message_offer_words() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- offer-words:start
    'במבצע', 'חינם', 'מחיר', 'מחירים', 'הטבה', 'הטבות', 'קופון', 'קופונים', 'בלעדי', 'בלעדית', 'בלעדיים',
    'בלעדיות', 'אחוז', 'אחוזים', 'שקל', 'שקלים', 'דולר', 'דולרים', 'יורו', 'nis', 'ils', 'usd', 'eur', 'sale', 'discount',
    'coupon', 'promo'
    -- offer-words:end
  ]::text[]
$$;
revoke all on function app.message_offer_words() from public, anon, authenticated, service_role;

-- ordinary words that a prefix letter and a list word make: the last prefix letter with the rest is one of these
create or replace function app.message_offer_not_words() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- offer-not-words:start
    'משקל', 'משקלים', 'לאחוז'
    -- offer-not-words:end
  ]::text[]
$$;
revoke all on function app.message_offer_not_words() from public, anon, authenticated, service_role;

-- Whether a text reads as an offer (see the header). Linear: one normalization, character classes, four regex scans and one
-- pass over the words, each word tried with at most four cuts.
create or replace function app.message_offer(p_text text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_text text;
  v_words text[] := app.message_offer_words();
  v_not text[] := app.message_offer_not_words();
  v_prefix text := 'ובלהשכמ';
  v_word text;
  v_k integer;
  v_rest text;
  v_ok boolean;
  v_strip text;
  v_space text;
  v_heb text := chr(1488) || '-' || chr(1514);
begin
  if p_text is null or p_text = '' then
    return false;
  end if;
  v_text := normalize(p_text, NFKC);
  -- the format characters (Cf), U+034F, the variation selectors and niqqud
  v_strip := '[' || chr(173) || chr(1536) || '-' || chr(1541) || chr(1564) || chr(1757) || chr(1807)
             || chr(2192) || '-' || chr(2193) || chr(2274) || chr(6158) || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238)
             || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8303) || chr(65279) || chr(65529) || '-' || chr(65531)
             || chr(69821) || chr(69837) || chr(78896) || '-' || chr(78911) || chr(113824) || '-' || chr(113827)
             || chr(119155) || '-' || chr(119162) || chr(917505) || chr(917536) || '-' || chr(917631)
             -- every combining mark (Mn; niqqud, U+034F and the variation selectors among them) = OFFER_MN_RANGES
             || chr(768) || '-' || chr(879) || chr(1155) || '-' || chr(1159) || chr(1425) || '-' || chr(1469) || chr(1471) || chr(1473) || '-' || chr(1474)
             || chr(1476) || '-' || chr(1477) || chr(1479) || chr(1552) || '-' || chr(1562) || chr(1611) || '-' || chr(1631) || chr(1648)
             || chr(1750) || '-' || chr(1756) || chr(1759) || '-' || chr(1764) || chr(1767) || '-' || chr(1768) || chr(1770) || '-' || chr(1773) || chr(1809)
             || chr(1840) || '-' || chr(1866) || chr(1958) || '-' || chr(1968) || chr(2027) || '-' || chr(2035) || chr(2045) || chr(2070) || '-' || chr(2073)
             || chr(2075) || '-' || chr(2083) || chr(2085) || '-' || chr(2087) || chr(2089) || '-' || chr(2093) || chr(2137) || '-' || chr(2139) || chr(2199) || '-' || chr(2207)
             || chr(2250) || '-' || chr(2273) || chr(2275) || '-' || chr(2306) || chr(2362) || chr(2364) || chr(2369) || '-' || chr(2376)
             || chr(2381) || chr(2385) || '-' || chr(2391) || chr(2402) || '-' || chr(2403) || chr(2433) || chr(2492)
             || chr(2497) || '-' || chr(2500) || chr(2509) || chr(2530) || '-' || chr(2531) || chr(2558) || chr(2561) || '-' || chr(2562)
             || chr(2620) || chr(2625) || '-' || chr(2626) || chr(2631) || '-' || chr(2632) || chr(2635) || '-' || chr(2637) || chr(2641)
             || chr(2672) || '-' || chr(2673) || chr(2677) || chr(2689) || '-' || chr(2690) || chr(2748) || chr(2753) || '-' || chr(2757)
             || chr(2759) || '-' || chr(2760) || chr(2765) || chr(2786) || '-' || chr(2787) || chr(2810) || '-' || chr(2815) || chr(2817)
             || chr(2876) || chr(2879) || chr(2881) || '-' || chr(2884) || chr(2893) || chr(2901) || '-' || chr(2902)
             || chr(2914) || '-' || chr(2915) || chr(2946) || chr(3008) || chr(3021) || chr(3072)
             || chr(3076) || chr(3132) || chr(3134) || '-' || chr(3136) || chr(3142) || '-' || chr(3144) || chr(3146) || '-' || chr(3149)
             || chr(3157) || '-' || chr(3158) || chr(3170) || '-' || chr(3171) || chr(3201) || chr(3260) || chr(3263)
             || chr(3270) || chr(3276) || '-' || chr(3277) || chr(3298) || '-' || chr(3299) || chr(3328) || '-' || chr(3329) || chr(3387) || '-' || chr(3388)
             || chr(3393) || '-' || chr(3396) || chr(3405) || chr(3426) || '-' || chr(3427) || chr(3457) || chr(3530)
             || chr(3538) || '-' || chr(3540) || chr(3542) || chr(3633) || chr(3636) || '-' || chr(3642) || chr(3655) || '-' || chr(3662)
             || chr(3761) || chr(3764) || '-' || chr(3772) || chr(3784) || '-' || chr(3790) || chr(3864) || '-' || chr(3865) || chr(3893)
             || chr(3895) || chr(3897) || chr(3953) || '-' || chr(3966) || chr(3968) || '-' || chr(3972) || chr(3974) || '-' || chr(3975)
             || chr(3981) || '-' || chr(3991) || chr(3993) || '-' || chr(4028) || chr(4038) || chr(4141) || '-' || chr(4144) || chr(4146) || '-' || chr(4151)
             || chr(4153) || '-' || chr(4154) || chr(4157) || '-' || chr(4158) || chr(4184) || '-' || chr(4185) || chr(4190) || '-' || chr(4192) || chr(4209) || '-' || chr(4212)
             || chr(4226) || chr(4229) || '-' || chr(4230) || chr(4237) || chr(4253) || chr(4957) || '-' || chr(4959)
             || chr(5906) || '-' || chr(5908) || chr(5938) || '-' || chr(5939) || chr(5970) || '-' || chr(5971) || chr(6002) || '-' || chr(6003) || chr(6068) || '-' || chr(6069)
             || chr(6071) || '-' || chr(6077) || chr(6086) || chr(6089) || '-' || chr(6099) || chr(6109) || chr(6155) || '-' || chr(6157)
             || chr(6159) || chr(6277) || '-' || chr(6278) || chr(6313) || chr(6432) || '-' || chr(6434) || chr(6439) || '-' || chr(6440)
             || chr(6450) || chr(6457) || '-' || chr(6459) || chr(6679) || '-' || chr(6680) || chr(6683) || chr(6742)
             || chr(6744) || '-' || chr(6750) || chr(6752) || chr(6754) || chr(6757) || '-' || chr(6764) || chr(6771) || '-' || chr(6780)
             || chr(6783) || chr(6832) || '-' || chr(6845) || chr(6847) || '-' || chr(6877) || chr(6880) || '-' || chr(6891) || chr(6912) || '-' || chr(6915)
             || chr(6964) || chr(6966) || '-' || chr(6970) || chr(6972) || chr(6978) || chr(7019) || '-' || chr(7027)
             || chr(7040) || '-' || chr(7041) || chr(7074) || '-' || chr(7077) || chr(7080) || '-' || chr(7081) || chr(7083) || '-' || chr(7085) || chr(7142)
             || chr(7144) || '-' || chr(7145) || chr(7149) || chr(7151) || '-' || chr(7153) || chr(7212) || '-' || chr(7219) || chr(7222) || '-' || chr(7223)
             || chr(7376) || '-' || chr(7378) || chr(7380) || '-' || chr(7392) || chr(7394) || '-' || chr(7400) || chr(7405) || chr(7412)
             || chr(7416) || '-' || chr(7417) || chr(7616) || '-' || chr(7679) || chr(8400) || '-' || chr(8412) || chr(8417) || chr(8421) || '-' || chr(8432)
             || chr(11503) || '-' || chr(11505) || chr(11647) || chr(11744) || '-' || chr(11775) || chr(12330) || '-' || chr(12333) || chr(12441) || '-' || chr(12442)
             || chr(42607) || chr(42612) || '-' || chr(42621) || chr(42654) || '-' || chr(42655) || chr(42736) || '-' || chr(42737) || chr(43010)
             || chr(43014) || chr(43019) || chr(43045) || '-' || chr(43046) || chr(43052) || chr(43204) || '-' || chr(43205)
             || chr(43232) || '-' || chr(43249) || chr(43263) || chr(43302) || '-' || chr(43309) || chr(43335) || '-' || chr(43345) || chr(43392) || '-' || chr(43394)
             || chr(43443) || chr(43446) || '-' || chr(43449) || chr(43452) || '-' || chr(43453) || chr(43493) || chr(43561) || '-' || chr(43566)
             || chr(43569) || '-' || chr(43570) || chr(43573) || '-' || chr(43574) || chr(43587) || chr(43596) || chr(43644)
             || chr(43696) || chr(43698) || '-' || chr(43700) || chr(43703) || '-' || chr(43704) || chr(43710) || '-' || chr(43711) || chr(43713)
             || chr(43756) || '-' || chr(43757) || chr(43766) || chr(44005) || chr(44008) || chr(44013)
             || chr(64286) || chr(65024) || '-' || chr(65039) || chr(65056) || '-' || chr(65071) || chr(66045) || chr(66272)
             || chr(66422) || '-' || chr(66426) || chr(68097) || '-' || chr(68099) || chr(68101) || '-' || chr(68102) || chr(68108) || '-' || chr(68111) || chr(68152) || '-' || chr(68154)
             || chr(68159) || chr(68325) || '-' || chr(68326) || chr(68900) || '-' || chr(68903) || chr(68969) || '-' || chr(68973) || chr(69291) || '-' || chr(69292)
             || chr(69370) || '-' || chr(69375) || chr(69446) || '-' || chr(69456) || chr(69506) || '-' || chr(69509) || chr(69633) || chr(69688) || '-' || chr(69702)
             || chr(69744) || chr(69747) || '-' || chr(69748) || chr(69759) || '-' || chr(69761) || chr(69811) || '-' || chr(69814) || chr(69817) || '-' || chr(69818)
             || chr(69826) || chr(69888) || '-' || chr(69890) || chr(69927) || '-' || chr(69931) || chr(69933) || '-' || chr(69940) || chr(70003)
             || chr(70016) || '-' || chr(70017) || chr(70070) || '-' || chr(70078) || chr(70089) || '-' || chr(70092) || chr(70095) || chr(70191) || '-' || chr(70193)
             || chr(70196) || chr(70198) || '-' || chr(70199) || chr(70206) || chr(70209) || chr(70367)
             || chr(70371) || '-' || chr(70378) || chr(70400) || '-' || chr(70401) || chr(70459) || '-' || chr(70460) || chr(70464) || chr(70502) || '-' || chr(70508)
             || chr(70512) || '-' || chr(70516) || chr(70587) || '-' || chr(70592) || chr(70606) || chr(70608) || chr(70610)
             || chr(70625) || '-' || chr(70626) || chr(70712) || '-' || chr(70719) || chr(70722) || '-' || chr(70724) || chr(70726) || chr(70750)
             || chr(70835) || '-' || chr(70840) || chr(70842) || chr(70847) || '-' || chr(70848) || chr(70850) || '-' || chr(70851) || chr(71090) || '-' || chr(71093)
             || chr(71100) || '-' || chr(71101) || chr(71103) || '-' || chr(71104) || chr(71132) || '-' || chr(71133) || chr(71219) || '-' || chr(71226) || chr(71229)
             || chr(71231) || '-' || chr(71232) || chr(71339) || chr(71341) || chr(71344) || '-' || chr(71349) || chr(71351)
             || chr(71453) || chr(71455) || chr(71458) || '-' || chr(71461) || chr(71463) || '-' || chr(71467) || chr(71727) || '-' || chr(71735)
             || chr(71737) || '-' || chr(71738) || chr(71995) || '-' || chr(71996) || chr(71998) || chr(72003) || chr(72148) || '-' || chr(72151)
             || chr(72154) || '-' || chr(72155) || chr(72160) || chr(72193) || '-' || chr(72202) || chr(72243) || '-' || chr(72248) || chr(72251) || '-' || chr(72254)
             || chr(72263) || chr(72273) || '-' || chr(72278) || chr(72281) || '-' || chr(72283) || chr(72330) || '-' || chr(72342) || chr(72344) || '-' || chr(72345)
             || chr(72544) || chr(72546) || '-' || chr(72548) || chr(72550) || chr(72752) || '-' || chr(72758) || chr(72760) || '-' || chr(72765)
             || chr(72767) || chr(72850) || '-' || chr(72871) || chr(72874) || '-' || chr(72880) || chr(72882) || '-' || chr(72883) || chr(72885) || '-' || chr(72886)
             || chr(73009) || '-' || chr(73014) || chr(73018) || chr(73020) || '-' || chr(73021) || chr(73023) || '-' || chr(73029) || chr(73031)
             || chr(73104) || '-' || chr(73105) || chr(73109) || chr(73111) || chr(73459) || '-' || chr(73460) || chr(73472) || '-' || chr(73473)
             || chr(73526) || '-' || chr(73530) || chr(73536) || chr(73538) || chr(73562) || chr(78912)
             || chr(78919) || '-' || chr(78933) || chr(90398) || '-' || chr(90409) || chr(90413) || '-' || chr(90415) || chr(92912) || '-' || chr(92916) || chr(92976) || '-' || chr(92982)
             || chr(94031) || chr(94095) || '-' || chr(94098) || chr(94180) || chr(113821) || '-' || chr(113822) || chr(118528) || '-' || chr(118573)
             || chr(118576) || '-' || chr(118598) || chr(119143) || '-' || chr(119145) || chr(119163) || '-' || chr(119170) || chr(119173) || '-' || chr(119179) || chr(119210) || '-' || chr(119213)
             || chr(119362) || '-' || chr(119364) || chr(121344) || '-' || chr(121398) || chr(121403) || '-' || chr(121452) || chr(121461) || chr(121476)
             || chr(121499) || '-' || chr(121503) || chr(121505) || '-' || chr(121519) || chr(122880) || '-' || chr(122886) || chr(122888) || '-' || chr(122904) || chr(122907) || '-' || chr(122913)
             || chr(122915) || '-' || chr(122916) || chr(122918) || '-' || chr(122922) || chr(123023) || chr(123184) || '-' || chr(123190) || chr(123566)
             || chr(123628) || '-' || chr(123631) || chr(124140) || '-' || chr(124143) || chr(124398) || '-' || chr(124399) || chr(124643) || chr(124646)
             || chr(124654) || '-' || chr(124655) || chr(124661) || chr(125136) || '-' || chr(125142) || chr(125252) || '-' || chr(125258) || chr(917760) || '-' || chr(917999)
             -- Hebrew sof pasuq and the invisible fillers
             || chr(1475) || chr(4447) || chr(4448) || chr(12644) || chr(10240) || ']';
  v_text := regexp_replace(v_text, v_strip, '', 'g');
  v_space := '[' || chr(9) || '-' || chr(13) || chr(133) || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202)
             || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || ']';
  v_text := regexp_replace(v_text, v_space, ' ', 'g');
  v_text := translate(v_text,
    -- offer-fold:start
    'аАвВеЕёЁкКмМнНоОрРсСтТуУхХіІјЈѕЅԁԀӏӀαΑβΒεΕηΗιΙκΚμΜνΝοΟρΡτΤυΥχΧΖ',
    'aabbeeeekkmmhhooppccttyyxxiijjssddllaabbeenhiikkumvnooppttuyxxz'
    -- offer-fold:end
  );
  -- the Arabic-Indic and Extended Arabic-Indic digits are digits
  v_text := translate(v_text,
    -- offer-digits:start
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
    '01234567890123456789'
    -- offer-digits:end
  );
  v_text := app.message_ascii_lower(v_text);
  if v_text ~ ('[' || chr(8362) || '$' || chr(8364) || chr(163) || ']') then
    return true;
  end if;
  if v_text ~ ('ש["''' || chr(1524) || chr(1523) || chr(8220) || chr(8221) || chr(8222) || chr(8243) || chr(8242)
               || chr(8216) || chr(8217) || ']{1,2}ח') then
    return true;
  end if;
  if v_text ~ ('[0-9] *שח([^' || v_heb || ']|$)|(^|[^' || v_heb || '])שח *[0-9]') then
    return true;
  end if;
  if v_text ~ ('[0-9] *[%' || chr(1642) || ']|[%' || chr(1642) || '] *[0-9]') then
    return true;
  end if;
  -- owner (305) ב: "הנחה" counts only in a phrase ("הנחה של", or a percent sign before it), and "רק היום" is a phrase; the
  -- first word may carry up to three prefix letters (= OFFER_PHRASES)
  if v_text ~ ('(^|[^' || v_heb || '])[' || v_prefix || ']{0,3}הנחה +של([^' || v_heb || ']|$)') then
    return true;
  end if;
  if v_text ~ ('[%' || chr(1642) || '] *[' || v_prefix || ']{0,3}הנחה([^' || v_heb || ']|$)') then
    return true;
  end if;
  if v_text ~ ('(^|[^' || v_heb || '])[' || v_prefix || ']{0,3}רק +היום([^' || v_heb || ']|$)') then
    return true;
  end if;
  for v_word in select m[1] from regexp_matches(v_text, '[' || v_heb || ']+|[a-z]+', 'g') as m loop
    for v_k in 0..3 loop
      exit when char_length(v_word) <= v_k;
      -- the first v_k letters must all be prefix letters
      v_ok := true;
      for i in 1..v_k loop
        if strpos(v_prefix, substr(v_word, i, 1)) = 0 then
          v_ok := false;
        end if;
      end loop;
      exit when not v_ok;
      v_rest := substr(v_word, v_k + 1);
      if v_rest = any (v_words) and (v_k = 0 or not (substr(v_word, v_k, 1) || v_rest = any (v_not))) then
        return true;
      end if;
    end loop;
  end loop;
  return false;
end;
$$;
revoke all on function app.message_offer(text) from public, anon, authenticated, service_role;
