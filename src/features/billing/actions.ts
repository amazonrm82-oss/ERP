"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { billingFromForm } from "./form";

const subjectArg = z.enum(["company", "contact"]);

/**
 * CON-08: saves the billing details of a company or contact from its billing card, with the
 * user's session. Whether the user may edit the record RLS decides (0 rows = not permitted).
 */
export async function updateBillingAction(
  orgId: string,
  subject: "company" | "contact",
  recordId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!validArg(subjectArg, subject)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, recordId);
  if (!context.ok) {
    return context;
  }
  let request;
  if (subject === "company") {
    const billing = billingFromForm(formData, "company");
    if (!billing.ok) return billing.failure;
    request = context.supabase.from("companies").update(billing.patch);
  } else {
    const billing = billingFromForm(formData, "contact");
    if (!billing.ok) return billing.failure;
    request = context.supabase.from("contacts").update(billing.patch);
  }
  const { data, error } = await request.eq("organization_id", orgId).eq("id", recordId).is("deleted_at", null).select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את פרטי החיוב. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  revalidatePath(subject === "company" ? paths.company(orgId, recordId) : paths.contact(orgId, recordId));
  if (subject === "company") {
    // a contact's card shows its company's billing for its own empty fields
    revalidatePath(paths.contacts(orgId), "layout");
  }
  return { ok: true };
}
