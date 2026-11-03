import "server-only";

import type { PrivacyRequestRow, PrivacyRequestStatus, PrivacyRequestType, PrivacyVerifyMethod } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

// PRK-02: the request log and the link's state, read with the user's session (owners and admins only, RLS).

/** A row with its closed lists typed (the table's check constraints hold them). */
export type PrivacyRequest = Omit<PrivacyRequestRow, "request_type" | "contact_kind" | "status" | "verify_method"> & {
  request_type: PrivacyRequestType;
  contact_kind: "email" | "phone";
  status: PrivacyRequestStatus;
  verify_method: PrivacyVerifyMethod | null;
};

/** The most requests the list shows at once (newest first). */
export const REQUESTS_SHOWN = 500;

const COLUMNS =
  "id, organization_id, request_type, requester_name, contact_kind, contact_value, details, status, received_at, target_date, verify_method, verify_note, verified_at, verified_by, refusal_reason, lead_id, contact_id, former_lead_ids, former_contact_ids, closed_at, closed_by, erased_at, updated_by, created_at, updated_at, erased_by_retention";

export async function listPrivacyRequests(orgId: string): Promise<PrivacyRequest[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("privacy_requests")
      .select(COLUMNS)
      .eq("organization_id", orgId)
      .order("received_at", { ascending: false })
      .order("id")
      .limit(REQUESTS_SHOWN),
    "privacy requests",
  );
  return rows as PrivacyRequest[];
}

export async function getPrivacyRequest(orgId: string, requestId: string): Promise<PrivacyRequest | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("privacy_requests").select(COLUMNS).eq("organization_id", orgId).eq("id", requestId).maybeSingle(),
    "privacy request",
  );
  return row as PrivacyRequest | null;
}

/** The linked record's name, when it is still there (null = none, or gone). */
export async function linkedRecordName(orgId: string, row: Pick<PrivacyRequestRow, "lead_id" | "contact_id">): Promise<string | null> {
  if (!row.lead_id && !row.contact_id) return null;
  const supabase = await createClient();
  const found = must(
    await supabase
      .from(row.lead_id ? "leads" : "contacts")
      .select("full_name")
      .eq("organization_id", orgId)
      .eq("id", (row.lead_id ?? row.contact_id) as string)
      .maybeSingle(),
    "linked record",
  );
  return found ? (found.full_name ?? "").trim() || null : null;
}

/** Whether the business has a working link, and since when; null for someone who may not manage it. */
export async function getPrivacyLinkStatus(orgId: string): Promise<{ active: boolean; createdAt: string | null; pagesOpen: boolean } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("privacy_request_link_status", { p_org: orgId });
  if (error) {
    if (error.code === "42501") return null;
    throw new Error(`privacy_request_link_status failed: ${error.code} ${error.message}`);
  }
  const value = data as { active?: unknown; created_at?: unknown; pages_open?: unknown } | null;
  return {
    active: value?.active === true,
    createdAt: typeof value?.created_at === "string" ? value.created_at : null,
    pagesOpen: value?.pages_open !== false,
  };
}
