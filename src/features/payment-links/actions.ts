"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { orderPath } from "@/features/orders/paths";
import { quotePath } from "@/features/quotes/paths";
import { getOrgContext } from "@/features/shell/queries";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { zoneDate } from "@/lib/format";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { paymentProviderCode } from "./providers/select";
import { PAYMENT_LINK_FIELD_NAMES, PAYMENT_LINK_SOURCE_KINDS, paymentLinkSchema, type PaymentLinkSource } from "./schema";

// LNK-02: making and cancelling a payment link, with the user's session. RLS and app.payment_links_check decide: whoever
// records payments (PAY-06), in a writable business with the keys `payments` and `payment_links`, on a source they read,
// for at most what is open there. Without a provider (owner (270) (1) א: the fake only off the live site) nothing is made.

const CANNOT = "אין לכם הרשאה ליצור קישורי תשלום כאן. יוצרים בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאת רישום תשלומים.";
const UNAVAILABLE = "קישורי תשלום עדיין לא זמינים: לא חובר ספק סליקה.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

const sourceSchema = z.object({ kind: z.enum(PAYMENT_LINK_SOURCE_KINDS), id: z.guid() });

/** The page a link's card sits on. */
function sourcePath(orgId: string, source: PaymentLinkSource): string {
  switch (source.kind) {
    case "quote":
      return quotePath(orgId, source.id);
    case "order":
      return orderPath(orgId, source.id);
    case "contact":
      return paths.contact(orgId, source.id);
    case "document":
      return `/o/${orgId}/documents`;
  }
}

/** A new link for an amount (in shekels), a maximum of instalments and a last day. */
export async function createPaymentLinkAction(orgId: string, source: PaymentLinkSource, _prev: FormState, formData: FormData): Promise<FormState> {
  if (!validArg(sourceSchema, source)) return fail(INVALID_ARGS);
  const provider = paymentProviderCode();
  if (!provider) return fail(UNAVAILABLE);
  const context = await actionContext(orgId, source.id);
  if (!context.ok) return context;
  const org = await getOrgContext(orgId);
  const parsed = paymentLinkSchema(zoneDate(new Date(), org.org.timeZone)).safeParse(pick(formData, PAYMENT_LINK_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);

  const { data, error } = await context.supabase
    .from("payment_links")
    .insert({
      organization_id: orgId,
      quote_id: source.kind === "quote" ? source.id : null,
      order_id: source.kind === "order" ? source.id : null,
      accounting_document_id: source.kind === "document" ? source.id : null,
      contact_id: source.kind === "contact" ? source.id : null,
      amount_agorot: parsed.data.amount,
      max_installments: parsed.data.max_installments,
      expires_on: parsed.data.expires_on,
      provider,
    })
    .select("id");
  if (error) return fail(writeError(error), { values: formValues(formData) });
  if (!data || data.length === 0) return fail(CANNOT, { values: formValues(formData) });
  revalidatePath(sourcePath(orgId, source));
  return { ok: true, message: "קישור התשלום נוצר." };
}

/** Cancels a pending link (never deleted; the database refuses any other change). */
export async function cancelPaymentLinkAction(orgId: string, source: PaymentLinkSource, linkId: string): Promise<ActionResult> {
  if (!validArg(sourceSchema, source)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, source.id, linkId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("payment_links")
    .update({ status: "cancelled" })
    .eq("organization_id", orgId)
    .eq("id", linkId)
    .eq("status", "pending")
    .select("id");
  if (error) return fail(writeError(error));
  if (!data || data.length === 0) return fail("הקישור כבר לא ממתין לתשלום, או שאין לכם הרשאה לבטל אותו.");
  revalidatePath(sourcePath(orgId, source));
  return ok();
}
