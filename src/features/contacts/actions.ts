"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { CONTACT_FIELD_NAMES, createContactSchema } from "./schema";

export async function createContactAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = createContactSchema.safeParse(pick(formData, CONTACT_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // owner_id is left out: the database assigns the contact to its creator.
  const { data, error } = await context.supabase
    .from("contacts")
    .insert({ organization_id: orgId, ...parsed.data })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את איש הקשר. נסו שוב."), { values: formValues(formData) });
  }

  revalidatePath(paths.contacts(orgId));
  redirect(paths.contact(orgId, data.id));
}
