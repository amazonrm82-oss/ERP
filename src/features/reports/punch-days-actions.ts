"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { isPunchDays, PUNCH_REPORT_PREFERENCE } from "./punch-days";

const SAVE_FAILED = "לא הצלחנו לשמור את הבחירה. נסו שוב.";

/**
 * PKG-07 (owner (117) ב): saves the user's "expiring" window of the punch cards report (7 / 14 / 30 / 60) for this
 * business, with the user's session (list_preferences: own rows only; the constraint holds the same closed list).
 * Update and select back, insert only when no row, retry the update once on 23505 (the one-row pattern).
 */
export async function savePunchReportDaysAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const days = Number(formData.get("days"));
  if (!isPunchDays(days)) {
    return fail("בחרו 7, 14, 30 או 60 יום.");
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const columns = [{ days }];
  const update = () =>
    context.supabase.from("list_preferences").update({ columns }).eq("organization_id", orgId).eq("object_type", PUNCH_REPORT_PREFERENCE).select("id");
  const first = await update();
  if (first.error) {
    return fail(dbErrorMessage(first.error, SAVE_FAILED));
  }
  if (first.data.length === 0) {
    const inserted = await context.supabase.from("list_preferences").insert({ organization_id: orgId, object_type: PUNCH_REPORT_PREFERENCE, columns });
    if (inserted.error) {
      if (inserted.error.code !== "23505") {
        return fail(dbErrorMessage(inserted.error, SAVE_FAILED));
      }
      const again = await update();
      if (again.error || again.data.length === 0) {
        return fail(again.error ? dbErrorMessage(again.error, SAVE_FAILED) : SAVE_FAILED);
      }
    }
  }
  revalidatePath(paths.report(orgId, "punch_cards"));
  return ok();
}
