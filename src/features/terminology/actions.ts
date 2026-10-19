"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";

import { saveTerms } from "./save";
import { CONTACT_TERMS, DEAL_TERMS, LEAD_TERMS } from "./terms";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשנות את המונחים.";

// "" = today's word (stored as null); otherwise a key of the ready list
const choice = (list: Record<string, unknown>) =>
  z
    .string()
    .refine((value) => value === "" || value in list, { error: "יש לבחור מהרשימה." })
    .transform((value) => (value === "" ? null : value));

const termsSchema = z.object({
  contact_term: choice(CONTACT_TERMS),
  lead_term: choice(LEAD_TERMS),
  deal_term: choice(DEAL_TERMS),
});

/** FLD-10: saves the business's words, with the user's session (owners and admins of a writable business). */
export async function saveTermsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = termsSchema.safeParse({
    contact_term: formData.get("contact_term") ?? "",
    lead_term: formData.get("lead_term") ?? "",
    deal_term: formData.get("deal_term") ?? "",
  });
  if (!parsed.success) return invalid(parsed.error, formData);
  const supabase = context.supabase;
  const result = await saveTerms(
    {
      update: (org, values) => supabase.from("org_terms").update(values).eq("organization_id", org).select("id"),
      insert: (org, values) => supabase.from("org_terms").insert({ organization_id: org, ...values }).select("id"),
    },
    orgId,
    parsed.data,
  );
  if (!result.ok) {
    return fail(result.error?.code === "42501" ? NOT_ADMIN : dbErrorMessage(result.error), { values: formValues(formData) });
  }
  // the words appear in the menu and on many screens
  revalidatePath(`/o/${orgId}`, "layout");
  return { ok: true, message: "המונחים נשמרו. הם מופיעים בתפריט, בכותרות ובכפתורים." };
}
