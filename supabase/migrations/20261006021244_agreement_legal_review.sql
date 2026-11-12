-- LEGAL-2 (owner, 12 November 2026; the legal review of that day, docs/DECISIONS.md). Two parts.
--
-- (1) The new wording of the terms, the privacy policy and the DPA is LEGAL_VERSION 2026-11-12
--     (src/features/legal/documents.ts): "בעל שליטה במאגר" / Mexuz "מחזיק", the privacy protection officer as a
--     highlighted placeholder until appointed, storage in Ireland (EU) and the business's consent to the transfer,
--     a security incident told within 24 hours, help reporting to the authority, the subprocessors with their country,
--     14 days' notice of a new one, return or deletion at the end, staff confidentiality, a yearly audit, the business
--     as "המפרסם" under section 30א, indemnity, no medical information until a secure module is turned on, liability
--     capped at 12 months' payments (not a full exemption), 30 days' notice of any change, jurisdiction in Israel.
--     Still a DRAFT until the lawyer edits it. FXS-09 accepts only registered texts, so the three fingerprints
--     (app.agreement_fingerprint(title, text) of agreementSnapshot(), tests/db/127) are registered here, before the
--     code that serves them. Earlier versions stay registered: signatures already made on them remain valid, and the
--     live site may serve 2026-10-13 until production is promoted. Users sign again on the new version
--     (requireAgreement).
--
-- (2) ADM-01: Anthropic, Cloudflare, InforU, Resend and Meta join the platform's subprocessors list with the DPA's 14
--     days' notice, through the same internal steps platform_add_subprocessor takes after its platform check (the
--     check needs a platform owner's aal2 session, which a migration has none of): app.subprocessor_input,
--     app.subprocessor_notice_ok, the insert (app.subprocessors_guard: a future day only), app.subprocessor_announce
--     (one 'system' notice per active owner of every business, the existing DRAFT wording) and app.log_platform
--     (action 'subprocessor.add', no actor). The day is 14 days after the day this migration runs, in Israel. An entry
--     of the same name that is not cancelled is never added twice, so a second run does nothing. The two entries in
--     force get their country, the fill-once location the guard allows while it is empty (Supabase: Ireland, on AWS;
--     Vercel: the United States); a location already set is left as it is.
--     The list is not part of a signed text, so (2) opens no LEGAL_VERSION.
--
-- Every statement is safe to run twice.

insert into app.agreement_texts (version, slug, text_hash) values
  ('2026-11-12', 'terms', '8751ef22b7c018026bf064c7e43271f410729387afeff5ddfb5dc3f2c2a073fb'),
  ('2026-11-12', 'privacy', 'd6ed15fbda87a64a28b3221e1287b3f2f22cad9d94f462f96fed8495cf36bdda'),
  ('2026-11-12', 'dpa', 'f37e7e1e37cd07ebb599a76f512cca33b70c8da2627be1ac431d8d3d7785bd82')
on conflict (version, slug, text_hash) do nothing;

do $$
declare
  v_from date := (now() at time zone 'Asia/Jerusalem')::date + 14;
  v_entry record;
  v jsonb;
  v_id uuid;
  v_sent integer;
begin
  for v_entry in
    select e.pos, e.name, e.purpose, e.data_categories, e.location
      from (values
        (1, 'Anthropic', 'כלי פיתוח ותחזוקה של השירות.', 'קוד השירות, ומידע שנדרש לבדיקת תקלה, רק כשצריך.', 'ארצות הברית'),
        (2, 'Cloudflare', 'הגנה מפני רובוטים בטופסי ההרשמה וההתחברות.', 'כתובת IP ופרטים טכניים של הדפדפן.', 'ארצות הברית'),
        (3, 'InforU', 'שליחת הודעות SMS מהשירות.', 'מספר הטלפון של הנמען ותוכן ההודעה.', 'ישראל'),
        (4, 'Resend', 'שליחת אימיילים מהשירות.', 'כתובת הנמען ותוכן האימייל.', 'אירלנד'),
        (5, 'Meta', 'קליטת לידים ממודעות בפייסבוק ובאינסטגרם, ושליחת הודעות WhatsApp, רק לעסק שחיבר אותם.',
            'פרטי הליד שמילא את הטופס במודעה, ומספר הטלפון ותוכן ההודעה.', 'ארצות הברית')
      ) as e(pos, name, purpose, data_categories, location)
     where not exists (select 1 from public.subprocessors s where s.name = e.name and s.cancelled_at is null)
     order by e.pos
  loop
    v := app.subprocessor_input(v_entry.name, v_entry.purpose, v_entry.data_categories, v_entry.location, null, v_from);
    perform app.subprocessor_notice_ok(v_from);
    insert into public.subprocessors (name, purpose, data_categories, location, website, effective_from, created_at, updated_at)
    values (v->>'name', v->>'purpose', v->>'data_categories', v->>'location', v->>'website', v_from,
            -- the list's order on the public page (effective_from, then created_at): the order above
            now() + v_entry.pos * interval '1 millisecond', now() + v_entry.pos * interval '1 millisecond')
    returning id into v_id;
    v_sent := app.subprocessor_announce(v_id);
    perform app.log_platform('subprocessor.add', null,
      v || jsonb_build_object('id', v_id, 'effective_from', v_from, 'notices', v_sent, 'by', 'migration LEGAL-2'));
  end loop;
end;
$$;

-- the country of the two entries in force, filled once while empty (the guard allows only that)
update public.subprocessors set location = 'אירלנד (על תשתית AWS)'
 where name = 'Supabase' and location is null and cancelled_at is null;
update public.subprocessors set location = 'ארצות הברית'
 where name = 'Vercel' and location is null and cancelled_at is null;
