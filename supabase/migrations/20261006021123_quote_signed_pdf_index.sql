-- =============================================================================
-- QUO-09 signed PDF: the old one-PDF-per-quote index gives way (pasted by hand in the SQL Editor: an index drop does not pass
-- the connector)
-- =============================================================================
-- 20261006021122_quote_signed_pdf made files_quote_pdf_root (one first file per quote) and files_quote_signed_one (one signed
-- PDF per quote); with files_one_newer a quote's files are one line: the PDF as sent, then the signed PDF. The index of 020955,
-- files_quote_pdf_one (one files row per quote), would refuse that second row, so it goes. No row is touched; the two new
-- indexes keep every rule it held for the PDF as sent. Safe to run twice. Paste it after 20261006021122 has been applied.

drop index if exists public.files_quote_pdf_one;
