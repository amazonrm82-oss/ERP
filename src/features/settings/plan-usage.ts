import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { ViewSeatUsage } from "./view-seats";

export type UsageRow = { key: string; label: string; limit: number | null; used: number; unit?: string };
export type PlanUsage = { planKey: string | null; planName: string; status: string; trialEndsAt: string | null; usage: UsageRow[] };

const LABELS: Record<string, { label: string; unit?: string }> = {
  max_users: { label: "משתמשים" },
  max_records: { label: "רשומות (לידים, אנשי קשר, חברות ועסקאות)" },
  max_pipelines: { label: "תהליכי מכירה" },
  max_forms: { label: "טפסים לקליטת לידים" },
  max_active_automations: { label: "אוטומציות פעילות" },
  storage_gb: { label: "אחסון קבצים", unit: "GB" },
  max_products: { label: "מוצרים בקטלוג (כולל מוצרים בארכיון)" },
  // PL-01: besides the default price list (the products' own prices)
  max_price_lists: { label: "מחירונים (נוסף על מחירי המוצרים)" },
  // PRM-02: per paid seat x the seats bought (active full seats while none are bought)
  view_seats: { label: "מושבי צפייה (לפי מספר המושבים בתשלום)" },
  // AUT-07: runs that executed a step this month (manual test runs do not count)
  max_automation_runs_per_month: { label: "הרצות אוטומציה החודש" },
};

/** The business's plan, trial and usage against each limit (FXU-04, migration 0046). */
export async function getPlanUsage(orgId: string): Promise<PlanUsage | null> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("org_plan_usage", { p_org: orgId }), "org_plan_usage") as {
    plan_name?: string;
    plan_key?: string;
    status?: string;
    trial_ends_at?: string | null;
    usage?: Array<{ key: string; limit: number | null; used: number }>;
  } | null;
  if (!data) return null;
  return {
    planKey: data.plan_key ?? null,
    planName: data.plan_name ?? data.plan_key ?? "",
    status: data.status ?? "",
    trialEndsAt: data.trial_ends_at ?? null,
    usage: (data.usage ?? []).map((row) => ({
      key: row.key,
      label: LABELS[row.key]?.label ?? row.key,
      unit: LABELS[row.key]?.unit,
      limit: row.limit === null ? null : Number(row.limit),
      used: Number(row.used),
    })),
  };
}

/** PRM-02: view seats in use, the allowance and open viewer invitations; null when the plan has no view seats. */
export async function getViewSeatUsage(orgId: string): Promise<ViewSeatUsage | null> {
  const usage = await getPlanUsage(orgId);
  const row = usage?.usage.find((item) => item.key === "view_seats");
  if (!row) return null;
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("invitations")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("role", "viewer")
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (error) {
    throw new Error(`viewer invitations query failed: ${error.message}`);
  }
  return { limit: row.limit, used: row.used, pending: count ?? 0 };
}
