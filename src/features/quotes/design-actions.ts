"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { QUOTE_DESIGN_FIELD_NAMES, quoteDesignSchema } from "./design";
import { quoteDesignPath } from "./paths";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשנות את עיצוב ההצעה.";

/** QUO-05: the business's quote design, with the user's session (owners and admins of a writable business). */
export async function saveQuoteDesignAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = quoteDesignSchema.safeParse(pick(formData, QUOTE_DESIGN_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("quote_designs")
    .upsert({ organization_id: orgId, ...parsed.data }, { onConflict: "organization_id" })
    .select("id");
  if (error) return fail(error.code === "42501" ? NOT_ADMIN : dbErrorMessage(error), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_ADMIN, { values: formValues(formData) });
  revalidatePath(quoteDesignPath(orgId));
  return { ok: true, message: "העיצוב נשמר. הוא חל על כל הצעה שעוד לא נשלחה." };
}
