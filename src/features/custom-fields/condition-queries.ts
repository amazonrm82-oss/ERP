import "server-only";

import { listPipelines } from "@/features/deals/queries";
import { getLeadLookups } from "@/features/leads/queries";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { createClient } from "@/lib/supabase/server";

import type { BuiltinChoices } from "./conditions";
import type { FieldObject } from "./types";

/**
 * FLD-09: the choices of the built-in fields a condition may depend on, keyed "builtin:<name>"
 * (ids and names, hidden ones marked). Read with the user's session.
 */
export async function conditionBuiltinChoices(orgId: string, objectType: FieldObject): Promise<BuiltinChoices> {
  if (objectType === "lead") {
    const { statuses, sources } = await getLeadLookups(orgId);
    return {
      "builtin:status": statuses.map((s) => ({ value: s.id, label: s.name })),
      "builtin:source": sources.map((s) => ({ value: s.id, label: s.isActive ? s.name : `${s.name} (מוסתר)` })),
    };
  }
  if (objectType === "deal") {
    const pipelines = await listPipelines(orgId);
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("stages")
      .select("id, name, pipeline_id, position")
      .eq("organization_id", orgId)
      .order("position", { ascending: true });
    if (error) throw new Error(`stages query failed: ${error.message}`);
    const choices: BuiltinChoices[string] = [];
    for (const pipeline of pipelines) {
      for (const stage of data.filter((row) => row.pipeline_id === pipeline.id)) {
        choices.push({ value: stage.id, label: pipelines.length > 1 ? `${pipeline.name}: ${stage.name}` : stage.name });
      }
    }
    return { "builtin:pipeline": pipelines.map((p) => ({ value: p.id, label: p.name })), "builtin:stage": choices };
  }
  const types = await listRecordTypes(orgId, objectType);
  return { "builtin:type": types.map((t) => ({ value: t.id, label: t.isActive ? t.name : `${t.name} (מוסתר)` })) };
}
