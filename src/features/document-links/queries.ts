import "server-only";

import { cache } from "react";

import { canIssueDocuments, canRecordDocuments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

// DOC-15: what the documents card needs to offer "שליחה ללקוח", read with the user's session.

export type DocumentDelivery = "system" | "provider";

/** Owner (413) ג: how a document goes to the customer by email; no settings row or an unknown value = our system. */
export const getDocumentDelivery = cache(async (orgId: string): Promise<DocumentDelivery> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select("document_delivery").eq("organization_id", orgId).maybeSingle(),
    "document delivery",
  );
  return row?.document_delivery === "provider" ? "provider" : "system";
});

/**
 * Whether the person may send a document's link: the database's rule (whoever records documents, or issues them by role or
 * the issue key); the database judges again, with the document's own reading rule.
 */
export const canSendDocuments = cache(async (orgId: string, canRecord: boolean): Promise<boolean> => {
  if (canRecord) return true;
  const [context, granted] = await Promise.all([getOrgContext(orgId), getMyPermissions(orgId)]);
  return context.canWrite && canIssueDocuments(context.role, granted);
});

/**
 * The rights of a document's link by role and personal keys only, without the plan key or a writable business: whoever may
 * see and turn off a link that exists (the database judges again, with the document's own reading rule).
 */
export const canManageDocumentLinks = cache(async (orgId: string): Promise<boolean> => {
  const [context, granted] = await Promise.all([getOrgContext(orgId), getMyPermissions(orgId)]);
  return canRecordDocuments(context.role, granted) || canIssueDocuments(context.role, granted);
});

/** Which of these documents have a link (made and not turned off) that the person may see and turn off. */
export async function existingDocumentLinks(orgId: string, documentIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(documentIds)].slice(0, 200);
  if (ids.length === 0) return new Set();
  const supabase = await createClient();
  const found = must(await supabase.rpc("document_links_existing", { p_org: orgId, p_documents: ids }), "document links");
  return new Set(found ?? []);
}

export type DocumentRecipient = { name: string | null; phoneE164: string | null; email: string | null };

/** The documents' contacts the person reads (RLS): the name, number and address the message goes to. */
export async function documentRecipients(orgId: string, contactIds: readonly string[]): Promise<Map<string, DocumentRecipient>> {
  const ids = [...new Set(contactIds)];
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  // a card lists at most 100 documents, so at most 100 contacts
  const rows = must(
    await supabase.from("contacts").select("id, full_name, phone_e164, email").eq("organization_id", orgId).in("id", ids.slice(0, 200)),
    "document recipients",
  );
  return new Map(rows.map((c) => [c.id, { name: c.full_name, phoneE164: c.phone_e164, email: c.email }]));
}
