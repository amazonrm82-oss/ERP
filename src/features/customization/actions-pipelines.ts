"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, directionArg, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { must } from "@/lib/db-read";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { pipelineNameSchema, stageSchema } from "./schema";

function revalidatePipelines(orgId: string) {
  revalidatePath(paths.settingsPipelines(orgId));
  revalidatePath(paths.deals(orgId), "layout");
  revalidatePath(paths.org(orgId));
}

// Stages a new pipeline starts with; the admin renames and adds from there.
const STARTER_STAGES = [
  { name: "חדש", kind: "open", probability: 10 },
  { name: "נסגר בהצלחה", kind: "won", probability: 100 },
  { name: "אבוד", kind: "lost", probability: 0 },
] as const;

export async function createPipelineAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = pipelineNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { count } = await context.supabase
    .from("pipelines")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .is("deleted_at", null);

  // the plan's pipeline limit is enforced by a trigger (hint limit:max_pipelines)
  const { data: pipeline, error } = await context.supabase
    .from("pipelines")
    .insert({ organization_id: orgId, name: parsed.data.name, position: count ?? 0, is_default: count === 0 })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את תהליך המכירה. נסו שוב."), { values: formValues(formData) });
  }

  const { error: stagesError } = await context.supabase.from("stages").insert(
    STARTER_STAGES.map((stage, position) => ({ organization_id: orgId, pipeline_id: pipeline.id, position, ...stage })),
  );
  if (stagesError) {
    // without stages the pipeline is useless: take it back
    await context.supabase.from("pipelines").delete().eq("organization_id", orgId).eq("id", pipeline.id);
    return fail(dbErrorMessage(stagesError, "לא הצלחנו ליצור את תהליך המכירה. נסו שוב."), { values: formValues(formData) });
  }

  revalidatePipelines(orgId);
  return { ok: true, message: "תהליך המכירה נוצר עם שלושה שלבים. אפשר לשנות ולהוסיף." };
}

export async function renamePipelineAction(
  orgId: string,
  pipelineId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, pipelineId);
  if (!context.ok) {
    return context;
  }
  const parsed = pipelineNameSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("pipelines")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", pipelineId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePipelines(orgId);
  return { ok: true };
}

/** The default pipeline is the one the board opens with and leads convert into. */
export async function setDefaultPipelineAction(orgId: string, pipelineId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, pipelineId);
  if (!context.ok) {
    return context;
  }
  // one default per organization (unique index): clear the old one first
  const { error: clearError } = await context.supabase
    .from("pipelines")
    .update({ is_default: false })
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .neq("id", pipelineId);
  if (clearError) {
    return fail(dbErrorMessage(clearError));
  }
  const { data, error } = await context.supabase
    .from("pipelines")
    .update({ is_default: true })
    .eq("organization_id", orgId)
    .eq("id", pipelineId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePipelines(orgId);
  return ok();
}

/** Removes a pipeline that has no live deals. Not the default one. */
export async function deletePipelineAction(orgId: string, pipelineId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, pipelineId);
  if (!context.ok) {
    return context;
  }
  const [{ data: pipeline }, { count }] = await Promise.all([
    context.supabase.from("pipelines").select("is_default").eq("organization_id", orgId).eq("id", pipelineId).maybeSingle(),
    context.supabase
      .from("deals")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("pipeline_id", pipelineId)
      .is("deleted_at", null),
  ]);
  if (!pipeline) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (pipeline.is_default) {
    return fail("אי אפשר למחוק את תהליך המכירה שמוגדר כברירת מחדל. קבעו קודם תהליך מכירה אחר כברירת מחדל.");
  }
  if ((count ?? 0) > 0) {
    return fail("יש בתהליך המכירה עסקאות. העבירו אותן או מחקו אותן לפני שמוחקים את תהליך המכירה.");
  }
  const { data, error } = await context.supabase
    .from("pipelines")
    .update({ deleted_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", pipelineId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePipelines(orgId);
  return ok();
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

type StageRowLite = { id: string; kind: string; position: number };

async function stagesOf(context: Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>, orgId: string, pipelineId: string) {
  const data = must(await context.supabase
    .from("stages")
    .select("id, kind, position")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipelineId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true }), "stages");
  return (data ?? []) as StageRowLite[];
}

/** Writes positions 0..n-1 in the given order, touching only rows that change. */
async function writeOrder(
  context: Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>,
  orgId: string,
  ordered: StageRowLite[],
): Promise<string | null> {
  for (const [index, stage] of ordered.entries()) {
    if (stage.position !== index) {
      const { error } = await context.supabase.from("stages").update({ position: index }).eq("organization_id", orgId).eq("id", stage.id);
      if (error) {
        return dbErrorMessage(error);
      }
    }
  }
  return null;
}

export async function addStageAction(orgId: string, pipelineId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, pipelineId);
  if (!context.ok) {
    return context;
  }
  const parsed = stageSchema.safeParse(pick(formData, ["name", "kind", "probability"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const existing = await stagesOf(context, orgId, pipelineId);
  // a new open stage goes before the closing stages (won / lost)
  const firstClosed = existing.findIndex((stage) => stage.kind !== "open");
  const insertAt = parsed.data.kind === "open" && firstClosed >= 0 ? firstClosed : existing.length;

  const { data, error } = await context.supabase
    .from("stages")
    .insert({ organization_id: orgId, pipeline_id: pipelineId, position: insertAt, ...parsed.data })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו להוסיף את השלב. נסו שוב."), { values: formValues(formData) });
  }
  const ordered = [...existing];
  ordered.splice(insertAt, 0, { id: data.id, kind: parsed.data.kind, position: insertAt });
  const orderError = await writeOrder(context, orgId, ordered);
  revalidatePipelines(orgId);
  return orderError ? fail(orderError) : { ok: true };
}

async function stageWithCount(context: Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>, orgId: string, stageId: string) {
  const [{ data: stage }, { count }] = await Promise.all([
    context.supabase.from("stages").select("id, pipeline_id, kind").eq("organization_id", orgId).eq("id", stageId).maybeSingle(),
    context.supabase.from("deals").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("stage_id", stageId),
  ]);
  return stage ? { ...stage, dealCount: count ?? 0 } : null;
}

const LAST_OPEN_STAGE = "בכל תהליך מכירה צריך להישאר לפחות שלב פתוח אחד, כדי שיהיה לאן להכניס עסקאות חדשות.";

export async function updateStageAction(orgId: string, stageId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, stageId);
  if (!context.ok) {
    return context;
  }
  const parsed = stageSchema.safeParse(pick(formData, ["name", "kind", "probability"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const stage = await stageWithCount(context, orgId, stageId);
  if (!stage) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (stage.kind !== parsed.data.kind) {
    // deals copy their status from the stage when they enter it
    if (stage.dealCount > 0) {
      return fail("אי אפשר לשנות את סוג השלב כשיש בו עסקאות. העבירו אותן לשלב אחר קודם.", { values: formValues(formData) });
    }
    if (stage.kind === "open") {
      const openCount = (await stagesOf(context, orgId, stage.pipeline_id)).filter((s) => s.kind === "open").length;
      if (openCount <= 1) {
        return fail(LAST_OPEN_STAGE, { values: formValues(formData) });
      }
    }
  }
  const { data, error } = await context.supabase
    .from("stages")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", stageId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השלב. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePipelines(orgId);
  return { ok: true };
}

export async function moveStageAction(orgId: string, stageId: string, direction: "up" | "down"): Promise<ActionResult> {
  if (!validArg(directionArg, direction)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, stageId);
  if (!context.ok) {
    return context;
  }
  const { data: stage, error: stageError } = await context.supabase.from("stages").select("pipeline_id").eq("organization_id", orgId).eq("id", stageId).maybeSingle();
  if (stageError) return fail(dbErrorMessage(stageError));
  if (!stage) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  const ordered = await stagesOf(context, orgId, stage.pipeline_id);
  const index = ordered.findIndex((s) => s.id === stageId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) {
    return ok();
  }
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const orderError = await writeOrder(context, orgId, ordered);
  revalidatePipelines(orgId);
  return orderError ? fail(orderError) : ok();
}

export async function deleteStageAction(orgId: string, stageId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, stageId);
  if (!context.ok) {
    return context;
  }
  const stage = await stageWithCount(context, orgId, stageId);
  if (!stage) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  if (stage.dealCount > 0) {
    return fail("יש בשלב עסקאות (גם בסל המחזור נספרות). העבירו אותן לשלב אחר לפני המחיקה.");
  }
  if (stage.kind === "open") {
    const openCount = (await stagesOf(context, orgId, stage.pipeline_id)).filter((s) => s.kind === "open").length;
    if (openCount <= 1) {
      return fail(LAST_OPEN_STAGE);
    }
  }
  const { data, error } = await context.supabase.from("stages").delete().eq("organization_id", orgId).eq("id", stageId).select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו למחוק את השלב. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePipelines(orgId);
  return ok();
}
