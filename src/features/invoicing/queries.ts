import "server-only";

import { cache } from "react";

import { canIssueCredits, canIssueDocuments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { invoiceProviderName } from "./providers/select";
import { ISSUABLE_DOCUMENT_TYPES, type IssuableDocumentType, type InvoiceLocale } from "./providers/types";

// DOC-05: the business's invoice provider settings, read with the user's session (members read the row; RLS).

export type InvoicingSettings = {
  provider: string | null;
  connected: boolean;
  connectedAt: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  defaultDocType: IssuableDocumentType;
  locale: InvoiceLocale;
  sendEmail: boolean;
};

export const DEFAULT_INVOICING_SETTINGS: InvoicingSettings = {
  provider: null,
  connected: false,
  connectedAt: null,
  lastCheckAt: null,
  lastCheckOk: null,
  defaultDocType: "tax_invoice",
  locale: "he",
  sendEmail: false,
};

export const getInvoicingSettings = cache(async (orgId: string): Promise<InvoicingSettings> => {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("invoice_provider_settings")
      .select("provider, status, connected_at, last_check_at, last_check_ok, default_doc_type, locale, provider_sends_email")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "invoice provider settings",
  );
  if (!row) return DEFAULT_INVOICING_SETTINGS;
  return {
    provider: row.provider,
    connected: row.status === "connected",
    connectedAt: row.connected_at,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
    defaultDocType: (ISSUABLE_DOCUMENT_TYPES as readonly string[]).includes(row.default_doc_type) ? (row.default_doc_type as IssuableDocumentType) : "tax_invoice",
    locale: row.locale === "en" ? "en" : "he",
    sendEmail: row.provider_sends_email,
  };
});

export type InvoicingAccess = {
  /** The provider this deployment offers (INVOICE_PROVIDER); null = the feature is hidden everywhere */
  offered: string | null;
  inPlan: boolean;
  /** Owners and admins of a writable business: connect, test, defaults */
  canManage: boolean;
  /** DOC-17: may issue now (and the business is connected to the offered provider) */
  canIssue: boolean;
  /** DOC-14: may credit a provider's document now (owners, admins, the `issue_credits` grant; connected) */
  canCredit: boolean;
  /** The business is connected to the provider this deployment offers */
  connected: boolean;
};

const HIDDEN: InvoicingAccess = { offered: null, inPlan: false, canManage: false, canIssue: false, canCredit: false, connected: false };

export const getInvoicingAccess = cache(async (orgId: string): Promise<InvoicingAccess> => {
  const offered = invoiceProviderName();
  if (offered === null) return HIDDEN;
  const [inPlan, context, granted] = await Promise.all([orgHasFeature(orgId, "documents"), getOrgContext(orgId), getMyPermissions(orgId)]);
  if (!inPlan) return { ...HIDDEN, offered };
  const settings = await getInvoicingSettings(orgId);
  const connected = settings.connected && settings.provider === offered;
  return {
    offered,
    inPlan,
    canManage: context.canWrite && isAdminRole(context.role),
    canIssue: connected && context.canWrite && canIssueDocuments(context.role, granted),
    canCredit: connected && context.canWrite && canIssueCredits(context.role, granted),
    connected,
  };
});

export type OpenIssueRequest = {
  id: string;
  /** check = ended without a record and may exist at the provider: check there, then close it */
  status: "pending" | "stale" | "check";
  createdAt: string;
  docType: string | null;
  totalAgorot: number | null;
  requester: string | null;
  mine: boolean;
};

/** Requests that never finished (pending or stale) or may exist at the provider (check): owners and admins see all of them, anyone else their own. */
export async function getOpenIssueRequests(orgId: string): Promise<OpenIssueRequest[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invoice_issue_requests_open", { p_org: orgId });
  if (error) {
    if (error.code === "42501") return [];
    throw new Error(`invoice_issue_requests_open: ${error.message}`);
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || (row.status !== "pending" && row.status !== "stale" && row.status !== "check") || typeof row.created_at !== "string") return [];
    return [
      {
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        docType: typeof row.doc_type === "string" ? row.doc_type : null,
        totalAgorot: typeof row.total_agorot === "number" ? row.total_agorot : null,
        requester: typeof row.requester === "string" ? row.requester : null,
        mine: row.mine === true,
      },
    ];
  });
}

export type IssueRequestView = {
  status: "pending" | "issued" | "unrecorded" | "failed" | "stale";
  documentId: string | null;
  number: string | null;
  code: string | null;
  docType: string | null;
  totalAgorot: number | null;
  sourceKind: "deal" | "contact" | "quote" | "order" | null;
  sourceId: string | null;
};

const REQUEST_STATUSES = ["pending", "issued", "unrecorded", "failed", "stale"] as const;
const SOURCE_KINDS = ["deal", "contact", "quote", "order"] as const;

/** DOC-07 (owner (398) א): one request's state for its page (the requester, or an owner/admin); null = not found. */
export async function getIssueRequest(orgId: string, requestId: string): Promise<IssueRequestView | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invoice_issue_state", { p_org: orgId, p_request: requestId });
  if (error) {
    if (error.code === "42501" || error.hint === "invoice:request") return null;
    throw new Error(`invoice_issue_state: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : null);
  const status = REQUEST_STATUSES.find((value) => value === row.status);
  if (!status) return null;
  const kind = SOURCE_KINDS.find((value) => value === row.source_kind) ?? null;
  return {
    status,
    documentId: text("document_id"),
    number: text("number"),
    code: text("code"),
    docType: text("doc_type"),
    totalAgorot: typeof row.total_agorot === "number" ? row.total_agorot : null,
    sourceKind: kind,
    sourceId: text("source_id"),
  };
}

/**
 * DOC-10: the recorded document's allocation number, or the provider's failure to get one, for the request's page. Read with
 * the user's session (the accounting_documents RLS decides); null when the document is not readable.
 */
export async function getIssuedDocumentAllocation(
  orgId: string,
  documentId: string,
): Promise<{ allocationNumber: string | null; allocationErrorCode: string | null } | null> {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("accounting_documents")
      .select("allocation_number, allocation_error_code")
      .eq("organization_id", orgId)
      .eq("id", documentId)
      .maybeSingle(),
    "issued document allocation",
  );
  return row ? { allocationNumber: row.allocation_number, allocationErrorCode: row.allocation_error_code } : null;
}

export type CreditRoom = {
  creditable: boolean;
  code: string | null;
  docType: string;
  number: string;
  docDate: string | null;
  amountAgorot: number;
  creditedAgorot: number;
  pendingAgorot: number;
  leftAgorot: number;
  /** DOC-14: the credit requests that still reserve an amount (ended ones an owner or admin may release) */
  reserving: { id: string; status: string; code: string | null; totalAgorot: number | null; createdAt: string }[];
  /** owner (411) ב: the original's lines mix exempt and taxable ones (a partial credit is made of chosen lines) */
  mixed: boolean;
  /** owner (411) ב: the original's lines, with what is left of each (in the original's price mode) */
  lines: { id: string; description: string; vatExempt: boolean; totalAgorot: number; leftAgorot: number }[];
  /** the original's lines are prices with VAT (null = they do not give back its totals) */
  gross: boolean | null;
  /** The record the original belongs to (its deal, else its contact), for the way back */
  back: { kind: "deal" | "contact"; id: string } | null;
};

/**
 * DOC-14: what is left to credit of one document (public.invoice_credit_room, the user's session: RLS reads the original).
 * null = not found, not readable, or the person may not credit.
 */
export async function getCreditRoom(orgId: string, documentId: string): Promise<CreditRoom | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("invoice_credit_room", { p_org: orgId, p_document: documentId });
  if (error) {
    if (error.code === "42501" || error.hint === "invoice_credit:original" || error.hint === "feature:documents") return null;
    throw new Error(`invoice_credit_room: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const num = (key: string) => (typeof row[key] === "number" ? (row[key] as number) : 0);
  if (typeof row.doc_type !== "string" || typeof row.number !== "string") return null;
  const parent = must(
    await supabase.from("accounting_documents").select("deal_id, contact_id").eq("organization_id", orgId).eq("id", documentId).maybeSingle(),
    "credit original",
  );
  return {
    creditable: row.creditable === true,
    code: typeof row.code === "string" ? row.code : null,
    docType: row.doc_type,
    number: row.number,
    docDate: typeof row.doc_date === "string" ? row.doc_date : null,
    amountAgorot: num("amount_agorot"),
    creditedAgorot: num("credited_agorot"),
    pendingAgorot: num("pending_agorot"),
    leftAgorot: num("left_agorot"),
    mixed: row.mixed === true,
    gross: typeof row.gross === "boolean" ? row.gross : null,
    lines: Array.isArray(row.lines)
      ? row.lines.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const r = item as Record<string, unknown>;
          if (typeof r.id !== "string" || typeof r.description !== "string") return [];
          return [{ id: r.id, description: r.description, vatExempt: r.vat_exempt === true, totalAgorot: typeof r.total_agorot === "number" ? r.total_agorot : 0, leftAgorot: typeof r.left_agorot === "number" ? r.left_agorot : 0 }];
        })
      : [],
    reserving: Array.isArray(row.reserving)
      ? row.reserving.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const r = item as Record<string, unknown>;
          if (typeof r.id !== "string" || typeof r.status !== "string" || typeof r.created_at !== "string") return [];
          return [{ id: r.id, status: r.status, code: typeof r.code === "string" ? r.code : null, totalAgorot: typeof r.total_agorot === "number" ? r.total_agorot : null, createdAt: r.created_at }];
        })
      : [],
    back: parent?.deal_id ? { kind: "deal", id: parent.deal_id } : parent?.contact_id ? { kind: "contact", id: parent.contact_id } : null,
  };
}
