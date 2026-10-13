import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

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
