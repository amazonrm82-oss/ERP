"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { findPersonDuplicate, duplicateMessage, type Existing } from "@/features/data-quality/duplicates";
import { chequeSchema } from "@/features/payments/cheques";
import { paymentsPath } from "@/features/payments/paths";
import { isPaymentMethod, PAYMENT_INSTALLMENTS_MAX, PAYMENT_REFERENCE_MAX, type PaymentMethod } from "@/features/payments/schema";
import { activeHolds, customerOf, getHoldsAccess } from "@/features/customer-holds/queries";
import { holdWarningText } from "@/features/customer-holds/schema";
import { getOrgTerms } from "@/features/terminology/queries";
import type { OrgTerms } from "@/features/terminology/terms";
import { totalsErrorMessage } from "@/features/tax/calc";
import { VAT_STATUS_MISSING } from "@/features/tax/rates";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, FORM_INVALID, formValues, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { parseMoneyToAgorot } from "@/lib/format";
import { paths } from "@/lib/paths";
import { optionalPhone, pick } from "@/lib/validation";

import {
  QUICK_SALE_CHEQUE_STATUSES,
  QUICK_SALE_CHEQUES_MAX,
  QUICK_SALE_DOC_TYPES,
  chequesAddUp,
  quickSaleBody,
  quickSaleDealName,
  quickSaleItemsSchema,
  type PricedSale,
  type QuickSaleDocType,
  type SaleCheque,
  type SaleCustomer,
} from "./sale";
import { priceQuickSale } from "./server";

// GAP-08: the quick sale. Everything goes with the user's session: the preview reads prices under RLS, and the sale itself
// is one call to public.quick_sale (security invoker, all or nothing), so the tables' own policies and triggers decide.

const CANNOT = "אין לכם הרשאה למכירה מהירה כאן. רושמים תשלומים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים; רישום מסמך דורש גם הרשאת מסמכים.";
const PRODUCT_GONE = "אחד הפריטים כבר לא פעיל בקטלוג. הסירו אותו ובחרו שוב.";
const CHEQUES_TOTAL = "סכומי הצ'קים צריכים להסתכם בדיוק בסכום לתשלום.";
const RECURRING = "מכירה מהירה היא חיוב אחד. מוצר בחיוב חוזר נמכר דרך עסקה.";

export type PreviewLine = { productId: string; name: string; quantity: number; unitPriceAgorot: number; fromList: boolean };
export type QuickSalePreview = {
  lines: PreviewLine[];
  includesVat: boolean;
  netAgorot: number;
  vatAgorot: number;
  totalAgorot: number;
};

function pricedFailure(priced: Exclude<PricedSale, { ok: true }>): string {
  if (priced.reason === "vat_unknown") return VAT_STATUS_MISSING;
  if (priced.reason === "recurring") return RECURRING;
  if (priced.reason === "totals") return totalsErrorMessage(priced.error);
  return PRODUCT_GONE;
}

const contactArg = z.union([z.null(), z.guid()]);

/** The prices and the total the screen shows (the same rule the sale uses). */
export async function previewQuickSaleAction(orgId: string, contactId: unknown, items: unknown): Promise<ActionResult<QuickSalePreview>> {
  const contact = contactArg.safeParse(contactId);
  const parsed = quickSaleItemsSchema.safeParse(items);
  if (!contact.success || !parsed.success) return fail(INVALID_ARGS);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  let priced: PricedSale;
  try {
    ({ priced } = await priceQuickSale(context.supabase, orgId, contact.data, parsed.data));
  } catch {
    return fail("לא הצלחנו לחשב את הסכום. נסו שוב.");
  }
  if (!priced.ok) return fail(pricedFailure(priced));
  return ok({
    lines: priced.lines.map((line) => ({
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitPriceAgorot: line.unitPriceAgorot,
      fromList: line.source === "price_list",
    })),
    includesVat: priced.totals.pricesIncludeVat,
    netAgorot: priced.totals.netTotalAgorot,
    vatAgorot: priced.totals.vatAgorot,
    totalAgorot: priced.totals.totalAgorot,
  });
}

export type QuickSaleDone = { dealId: string; contactId: string; documentId: string | null; totalAgorot: number };

const raw = z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string());

const customerSchema = z.discriminatedUnion("customer_mode", [
  z.object({ customer_mode: z.literal("existing"), contact_id: z.guid({ error: "יש לבחור לקוח." }) }),
  z.object({
    customer_mode: z.literal("new"),
    first_name: raw.pipe(z.string().min(1, { error: "יש לכתוב את שם הלקוח." }).max(100, { error: "השם ארוך מדי (עד 100 תווים)." })),
    last_name: raw.pipe(z.string().max(100, { error: "שם המשפחה ארוך מדי (עד 100 תווים)." })),
    phone: optionalPhone,
  }),
]);

const paymentSchema = z
  .object({
    method: raw.refine(isPaymentMethod, "יש לבחור אמצעי תשלום.").transform((value) => value as PaymentMethod),
    installments: raw,
    reference: raw.pipe(z.string().max(PAYMENT_REFERENCE_MAX, { error: `האסמכתא עד ${PAYMENT_REFERENCE_MAX} תווים.` })),
  })
  .transform((value, ctx) => {
    let installments: number | null = null;
    if (value.method === "credit") {
      const text = value.installments === "" ? "1" : value.installments;
      const n = /^\d+$/.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > PAYMENT_INSTALLMENTS_MAX) {
        ctx.addIssue({ code: "custom", path: ["installments"], message: `מספר התשלומים בין 1 ל-${PAYMENT_INSTALLMENTS_MAX}.` });
        return z.NEVER;
      }
      installments = n;
    }
    return { method: value.method, installments, reference: value.reference === "" ? null : value.reference };
  });

const documentSchema = z.object({
  doc_type: raw.refine((v) => (QUICK_SALE_DOC_TYPES as readonly string[]).includes(v), "יש לבחור את סוג המסמך.").transform((v) => v as QuickSaleDocType),
  doc_number: raw.pipe(z.string().min(1, { error: "יש לכתוב את מספר המסמך." }).max(40, { error: "מספר המסמך עד 40 תווים." })),
});

/** PAY-04: the cheques of the sale (JSON from the screen), each checked by the cheque form's own rules. */
function parseCheques(input: FormDataEntryValue | null): { ok: true; cheques: SaleCheque[] } | { ok: false; message: string } {
  let rows: unknown;
  try {
    rows = JSON.parse(String(input ?? "[]"));
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > QUICK_SALE_CHEQUES_MAX) {
    return { ok: false, message: `יש להזין בין 1 ל-${QUICK_SALE_CHEQUES_MAX} צ'קים.` };
  }
  const cheques: SaleCheque[] = [];
  for (const [index, row] of rows.entries()) {
    const label = rows.length > 1 ? `צ'ק ${index + 1}: ` : "";
    const record = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
    const fields = chequeSchema.safeParse(record);
    if (!fields.success) return { ok: false, message: label + (fields.error.issues[0]?.message ?? "פרטי הצ'ק לא תקינים.") };
    if (!(QUICK_SALE_CHEQUE_STATUSES as readonly string[]).includes(fields.data.cheque_status)) {
      return { ok: false, message: `${label}בצ'ק במכירה מהירה המצב הוא ביד או נפרע.` };
    }
    const amount = typeof record.amount === "string" ? parseMoneyToAgorot(record.amount.trim()) : null;
    if (amount === null || amount < 1) return { ok: false, message: `${label}יש להזין את סכום הצ'ק בשקלים.` };
    cheques.push({ ...fields.data, cheque_status: fields.data.cheque_status as SaleCheque["cheque_status"], amount_agorot: amount });
  }
  return { ok: true, cheques };
}

function fieldFailure(error: z.ZodError, formData: FormData) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_form");
    if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
  }
  return fail(FORM_INVALID, { fieldErrors, values: formValues(formData) });
}

/** GAP-08: the sale itself. Prices are worked out again here; the database refuses a total other than the one shown. */
export async function quickSaleAction(orgId: string, _prev: FormState<QuickSaleDone>, formData: FormData): Promise<FormState<QuickSaleDone>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const values = formValues(formData);

  const customer = customerSchema.safeParse({
    customer_mode: formData.get("customer_mode"),
    contact_id: formData.get("contact_id") ?? "",
    first_name: formData.get("first_name") ?? "",
    last_name: formData.get("last_name") ?? "",
    phone: formData.get("phone") ?? "",
  });
  if (!customer.success) return fieldFailure(customer.error, formData);

  let itemsJson: unknown;
  try {
    itemsJson = JSON.parse(String(formData.get("items") ?? "[]"));
  } catch {
    itemsJson = null;
  }
  const items = quickSaleItemsSchema.safeParse(itemsJson);
  if (!items.success) return fail("יש להוסיף לפחות פריט אחד.", { fieldErrors: { items: "יש להוסיף לפחות פריט אחד." }, values });

  const payment = paymentSchema.safeParse(pick(formData, ["method", "installments", "reference"]));
  if (!payment.success) return fieldFailure(payment.error, formData);
  let cheques: SaleCheque[] | null = null;
  if (payment.data.method === "cheque") {
    const parsedCheques = parseCheques(formData.get("cheques"));
    if (!parsedCheques.ok) return fail(parsedCheques.message, { fieldErrors: { cheques: parsedCheques.message }, values });
    cheques = parsedCheques.cheques;
  }

  let document: { docType: QuickSaleDocType; number: string } | null = null;
  if (formData.get("record_document") === "on") {
    const doc = documentSchema.safeParse(pick(formData, ["doc_type", "doc_number"]));
    if (!doc.success) return fieldFailure(doc.error, formData);
    document = { docType: doc.data.doc_type, number: doc.data.doc_number };
  }

  const expected = Number(formData.get("expected_total"));
  if (!Number.isSafeInteger(expected) || expected < 1) return fail(INVALID_ARGS, { values });
  if (cheques && !chequesAddUp(cheques, expected)) {
    return fail(CHEQUES_TOTAL, { fieldErrors: { cheques: CHEQUES_TOTAL }, values });
  }

  const who: SaleCustomer =
    customer.data.customer_mode === "existing"
      ? { contactId: customer.data.contact_id }
      : { newContact: { firstName: customer.data.first_name, lastName: customer.data.last_name || null, phone: customer.data.phone } };

  // DQL-02 (owner, 26 October 2026): a new customer is checked against the leads and contacts the user sees first; on a
  // match the screen offers to sell to the existing contact, or to make the new one anyway
  if ("newContact" in who && who.newContact.phone && formData.get("allow_duplicate") !== "on") {
    let duplicate: Existing | null;
    try {
      duplicate = await findPersonDuplicate(context.supabase, orgId, [who.newContact.phone], []);
    } catch {
      return fail("לא הצלחנו לבדוק אם הלקוח כבר קיים. נסו שוב.", { values });
    }
    if (duplicate) {
      return fail(duplicateMessage(duplicate, "הטלפון הזה"), {
        fieldErrors: {
          duplicate: duplicateMessage(duplicate, "הטלפון הזה"),
          duplicate_href: duplicate.href,
          ...(duplicate.kind === "contact" && duplicate.id ? { duplicate_id: duplicate.id, duplicate_name: duplicate.name } : {}),
        },
        values,
      });
    }
  }

  let priced: PricedSale;
  let day: string;
  let terms: OrgTerms;
  try {
    [{ priced, day }, terms] = await Promise.all([priceQuickSale(context.supabase, orgId, "contactId" in who ? who.contactId : null, items.data), getOrgTerms(orgId)]);
  } catch {
    return fail("לא הצלחנו לחשב את הסכום. נסו שוב.", { values });
  }
  if (!priced.ok) return fail(pricedFailure(priced), { values });

  const body = quickSaleBody(who, priced.lines, { ...payment.data, cheques }, document, expected, quickSaleDealName(terms.deal.singular, day));
  const { data, error } = await context.supabase.rpc("quick_sale", { p_org: orgId, p_sale: body });
  if (error) return fail(error.code === "42501" ? CANNOT : dbErrorMessage(error), { values });
  const result = data as { deal_id: string; contact_id: string; document_id: string | null; total_agorot: number };
  revalidatePath(paymentsPath(orgId));
  revalidatePath(paths.deals(orgId));
  return ok({ dealId: result.deal_id, contactId: result.contact_id, documentId: result.document_id, totalAgorot: Number(result.total_agorot) }, "המכירה נרשמה.");
}

/**
 * COL-05: the warnings for a held customer (the contact's own hold, then its company's), as on quotes and orders: only
 * with the `collection` key, and a warning only; the sale is never refused.
 */
export async function quickSaleHoldsAction(orgId: string, contactId: unknown): Promise<string[]> {
  const parsed = z.guid().safeParse(contactId);
  if (!parsed.success) return [];
  const context = await actionContext(orgId, parsed.data);
  if (!context.ok) return [];
  try {
    if (!(await getHoldsAccess(orgId)).inPlan) return [];
    const who = await customerOf(orgId, { kind: "contact", id: parsed.data });
    const holds = await activeHolds(orgId, who);
    // the contact's own hold first
    return [...holds].sort((a, b) => (a.on === b.on ? 0 : a.on === "contact" ? -1 : 1)).map(holdWarningText);
  } catch {
    return [];
  }
}
