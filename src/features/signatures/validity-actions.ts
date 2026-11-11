"use server";

import { revalidatePath } from "next/cache";

import { isDocumentRecordType } from "@/features/document-templates/fields";
import { documentTemplatesPath } from "@/features/document-templates/paths";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { contractRenewalSchema, validitySchema } from "./validity";

const CANNOT = "אין לכם הרשאה לשנות את התאריכים של המסמך הזה.";
const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשנות את ההגדרה.";

/**
 * SGN-04: a signed document's last day and renewal day, with the user's session. The database decides who may (whoever may
 * edit the live record, in a writable business with the `signatures` key) and checks the dates again.
 */
export async function saveSignatureValidityAction(
  orgId: string,
  kind: string,
  recordId: string,
  docId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isDocumentRecordType(kind)) return fail(NOT_FOUND);
  const context = await actionContext(orgId, recordId, docId);
  if (!context.ok) return context;
  const parsed = validitySchema.safeParse(pick(formData, ["valid_until", "renewal_on"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { error } = await context.supabase.rpc("signature_document_set_validity", {
    p_org: orgId,
    p_doc: docId,
    p_valid_until: parsed.data.validUntil,
    p_renewal_on: parsed.data.renewalOn,
  });
  if (error) return fail(error.code === "42501" ? CANNOT : dbErrorMessage(error), { values: formValues(formData) });
  const page =
    kind === "lead"
      ? paths.lead(orgId, recordId)
      : kind === "contact"
        ? paths.contact(orgId, recordId)
        : kind === "company"
          ? paths.company(orgId, recordId)
          : paths.deal(orgId, recordId);
  revalidatePath(page);
  revalidatePath(documentTemplatesPath(orgId));
  return { ok: true, message: "התאריכים נשמרו." };
}

/**
 * SGN-04: how many days before the renewal day (else the last day) the alert task is made (0 = never). Saved on the
 * business's one documents-settings row as SGN-03's setting: update first, insert only when there is none, update once more
 * when the insert lost a race (no upsert: its DO UPDATE names organization_id, which has no UPDATE grant).
 */
export async function saveContractRenewalAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = contractRenewalSchema.safeParse(pick(formData, ["contract_renewal_days"]));
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
  revalidatePath(documentTemplatesPath(orgId));
  return { ok: true, message: "ההגדרה נשמרה." };
}
