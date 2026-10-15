import "server-only";

import { z } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { getLeadLookups } from "@/features/leads/queries";
import { listTags } from "@/features/tags/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { ScoreLookups, ScoreRule } from "./rules";

/** Every score rule of the business, hidden ones included, in the order they were added (LEAD-05). */
export async function listScoreRules(orgId: string): Promise<ScoreRule[]> {
  const supabase = await createClient();
  const rows =
    must(
      await supabase
        .from("lead_score_rules")
        .select("id, field, op, value, points, is_active, position, created_at")
        .eq("organization_id", orgId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
      "lead score rules",
    ) ?? [];
  return rows.map((row) => ({ id: row.id, field: row.field, op: row.op, value: row.value, points: row.points, isActive: row.is_active }));
}

/** What a rule may point at: statuses, sources, tags and the active lead custom fields. */
export async function getScoreLookups(orgId: string): Promise<ScoreLookups> {
  const [lookups, tags, fields] = await Promise.all([getLeadLookups(orgId), listTags(orgId), listFieldDefinitions(orgId, "lead")]);
  return {
    statuses: lookups.statuses.map((s) => ({ id: s.id, name: s.name })),
    sources: lookups.sources.map((s) => ({ id: s.id, name: s.name })),
    tags: tags.map((t) => ({ id: t.id, name: t.name })),
    fields,
  };
}

/** Whether a recompute of the business's scores is still waiting (after a rule change). */
export async function scoresPending(orgId: string): Promise<boolean> {
  const supabase = await createClient();
  return must(await supabase.rpc("lead_scores_pending", { p_org: orgId }), "lead scores pending") === true;
}

const breakdownSchema = z.object({ score: z.number().int(), matched: z.array(z.object({ id: z.string(), points: z.number().int() })) });
export type ScoreBreakdown = z.infer<typeof breakdownSchema>;

/** The lead's stored score and the active rules it matches now; null when the user cannot read the lead. */
export async function getScoreBreakdown(orgId: string, leadId: string): Promise<ScoreBreakdown | null> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("lead_score_breakdown", { p_org: orgId, p_lead: leadId }), "lead score breakdown");
  return data === null ? null : breakdownSchema.parse(data);
}
