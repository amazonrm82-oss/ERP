"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { BusinessCardField } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { CARD_FIELD_KEYS, cardSchema, shownFields } from "./model";
import { businessCardSettingsPath } from "./paths";

/**
 * BIZ-02: saves a rep's card: a new one, or the rep's existing one. The rep and owners/admins may (the database
 * decides, with the plan's flag and one card per rep).
 */
export async function saveCardAction(orgId: string, userId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, userId);
  if (!context.ok) return context;
  const picked = formData.getAll("public_fields").map(String).filter((f): f is BusinessCardField => (CARD_FIELD_KEYS as string[]).includes(f));
  const parsed = cardSchema.safeParse({
    ...pick(formData, ["job_title", "about", "phone", "email", "website"]),
    public_fields: picked,
    is_active: formData.get("is_active") === "on",
  });
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = {
    job_title: parsed.data.job_title,
    about: parsed.data.about,
    phone: parsed.data.phone,
    email: parsed.data.email,
    website: parsed.data.website,
    public_fields: shownFields(parsed.data, parsed.data.public_fields),
    is_active: parsed.data.is_active,
  };
  const { supabase } = context;
  const existing = await supabase.from("business_cards").select("id").eq("organization_id", orgId).eq("user_id", userId).maybeSingle();
  if (existing.error) return fail(dbErrorMessage(existing.error), { values: formValues(formData) });
  if (existing.data) {
    const { data, error } = await supabase.from("business_cards").update(values).eq("organization_id", orgId).eq("id", existing.data.id).select("id");
    if (error) return fail(dbErrorMessage(error), { values: formValues(formData) });
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  } else {
    const { error } = await supabase.from("business_cards").insert({ organization_id: orgId, user_id: userId, ...values });
    if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הכרטיס. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(businessCardSettingsPath(orgId));
  return { ok: true, message: "הכרטיס נשמר." };
}

/** Removes a card: its link stops working, and its form goes with it (inquiries and leads stay). */
export async function deleteCardAction(orgId: string, cardId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, cardId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("business_cards").delete().eq("organization_id", orgId).eq("id", cardId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(businessCardSettingsPath(orgId));
  return ok();
}
