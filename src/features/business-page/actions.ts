"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid } from "@/lib/paths";
import { optionalText } from "@/lib/validation";

import { MAX_ABOUT, MAX_PAGE_BOOKINGS } from "./model";
import { businessPageSettingsPath } from "./paths";

const schema = z.object({
  about: optionalText(MAX_ABOUT, "התיאור ארוך מדי (עד 1,000 תווים)."),
  is_active: z.boolean(),
  show_phone: z.boolean(),
  show_whatsapp: z.boolean(),
  show_website: z.boolean(),
  show_hours: z.boolean(),
  show_form: z.boolean(),
  booking_page_ids: z.array(z.string().refine(isUuid)).max(MAX_PAGE_BOOKINGS, { error: `אפשר לבחור עד ${MAX_PAGE_BOOKINGS} דפי קביעת תור.` }),
});

/**
 * BIZ-01: saves the business page (owners and admins of a writable business; the database decides, with the plan key to
 * switch it on and the business's own booking pages). One row per business: update, else insert; a parallel first save
 * that lost the insert is retried as an update (the rule for one-row settings tables).
 */
export async function saveBusinessPageAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const on = (name: string) => formData.get(name) === "on";
  const parsed = schema.safeParse({
    about: formData.get("about"),
    is_active: on("is_active"),
    show_phone: on("show_phone"),
    show_whatsapp: on("show_whatsapp"),
    show_website: on("show_website"),
    show_hours: on("show_hours"),
    show_form: on("show_form"),
    booking_page_ids: [...new Set(formData.getAll("booking_page_ids").map(String))],
  });
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = parsed.data;
  const { supabase } = context;

  const update = () => supabase.from("business_pages").update(values).eq("organization_id", orgId).select("id");
  let saved = await update();
  if (saved.error) return fail(dbErrorMessage(saved.error), { values: formValues(formData) });
  if (saved.data.length === 0) {
    const inserted = await supabase.from("business_pages").insert({ organization_id: orgId, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      saved = await update();
      if (saved.error) return fail(dbErrorMessage(saved.error), { values: formValues(formData) });
      if (saved.data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
    } else if (inserted.error) {
      return fail(dbErrorMessage(inserted.error, "לא הצלחנו לשמור את הדף. נסו שוב."), { values: formValues(formData) });
    } else if (inserted.data.length === 0) {
      return fail(NOT_FOUND_OR_FORBIDDEN);
    }
  }
  revalidatePath(businessPageSettingsPath(orgId));
  return { ok: true, message: "הדף נשמר." };
}
