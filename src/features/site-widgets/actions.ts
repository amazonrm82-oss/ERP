"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { widgetSchema } from "./model";
import { siteWidgetSettingsPath } from "./paths";

function parse(formData: FormData) {
  return widgetSchema.safeParse({
    ...pick(formData, ["name", "button_label", "phone", "position", "assign_mode", "owner_id", "team_id"]),
    show_whatsapp: formData.get("show_whatsapp") === "on",
    show_call: formData.get("show_call") === "on",
    show_form: formData.get("show_form") === "on",
    is_active: formData.get("is_active") === "on",
  });
}

/**
 * SPD-07: saves a site widget: a new one (widgetId null) or an existing one. Owners and admins (the database decides,
 * with the plan's flag and quota); its form follows the widget in the database.
 */
export async function saveWidgetAction(orgId: string, widgetId: string | null, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, ...(widgetId ? [widgetId] : []));
  if (!context.ok) return context;
  const parsed = parse(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const { supabase } = context;
  if (widgetId) {
    const { data, error } = await supabase.from("site_widgets").update(parsed.data).eq("organization_id", orgId).eq("id", widgetId).select("id");
    if (error) return fail(dbErrorMessage(error), { values: formValues(formData) });
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  } else {
    const { error } = await supabase.from("site_widgets").insert({ organization_id: orgId, ...parsed.data });
    if (error) return fail(dbErrorMessage(error, "לא הצלחנו ליצור את הכפתור. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(siteWidgetSettingsPath(orgId));
  return { ok: true, message: widgetId ? "השינויים נשמרו. באתר הם מופיעים תוך כמה דקות." : "הכפתור נוצר. העתיקו את השורה לאתר שלכם." };
}

/** Removes a widget: the script stops showing the button, and its form goes with it (leads that came in stay). */
export async function deleteWidgetAction(orgId: string, widgetId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, widgetId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("site_widgets").delete().eq("organization_id", orgId).eq("id", widgetId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(siteWidgetSettingsPath(orgId));
  return ok();
}
