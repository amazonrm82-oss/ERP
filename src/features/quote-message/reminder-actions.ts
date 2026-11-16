"use server";

import { revalidatePath } from "next/cache";

import { quoteDesignPath } from "@/features/quotes/paths";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { quoteReminderSchema } from "./reminders";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשנות את ההגדרה.";

/**
 * QUO-18 (383) א: the switch of the automatic reminders to the customer. Saved on the business's one documents-settings row
 * with the user's session: updated first, inserted only when there is none, updated once more when the insert lost a race
 * (no upsert: its DO UPDATE names organization_id, which has no UPDATE grant).
 */
export async function saveQuoteReminderAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = quoteReminderSchema.safeParse(pick(formData, ["quote_customer_reminder"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = { values: formValues(formData) };
  const table = () => context.supabase.from("org_document_settings");
  const update = () => table().update(parsed.data).eq("organization_id", orgId).select("id");
  let result = await update();
  if (!result.error && result.data.length === 0) {
    const inserted = await table()
      .insert({ organization_id: orgId, ...parsed.data })
      .select("id");
    result = inserted.error?.code === "23505" ? await update() : inserted;
  }
  if (result.error) return fail(result.error.code === "42501" ? NOT_ADMIN : dbErrorMessage(result.error), values);
  if (result.data.length === 0) return fail(NOT_ADMIN, values);
  revalidatePath(quoteDesignPath(orgId));
  return { ok: true, message: "ההגדרה נשמרה. היא חלה גם על הצעות שכבר נשלחו ועוד לא נענו." };
}
