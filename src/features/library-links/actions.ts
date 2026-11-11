"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

import { LIBRARY_LINK_TOKEN, publicLibraryPath } from "./public";
import { isLibraryRecordKind, type LibraryRecord } from "./record";

// LIB-02: a library item sent by a tracked link, with the user's session. The database decides who may (whoever writes in
// the business, for a record they read, of an item that may be sent now) and keeps only the token's hash.

const CANNOT = "אין לכם הרשאה לשלוח קישור מהספרייה לרשומה הזאת.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

function recordPath(orgId: string, record: LibraryRecord): string {
  switch (record.kind) {
    case "lead":
      return paths.lead(orgId, record.id);
    case "contact":
      return paths.contact(orgId, record.id);
    case "company":
      return paths.company(orgId, record.id);
    case "deal":
      return paths.deal(orgId, record.id);
  }
}

/** A new personal link of one item for the record (public.library_link_create). The address is returned once. */
export async function createLibraryLinkAction(orgId: string, record: LibraryRecord, itemId: string): Promise<ActionResult<{ url: string }>> {
  if (!record || !isLibraryRecordKind(record.kind)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, record.id, itemId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("library_link_create", {
    p_org: orgId,
    p_item: itemId,
    p_record_type: record.kind,
    p_record_id: record.id,
  });
  if (error) return fail(writeError(error));
  if (typeof data !== "string" || !LIBRARY_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(recordPath(orgId, record));
  return ok({ url: `${await siteOrigin()}${publicLibraryPath(data)}` });
}

/** Turns one link off; its page answers "not found" from now on. */
export async function revokeLibraryLinkAction(orgId: string, record: LibraryRecord, linkId: string): Promise<ActionResult> {
  if (!record || !isLibraryRecordKind(record.kind)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, record.id, linkId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("library_link_revoke", { p_org: orgId, p_link: linkId });
  if (error) return fail(writeError(error));
  revalidatePath(recordPath(orgId, record));
  return ok();
}
