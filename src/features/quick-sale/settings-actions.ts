"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשנות את ההגדרה.";
const pipelineSchema = z.union([z.literal(""), z.guid()]);

/**
 * GAP-08 (owner, 26 October 2026): the sales process quick sales go to; empty = the default one. Saved on the business's
 * one documents-settings row with the user's session: updated first, inserted only when there is none, updated once more
 * when the insert lost a race (no upsert: its DO UPDATE names organization_id, which has no UPDATE grant). The composite
 * foreign key keeps it inside the business.
 */
export async function saveQuickSalePipelineAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = pipelineSchema.safeParse(String(formData.get("quick_sale_pipeline_id") ?? ""));
  if (!parsed.success) return fail("יש לבחור תהליך מכירה מהרשימה.", { values: formValues(formData) });
  const patch = { quick_sale_pipeline_id: parsed.data === "" ? null : parsed.data };
  const values = { values: formValues(formData) };
  const table = () => context.supabase.from("org_document_settings");
  const update = () => table().update(patch).eq("organization_id", orgId).select("id");
  let result = await update();
  if (!result.error && result.data.length === 0) {
    const inserted = await table()
      .insert({ organization_id: orgId, ...patch })
      .select("id");
    result = inserted.error?.code === "23505" ? await update() : inserted;
  }
  if (result.error) return fail(result.error.code === "42501" ? NOT_ADMIN : dbErrorMessage(result.error), values);
  if (result.data.length === 0) return fail(NOT_ADMIN, values);
  revalidatePath(paths.settingsPipelines(orgId));
  return { ok: true, message: "ההגדרה נשמרה." };
}
