"use server";

import { revalidatePath } from "next/cache";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery } from "@/components/ui/search-picker-logic";
import { getOrgModules } from "@/features/modules/queries";
import { shareSearchHits, subjectFromPick, type SearchRecordsAnswer } from "@/features/share/records";
import { getOrgTerms } from "@/features/terminology/queries";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { isDocumentRecordType } from "./fields";
import { documentTemplatesPath } from "./paths";
import { documentTemplateSchema } from "./schema";
import { readRecordDocumentValues, type DocumentPreviewRecord } from "./record-values-server";

// SGN-01: owners and admins of a writable business with the `signatures` key manage the list; RLS and the trigger refuse
// everyone else (0 rows / 42501 / feature:signatures). Owner (201) ב: without the key they may still switch a template off
// and delete it (switchOffDocumentTemplateAction, deleteDocumentTemplateAction).

const DUPLICATE_NAME = "כבר יש תבנית מסמך בשם הזה.";
const FIELDS = ["name", "kind", "record_type", "body", "is_active", "default_validity_months"] as const;

function parse(formData: FormData) {
  return documentTemplateSchema.safeParse(pick(formData, [...FIELDS]));
}

export async function addDocumentTemplateAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = parse(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const { error } = await context.supabase.from("document_templates").insert({ organization_id: orgId, ...parsed.data });
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE_NAME : dbErrorMessage(error, "לא הצלחנו להוסיף את התבנית. נסו שוב."), {
      values: formValues(formData),
    });
  }
  revalidatePath(documentTemplatesPath(orgId));
  return ok();
}

export async function updateDocumentTemplateAction(orgId: string, templateId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const parsed = parse(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("document_templates")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", templateId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE_NAME : dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(documentTemplatesPath(orgId));
  return { ok: true, message: "התבנית נשמרה." };
}

/** Switches a template off and nothing else: allowed without the plan key (owner (201) ב), so it sends only is_active. */
export async function switchOffDocumentTemplateAction(orgId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("document_templates")
    .update({ is_active: false })
    .eq("organization_id", orgId)
    .eq("id", templateId)
    .eq("is_active", true)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(documentTemplatesPath(orgId));
  return ok();
}

export async function deleteDocumentTemplateAction(orgId: string, templateId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, templateId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("document_templates").delete().eq("organization_id", orgId).eq("id", templateId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(documentTemplatesPath(orgId));
  return ok();
}

const SEARCH_FAILED = "החיפוש נכשל. נסו שוב.";

/**
 * The preview's record picker: the global search (public.search_records, security invoker: RLS decides what is found) with
 * the user's session, only records of the template's type, a switched-off module left out.
 */
export async function searchDocumentRecordsAction(orgId: string, recordType: string, query: string): Promise<SearchPickerResult> {
  if (!isDocumentRecordType(recordType)) return { hits: [] };
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") return { hits: [] };
  const term = pickerQuery(query);
  if (term === null) return { hits: [] };
  const context = await actionContext(orgId);
  if (!context.ok) return { error: context.message };
  const { data, error } = await context.supabase.rpc("search_records", { p_org: orgId, p_query: term, p_limit: 8 });
  if (error) return { error: SEARCH_FAILED };
  const [modules, terms] = await Promise.all([getOrgModules(orgId), getOrgTerms(orgId)]);
  const hits = shareSearchHits(data as SearchRecordsAnswer, modules, terms).filter((hit) => hit.id.startsWith(`${recordType}:`));
  return { hits };
}

export type { DocumentPreviewRecord };

/**
 * The picked record's merge values for the preview, read with the user's session (a record the user cannot read is not
 * found). Nothing is stored: the preview is filled in the browser.
 */
export async function documentPreviewAction(orgId: string, recordType: string, picked: string): Promise<ActionResult<DocumentPreviewRecord>> {
  if (!isDocumentRecordType(recordType)) return fail(NOT_FOUND);
  const subject = subjectFromPick(picked);
  if (!subject || subject.kind !== recordType) return fail(NOT_FOUND);
  const context = await actionContext(orgId, subject.id);
  if (!context.ok) return context;
  return readRecordDocumentValues(context.supabase, orgId, recordType, subject.id);
}
