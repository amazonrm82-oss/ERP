-- Legal (owner, 4 November 2026): the operating company's name (MEXUZ) and postal address (הלילך 9,
-- ירושלים, ישראל) fill the placeholders of the terms, the privacy notice and the DPA. A filled-in detail,
-- not new wording: LEGAL_VERSION stays 2026-10-13 (owner's rule of 12 October 2026;
-- tests/unit/legal-fingerprint.test.ts keeps the masked wording's hash unchanged). FXS-09 accepts only
-- registered texts, so the filled texts' fingerprints are registered here, before the code that serves
-- them. Earlier fingerprints stay: signatures already made on them remain valid, and the live site may
-- serve the older text until production is promoted.
-- Every statement is safe to run twice.

insert into app.agreement_texts (version, slug, text_hash) values
  ('2026-10-13', 'terms', 'e0e1e3ff1d61de427fff41db39927a38d83e67d5f5aa18f54e2da0d85bfb6a18'),
  ('2026-10-13', 'privacy', '8de21bb4e4040add25722665c50c44b9d742b6973cf4762867e35d59f8f8d0b0'),
  ('2026-10-13', 'dpa', '6ec9196c6efef58de60b7c96212247cf943408253ade21fe183ec5e82ff26f67')
on conflict (version, slug, text_hash) do nothing;
