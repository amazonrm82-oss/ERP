"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { documentSettingsPath } from "./paths";
import { BANK_FIELD_NAMES, bankDetailsSchema, DETAILS_FIELD_NAMES, documentDetailsSchema, TAX_FIELD_NAMES, taxSettingsSchema } from "./schema";

type SettingsWrite = Database["public"]["Tables"]["org_document_settings"]["Update"];
type BankWrite = Database["public"]["Tables"]["org_bank_details"]["Update"];
type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

type SaveResult = { error: string | null; denied: boolean };
type RowsResult = { data: { id: string }[] | null; error: { code?: string; message: string } | null };

/**
 * Writes some columns of the organization's one row of a settings table:
 * updates it, or creates it the first time. Owners and admins of a writable
 * organization only; RLS decides, and 0 rows on both means not permitted. Two
 * first saves at the same time (the forms of the page): the later insert hits
 * the unique key (23505), and its values are written by updating the row the
 * other one made.
 */
async function saveOneRow(update: () => PromiseLike<RowsResult>, insert: () => PromiseLike<RowsResult>): Promise<SaveResult> {
  const updateOnce = async (): Promise<SaveResult & { updated: boolean }> => {
    const { data, error } = await update();
    if (error) {
      return { error: dbErrorMessage(error, SAVE_FAILED), denied: false, updated: false };
    }
    return { error: null, denied: false, updated: (data?.length ?? 0) > 0 };
  };
  const first = await updateOnce();
  if (first.error || first.updated) {
    return { error: first.error, denied: false };
  }
  const { data: inserted, error: insertError } = await insert();
  if (insertError?.code === "23505") {
    const retry = await updateOnce();
    return { error: retry.error, denied: !retry.error && !retry.updated };
  }
  if (insertError) {
    // 42501: not an owner/admin, or the organization is read-only
    return insertError.code === "42501" ? { error: null, denied: true } : { error: dbErrorMessage(insertError, SAVE_FAILED), denied: false };
  }
  return { error: null, denied: (inserted?.length ?? 0) === 0 };
}

function saveSettingsRow(supabase: Supabase, orgId: string, values: SettingsWrite): Promise<SaveResult> {
  return saveOneRow(
    () => supabase.from("org_document_settings").update(values).eq("organization_id", orgId).select("id"),
    () => supabase.from("org_document_settings").insert({ organization_id: orgId, ...values }).select("id"),
  );
}

function saveBankRow(supabase: Supabase, orgId: string, values: BankWrite): Promise<SaveResult> {
  return saveOneRow(
    () => supabase.from("org_bank_details").update(values).eq("organization_id", orgId).select("id"),
    () => supabase.from("org_bank_details").insert({ organization_id: orgId, ...values }).select("id"),
  );
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

/**
 * Saves the bank details (TAX-02 follow-up). Owners and admins of a writable
 * organization only, enforced by RLS; the database audits the change (account
 * masked) and tells every owner and admin.
 */
export async function saveBankDetailsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = bankDetailsSchema.safeParse(pick(formData, BANK_FIELD_NAMES));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const saved = await saveBankRow(context.supabase, orgId, parsed.data);
  if (saved.error || saved.denied) {
    return fail(saved.error ?? NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  }
  revalidatePath(documentSettingsPath(orgId));
  return { ok: true, message: "פרטי הבנק נשמרו." };
}
