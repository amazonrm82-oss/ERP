"use server";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { siteOrigin } from "@/lib/site-origin";

import { DOCUMENT_LINK_TOKEN, publicDocumentPath } from "./public";

// DOC-15: the customer's document link, with the user's session. The database decides who may (whoever records or issues
// documents, for a document they read; a new link only for an active document whose record is live, in a writable business
// with the `documents` key).

const CANNOT = "אין לכם הרשאה לשלוח את המסמך הזה ללקוח.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

/** `exists`: a link was made and not turned off; `active`: it opens now (it can exist and not open, e.g. a binned record or the
 * documents key off, and must still be turned off so it never comes back). */
export type DocumentLinkStatus = { exists: boolean; active: boolean; reason: DocumentLinkDormantReason | null; createdAt: string | null };

/** Why a link that exists does not open now, when the database can tell. */
export type DocumentLinkDormantReason = "pages_closed" | "feature_off" | "record_gone";
const REASONS: readonly string[] = ["pages_closed", "feature_off", "record_gone"];

/** Whether the document has a working link, and since when. */
export async function documentLinkStatusAction(orgId: string, documentId: string): Promise<ActionResult<DocumentLinkStatus>> {
  const context = await actionContext(orgId, documentId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("document_link_status", { p_org: orgId, p_document: documentId });
  if (error) return fail(writeError(error));
  const answer = (data ?? {}) as { exists?: unknown; usable?: unknown; reason?: unknown; created_at?: unknown };
  const exists = answer.exists === true;
  const active = exists && answer.usable === true;
  const reason = exists && !active && typeof answer.reason === "string" && REASONS.includes(answer.reason) ? (answer.reason as DocumentLinkDormantReason) : null;
  return ok({ exists, active, reason, createdAt: typeof answer.created_at === "string" ? answer.created_at : null });
}

/** A new link (public.document_link_create). The address is returned once: only its hash is kept; the previous link stops. */
export async function createDocumentLinkAction(orgId: string, documentId: string): Promise<ActionResult<{ url: string }>> {
  const context = await actionContext(orgId, documentId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("document_link_create", { p_org: orgId, p_document: documentId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string" || !DOCUMENT_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  return ok({ url: `${await siteOrigin()}${publicDocumentPath(data)}` });
}

/** Turns the document's link off; the page answers "not found" from now on. */
export async function revokeDocumentLinkAction(orgId: string, documentId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, documentId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("document_link_revoke", { p_org: orgId, p_document: documentId });
  if (error) return fail(writeError(error));
  return ok();
}
