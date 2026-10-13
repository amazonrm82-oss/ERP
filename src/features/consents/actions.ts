"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";

import { manualConsentSchema } from "./schema";

const subjectArg = z.object({ kind: z.enum(["lead", "contact"]), id: z.guid() });

const CANNOT_RECORD = "אי אפשר לרשום הסכמה לרשומה הזו. ייתכן שנמחקה, שהיא בסל המחזור או שאין לכם הרשאה לערוך אותה.";

/**
 * CNS-03: a person records a new consent state for one channel of a lead or contact, with how it
 * was given. Always a new row (CNS-02); the database sets who and when, and the address hash.
 */
export async function recordConsentAction(
  orgId: string,
  subject: { kind: "lead" | "contact"; id: string },
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsedSubject = subjectArg.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(CANNOT_RECORD);
  }
  const { kind, id } = parsedSubject.data;
  const context = await actionContext(orgId, id);
  if (!context.ok) {
    return context;
  }
  const parsed = manualConsentSchema.safeParse({
    channel: formData.get("channel"),
    state: formData.get("state"),
    method: formData.get("method") ?? "",
    wording: formData.get("wording") ?? "",
    lift_method: formData.get("lift_method") ?? "",
    lift_note: formData.get("lift_note") ?? "",
  });
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { error } = await context.supabase.from("consents").insert({
    organization_id: orgId,
    lead_id: kind === "lead" ? id : null,
    contact_id: kind === "contact" ? id : null,
    channel: parsed.data.channel,
    state: parsed.data.state,
    source: "manual",
    method: parsed.data.method,
    wording: parsed.data.wording,
    lift_method: parsed.data.lift_method,
    lift_note: parsed.data.lift_note,
  });
  if (error) {
    // a refused row (not editable, in the bin, read-only organization); a missing second step keeps its own message
    return fail(error.code === "42501" && !error.hint ? CANNOT_RECORD : dbErrorMessage(error), { values: formValues(formData) });
  }
  revalidatePath(recordPage(kind, orgId, id));
  return ok();
}
