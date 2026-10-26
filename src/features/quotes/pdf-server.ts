import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import { getQuoteDocumentData } from "./design-server";
import { quotePdfDocument, quotePdfFileName } from "./pdf";
import { writeQuotePdfAsServer } from "./pdf-store-server";
import type { Quote } from "./queries";

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

/** The stored PDF of a quote (a confirmed file), or null. Read with the user's session: whoever reads the quote. */
export async function getQuotePdfFile(supabase: Client, orgId: string, quoteId: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from("files")
    .select("id, name, unconfirmed_since")
    .eq("organization_id", orgId)
    .eq("quote_id", quoteId)
    .maybeSingle();
  if (error) throw new Error(`quote pdf: ${error.message}`);
  return data && data.unconfirmed_since === null ? { id: data.id, name: data.name } : null;
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
  // review L3: a later PDF only while the quote is still the open offer that was sent
  if (!quotePdfStorable(quote.status)) return { ok: false, message: CLOSED };
  const existing = await getQuotePdfFile(supabase, orgId, quote.id).catch(() => null);
  if (existing) return { ok: true, fileId: existing.id };

  // the person's own session decides first (writable business, the flag, may edit the quote's deal or contact)
  const allowed = await supabase.rpc("quote_pdf_allowed", { p_org: orgId, p_quote: quote.id });
  if (allowed.error) return { ok: false, message: dbErrorMessage(allowed.error) };
  if (allowed.data !== true) return { ok: false, message: NOT_PERMITTED };

  const org = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
  if (org.error || !org.data) return { ok: false, message: NOT_MADE };
  const data = await getQuoteDocumentData(orgId, quote, org.data.name);
  const bytes = await renderPdf(quotePdfDocument(data, await loadPdfLogo(data.logoUrl)));

  const stored = await writeQuotePdfAsServer({ orgId, quoteId: quote.id, userId, bytes, name: quotePdfFileName(quote.numberDisplay, quote.title) });
  if (!stored.ok) return { ok: false, message: stored.busy ? IN_PROGRESS : stored.message };
  return { ok: true, fileId: stored.fileId };
}
