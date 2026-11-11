import "server-only";

import { must } from "@/lib/db-read";
import { PAGE_SIZE } from "@/lib/search";
import { createClient } from "@/lib/supabase/server";

import type { DocumentRecordType } from "@/features/document-templates/fields";

import { CONVERTED_LEADS_MAX, recordDocumentsFilter } from "./record-filter";
import { signatureCustomerReminderOf, signatureReminderDaysOf, type SignatureReminderSettings } from "./reminder";
import { isSignatureStatus, type SignatureStatus } from "./states";
import { addCalendarDays, CONTRACT_RENEWAL_DEFAULT, contractRenewalDaysOf, endsSoon, EXPIRED_LIST_DAYS, recentlyExpired } from "./validity";

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
  // SGN-04: a signed document's last day and renewal day ("YYYY-MM-DD")
  validUntil: string | null;
  renewalOn: string | null;
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
    .select("id, title, status, sent_at, viewed_at, signed_at, cancelled_at, expires_at, erased_at, text_erased_at, lead_id, valid_until, renewal_on")
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
            validUntil: row.valid_until,
            renewalOn: row.renewal_on,
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
        .select("id, title, body, status, sent_at, viewed_at, signed_at, cancelled_at, expires_at, erased_at, text_erased_at, customer_deleted_at, valid_until, renewal_on")
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
              validUntil: row.valid_until,
              renewalOn: row.renewal_on,
            },
          ]
        : [],
    ),
  };
}

/** SGN-04: days before the renewal day the alert task is made (no settings row = 30; 0 = off). */
export async function getContractRenewalDays(orgId: string): Promise<number> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_document_settings").select("contract_renewal_days").eq("organization_id", orgId).maybeSingle(),
    "contract renewal settings",
  );
  return contractRenewalDaysOf(row?.contract_renewal_days);
}

export type EndingSoonDocument = {
  id: string;
  title: string;
  validUntil: string;
  renewalOn: string | null;
  kind: DocumentRecordType;
  recordId: string;
};

/**
 * SGN-04 "מסתיימים בקרוב": signed documents still valid whose renewal day (else last day) is within `days` days (30 when the
 * alert is off), soonest first, at most 100; read with the user's session (RLS decides: the record's readers).
 */
export async function listEndingSoonDocuments(orgId: string, today: string, days: number): Promise<EndingSoonDocument[]> {
  const supabase = await createClient();
  const until = addCalendarDays(today, days > 0 ? days : CONTRACT_RENEWAL_DEFAULT);
  const rows =
    must(
      await supabase
        .from("signature_documents")
        .select("id, title, valid_until, renewal_on, lead_id, contact_id, company_id, deal_id")
        .eq("organization_id", orgId)
        .eq("status", "signed")
        .is("erased_at", null)
        .gte("valid_until", today)
        // a renewal day is never after the last day: the target is within the window when either day is
        .or(`valid_until.lte.${until},renewal_on.lte.${until}`)
        .order("valid_until", { ascending: true })
        .order("id", { ascending: true })
        .limit(100),
      "documents ending soon",
    ) ?? [];
  return rows.flatMap((row) => {
    if (!row.valid_until || !endsSoon(row.valid_until, row.renewal_on, today, days)) return [];
    const ref = recordRef(row);
    return ref ? [{ id: row.id, title: row.title, validUntil: row.valid_until, renewalOn: row.renewal_on, ...ref }] : [];
  });
}

/**
 * Owner (278) ב: signed documents whose last day passed within the last EXPIRED_LIST_DAYS days, latest first, at most 100;
 * read with the user's session (RLS decides).
 */
export async function listRecentlyExpiredDocuments(orgId: string, today: string): Promise<EndingSoonDocument[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("signature_documents")
        .select("id, title, valid_until, renewal_on, lead_id, contact_id, company_id, deal_id")
        .eq("organization_id", orgId)
        .eq("status", "signed")
        .is("erased_at", null)
        .lt("valid_until", today)
        .gte("valid_until", addCalendarDays(today, -EXPIRED_LIST_DAYS))
        .order("valid_until", { ascending: false })
        .order("id", { ascending: true })
        .limit(100),
      "expired documents",
    ) ?? [];
  return rows.flatMap((row) => {
    if (!row.valid_until || !recentlyExpired(row.valid_until, today)) return [];
    const ref = recordRef(row);
    return ref ? [{ id: row.id, title: row.title, validUntil: row.valid_until, renewalOn: row.renewal_on, ...ref }] : [];
  });
}

function recordRef(row: { lead_id: string | null; contact_id: string | null; company_id: string | null; deal_id: string | null }): { kind: DocumentRecordType; recordId: string } | null {
  if (row.lead_id) return { kind: "lead", recordId: row.lead_id };
  if (row.contact_id) return { kind: "contact", recordId: row.contact_id };
  if (row.company_id) return { kind: "company", recordId: row.company_id };
  if (row.deal_id) return { kind: "deal", recordId: row.deal_id };
  return null;
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
