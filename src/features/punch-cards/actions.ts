"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, formValues, ok, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { productPath } from "@/features/products/paths";

import { PUNCH_ENTRIES_MAX, PUNCH_REASON_MAX, PUNCH_VALIDITY_MAX, PUNCH_VALIDITY_UNITS } from "./balance";

// PKG-01, PKG-02: every write goes through a punch_card_* function with the user's session; the function judges rights
// first (42501) and the plan key (feature:punch_cards).

const CANNOT = "אין לכם הרשאה לפעולה הזו בכרטיסיות.";
const writeError = (error: { code?: string; message?: string; hint?: string; details?: string }) =>
  error.code === "42501" ? CANNOT : dbErrorMessage(error);

const reasonSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, { error: "כתבו נימוק." }).max(PUNCH_REASON_MAX, { error: `הנימוק ארוך מדי (עד ${PUNCH_REASON_MAX} תווים).` }));
const optionalId = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.union([z.literal(""), z.guid({ error: INVALID_ARGS })]))
  .transform((value) => (value === "" ? null : value));

function contactPage(orgId: string, contactId: string) {
  revalidatePath(paths.contact(orgId, contactId));
}

/** Open a card for the contact: with a payment it is active at once, else it waits (or an owner/admin activates it). */
export async function openPunchCardAction(orgId: string, contactId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, contactId);
  if (!context.ok) return context;
  const parsed = z
    .object({ product_id: z.guid({ error: "בחרו כרטיסייה." }), payment_id: optionalId, activate: z.string().optional() })
    .safeParse({ product_id: formData.get("product_id") ?? "", payment_id: formData.get("payment_id") ?? "", activate: formData.get("activate") ?? undefined });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? INVALID_ARGS, { fieldErrors: { product_id: "בחרו כרטיסייה." }, values: formValues(formData) });
  }
  const { error } = await context.supabase.rpc("punch_card_open", {
    p_org: orgId,
    p_contact: contactId,
    p_product: parsed.data.product_id,
    p_payment: parsed.data.payment_id,
    p_activate: parsed.data.payment_id === null && parsed.data.activate === "on",
  });
  if (error) return fail(writeError(error), { values: formValues(formData) });
  contactPage(orgId, contactId);
  return ok();
}

/** A waiting card: link a payment of the contact, or (owners/admins) activate by hand. */
export async function activatePunchCardAction(orgId: string, contactId: string, cardId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, contactId, cardId);
  if (!context.ok) return context;
  const payment = optionalId.safeParse(formData.get("payment_id") ?? "");
  if (!payment.success) return fail(INVALID_ARGS);
  const { error } = await context.supabase.rpc("punch_card_activate", { p_org: orgId, p_card: cardId, p_payment: payment.data });
  if (error) return fail(writeError(error), { values: formValues(formData) });
  contactPage(orgId, contactId);
  return ok();
}

export async function cancelPunchCardAction(orgId: string, contactId: string, cardId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, contactId, cardId);
  if (!context.ok) return context;
  const reason = reasonSchema.safeParse(formData.get("reason") ?? "");
  if (!reason.success) return fail(reason.error.issues[0].message, { fieldErrors: { reason: reason.error.issues[0].message }, values: formValues(formData) });
  const { error } = await context.supabase.rpc("punch_card_cancel", { p_org: orgId, p_card: cardId, p_reason: reason.data });
  if (error) return fail(writeError(error), { values: formValues(formData) });
  contactPage(orgId, contactId);
  return ok();
}

export async function transferPunchCardAction(orgId: string, contactId: string, cardId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, contactId, cardId);
  if (!context.ok) return context;
  const target = z.guid().safeParse(formData.get("to_contact_id") ?? "");
  if (!target.success) return fail("בחרו איש קשר.", { fieldErrors: { to_contact_id: "בחרו איש קשר." } });
  const { error } = await context.supabase.rpc("punch_card_transfer", { p_org: orgId, p_card: cardId, p_contact: target.data });
  if (error) return fail(writeError(error));
  contactPage(orgId, contactId);
  revalidatePath(paths.contact(orgId, target.data));
  return ok();
}

const settingsSchema = z
  .object({
    entries: z.coerce
      .number({ error: `מספר כניסות, מ-1 עד ${PUNCH_ENTRIES_MAX}.` })
      .int({ error: `מספר כניסות, מ-1 עד ${PUNCH_ENTRIES_MAX}.` })
      .min(1, { error: `מספר כניסות, מ-1 עד ${PUNCH_ENTRIES_MAX}.` })
      .max(PUNCH_ENTRIES_MAX, { error: `מספר כניסות, מ-1 עד ${PUNCH_ENTRIES_MAX}.` }),
    validity_count: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value === "" || (/^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= PUNCH_VALIDITY_MAX), {
        error: `תוקף, מ-1 עד ${PUNCH_VALIDITY_MAX}, או ריק בלי תוקף.`,
      })
      .transform((value) => (value === "" ? null : Number(value))),
    validity_unit: z.enum(PUNCH_VALIDITY_UNITS, { error: "בחרו ימים או חודשים." }),
    meeting_type_ids: z.array(z.guid()).max(50, { error: "אפשר לבחור עד 50 סוגי פגישה." }),
  });

/** PKG-01: a punch card product's settings (entries, validity, the meeting types it covers), on the product's page. */
export async function savePunchSettingsAction(orgId: string, productId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, productId);
  if (!context.ok) return context;
  const parsed = settingsSchema.safeParse({
    entries: formData.get("entries") ?? "",
    validity_count: formData.get("validity_count") ?? "",
    validity_unit: formData.get("validity_unit") ?? "",
    meeting_type_ids: formData.getAll("meeting_type_ids").map(String),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    return fail("יש לתקן את השדות המסומנים.", { fieldErrors, values: formValues(formData) });
  }
  const ids = [...new Set(parsed.data.meeting_type_ids)];
  const { data, error } = await context.supabase
    .from("products")
    .update({
      punch_entries: parsed.data.entries,
      punch_validity_count: parsed.data.validity_count,
      punch_validity_unit: parsed.data.validity_count === null ? null : parsed.data.validity_unit,
      punch_meeting_type_ids: ids.length ? ids : null,
    })
    .eq("organization_id", orgId)
    .eq("id", productId)
    .eq("kind", "punch_card")
    .select("id");
  if (error) return fail(dbErrorMessage(error), { values: formValues(formData) });
  if (data.length === 0) return fail("אין לכם הרשאה לערוך את המוצר, או שהוא כבר לא כרטיסייה.");
  revalidatePath(productPath(orgId, productId));
  return { ok: true, message: "הגדרות הכרטיסייה נשמרו." };
}
