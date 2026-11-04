-- LND/legal (owner, 4 November 2026): the business's own address mexuzsystem@gmail.com replaces the
-- personal one in the terms and the privacy notice (contact, support line, cancellation by email,
-- privacy requests). A filled-in detail, not new wording: LEGAL_VERSION stays 2026-10-13 (owner's rule
-- of 12 October 2026; tests/unit/legal-fingerprint.test.ts keeps the masked wording's hash unchanged).
-- FXS-09 accepts only registered texts, so the filled texts' fingerprints are registered here, before
-- the code that serves them. The earlier fingerprints stay: signatures already made on them remain valid,
-- and the live site may serve the older text until production is promoted. The DPA did not change.
-- Every statement is safe to run twice.

insert into app.agreement_texts (version, slug, text_hash) values
  ('2026-10-13', 'terms', '26b1cd068823bfd14dedd178a2643503fd2346b51143ccaf8e073165d2dba61a'),
  ('2026-10-13', 'privacy', 'aadec7c9c80452f0e86e179b8cfbfa86c6da47f20a8ac63ed1afdde4a1fe9dcb')
on conflict (version, slug, text_hash) do nothing;
