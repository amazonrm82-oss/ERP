import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isGender, type Gender } from "@/features/gender/gender";
import { firstNameOf } from "@/features/whatsapp/templates";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { formatMoney } from "@/lib/format";

import type { DocumentRecordType } from "./fields";
import { dayText, joinParts } from "./values";

// SGN-01 / SGN-02: a record's merge values, read with the caller's session (a record the caller cannot read is not found).
// Shared by the settings preview (SGN-01) and the document sent for signature from a record (SGN-02).

export type DocumentPreviewRecord = {
  /** merge field name -> value; a field the record has no value for is left out */
  values: Record<string, string>;
  gender: Gender | null;
};

const text = (value: string | null | undefined) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

function only(values: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
}

/** The record's merge values (only fields that have a value) and its gender for HEB-01 blocks. */
export async function readRecordDocumentValues(
  supabase: SupabaseClient<Database>,
  orgId: string,
  type: DocumentRecordType,
  recordId: string,
): Promise<ActionResult<DocumentPreviewRecord>> {
  const subject = { id: recordId };

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
