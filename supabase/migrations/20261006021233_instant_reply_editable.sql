-- =============================================================================
-- SPD-04, owner's answer (282) ב: the instant-reply templates can be edited; an offer is refused
-- =============================================================================
-- Owner, 11 November 2026, (282) ב: "נוסח התשובה המיידית ניתן לעריכה; השמירה מסורבת כשמזוהים מחיר, אחוז הנחה, קישור
-- חיצוני או מילים שיווקיות (רשימה סגורה), דרך app.message_template_problem".
--
-- * The interim lock of 021225 (review 3) is lifted: app.message_templates_fixed_notice() becomes a pass-through (its trigger
--   message_templates_fixed_notice stays attached and does nothing: removing a trigger needs a statement the connector does
--   not take, see CLAUDE.md "Migrations"), and the hint message_template:fixed_notice is no longer raised. A person may now
--   edit the four seeded instant-reply templates and switch them off; deleting one of the system's marked templates
--   (notice_kind instant_reply_open|instant_reply_closed) is still refused for a person's own write (`authenticated`, depth
--   1, the rule 021225 had), now with the hint message_template:instant_reply_delete. Server paths (a business's cascade)
--   pass as before.
-- * A new code `offer` in the service template rule, judged for message type instant_reply ONLY:
--   app.message_offer(text) (immutable, pure) = messageOffer() in src/features/message-templates/service-rule.ts, both run
--   the shared fixture tests/unit/fixtures/message-template-problems.json (unit test and test 291). It judges the
--   TEMPLATE'S TEXT as written (subject and body together), never the filled fields: a business name or any other value a
--   merge field brings in at send time is not judged. The text is first made plain, in this order:
--   1. NFKC (as app.message_external_link): fullwidth forms, Hebrew presentation forms and look-alike digits fold;
--   2. removed: every combining mark (Unicode category Mn, written out as code point ranges and checked against the runtime's
--      \p{Mn} by a unit test; niqqud, U+034F and the variation selectors U+FE00..U+FE0F are Mn), the Hebrew sof pasuq
--      U+05C3, the invisible fillers U+115F, U+1160, U+3164 and U+2800, and every format character (Unicode category Cf,
--      listed explicitly: U+00AD, U+0600..U+0605, U+061C, U+06DD,
--      U+070F, U+0890..U+0891, U+08E2, U+180E, U+200B..U+200F, U+202A..U+202E, U+2060..U+2064, U+2066..U+206F, U+FEFF,
--      U+FFF9..U+FFFB, U+110BD, U+110CD, U+13430..U+1343F, U+1BCA0..U+1BCA3, U+1D173..U+1D17A, U+E0001, U+E0020..U+E007F;
--      a unit test compares the list with the runtime's \p{Cf});
--   3. every whitespace (tab, line ends, U+0085, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000)
--      becomes a space;
--   4. Cyrillic and Greek letters that look like Latin ones become those Latin letters (the two strings between the markers
--      offer-fold:start/end, = OFFER_FOLD_FROM / OFFER_FOLD_TO);
--   5. the Arabic-Indic digits U+0660..U+0669 and U+06F0..U+06F9 become 0-9 (markers offer-digits:start/end);
--   6. ASCII letters to lower case (app.message_ascii_lower).
--   Accepted (review): other look-alikes (Cherokee, small capitals, dotless i and the like) are not folded.
--   The plain text is an offer when it holds:
--   - a currency sign: ₪ $ € £;
--   - ש, one or two quote marks of " ' ״ ׳ “ ” „ ″ ′ ‘ ’, then ח (ש"ח);
--   - a bare שח as a word right next to a number, spaces between allowed ("100 שח", "100שח", "שח 100");
--   - a percent sign (% or the Arabic ٪; ％ folds by NFKC) next to a digit, spaces between allowed;
--   - a word of the closed list app.message_offer_words() (= OFFER_WORDS, markers offer-words:start/end). Words are the runs
--     of Hebrew letters (U+05D0..U+05EA) and the runs of a-z, so digits and other characters split them ("100nis",
--     "nis100", "50ils"). A word matches when it, or what is left after one, two or three leading prefix letters of
--     ו ב ל ה ש כ מ, is on the list, unless the last prefix letter with what is left makes an ordinary word of the closed
--     list app.message_offer_not_words() (= OFFER_NOT_WORDS, markers offer-not-words:start/end: "משקל" is weight, "לאחוז"
--     is to hold). Left out on purpose: "אחרון" ("לאחרונה" = recently), "free" ("feel free"), "הזדמנות" ("בהזדמנות" = some
--     time).
--   app.message_notice_template_problem (021218's body) adds one block: for instant_reply, right after field_not_allowed,
--   app.message_offer = 'offer'. So app.message_template_problem (its wrapper) and app.message_template_sendable answer it
--   too, and an instant-reply template saved before this rule that holds an offer is not sent (told once a day, as every
--   refusal code). app.message_send_refusal_text (021162's body) adds the 'offer' line.
-- * Saving is REFUSED (owner (282) ב), for instant_reply only, by the new trigger message_templates_instant_reply
--   (app.message_templates_instant_reply, invoker; before insert or update or delete): an insert, or an update that
--   changes the channel, type, subject or body, of an instant_reply template whose text holds an offer (P0001 hint
--   message_template:offer) or an external link (app.message_address_glue's external_link or app.message_external_link,
--   with the business's own domain and email as app.message_template_sendable reads them; P0001 hint
--   message_template:instant_reply_link) is refused, for every writer (the seeded wording passes). The judgement reads
--   the business's website and email through app.instant_reply_template_refusal (definer, granted to authenticated for the
--   trigger, schema app, not in the API; an outsider gets null, the outsider guard); an outsider's write is left to RLS.
--   Every other message type keeps its behaviour: saving is never refused, the problem is shown.
-- * The system's marked instant replies (notice_kind instant_reply_open|instant_reply_closed) keep their channel, message
--   type and mark for a person's write (`authenticated`, depth 1): a change is refused (P0001 hint
--   message_template:instant_reply_kind); only the name, wording, subject, locale and is_active change.
-- Redefined, each = its latest earlier body plus the lines marked "SPD-04 (282) ב": app.message_notice_template_problem
-- (021218), app.message_send_refusal_text (021162). Replaced: app.message_templates_fixed_notice (021225; the lock removed,
-- its body is now a pass-through). New: app.message_offer_words, app.message_offer_not_words, app.message_offer,
-- app.instant_reply_template_refusal,
-- app.message_templates_instant_reply and the trigger message_templates_instant_reply.
-- Every statement is safe to run twice. No drop statement, no delete.

-- ----------------------------------------------------------------------------
-- The closed lists of the offer rule (= OFFER_WORDS, OFFER_NOT_WORDS)
-- ----------------------------------------------------------------------------
create or replace function app.message_offer_words() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- offer-words:start
    'מבצע', 'מבצעים', 'הנחה', 'הנחות', 'חינם', 'הטבה', 'הטבות', 'קופון', 'קופונים', 'בלעדי', 'בלעדית', 'בלעדיים',
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

-- ----------------------------------------------------------------------------
-- The rule: 021218's body plus the offer block
-- ----------------------------------------------------------------------------
create or replace function app.message_notice_template_problem(p_channel text, p_message_type text, p_notice_kind text,
                                                               p_subject text, p_body text, p_own_domain text,
                                                               p_business_email text)
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
  -- SGN-03 review M1: the fields of the type, plus those only the system's own mark may hold
  v_fields := coalesce(app.message_type_fields(p_message_type), '{}'::text[]) || app.message_notice_fields(p_message_type, p_notice_kind);
  -- the same field pattern as app.message_unknown_field / MERGE_FIELD_PATTERN (a gender block always holds ":")
  if exists (select 1
               from regexp_matches(v_text, '\{([^{}:|\n]{1,30})\}', 'g') as m
              where not (m[1] = any (v_fields))) then
    return 'field_not_allowed';
  end if;
  -- SPD-04 (282) ב: an instant reply holds no price, percent discount or marketing word
  if p_message_type = 'instant_reply' and app.message_offer(v_text) then
    return 'offer';
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
revoke all on function app.message_notice_template_problem(text, text, text, text, text, text, text) from public, anon, authenticated, service_role;

create or replace function app.message_send_refusal_text(p_reason text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_reason
    when 'too_long' then 'ארוכה מדי: אחרי מילוי השדות היא עוברת את מספר התווים המותר בערוץ הזה'
    when 'field_not_allowed' then 'יש בתבנית שדה שלא מתאים לסוג ההודעה'
    when 'glued_address' then 'יש בתבנית כתובת צמודה לטקסט'
    when 'external_link' then 'יש בתבנית קישור חיצוני'
    -- SPD-04 (282) ב
    when 'offer' then 'יש בתבנית מחיר, הנחה או מילה שיווקית'
    when 'inactive' then 'התבנית כבויה'
  end;
$$;
revoke all on function app.message_send_refusal_text(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Saving an instant reply that holds an offer or an external link is refused
-- ----------------------------------------------------------------------------
-- 'offer' | 'external_link' | null for an instant_reply text, with the business's own domain and email (as
-- app.message_template_sendable reads them); null for every other type. Independent of the rule's order, so a text that
-- also holds a field of another type is still refused for its offer.
create or replace function app.instant_reply_template_refusal(p_org uuid, p_message_type text, p_subject text, p_body text)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_text text := coalesce(p_subject, '') || chr(10) || coalesce(p_body, '');
  v_own text;
  v_email text;
begin
  -- outsider guard: a person who is not a member of the business learns nothing about its domain or email
  if auth.uid() is not null and not app.is_member(p_org) then
    return null;
  end if;
  if coalesce(p_message_type, '') <> 'instant_reply' then
    return null;
  end if;
  if app.message_offer(v_text) then
    return 'offer';
  end if;
  select app.website_domain(o.website) into v_own from public.organizations o where o.id = p_org;
  select s.email into v_email from public.org_document_settings s where s.organization_id = p_org;
  if app.message_address_glue(v_text, v_own, v_email) = 'external_link'
     or app.message_external_link(v_text, v_own, v_email) then
    return 'external_link';
  end if;
  return null;
end;
$$;
revoke all on function app.instant_reply_template_refusal(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function app.instant_reply_template_refusal(uuid, text, text, text) to authenticated;

create or replace function app.message_templates_instant_reply() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_refusal text;
begin
  if tg_op = 'DELETE' then
    -- the system's marked instant replies are kept: a person switches one off (021225's rule, a new hint)
    if current_user = 'authenticated' and pg_trigger_depth() = 1
       and old.notice_kind in ('instant_reply_open', 'instant_reply_closed') then
      raise exception 'an instant reply template is not deleted' using errcode = 'P0001', hint = 'message_template:instant_reply_delete';
    end if;
    return old;
  end if;
  -- outsider guard: a write the caller may not make is RLS's to refuse
  if auth.uid() is not null and not app.is_admin(new.organization_id) then
    return new;
  end if;
  -- the system's marked templates keep their channel, type and mark for a person's write
  if tg_op = 'UPDATE' and current_user = 'authenticated' and pg_trigger_depth() = 1
     and old.notice_kind in ('instant_reply_open', 'instant_reply_closed')
     and (new.channel, new.message_type, new.notice_kind) is distinct from (old.channel, old.message_type, old.notice_kind) then
    raise exception 'an instant reply template keeps its channel and type' using errcode = 'P0001', hint = 'message_template:instant_reply_kind';
  end if;
  if new.message_type <> 'instant_reply' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and (new.channel, new.message_type, new.subject, new.body) is not distinct from (old.channel, old.message_type, old.subject, old.body) then
    return new;
  end if;
  v_refusal := app.instant_reply_template_refusal(new.organization_id, new.message_type, new.subject, new.body);
  if v_refusal = 'offer' then
    raise exception 'an instant reply holds no offer' using errcode = 'P0001', hint = 'message_template:offer';
  end if;
  if v_refusal = 'external_link' then
    raise exception 'an instant reply holds no external link' using errcode = 'P0001', hint = 'message_template:instant_reply_link';
  end if;
  return new;
end;
$$;
revoke all on function app.message_templates_instant_reply() from public, anon, authenticated;
grant execute on function app.message_templates_instant_reply() to authenticated;

create or replace trigger message_templates_instant_reply
  before insert or update or delete on public.message_templates
  for each row execute function app.message_templates_instant_reply();

-- 021225's interim lock is lifted (owner (282) ב): the trigger message_templates_fixed_notice now does nothing
create or replace function app.message_templates_fixed_notice() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
begin
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function app.message_templates_fixed_notice() from public, anon, authenticated;
grant execute on function app.message_templates_fixed_notice() to authenticated;

notify pgrst, 'reload schema';
