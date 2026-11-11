import "server-only";

import { must } from "@/lib/db-read";
import { PAGE_SIZE } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

import type { DocumentRecordType } from "@/features/document-templates/fields";

import { CONVERTED_LEADS_MAX, recordDocumentsFilter } from "./record-filter";
import { signatureCustomerReminderOf, signatureReminderDaysOf, type SignatureReminderSettings } from "./reminder";
import { isSignatureStatus, type SignatureStatus } from "./states";

/** SGN-03: the reminder interval in business days (0 = off) and the customer's reminder (no settings row = 3 and on). */
export async function getSignatureReminderSettings(orgId: string): Promise<SignatureReminderSettings> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select("signature_reminder_days, signature_customer_reminder").eq("organization_id", orgId).maybeSingle(),
    "signature reminder settings",
  );
  return { days: signatureReminderDaysOf(row?.signature_reminder_days), customer: signatureCustomerReminderOf(row?.signature_customer_reminder) };
}

// SGN-02: a record's documents for signature and the templates it may send, read with the user's session (RLS decides: the
// record's readers see its documents; only owners and admins see a signed PDF's file row).

export type RecordSignatureDocument = {
  id: string;
  title: string;
  status: SignatureStatus;
  sentAt: string;
  viewedAt: string | null;
  signedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
  // the signed PDF's file, when the reader may see it (owners and admins)
  fileId: string | null;
  // a person's erasure emptied it (review 1), or emptied its signature ((234) ב): no PDF is made for it any more
  erased: boolean;
  // the person's own document: its text was emptied by their erasure
  emptied: boolean;
  // (234) ב: signed, and a person's erasure changed its text since (the text stays)
  textErased: boolean;
  // RVW-83: on a contact's card, a document sent while the contact was still a lead
  fromLead?: boolean;
};

type Client = Awaited<ReturnType<typeof createClient>>;

// (234) ב: the documents whose signature a person's erasure emptied (the signer was the person). Signatures are read by
// owners and admins only, the readers who are offered to make a missing PDF; for anyone else this is empty.
async function erasedSignatures(supabase: Client, orgId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows =
    must(
      await supabase.from("signature_signatures").select("document_id").eq("organization_id", orgId).in("document_id", ids).not("erased_at", "is", null),
      "erased signatures",
    ) ?? [];
  return new Set(rows.map((row) => row.document_id));
}

// RVW-83: the newest leads converted into a contact (at most CONVERTED_LEADS_MAX), read with the user's session (RLS
// decides), and whether there are more
async function convertedLeads(supabase: Client, orgId: string, contactId: string): Promise<{ ids: string[]; more: boolean }> {
  const rows =
    must(
      await supabase
        .from("leads")
        .select("id")
        .eq("organization_id", orgId)
        .eq("converted_contact_id", contactId)
        .order("converted_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
        .limit(CONVERTED_LEADS_MAX + 1),
      "converted leads",
    ) ?? [];
  return { ids: rows.slice(0, CONVERTED_LEADS_MAX).map((row) => row.id), more: rows.length > CONVERTED_LEADS_MAX };
}

export type RecordSignatureDocuments = {
  docs: RecordSignatureDocument[];
  // RVW-83: a contact with more converted leads than are looked at (their newest CONVERTED_LEADS_MAX were)
  moreConvertedLeads: boolean;
};

/** The record's documents for signature, newest first (at most 50); a contact's also those of the leads converted into it. */
export async function listRecordSignatureDocuments(orgId: string, kind: DocumentRecordType, recordId: string): Promise<RecordSignatureDocuments> {
  const supabase = await createClient();
  const converted = kind === "contact" ? await convertedLeads(supabase, orgId, recordId) : { ids: [], more: false };
  const filter = recordDocumentsFilter(kind, recordId, converted.ids);
  const base = supabase
    .from("signature_documents")
    .select("id, title, status, sent_at, viewed_at, signed_at, cancelled_at, expires_at, erased_at, text_erased_at, lead_id")
    .eq("organization_id", orgId);
  const rows =
    must(
      await (filter.kind === "eq" ? base.eq(filter.column, filter.value) : base.or(filter.filter))
        .order("sent_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(50),
      "signature documents",
    ) ?? [];
  const ids = rows.map((row) => row.id);
  const files =
    ids.length === 0
      ? []
      : (must(
          await supabase.from("files").select("id, signature_document_id").eq("organization_id", orgId).in("signature_document_id", ids),
          "signed document files",
        ) ?? []);
  const fileOf = new Map(files.map((file) => [file.signature_document_id, file.id]));
  const signerErased = await erasedSignatures(supabase, orgId, ids);
  const docs = rows.flatMap((row) =>
    isSignatureStatus(row.status)
      ? [
          {
            id: row.id,
            title: row.title,
            status: row.status,
            sentAt: row.sent_at,
            viewedAt: row.viewed_at,
            signedAt: row.signed_at,
            cancelledAt: row.cancelled_at,
            expiresAt: row.expires_at,
            fileId: fileOf.get(row.id) ?? null,
            erased: row.erased_at !== null || signerErased.has(row.id),
            emptied: row.erased_at !== null,
            textErased: row.status === "signed" && row.erased_at === null && row.text_erased_at !== null,
            fromLead: kind === "contact" && row.lead_id !== null,
          },
        ]
      : [],
  );
  return { docs, moreConvertedLeads: converted.more };
}

export type DetachedSignatureDocument = RecordSignatureDocument & { body: string; customerDeletedAt: string };

/**
 * SGN-02 (235) ב: documents whose record was purged (detached, owner (219) ב), newest deletion first, one page at a time.
 * Read with the user's session: the select policy shows them to owners, admins and managers by role, and a signed PDF's
 * file row to owners and admins only.
 */
export async function listDetachedSignatureDocuments(orgId: string, page: number): Promise<{ docs: DetachedSignatureDocument[]; hasMore: boolean }> {
  const supabase = await createClient();
  const from = (page - 1) * PAGE_SIZE;
  const rows =
    must(
      await supabase
        .from("signature_documents")
        .select("id, title, body, status, sent_at, viewed_at, signed_at, cancelled_at, expires_at, erased_at, text_erased_at, customer_deleted_at")
        .eq("organization_id", orgId)
        .not("customer_deleted_at", "is", null)
        .order("customer_deleted_at", { ascending: false })
        .order("id")
        .range(from, from + PAGE_SIZE),
      "detached signature documents",
    ) ?? [];
  const shown = rows.slice(0, PAGE_SIZE);
  const ids = shown.map((row) => row.id);
  const files =
    ids.length === 0
      ? []
      : (must(
          await supabase.from("files").select("id, signature_document_id").eq("organization_id", orgId).in("signature_document_id", ids),
          "detached signed document files",
        ) ?? []);
  const fileOf = new Map(files.map((file) => [file.signature_document_id, file.id]));
  const signerErased = await erasedSignatures(supabase, orgId, ids);
  return {
    hasMore: rows.length > PAGE_SIZE,
    docs: shown.flatMap((row) =>
      isSignatureStatus(row.status) && row.customer_deleted_at
        ? [
            {
              id: row.id,
              title: row.title,
              body: row.body,
              status: row.status,
              sentAt: row.sent_at,
              viewedAt: row.viewed_at,
              signedAt: row.signed_at,
              cancelledAt: row.cancelled_at,
              expiresAt: row.expires_at,
              fileId: fileOf.get(row.id) ?? null,
              erased: row.erased_at !== null || signerErased.has(row.id),
              emptied: row.erased_at !== null,
              textErased: row.status === "signed" && row.erased_at === null && row.text_erased_at !== null,
              customerDeletedAt: row.customer_deleted_at,
            },
          ]
        : [],
    ),
  };
}

export type SendableTemplate = { id: string; name: string; draftWording: boolean };

/** The business's active templates of the record's type, by name. */
export async function listSendableTemplates(orgId: string, kind: DocumentRecordType): Promise<SendableTemplate[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("document_templates")
        .select("id, name, draft_wording")
        .eq("organization_id", orgId)
        .eq("record_type", kind)
        .eq("is_active", true)
        .order("name", { ascending: true })
        .order("id", { ascending: true }),
      "sendable document templates",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, name: row.name, draftWording: row.draft_wording }));
}
