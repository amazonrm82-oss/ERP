"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { documentSettingsPath } from "./paths";
import { DETAILS_FIELD_NAMES, documentDetailsSchema, TAX_FIELD_NAMES, taxSettingsSchema } from "./schema";

type SettingsWrite = Database["public"]["Tables"]["org_document_settings"]["Update"];
type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

type SaveResult = { error: string | null; denied: boolean };

async function updateSettingsRow(supabase: Supabase, orgId: string, values: SettingsWrite): Promise<SaveResult & { updated: boolean }> {
  const { data, error } = await supabase.from("org_document_settings").update(values).eq("organization_id", orgId).select("id");
  if (error) {
    return { error: dbErrorMessage(error, SAVE_FAILED), denied: false, updated: false };
  }
  return { error: null, denied: false, updated: data.length > 0 };
}

/**
 * Writes some columns of the organization's one settings row: updates it, or
 * creates it the first time. Owners and admins of a writable organization
 * only; RLS decides, and 0 rows on both means not permitted. Two first saves at
 * the same time (the two forms of the page): the later insert hits the unique
 * key (23505), and its values are written by updating the row the other one made.
 */
async function saveSettingsRow(supabase: Supabase, orgId: string, values: SettingsWrite): Promise<SaveResult> {
  const first = await updateSettingsRow(supabase, orgId, values);
  if (first.error || first.updated) {
    return { error: first.error, denied: false };
  }
  const { data: inserted, error: insertError } = await supabase
    .from("org_document_settings")
    .insert({ organization_id: orgId, ...values })
    .select("id");
  if (insertError?.code === "23505") {
    const retry = await updateSettingsRow(supabase, orgId, values);
    return { error: retry.error, denied: !retry.error && !retry.updated };
  }
  if (insertError) {
    // 42501: not an owner/admin, or the organization is read-only
    return insertError.code === "42501" ? { error: null, denied: true } : { error: dbErrorMessage(insertError, SAVE_FAILED), denied: false };
  }
  return { error: null, denied: inserted.length === 0 };
}

const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/** Saves the business's legal form and VAT status (TAX-01). */
export async function saveTaxSettingsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = taxSettingsSchema.safeParse(pick(formData, TAX_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const saved = await saveSettingsRow(context.supabase, orgId, parsed.data);
  if (saved.error || saved.denied) {
    return fail(saved.error ?? NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(documentSettingsPath(orgId));
  return { ok: true, message: 'המעמד במע"מ נשמר.' };
}

/** Saves the business details printed on documents (TAX-02). */
export async function saveDocumentDetailsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = documentDetailsSchema.safeParse(pick(formData, DETAILS_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const saved = await saveSettingsRow(context.supabase, orgId, parsed.data);
  if (saved.error || saved.denied) {
    return fail(saved.error ?? NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(documentSettingsPath(orgId));
  return { ok: true, message: "הפרטים למסמכים נשמרו." };
}
