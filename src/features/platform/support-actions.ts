"use server";

import { revalidatePath } from "next/cache";

import { fail, formValues, type FormState } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { SESSION_EXPIRED } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

function supportError(error: { code?: string }): string {
  if (error.code === "42501") return "אין לכם הרשאה לפעולה הזו, או שהאימות הדו-שלבי פג. התחברו מחדש ונסו שוב.";
  if (error.code === "P0002") return "הפנייה לא נמצאה.";
  if (error.code === "22023") return "הנתונים אינם תקינים.";
  return "הפעולה נכשלה. נסו שוב.";
}

/** ADM-05: support moves a request to another status; the requester gets a notice (database). */
export async function setSupportRequestStatusAction(requestId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!isUuid(requestId) || !(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const status = formData.get("status");
  if (status !== "open" && status !== "in_progress" && status !== "closed") return fail("יש לבחור מצב.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_set_support_request_status", { p_id: requestId, p_status: status });
  if (error) return fail(supportError(error));
  revalidatePath(paths.adminSupport);
  return { ok: true, message: "המצב עודכן, והפונה קיבל התראה." };
}

/** ADM-05: an internal note on a request; the business never sees it. */
export async function addSupportRequestNoteAction(requestId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!isUuid(requestId) || !(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const body = typeof formData.get("body") === "string" ? String(formData.get("body")).trim() : "";
  if (body === "" || body.length > 2000) return fail("יש לכתוב הערה של עד 2,000 תווים.", { values: formValues(formData) });
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_add_support_request_note", { p_id: requestId, p_body: body });
  if (error) return fail(supportError(error), { values: formValues(formData) });
  revalidatePath(paths.adminSupport);
  return { ok: true, message: "ההערה נשמרה." };
}
