import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PdfDocument } from "@/features/pdf/document";
import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";
import { TIME_ZONE } from "@/lib/app";

import { getQuoteDocumentData } from "./design-server";
import { quotePdfDocument, quotePdfFileName, remadeNote } from "./pdf";
import { writeQuotePdfAsServer } from "./pdf-store-server";
import { ACCEPTED_REMAKE_SUFFIX, acceptedChoiceChanged } from "./decision";
import { getQuoteDecision, type Quote } from "./queries";
import { readSignature, SIGNATURE_INVALID_MESSAGE, signedQuotePdfFileName } from "./signed-pdf";
import { renderSignedQuotePdf, writeSignedQuotePdfAsServer } from "./signed-pdf-server";
import { linesAsSent, parseQuoteSentState, quoteAsSent, remakeRender, SENT_REMAKE_SUFFIX, sentStateDiffers, wasAccepted, type QuoteSentState } from "./sent-state";

type Client = SupabaseClient<Database>;

export type QuotePdfResult = { ok: true; fileId: string } | { ok: false; message: string };

const NOT_MADE = "קובץ ה-PDF לא נשמר. נסו שוב בעוד רגע.";
const IN_PROGRESS = "קובץ ה-PDF של ההצעה בהכנה. נסו שוב בעוד כמה דקות.";
const NOT_PERMITTED = "אין לכם הרשאה לשמור את קובץ ה-PDF של ההצעה הזאת.";
const CLOSED = "קובץ PDF נשמר רק להצעה שנשלחה ועדיין פתוחה (נשלחה או נצפתה).";

/** Review L3: a PDF is made (at sending, or later) only while the quote is sent or viewed. */
export function quotePdfStorable(status: Quote["status"]): boolean {
  return status === "sent" || status === "viewed";
}

/**
 * PKG-06 (owner (172) ב): the next PDF of this quote or order is made again after a service recipient's erasure removed its
 * file (asked with the person's own session; false when it cannot be read).
 */
export async function recipientPdfRemakePending(supabase: Client, orgId: string, doc: { quoteId?: string; orderId?: string }): Promise<boolean> {
  const { data, error } = await supabase.rpc("recipient_pdf_remake_pending", { p_org: orgId, p_quote: doc.quoteId ?? null, p_order: doc.orderId ?? null });
  return !error && data === true;
}

/** PKG-06 (second review M1): is this stored file a PDF made again after a service recipient's erasure (the user's session)? */
export async function recipientPdfRemade(supabase: Client, orgId: string, fileId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("recipient_pdf_remade", { p_org: orgId, p_file: fileId });
  return !error && data === true;
}

/**
 * Owner (175) ג: the quote's state as sent (021190), with the person's own session. `state` is null for a quote sent before
 * 021190 (or when the person may not have the quote's PDF made); a failed read, or an answer we cannot read, is `ok: false`,
 * so a remake renders nothing rather than guess (review M1).
 */
export async function getQuoteSentState(
  supabase: Client,
  orgId: string,
  quoteId: string,
): Promise<{ ok: true; state: QuoteSentState | null } | { ok: false }> {
  const { data, error } = await supabase.rpc("quote_sent_state", { p_org: orgId, p_quote: quoteId });
  if (error) return { ok: false };
  if (data === null || data === undefined) return { ok: true, state: null };
  const state = parseQuoteSentState(data);
  return state ? { ok: true, state } : { ok: false };
}

/** Owner (175) ג: does a quote the caller reads keep its state as sent (a boolean only; `onError` when it cannot be read)? */
export async function quoteHasSentState<E extends boolean | null = false>(
  supabase: Client,
  orgId: string,
  quoteId: string,
  onError: E = false as E,
): Promise<boolean | E> {
  const { data, error } = await supabase.rpc("quote_has_sent_state", { p_org: orgId, p_quote: quoteId });
  if (error || typeof data !== "boolean") return onError;
  return data;
}

/**
 * The document of a PDF as sent that the server makes again: from the state as sent when the quote has one (owner (175) ג),
 * else 021187's rule (second review M1: an accepted quote whose customer's choice changed it is made again as accepted, and
 * says so). The footer always says it was made again (owner, 26 October 2026, answer 3: the day in the business's zone).
 */
async function remadeQuoteDocument(
  supabase: Client,
  orgId: string,
  quote: Quote,
  org: { name: string; timezone: string | null },
  // the recipient-erasure remake (021187) falls back to "as accepted"; the legacy remake (021015) to the quote as it is
  acceptedFallback: boolean,
): Promise<PdfDocument | null> {
  const read = await getQuoteSentState(supabase, orgId, quote.id);
  if (!read.ok) return null;
  const sent = read.state;
  // review M1: a quote that keeps its state as sent but whose state came back empty (a reader who may not have it, a race)
  // is never made again by the fallback rule
  if (!sent && (await quoteHasSentState(supabase, orgId, quote.id, null)) !== false) return null;
  const base = await getQuoteDocumentData(orgId, sent ? quoteAsSent(quote, sent) : quote, org.name);
  const changed =
    acceptedFallback &&
    !sent &&
    wasAccepted(quote) &&
    acceptedChoiceChanged(await getQuoteDecision(orgId, quote.id).catch(() => null), base.lines);
  const render = remakeRender({ remake: true, hasSentState: sent !== null, acceptedChoiceChanged: changed });
  const data = sent ? { ...base, lines: linesAsSent(base.lines, sent) } : base;
  // owner (176) ב: ", כפי שנשלח" only when the state as sent differs from the quote today (totals, rate, optional selections)
  const sentMark = sent !== null && sentStateDiffers(quote, base.lines, sent);
  const suffix = render.kind === "sent" ? (sentMark ? SENT_REMAKE_SUFFIX : "") : render.kind === "accepted" ? ACCEPTED_REMAKE_SUFFIX : "";
  const note = remadeNote(new Date(), org.timezone || TIME_ZONE) + suffix;
  return quotePdfDocument(data, await loadPdfLogo(data.logoUrl), { remadeNote: note, accepted: render.kind === "accepted" });
}

/**
 * The stored PDF of a quote (a confirmed file), or null. Read with the user's session: whoever reads the quote.
 * `fingerprinted` is false for a PDF kept by the old flow, before the server kept its SHA-256 (020995).
 */
export async function getQuotePdfFile(
  supabase: Client,
  orgId: string,
  quoteId: string,
): Promise<{ id: string; name: string; fingerprinted: boolean } | null> {
  const { data, error } = await supabase
    .from("files")
    .select("id, name, unconfirmed_since, sha256")
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    // QUO-09: the PDF as sent (a signed version after it is its own row)
    .is("quote_signed", null)
    .maybeSingle();
  if (error) throw new Error(`quote pdf: ${error.message}`);
  return data && data.unconfirmed_since === null ? { id: data.id, name: data.name, fingerprinted: data.sha256 !== null } : null;
}

/**
 * QUO-06 follow-up (owner, 26 October 2026, answer 1 (ג)): a PDF kept before the fingerprint existed is made again by the
 * server, once, when someone who may edit the quote opens it or asks to keep it. Not counted in the monthly quota; the same
 * files row moves to the new file and the old object is deleted by the nightly cleanup (public.quote_pdf_store decides all of
 * it). Answers true when the file now has its fingerprint. A failure leaves the old file as it was.
 */
export async function remakeLegacyQuotePdf(supabase: Client, orgId: string, quote: Quote, userId: string): Promise<boolean> {
  if (quote.status === "draft") return false;
  // the person's own session decides first (review L1 of 020995: the two-step rule holds here)
  const allowed = await supabase.rpc("quote_pdf_remake_allowed", { p_org: orgId, p_quote: quote.id });
  if (allowed.error || allowed.data !== true) return false;
  const org = await supabase.from("organizations").select("name, timezone").eq("id", orgId).maybeSingle();
  if (org.error || !org.data) return false;
  // a remade file says so at its bottom; owner (175) ג: from the state as sent when the quote has one
  const doc = await remadeQuoteDocument(supabase, orgId, quote, org.data, false);
  // review M1: the state as sent could not be read; the old file stays as it is
  if (!doc) return false;
  const bytes = await renderPdf(doc);
  const stored = await writeQuotePdfAsServer({ orgId, quoteId: quote.id, userId, bytes, name: quotePdfFileName(quote.numberDisplay, quote.title) });
  if (!stored.ok) return false;
  const now = await getQuotePdfFile(supabase, orgId, quote.id);
  return now?.fingerprinted === true;
}

/**
 * QUO-06: makes the PDF of a sent quote and keeps it, once (owner, 13 October 2026: produced on our server, counted
 * against max_pdf_per_month only when a new version's file is made; a stored file is never made again).
 * Since the follow-up of 26 October 2026 (answer 3) only the server writes it: the person's right is asked here with their
 * own session (public.quote_pdf_allowed), the PDF is rendered here, and the row and the object are written with the service
 * key through public.quote_pdf_store alone (pdf-store-server.ts), which checks the user again and keeps the file's SHA-256.
 */
export async function storeQuotePdf(supabase: Client, orgId: string, quote: Quote, userId: string): Promise<QuotePdfResult> {
  if (quote.status === "draft") return { ok: false, message: "לטיוטה אין קובץ PDF. הקובץ נשמר כשההצעה נשלחת." };
  const existing = await getQuotePdfFile(supabase, orgId, quote.id).catch(() => null);
  if (existing) {
    // answer 1 (ג): a file kept by the old flow is made again once; it stays as it is when that cannot happen now
    if (!existing.fingerprinted) await remakeLegacyQuotePdf(supabase, orgId, quote, userId).catch(() => false);
    return { ok: true, fileId: existing.id };
  }
  // PKG-06 (owner (172) ב): the PDF as sent that a service recipient's erasure removed is made again, whatever the quote's
  // status, with the footer of a remake (the database keeps the marker and lets only that one through)
  const remake = await recipientPdfRemakePending(supabase, orgId, { quoteId: quote.id });
  // review L3: a later PDF only while the quote is still the open offer that was sent
  if (!quotePdfStorable(quote.status) && !remake) return { ok: false, message: CLOSED };

  // the person's own session decides first (writable business, the flag, may edit the quote's deal or contact)
  const allowed = quotePdfStorable(quote.status)
    ? await supabase.rpc("quote_pdf_allowed", { p_org: orgId, p_quote: quote.id })
    : await supabase.rpc("quote_pdf_recipient_remake_allowed", { p_org: orgId, p_quote: quote.id });
  if (allowed.error) return { ok: false, message: dbErrorMessage(allowed.error) };
  if (allowed.data !== true) return { ok: false, message: NOT_PERMITTED };

  const org = await supabase.from("organizations").select("name, timezone").eq("id", orgId).maybeSingle();
  if (org.error || !org.data) return { ok: false, message: NOT_MADE };
  // a first PDF is the live quote (still the sent state: made only while sent or viewed); a remake after a recipient's erasure
  // renders the state as sent when the quote has one (owner (175) ג), else 021187's rule (remadeQuoteDocument)
  let doc: PdfDocument;
  if (remake) {
    const remade = await remadeQuoteDocument(supabase, orgId, quote, org.data, true);
    // review M1: the state as sent could not be read; nothing is made, so the credit is kept for the next try
    if (!remade) return { ok: false, message: NOT_MADE };
    doc = remade;
  } else {
    const data = await getQuoteDocumentData(orgId, quote, org.data.name);
    doc = quotePdfDocument(data, await loadPdfLogo(data.logoUrl));
  }
  const bytes = await renderPdf(doc);

  const stored = await writeQuotePdfAsServer({ orgId, quoteId: quote.id, userId, bytes, name: quotePdfFileName(quote.numberDisplay, quote.title) });
  if (!stored.ok) return { ok: false, message: stored.busy ? IN_PROGRESS : stored.message };
  return { ok: true, fileId: stored.fileId };
}

// QUO-09 signed PDF (owner, 1 November 2026, answers (3) א and (33) ב) ---------------------------------------------------------

/** The accepted quote's signed PDF (a confirmed file), or null. Read with the user's session: whoever reads the quote. */
export async function getSignedQuotePdfFile(supabase: Client, orgId: string, quoteId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from("files")
    .select("id, name, unconfirmed_since")
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    .eq("quote_signed", true)
    .maybeSingle();
  if (error) throw new Error(`signed quote pdf: ${error.message}`);
  return data && data.unconfirmed_since === null ? { id: data.id, name: data.name } : null;
}

const SIGNED_NOT_MADE = "קובץ ה-PDF החתום לא נשמר. נסו שוב בעוד רגע.";
const SIGNED_IN_PROGRESS = "קובץ ה-PDF החתום בהכנה. נסו שוב בעוד כמה דקות.";
const SIGNED_NOT_PERMITTED = "אין לכם הרשאה לשמור את ה-PDF החתום של ההצעה הזאת.";

/**
 * "יצירת PDF חתום": the signed PDF of an accepted quote whose file was not made at the acceptance (a full monthly quota, a
 * render error). The person's right and the signature block come from public.quote_signed_pdf_allowed with their own
 * session; the document is read with it too, rendered here, and written with the service key for that user (checked again).
 */
export async function storeSignedQuotePdf(
  supabase: Client,
  orgId: string,
  quote: Quote,
  userId: string,
  // SGN-07 (276) א: "in_person" = the rep who was present at an in-person acceptance, right after it (the rep's session asks
  // public.quote_in_person_pdf_allowed; the same writer checks that rep again)
  via: "staff" | "in_person" = "staff",
): Promise<QuotePdfResult> {
  if (quote.status !== "accepted") return { ok: false, message: "PDF חתום נשמר רק להצעה שהלקוח אישר וחתם עליה." };
  const existing = await getSignedQuotePdfFile(supabase, orgId, quote.id).catch(() => null);
  if (existing) return { ok: true, fileId: existing.id };
  const allowed = await supabase.rpc(via === "in_person" ? "quote_in_person_pdf_allowed" : "quote_signed_pdf_allowed", { p_org: orgId, p_quote: quote.id });
  // owners and admins only (review, until the owner answers question 37)
  if (allowed.error?.code === "42501") return { ok: false, message: SIGNED_NOT_PERMITTED };
  if (allowed.error) return { ok: false, message: dbErrorMessage(allowed.error) };
  if (allowed.data === null) return { ok: false, message: SIGNED_NOT_PERMITTED };
  const read = readSignature(allowed.data);
  // a stored signature that fails the image checks gets its own message (no retry helps)
  if ("problem" in read) return { ok: false, message: read.problem === "shape" ? SIGNED_NOT_MADE : SIGNATURE_INVALID_MESSAGE };
  const signature = read.signature;
  const org = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
  if (org.error || !org.data) return { ok: false, message: SIGNED_NOT_MADE };
  const data = await getQuoteDocumentData(orgId, quote, org.data.name);
  const bytes = await renderSignedQuotePdf(data, signature);
  const stored = await writeSignedQuotePdfAsServer({
    orgId,
    quoteId: quote.id,
    userId,
    bytes,
    name: signedQuotePdfFileName(quote.numberDisplay, quote.title),
    fingerprint: signature.fingerprint,
  });
  if (!stored.ok) return { ok: false, message: stored.busy ? SIGNED_IN_PROGRESS : stored.message };
  return { ok: true, fileId: stored.fileId };
}
