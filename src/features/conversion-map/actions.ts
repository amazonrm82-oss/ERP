"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid } from "@/lib/paths";

import { conversionMapSettingsPath } from "./paths";
import { getConversionMap } from "./queries";
import { AUTO, checkMapPicks, isMapTarget, MAP_TARGETS, NONE, REMOVED, type MapPick } from "./rules";

const DUPLICATE = "אותו שדה נבחר ליותר משדה אחד של ליד. בחרו לכל שדה יעד שדה אחד של ליד לכל היותר.";
const CHANGED = "השדות השתנו בינתיים. רעננו את הדף ונסו שוב.";

// the database caps the list at 400 entries too
const picksSchema = z
  .array(
    z.object({
      leadFieldId: z.string().refine(isUuid),
      targetType: z.enum(MAP_TARGETS),
      choice: z.union([z.literal(AUTO), z.literal(NONE), z.literal(REMOVED), z.string().refine(isUuid)]),
    }),
  )
  .max(400);

/** LEAD-06: saves where each lead custom field goes on conversion, in one transaction (owners and admins; RLS decides). */
export async function saveConversionMapAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const raw: MapPick[] = [];
  for (const [name, value] of formData.entries()) {
    const [type, leadFieldId, extra] = name.split(":");
    if (extra !== undefined || !type || !leadFieldId || !isMapTarget(type) || typeof value !== "string") {
      continue;
    }
    raw.push({ leadFieldId: leadFieldId.toLowerCase(), targetType: type, choice: value.toLowerCase() });
  }
  const parsed = picksSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(INVALID_ARGS);
  }
  const picks = parsed.data;

  let data;
  try {
    data = await getConversionMap(orgId);
  } catch {
    return fail(dbErrorMessage(null));
  }
  const checked = checkMapPicks(picks, data.rows, data.leadFields, data.targets);
  if (!checked.ok) {
    return fail(checked.reason === "duplicate" ? DUPLICATE : CHANGED);
  }

  const { error } = await context.supabase.rpc("save_conversion_field_map", {
    p_org: orgId,
    // a deleted target nobody chose again stays as it is
    p_map: picks.filter((p) => p.choice !== REMOVED).map((p) => ({ lead_field_id: p.leadFieldId, target_type: p.targetType, choice: p.choice })),
  });
  if (error) {
    // 42501: a write RLS refused (also "0 rows" inside the function); 23505: a field another lead field holds
    if (error.code === "42501") return fail(NOT_FOUND_OR_FORBIDDEN);
    if (error.code === "23505") return fail(DUPLICATE);
    if (error.code === "23514" || error.code === "22023") return fail(CHANGED);
    return fail(dbErrorMessage(error));
  }

  revalidatePath(conversionMapSettingsPath(orgId));
  return { ok: true, message: "השינויים נשמרו." };
}
