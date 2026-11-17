import "server-only";

import { cache } from "react";

import { canIssueDocuments } from "@/features/permissions/keys";
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
  /** The business is connected to the provider this deployment offers */
  connected: boolean;
};

const HIDDEN: InvoicingAccess = { offered: null, inPlan: false, canManage: false, canIssue: false, connected: false };

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
