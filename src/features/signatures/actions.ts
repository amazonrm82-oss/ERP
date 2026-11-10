"use server";

import { revalidatePath } from "next/cache";

import { isDocumentRecordType, type DocumentRecordType } from "@/features/document-templates/fields";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

import { readSignedDocumentSource } from "./pdf";
import { writeSignedDocumentPdfAsServer } from "./pdf-server";
import { publicSignaturePath, SIGNATURE_LINK_TOKEN } from "./public";

// SGN-02: a document for signature from a record, with the user's session. The database decides who may (whoever may edit
// the live record, in a writable business with the `signatures` key) and counts the month's cap. Owner (224) ב: the DATABASE
// fills the template for the record (public.signature_document_draft); the sender edits the free text only, and the send
// judges the text against the database's own fill again (locked sections and filled values unchanged, in order).

const CANNOT = "אין לכם הרשאה לשלוח מסמך לחתימה מהרשומה הזאת.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

function recordPath(orgId: string, kind: DocumentRecordType, id: string): string {
  if (kind === "lead") return paths.lead(orgId, id);
  if (kind === "contact") return paths.contact(orgId, id);
  if (kind === "company") return paths.company(orgId, id);
  return paths.deal(orgId, id);
}

export type DraftSegment = { locked: boolean; text: string };
type Drafted = { title: string; segments: DraftSegment[]; unfilled: string[]; draftWording: boolean };

function draftFrom(raw: unknown): Drafted | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { title?: unknown; segments?: unknown; unfilled?: unknown; draft_wording?: unknown };
  if (typeof r.title !== "string" || !Array.isArray(r.segments) || !Array.isArray(r.unfilled)) return null;
  const segments: DraftSegment[] = [];
  for (const seg of r.segments) {
    const s2 = seg as { locked?: unknown; text?: unknown };
    if (typeof s2?.locked !== "boolean" || typeof s2.text !== "string") return null;
    segments.push({ locked: s2.locked, text: s2.text });
  }
  return { title: r.title, segments, unfilled: r.unfilled.filter((name): name is string => typeof name === "string"), draftWording: r.draft_wording === true };
}

/**
 * Owner (224) ב: the template filled by the DATABASE for this record (public.signature_document_draft, the sending rights),
 * in segments: the sender edits the free ones; the locked ones are shown read-only. Nothing is stored.
 */
export async function prepareSignatureDocumentAction(orgId: string, kind: string, recordId: string, templateId: string): Promise<ActionResult<Drafted>> {
  if (!isDocumentRecordType(kind)) return fail(NOT_FOUND);
  const context = await actionContext(orgId, recordId, templateId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("signature_document_draft", { p_org: orgId, p_template: templateId, p_record_type: kind, p_record_id: recordId });
  if (error) return fail(writeError(error));
  const drafted = draftFrom(data);
  return drafted ? ok(drafted) : fail("לא הצלחנו להכין את המסמך.");
}

const VALID_DAYS = [3, 7, 14, 30] as const;

/**
 * Sends the document as the sender edited it. The database fills the template again itself and refuses the text unless every
 * locked section and every filled value is there unchanged and in order (signature_document:locked_changed); it stores it
 * frozen with its link and answers the link (shown once).
 */
export async function sendSignatureDocumentAction(
  orgId: string,
  kind: string,
  recordId: string,
  templateId: string,
  title: string,
  body: string,
  validDays: number | null,
): Promise<ActionResult<{ url: string; title: string }>> {
  if (!isDocumentRecordType(kind)) return fail(NOT_FOUND);
  if (!validArg(optionalTextArg(120), title) || typeof title !== "string") return fail("הכותרת ארוכה מדי.");
  if (typeof body !== "string" || body.trim() === "" || body.length > 30000) return fail("המסמך ריק או ארוך מדי.");
  if (validDays !== null && !(VALID_DAYS as readonly number[]).includes(validDays)) return fail("הבקשה אינה תקינה.");
  const context = await actionContext(orgId, recordId, templateId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("signature_document_send", {
    p_org: orgId,
    p_template: templateId,
    p_record_type: kind,
    p_record_id: recordId,
    p_title: title.trim(),
    p_body: body.replace(/\r\n/g, "\n"),
    p_valid_days: validDays,
  });
  if (error) return fail(writeError(error));
  const token = (data as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || !SIGNATURE_LINK_TOKEN.test(token)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(recordPath(orgId, kind, recordId));
  return ok({ url: `${await siteOrigin()}${publicSignaturePath(token)}`, title: title.trim() || "מסמך לחתימה" });
}

/** A new link for a document that waits for its signature; the previous link stops working. */
export async function newSignatureLinkAction(orgId: string, kind: string, recordId: string, docId: string): Promise<ActionResult<{ url: string }>> {
  if (!isDocumentRecordType(kind)) return fail(NOT_FOUND);
  const context = await actionContext(orgId, recordId, docId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("signature_document_link", { p_org: orgId, p_doc: docId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string" || !SIGNATURE_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(recordPath(orgId, kind, recordId));
  return ok({ url: `${await siteOrigin()}${publicSignaturePath(data)}` });
}

/** Cancels a document that waits for its signature; its link then shows only that it was cancelled. */
export async function cancelSignatureDocumentAction(orgId: string, kind: string, recordId: string, docId: string): Promise<ActionResult> {
  if (!isDocumentRecordType(kind)) return fail(NOT_FOUND);
  const context = await actionContext(orgId, recordId, docId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("signature_document_cancel", { p_org: orgId, p_doc: docId });
  if (error) return fail(writeError(error));
  revalidatePath(recordPath(orgId, kind, recordId));
  return ok();
}

/** Owners and admins: makes the signed PDF when the customer's route could not (asked with their own session first). */
export async function makeSignedDocumentPdfAction(orgId: string, kind: string, recordId: string, docId: string): Promise<ActionResult> {
  if (!isDocumentRecordType(kind)) return fail(NOT_FOUND);
  const context = await actionContext(orgId, recordId, docId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("signature_pdf_allowed", { p_org: orgId, p_doc: docId });
  if (error) return fail(error.code === "42501" ? "רק בעלים ומנהלי מערכת יוצרים את ה-PDF החתום." : dbErrorMessage(error));
  if (data === null) {
    revalidatePath(recordPath(orgId, kind, recordId));
    return ok();
  }
  const read = readSignedDocumentSource(data);
  if ("problem" in read) return fail("החתימה השמורה אינה תקינה, לא ניתן ליצור PDF חתום.");
  const stored = await writeSignedDocumentPdfAsServer({ orgId, docId, userId: context.user.id, source: read.source });
  if (!stored.ok) return fail(stored.message);
  revalidatePath(recordPath(orgId, kind, recordId));
  return ok();
}
