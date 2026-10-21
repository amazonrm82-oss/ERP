import "server-only";

import { cache } from "react";

import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import type { MembershipRole } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { HoldSubject } from "./schema";

// COL-05: the holds a user may read (RLS: whoever reads the contact or the company).

export type ActiveHold = { id: string; on: "contact" | "company"; reason: string; createdAt: string; by: string | null };

/** Answer 1 (א), the rule of app.can_manage_customer_holds(): owners, admins and managers, or the record_payments key. */
export function canManageHolds(role: MembershipRole | null, granted: readonly string[]): boolean {
  if (role === null) return false;
  return role === "owner" || role === "admin" || role === "manager" || (role === "member" && granted.includes("record_payments"));
}

export const getHoldsAccess = cache(async (orgId: string): Promise<{ inPlan: boolean; canManage: boolean }> => {
  const [inPlan, context, granted] = await Promise.all([orgHasFeature(orgId, "collection"), getOrgContext(orgId), getMyPermissions(orgId)]);
  return { inPlan, canManage: inPlan && context.canWrite && canManageHolds(context.role, granted) };
});

/** The active holds of a contact and/or a company (at most one each). */
export async function activeHolds(orgId: string, customer: { contactId: string | null; companyId: string | null }): Promise<ActiveHold[]> {
  if (!customer.contactId && !customer.companyId) return [];
  const supabase = await createClient();
  const filter = [customer.contactId ? `contact_id.eq.${customer.contactId}` : null, customer.companyId ? `company_id.eq.${customer.companyId}` : null]
    .filter(Boolean)
    .join(",");
  const rows = must(
    await supabase
      .from("customer_holds")
      .select("id, contact_id, company_id, reason, created_by, created_at")
      .eq("organization_id", orgId)
      .is("cleared_at", null)
      .or(filter)
      .order("created_at")
      .order("id"),
    "customer holds",
  );
  const names = await getUserNames(rows.map((r) => r.created_by));
  return rows.map((r) => ({
    id: r.id,
    on: r.contact_id ? "contact" : "company",
    reason: r.reason,
    createdAt: r.created_at,
    by: r.created_by ? (names.get(r.created_by) ?? null) : null,
  }));
}

/** The customer behind a deal, a contact or a company: the contact and its company (answer 2 (א)). */
export async function customerOf(
  orgId: string,
  subject: { kind: "deal" | "contact" | "company"; id: string },
): Promise<{ contactId: string | null; companyId: string | null }> {
  if (subject.kind === "company") return { contactId: null, companyId: subject.id };
  const supabase = await createClient();
  let contactId: string | null = subject.kind === "contact" ? subject.id : null;
  let companyId: string | null = null;
  if (subject.kind === "deal") {
    const deal = must(
      await supabase.from("deals").select("contact_id, company_id").eq("organization_id", orgId).eq("id", subject.id).maybeSingle(),
      "deal customer",
    );
    contactId = deal?.contact_id ?? null;
    companyId = deal?.company_id ?? null;
  }
  if (contactId && !companyId) {
    const contact = must(
      await supabase.from("contacts").select("company_id").eq("organization_id", orgId).eq("id", contactId).maybeSingle(),
      "contact company",
    );
    companyId = contact?.company_id ?? null;
  }
  return { contactId, companyId };
}

/** The record's own active hold, for its card. */
export async function recordHold(orgId: string, subject: HoldSubject): Promise<ActiveHold | null> {
  const holds = await activeHolds(orgId, subject.kind === "contact" ? { contactId: subject.id, companyId: null } : { contactId: null, companyId: subject.id });
  return holds[0] ?? null;
}
