"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { reviewRequestSettingsPath } from "./paths";
import { REVIEW_REQUEST_FIELD_NAMES, reviewRequestSettingsSchema } from "./review-url";

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/**
 * RET-02: saves the business's review requests with the user's session (owners and admins of a writable business, RLS; 0
 * rows = not permitted). The database judges the link, the plan key and a complete setting again (app.review_request_settings_check).
 * Updates the row, or inserts it the first time; a first save racing another hits the unique key and updates.
 */
export async function saveReviewRequestSettingsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = reviewRequestSettingsSchema.safeParse(pick(formData, REVIEW_REQUEST_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = parsed.data;
  const update = () => context.supabase.from("review_request_settings").update(values).eq("organization_id", orgId).select("id");

  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("review_request_settings").insert({ organization_id: orgId, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED), { values: formValues(formData) });
  if ((data?.length ?? 0) === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  revalidatePath(reviewRequestSettingsPath(orgId));
  return { ok: true, message: values.enabled ? "נשמר. בקשות הביקורת פועלות." : "נשמר. בקשות הביקורת כבויות." };
}
