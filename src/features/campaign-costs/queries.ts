import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type CampaignCost = {
  id: string;
  sourceId: string | null;
  campaign: string | null;
  month: string;
  amount: number;
  includesVat: boolean;
  note: string | null;
};

/** SEG-03: the costs of the last `months` months and later, newest month first (every member reads them). */
export async function listCampaignCosts(orgId: string, fromMonth: string): Promise<CampaignCost[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("campaign_costs")
      .select("id, source_id, campaign, month, amount_agorot, amount_includes_vat, note")
      .eq("organization_id", orgId)
      .gte("month", fromMonth)
      .order("month", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id")
      .limit(500),
    "campaign costs",
  );
  return rows.map((r) => ({ id: r.id, sourceId: r.source_id, campaign: r.campaign, month: r.month, amount: r.amount_agorot, includesVat: r.amount_includes_vat, note: r.note }));
}

/** The campaign names on recent leads, for the form's suggestions (so a cost is typed as the leads hold it). */
export async function recentCampaignNames(orgId: string): Promise<string[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("leads")
      .select("campaign")
      .eq("organization_id", orgId)
      .not("campaign", "is", null)
      .order("created_at", { ascending: false })
      .limit(500),
    "campaign names",
  );
  const seen = new Map<string, string>();
  for (const row of rows) {
    const name = row.campaign?.trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].slice(0, 100);
}
