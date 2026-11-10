"use server";

import { revalidatePath } from "next/cache";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery } from "@/components/ui/search-picker-logic";
import { isGender, type Gender } from "@/features/gender/gender";
import { getOrgModules } from "@/features/modules/queries";
import { shareSearchHits, subjectFromPick, type SearchRecordsAnswer } from "@/features/share/records";
import { getOrgTerms } from "@/features/terminology/queries";
import { firstNameOf } from "@/features/whatsapp/templates";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { pick } from "@/lib/validation";

import { isDocumentRecordType, type DocumentRecordType } from "./fields";
import { documentTemplatesPath } from "./paths";
import { documentTemplateSchema } from "./schema";
import { dayText, joinParts } from "./values";

// SGN-01: owners and admins of a writable business with the `signatures` key manage the list; RLS and the trigger refuse
// everyone else (0 rows / 42501 / feature:signatures). Owner (201) ב: without the key they may still switch a template off
// and delete it (switchOffDocumentTemplateAction, deleteDocumentTemplateAction).

const DUPLICATE_NAME = "כבר יש תבנית מסמך בשם הזה.";
const FIELDS = ["name", "kind", "record_type", "body", "is_active"] as const;

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

export type DocumentPreviewRecord = {
  /** merge field name -> value; a field the record has no value for is left out */
  values: Record<string, string>;
  gender: Gender | null;
};

const text = (value: string | null | undefined) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

function only(values: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
}

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
  const supabase = context.supabase;
  const type: DocumentRecordType = recordType;

  // a linked company the user does not read gives no values; a failed read fails the preview
  const companyName = async (companyId: string | null) => {
    if (!companyId) return { name: null as string | null, billingAddress: null as string | null, error: null };
    const { data, error } = await supabase.from("companies").select("name, billing_address").eq("organization_id", orgId).eq("id", companyId).maybeSingle();
    return { name: text(data?.name), billingAddress: text(data?.billing_address), error };
  };

  if (type === "lead") {
    const { data, error } = await supabase
      .from("leads")
      .select("full_name, phone, email, company_name, job_title, gender")
      .eq("organization_id", orgId)
      .eq("id", subject.id)
      .maybeSingle();
    if (error) return fail(dbErrorMessage(error));
    if (!data) return fail(NOT_FOUND);
    return ok({
      values: only({
        "שם מלא": text(data.full_name),
        "שם פרטי": text(firstNameOf(data.full_name)),
        טלפון: text(data.phone),
        אימייל: text(data.email),
        "שם החברה": text(data.company_name),
        תפקיד: text(data.job_title),
      }),
      gender: isGender(data.gender) ? data.gender : null,
    });
  }

  if (type === "contact") {
    const { data, error } = await supabase
      .from("contacts")
      .select("first_name, last_name, full_name, phone, email, job_title, address_line, city, billing_tax_id, billing_address, company_id, birth_date, gender")
      .eq("organization_id", orgId)
      .eq("id", subject.id)
      .maybeSingle();
    if (error) return fail(dbErrorMessage(error));
    if (!data) return fail(NOT_FOUND);
    const company = await companyName(data.company_id);
    if (company.error) return fail(dbErrorMessage(company.error));
    return ok({
      values: only({
        "שם מלא": text(data.full_name),
        "שם פרטי": text(data.first_name) ?? text(firstNameOf(data.full_name)),
        "שם משפחה": text(data.last_name),
        טלפון: text(data.phone),
        אימייל: text(data.email),
        תפקיד: text(data.job_title),
        כתובת: joinParts([data.address_line, data.city]),
        "תעודת זהות": text(data.billing_tax_id),
        // CON-08: a contact's empty billing address shows its company's (display only)
        "כתובת לחיוב": text(data.billing_address) ?? company.billingAddress,
        "שם החברה": company.name,
        "תאריך לידה": dayText(data.birth_date),
      }),
      gender: isGender(data.gender) ? data.gender : null,
    });
  }

  if (type === "company") {
    const { data, error } = await supabase
      .from("companies")
      .select("name, tax_id, address_line, city, phone, email, billing_name, billing_address")
      .eq("organization_id", orgId)
      .eq("id", subject.id)
      .maybeSingle();
    if (error) return fail(dbErrorMessage(error));
    if (!data) return fail(NOT_FOUND);
    return ok({
      values: only({
        "שם החברה": text(data.name),
        "מספר החברה": text(data.tax_id),
        כתובת: joinParts([data.address_line, data.city]),
        טלפון: text(data.phone),
        אימייל: text(data.email),
        "שם לחיוב": text(data.billing_name) ?? text(data.name),
        "כתובת לחיוב": text(data.billing_address),
      }),
      gender: null,
    });
  }

  const { data, error } = await supabase
    .from("deals")
    .select("name, amount_agorot, expected_close_date, contact_id, company_id")
    .eq("organization_id", orgId)
    .eq("id", subject.id)
    .maybeSingle();
  if (error) return fail(dbErrorMessage(error));
  if (!data) return fail(NOT_FOUND);
  // the deal's contact and company, each only when the user reads it
  const [contact, company] = await Promise.all([
    data.contact_id
      ? supabase.from("contacts").select("first_name, full_name, phone, email, gender").eq("organization_id", orgId).eq("id", data.contact_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    companyName(data.company_id),
  ]);
  if (contact.error) return fail(dbErrorMessage(contact.error));
  if (company.error) return fail(dbErrorMessage(company.error));
  const person = contact.data;
  return ok({
    values: only({
      "שם העסקה": text(data.name),
      "סכום העסקה": data.amount_agorot === null ? null : formatMoney(data.amount_agorot),
      "תאריך סגירה צפוי": dayText(data.expected_close_date),
      "שם מלא": text(person?.full_name),
      "שם פרטי": text(person?.first_name) ?? text(firstNameOf(person?.full_name)),
      טלפון: text(person?.phone),
      אימייל: text(person?.email),
      "שם החברה": company.name,
    }),
    gender: person && isGender(person.gender) ? person.gender : null,
  });
}
