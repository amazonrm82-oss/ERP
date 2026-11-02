import "server-only";

import { cache } from "react";
import { z } from "zod";

import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { DEFAULT_DORMANT_MONTHS, DEFAULT_FORMER_MONTHS, isCustomerStatus, parseCustomerSummary, type CustomerStatus, type CustomerSummary } from "./status";

export type CustomerStatusSettings = { dormantMonths: number; formerMonths: number };

/** CON-11: the business's thresholds; members read them, no row = the defaults (6 and 18 months). */
export const getCustomerStatusSettings = cache(async (orgId: string): Promise<CustomerStatusSettings> => {
  const supabase = await createClient();
  const row = must(
    await supabase.from("customer_status_settings").select("dormant_months, former_months").eq("organization_id", orgId).maybeSingle(),
    "customer status settings",
  );
  return { dormantMonths: row?.dormant_months ?? DEFAULT_DORMANT_MONTHS, formerMonths: row?.former_months ?? DEFAULT_FORMER_MONTHS };
});

/** CON-11: a contact's or company's status, purchases and value (public.customer_summary, the caller's RLS). */
export async function getCustomerSummary(orgId: string, contact: string | null, company: string | null): Promise<CustomerSummary> {
  const supabase = await createClient();
  const raw = must(await supabase.rpc("customer_summary", { p_org: orgId, p_contact: contact, p_company: company }), "customer summary");
  return parseCustomerSummary(raw);
}

export type CustomerNumbers = { status: CustomerStatus | null; value: number | null };

/** CON-11: the status and value columns of one page of contacts or companies (the computed fields; null = not a customer or partial). */
export async function getCustomerNumbers(orgId: string, table: "contacts" | "companies", ids: string[]): Promise<Map<string, CustomerNumbers>> {
  const result = new Map<string, CustomerNumbers>();
  if (ids.length === 0) return result;
  const supabase = await createClient();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = must(
      await supabase.from(table).select("id, customer_status, customer_value").eq("organization_id", orgId).in("id", ids.slice(i, i + 200)),
      "customer status",
    );
    for (const row of rows as unknown as Array<{ id: string; customer_status: string | null; customer_value: number | string | null }>) {
      result.set(row.id, {
        status: isCustomerStatus(row.customer_status) ? row.customer_status : null,
        value: row.customer_value === null ? null : Number(row.customer_value),
      });
    }
  }
  return result;
}

/**
 * CON-11 (review, lead's direction (b)): the list columns, sort and status filter read the business-wide kept facts, so only
 * owners and admins (who read every deal and payment) are offered them; the database answers null to anyone else.
 */
export const customerColumnsEnabled = cache(async (orgId: string): Promise<boolean> => {
  const context = await getOrgContext(orgId);
  return context.role === "owner" || context.role === "admin";
});

/** RET-01: the most rows of each kind the dormant list shows (longest without a purchase first). */
export const DORMANT_LIST_MAX = 200;

export type DormantCustomer = { id: string; name: string; lastPurchaseOn: string; value: number };
export type DormantList = { allowed: false } | { allowed: true; rows: DormantCustomer[]; more: boolean };

const dormantSchema = z.union([
  z.object({ allowed: z.literal(false) }),
  z.object({
    allowed: z.literal(true),
    more: z.boolean(),
    rows: z.array(
      z.object({ id: z.string(), name: z.string().nullable(), last_purchase_on: z.string(), value_agorot: z.coerce.number().int() }),
    ),
  }),
]);

/** RET-01: the business's dormant contacts or companies (public.dormant_customers: owners and admins, the kept facts). */
export async function listDormantCustomers(orgId: string, kind: "contact" | "company"): Promise<DormantList> {
  const supabase = await createClient();
  const raw = must(await supabase.rpc("dormant_customers", { p_org: orgId, p_kind: kind, p_limit: DORMANT_LIST_MAX }), "dormant customers");
  const parsed = dormantSchema.parse(raw);
  if (!parsed.allowed) return parsed;
  return {
    allowed: true,
    more: parsed.more,
    rows: parsed.rows.map((row) => ({
      id: row.id,
      name: row.name || (kind === "contact" ? "איש קשר ללא שם" : "חברה ללא שם"),
      lastPurchaseOn: row.last_purchase_on,
      value: row.value_agorot,
    })),
  };
}
