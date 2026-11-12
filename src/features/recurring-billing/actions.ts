"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { priceListTiers, readDealPricing, readPricedProduct } from "@/features/deal-lines/queries";
import { pulledPrice } from "@/features/deal-lines/pricing";
import { DEAL_LINE_FIELD_NAMES, dealLineSchema } from "@/features/deal-lines/schema";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { pick } from "@/lib/validation";
import { z } from "zod";

import { recurringBillingPath, recurringBillingsPath } from "./paths";
import { cancelSchema, EDIT_BILLING_FIELDS, editBillingSchema, NEW_BILLING_FIELDS, newBillingSchema } from "./schema";

// SUB-01..SUB-04. Every write goes with the user's session: RLS (app.recurring_billing_writer and the customer the user reads)
// and the database's triggers decide; a refused update answers 0 rows.

const CANNOT_EDIT =
  "אי אפשר לשנות את החיוב החוזר. רק מי שרושם תשלומים (בעלים, מנהלי מערכת, מנהלים או מי שקיבל הרשאה) משנה חיובים, בעסק פעיל ובחבילה שכוללת חיובים חוזרים.";
const PRODUCT_GONE = "המוצר שנבחר לא פעיל או בארכיון. בחרו מוצר פעיל מהקטלוג.";
const PRICE_MISSING = "בשורה בלי מוצר יש להזין מחיר.";

function writeError(error: { code?: string; message?: string; hint?: string }): string {
  if (error.code === "42501") return CANNOT_EDIT;
  return dbErrorMessage(error);
}

function revalidateBilling(orgId: string, billingId: string, customer?: { contactId: string | null; companyId: string | null }) {
  revalidatePath(recurringBillingPath(orgId, billingId));
  revalidatePath(recurringBillingsPath(orgId));
  if (customer?.contactId) revalidatePath(paths.contact(orgId, customer.contactId));
  if (customer?.companyId) revalidatePath(paths.company(orgId, customer.companyId));
}

const customerArg = z.object({ kind: z.enum(["contact", "company"]), id: z.guid() });

/** SUB-01: a new billing of a contact or a company; the lines are added on its page. */
export async function createBillingAction(orgId: string, customer: unknown, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(customerArg, customer)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, customer.id);
  if (!context.ok) return context;
  const parsed = newBillingSchema.safeParse(pick(formData, NEW_BILLING_FIELDS));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const { data, error } = await context.supabase
    .from("recurring_billings")
    .insert({
      organization_id: orgId,
      contact_id: customer.kind === "contact" ? customer.id : null,
      company_id: customer.kind === "company" ? customer.id : null,
      name: input.name,
      cycle: input.cycle,
      start_date: input.start_date,
      billing_day: input.billing_day,
      end_date: input.end_date,
      commitment_months: input.commitment_months,
    })
    .select("id")
    .single();
  if (error) return fail(writeError(error), { values: formValues(formData) });
  redirect(recurringBillingPath(orgId, data.id));
}

/** SUB-03: one click from a won deal with recurring lines. */
export async function createBillingFromDealAction(orgId: string, dealId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, dealId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("recurring_billing_from_deal", { p_org: orgId, p_deal: dealId });
  if (error) return fail(writeError(error));
  const made = data as { id?: unknown } | null;
  if (!made || typeof made.id !== "string" || !isUuid(made.id)) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(paths.deal(orgId, dealId));
  redirect(recurringBillingPath(orgId, made.id));
}

/** SUB-01: the name, billing day, end date and commitment (the customer, cycle and start stay as made). */
export async function updateBillingAction(orgId: string, billingId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, billingId);
  if (!context.ok) return context;
  const parsed = editBillingSchema.safeParse(pick(formData, EDIT_BILLING_FIELDS));
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("recurring_billings")
    .update(parsed.data)
    .eq("organization_id", orgId)
    .eq("id", billingId)
    .select("id, contact_id, company_id");
  if (error) return fail(writeError(error), { values: formValues(formData) });
  if (data.length === 0) return fail(CANNOT_EDIT, { values: formValues(formData) });
  revalidateBilling(orgId, billingId, { contactId: data[0].contact_id, companyId: data[0].company_id });
  return ok(undefined, "החיוב עודכן.");
}

async function setStatus(orgId: string, billingId: string, patch: { status: "active" | "paused" | "cancelled"; cancel_reason?: string }): Promise<ActionResult> {
  const context = await actionContext(orgId, billingId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("recurring_billings")
    .update(patch)
    .eq("organization_id", orgId)
    .eq("id", billingId)
    .select("id, contact_id, company_id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateBilling(orgId, billingId, { contactId: data[0].contact_id, companyId: data[0].company_id });
  return ok();
}

/** SUB-04: pause an active billing (no cycle is made while paused). */
export async function pauseBillingAction(orgId: string, billingId: string): Promise<ActionResult> {
  return setStatus(orgId, billingId, { status: "paused" });
}

/**
 * SUB-04, owner (353) ג: resume a paused or failed billing. The person chooses: go on from the next billing date (the missed
 * cycles are not made), or make up every missed cycle (the job then makes each one with its task and draft order).
 */
export async function resumeBillingAction(orgId: string, billingId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const choice = formData.get("make_up");
  if (choice !== "yes" && choice !== "no") return fail("יש לבחור מה לעשות עם המחזורים שעברו.", { fieldErrors: { make_up: "יש לבחור אפשרות." } });
  const context = await actionContext(orgId, billingId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("recurring_billing_resume", { p_org: orgId, p_billing: billingId, p_make_up: choice === "yes" });
  if (error) return fail(writeError(error));
  if (data !== true) return fail(CANNOT_EDIT);
  revalidateBilling(orgId, billingId);
  return ok(undefined, choice === "yes" ? "החיוב חודש. המחזורים שעברו ייווצרו בדקות הקרובות." : "החיוב חודש.");
}

/** SUB-04: cancel with a reason; a cancelled billing never changes again. */
export async function cancelBillingAction(orgId: string, billingId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = cancelSchema.safeParse(pick(formData, ["reason"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const result = await setStatus(orgId, billingId, { status: "cancelled", cancel_reason: parsed.data.reason });
  return result.ok ? ok(undefined, "החיוב בוטל.") : { ...result, values: formValues(formData) };
}

/**
 * SUB-01: a line from the catalog (an empty price takes the automatic price, PL-03: the customer's price list, else the
 * product's price, in the billing's VAT mode) or a free line. The change applies from the next cycle.
 */
export async function addBillingLineAction(orgId: string, billingId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, billingId);
  if (!context.ok) return context;
  const parsed = dealLineSchema.safeParse(pick(formData, DEAL_LINE_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const input = parsed.data;
  const values = formValues(formData);
  const [{ data: billing, error }, { data: org, error: orgError }] = await Promise.all([
    context.supabase.from("recurring_billings").select("contact_id, company_id, prices_include_vat").eq("organization_id", orgId).eq("id", billingId).maybeSingle(),
    context.supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
  ]);
  if (error || orgError) return fail(dbErrorMessage((error ?? orgError)!), { values });
  if (!billing || !org) return fail(NOT_FOUND_OR_FORBIDDEN, { values });

  let price: { agorot: number; source: "product" | "price_list" | "manual"; listId: string | null };
  if (input.productId) {
    const product = await readPricedProduct(context.supabase, orgId, input.productId);
    if (!product || !product.offerable) return fail(PRODUCT_GONE, { fieldErrors: { product_id: PRODUCT_GONE }, values });
    if (input.unitPriceAgorot === null) {
      const pricing = await readDealPricing(
        context.supabase,
        orgId,
        { contactId: billing.contact_id, companyId: billing.company_id },
        [{ priceIncludesVat: billing.prices_include_vat }],
        org.timezone,
      );
      const tiers = pricing.list ? await priceListTiers(context.supabase, orgId, pricing.list.id, [product.id]) : [];
      const pulled = pulledPrice(product, pricing.list ? { ...pricing.list, lines: tiers } : null, input.quantity, pricing.day, billing.prices_include_vat, pricing.rateBp);
      price = { agorot: pulled.priceAgorot, source: pulled.source, listId: pulled.priceListId };
    } else {
      price = { agorot: input.unitPriceAgorot, source: "manual", listId: null };
    }
  } else {
    if (input.unitPriceAgorot === null) return fail(PRICE_MISSING, { fieldErrors: { unit_price: PRICE_MISSING }, values });
    price = { agorot: input.unitPriceAgorot, source: "manual", listId: null };
  }
  const { data: last, error: lastError } = await context.supabase
    .from("recurring_billing_lines")
    .select("position")
    .eq("organization_id", orgId)
    .eq("billing_id", billingId)
    .order("position", { ascending: false })
    .limit(1);
  if (lastError) return fail(dbErrorMessage(lastError), { values });
  const position = Math.min((last?.[0]?.position ?? 0) + 1, 100000);
  const { error: insertError } = await context.supabase.from("recurring_billing_lines").insert({
    organization_id: orgId,
    billing_id: billingId,
    position,
    product_id: input.productId,
    description: input.description,
    quantity: input.quantity,
    unit_price_agorot: price.agorot,
    discount_bp: input.discountBp,
    discount_agorot: input.discountAgorot,
    ...(input.productId === null ? { vat_exempt: input.vatExempt ?? false } : {}),
    price_source: price.source,
    price_list_id: price.listId,
  });
  if (insertError) return fail(writeError(insertError), { values });
  revalidateBilling(orgId, billingId, { contactId: billing.contact_id, companyId: billing.company_id });
  return ok(undefined, "השורה נוספה. השינוי חל מהמחזור הבא.");
}

/** SUB-04: a line removed; the change applies from the next cycle. */
export async function deleteBillingLineAction(orgId: string, billingId: string, lineId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, billingId, lineId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("recurring_billing_lines")
    .delete()
    .eq("organization_id", orgId)
    .eq("billing_id", billingId)
    .eq("id", lineId)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateBilling(orgId, billingId);
  return ok();
}

const cycleStatusArg = z.enum(["due", "skipped"]);

/** SUB-02: name the document recorded for a cycle (DOC-01), which closes its task. */
export async function linkCycleDocumentAction(orgId: string, billingId: string, cycleId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, billingId, cycleId);
  if (!context.ok) return context;
  const raw = formData.get("document_id");
  const documentId = typeof raw === "string" && raw !== "" ? raw : null;
  if (documentId !== null && !isUuid(documentId)) return fail(INVALID_ARGS);
  const { data, error } = await context.supabase
    .from("recurring_billing_cycles")
    .update({ accounting_document_id: documentId })
    .eq("organization_id", orgId)
    .eq("billing_id", billingId)
    .eq("id", cycleId)
    .select("id");
  if (error) return fail(writeError(error), { values: formValues(formData) });
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateBilling(orgId, billingId);
  return ok(undefined, documentId ? "המסמך שויך למחזור." : "השיוך הוסר.");
}

/** SUB-02: a cycle with no document to issue (a free month), or back to waiting. */
export async function setCycleStatusAction(orgId: string, billingId: string, cycleId: string, status: unknown): Promise<ActionResult> {
  if (!validArg(cycleStatusArg, status)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, billingId, cycleId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("recurring_billing_cycles")
    .update({ status })
    .eq("organization_id", orgId)
    .eq("billing_id", billingId)
    .eq("id", cycleId)
    .select("id");
  if (error) return fail(writeError(error));
  if (data.length === 0) return fail(CANNOT_EDIT);
  revalidateBilling(orgId, billingId);
  return ok();
}
