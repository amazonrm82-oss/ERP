import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { FILES_BUCKET } from "@/features/files/types";
import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage } from "@/lib/errors";

import { getQuoteDocumentData } from "./design-server";
import { quotePdfDocument, quotePdfFileName } from "./pdf";
import type { Quote } from "./queries";

type Client = SupabaseClient<Database>;

export type QuotePdfResult = { ok: true; fileId: string } | { ok: false; message: string };

const NOT_MADE = "קובץ ה-PDF לא נשמר. נסו שוב בעוד רגע.";
const IN_PROGRESS = "קובץ ה-PDF של ההצעה בהכנה. נסו שוב בעוד כמה דקות.";
const STUCK = "קובץ ה-PDF של ההצעה לא הגיע. בעלים או מנהל מערכת יכולים לשמור אותו מחדש.";
const CLOSED = "קובץ PDF נשמר רק להצעה שנשלחה ועדיין פתוחה (נשלחה או נצפתה).";
// an upload that has waited this long is taken as one that never arrives
const STALE_WAIT_MS = 10 * 60 * 1000;

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
 * against max_pdf_per_month only when a new version's file is made; a stored file is never made again). Everything goes
 * with the session of the person who asks, under the files rules: the row (the database checks the quote, the flag, the
 * quota and the rate), the object in record-files, and the confirmation that reads the real object back.
 */
export async function storeQuotePdf(supabase: Client, orgId: string, quote: Quote, userId: string): Promise<QuotePdfResult> {
  if (quote.status === "draft") return { ok: false, message: "לטיוטה אין קובץ PDF. הקובץ נשמר כשההצעה נשלחת." };
  // review L3: a later PDF only while the quote is still the open offer that was sent
  if (!quotePdfStorable(quote.status)) return { ok: false, message: CLOSED };
  const existing = await supabase
    .from("files")
    .select("id, unconfirmed_since, uploaded_by, created_at")
    .eq("organization_id", orgId)
    .eq("quote_id", quote.id)
    .maybeSingle();
  if (existing.error) return { ok: false, message: dbErrorMessage(existing.error) };
  if (existing.data) {
    if (existing.data.unconfirmed_since === null) return { ok: true, fileId: existing.data.id };
    // an upload of this person's that never arrived goes. Someone else's is still on its way, unless it has waited longer
    // than STALE_WAIT_MS: then an owner or admin removes it (review L1; the database decides, a member gets 0 rows)
    const own = existing.data.uploaded_by === userId;
    if (!own && Date.now() - new Date(existing.data.created_at).getTime() < STALE_WAIT_MS) return { ok: false, message: IN_PROGRESS };
    // the object first (Storage finds its row to decide), then the row; a path left behind goes to the orphan cleanup
    await supabase.storage.from(FILES_BUCKET).remove([`${orgId}/${existing.data.id}`]);
    const removed = await supabase.from("files").delete().eq("organization_id", orgId).eq("id", existing.data.id).select("id");
    if (removed.error || (removed.data ?? []).length === 0) return { ok: false, message: own ? IN_PROGRESS : STUCK };
  }

  const org = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
  if (org.error || !org.data) return { ok: false, message: NOT_MADE };
  const data = await getQuoteDocumentData(orgId, quote, org.data.name);
  const bytes = await renderPdf(quotePdfDocument(data, await loadPdfLogo(data.logoUrl)));

  const row = await supabase
    .from("files")
    .insert({ organization_id: orgId, quote_id: quote.id, name: quotePdfFileName(quote.numberDisplay, quote.title), mime_type: "application/pdf", size_bytes: bytes.length })
    .select("id, storage_path")
    .single();
  if (row.error) {
    // two people at once: the other one's file is the quote's file
    if (row.error.code === "23505") return { ok: false, message: IN_PROGRESS };
    if (row.error.code === "42501") return { ok: false, message: "אין לכם הרשאה לשמור את קובץ ה-PDF של ההצעה הזאת." };
    return { ok: false, message: dbErrorMessage(row.error) };
  }
  const forget = async () => {
    await supabase.storage.from(FILES_BUCKET).remove([row.data.storage_path]);
    await supabase.from("files").delete().eq("organization_id", orgId).eq("id", row.data.id);
  };
  const upload = await supabase.storage.from(FILES_BUCKET).upload(row.data.storage_path, bytes, { contentType: "application/pdf", upsert: false });
  if (upload.error) {
    await forget();
    return { ok: false, message: NOT_MADE };
  }
  const confirmed = await supabase.rpc("confirm_file_upload", { p_org: orgId, p_file: row.data.id });
  const answer = confirmed.data as { ok?: boolean } | null;
  if (confirmed.error || answer?.ok !== true) {
    await forget();
    return { ok: false, message: confirmed.error ? dbErrorMessage(confirmed.error) : NOT_MADE };
  }
  return { ok: true, fileId: row.data.id };
}
