"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { duplicateMessage, findCompanyDuplicate } from "@/features/data-quality/duplicates";
import { customFieldsFromForm, customFieldsPatch } from "@/features/custom-fields/server";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { setTrashed } from "@/lib/record-trash";
import { typeIdFromForm } from "@/features/record-type-options/schema";
import { pick } from "@/lib/validation";

import { COMPANY_FIELD_NAMES, companySchema } from "./schema";

function revalidateCompany(orgId: string, companyId?: string) {
  revalidatePath(paths.companies(orgId));
  if (companyId) {
    revalidatePath(paths.company(orgId, companyId));
  }
}

export async function createCompanyAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = companySchema.safeParse(pick(formData, COMPANY_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const custom = await customFieldsFromForm(orgId, "company", formData);
  if (!custom.ok) {
    return custom;
  }
  // CON-02: only when the form has the field (the organization has types)
  const type = typeIdFromForm(formData);
  if (!type.ok) {
    return fail(type.message, { fieldErrors: { type_id: type.message }, values: formValues(formData) });
  }

  // DQL-02: a company the user can see with the same tax id, name or phone is pointed out first;
  // the user may still create the new one.
  if (formData.get("allow_duplicate") !== "on") {
    const duplicate = await findCompanyDuplicate(context.supabase, orgId, { name: parsed.data.name, taxId: parsed.data.tax_id, phone: parsed.data.phone });
    if (duplicate) {
      return fail(duplicateMessage(duplicate, "השם, המספר או הטלפון האלה"), {
        fieldErrors: { allow_duplicate: duplicate.href },
        values: formValues(formData),
      });
    }
  }

  // owner_id is left out: the database assigns the company to its creator.
  const { data, error } = await context.supabase
    .from("companies")
    .insert({ organization_id: orgId, ...parsed.data, ...type.patch, ...customFieldsPatch(custom.customFields) })
    .select("id")
    .single();
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את החברה. נסו שוב."), { values: formValues(formData) });
  }

  revalidateCompany(orgId);
  redirect(paths.company(orgId, data.id));
}

export async function updateCompanyAction(
  orgId: string,
  companyId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, companyId);
  if (!context.ok) {
    return context;
  }
  const parsed = companySchema.safeParse(pick(formData, COMPANY_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const custom = await customFieldsFromForm(orgId, "company", formData, companyId);
  if (!custom.ok) {
    return custom;
  }
  // CON-02: only when the form has the field (the organization has types)
  const type = typeIdFromForm(formData);
  if (!type.ok) {
    return fail(type.message, { fieldErrors: { type_id: type.message }, values: formValues(formData) });
  }

  const { data, error } = await context.supabase
    .from("companies")
    .update({ ...parsed.data, ...type.patch, ...customFieldsPatch(custom.customFields) })
    .eq("organization_id", orgId)
    .eq("id", companyId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את השינויים. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }

  revalidateCompany(orgId, companyId);
  return { ok: true };
}

/** Moves the company to the recycle bin. Its contacts and deals stay and keep pointing at it. */
export async function trashCompanyAction(orgId: string, companyId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, companyId);
  if (!context.ok) {
    return context;
  }
  const result = await setTrashed(context.supabase, "companies", orgId, companyId, true);
  if (!result.ok) {
    return result;
  }
  revalidateCompany(orgId, companyId);
  redirect(paths.companies(orgId));
}
