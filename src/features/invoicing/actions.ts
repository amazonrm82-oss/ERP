"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { invoicingSettingsPath } from "./paths";
import { invoiceProviderFor } from "./providers/select";
import { ISSUABLE_DOCUMENT_TYPES } from "./providers/types";

// DOC-05: the invoice provider's connection and defaults, with the user's own session. The database decides who may (owners
// and admins of a writable business); a provider the deployment does not offer refuses everything.

const UNAVAILABLE = "ספק החשבוניות לא זמין כרגע.";
const CHECK_FAILED = "הספק לא אישר את החיבור. בדקו את פרטי החשבון אצל הספק ונסו שוב.";
const SAVE_FAILED = "לא הצלחנו לשמור. נסו שוב.";

async function providerCheck(): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const provider = invoiceProviderFor();
  if (!provider) return { ok: false, message: UNAVAILABLE };
  try {
    const checked = await provider.checkConnection();
    return checked.ok ? { ok: true, name: provider.name } : { ok: false, message: CHECK_FAILED };
  } catch {
    return { ok: false, message: CHECK_FAILED };
  }
}

/** DOC-05: connect the business to the provider this deployment offers, after the provider's own check passed. */
export async function connectInvoiceProviderAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const checked = await providerCheck();
  if (!checked.ok) return fail(checked.message);
  const { error } = await context.supabase.rpc("invoice_provider_connect", { p_org: orgId, p_provider: checked.name });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(invoicingSettingsPath(orgId));
  return { ok: true, message: "העסק מחובר לספק החשבוניות." };
}

/** DOC-05: "test the connection": the provider's check again, and its result recorded. */
export async function testInvoiceConnectionAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const checked = await providerCheck();
  const { error } = await context.supabase.rpc("invoice_provider_check_recorded", { p_org: orgId, p_ok: checked.ok });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(invoicingSettingsPath(orgId));
  return checked.ok ? { ok: true, message: "החיבור עובד." } : fail(checked.message);
}

export async function disconnectInvoiceProviderAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("invoice_provider_disconnect", { p_org: orgId });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(invoicingSettingsPath(orgId));
  return { ok: true, message: "החיבור לספק נותק. מסמכים שכבר הופקו נשארים במערכת." };
}

const defaultsSchema = z.object({
  default_doc_type: z.enum(ISSUABLE_DOCUMENT_TYPES, "יש לבחור סוג מסמך."),
  locale: z.enum(["he", "en"], "יש לבחור שפה."),
  provider_sends_email: z.string().optional().transform((value) => value === "on"),
});

/** DOC-05: the defaults (owners and admins of a writable business, RLS; 0 rows = not permitted). */
export async function saveInvoiceDefaultsAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = defaultsSchema.safeParse(pick(formData, ["default_doc_type", "locale", "provider_sends_email"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = parsed.data;
  const update = () => context.supabase.from("invoice_provider_settings").update(values).eq("organization_id", orgId).select("id");
  let { data, error } = await update();
  if (!error && (data?.length ?? 0) === 0) {
    const inserted = await context.supabase.from("invoice_provider_settings").insert({ organization_id: orgId, ...values }).select("id");
    if (inserted.error?.code === "23505") {
      ({ data, error } = await update());
    } else if (inserted.error?.code === "42501") {
      data = [];
      error = null;
    } else {
      ({ data, error } = inserted);
    }
  }
  if (error) return fail(dbErrorMessage(error, SAVE_FAILED), { values: formValues(formData) });
  if ((data?.length ?? 0) === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  revalidatePath(invoicingSettingsPath(orgId));
  return { ok: true, message: "ברירות המחדל נשמרו." };
}

/** A request that never finished, marked unrecorded (its requester, or an owner/admin). */
export async function closeIssueRequestAction(orgId: string, requestId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, requestId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("invoice_issue_close", { p_org: orgId, p_request: requestId });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(invoicingSettingsPath(orgId));
  // a request that may exist at the provider (listed as "check"): closed once someone checked there
  if (data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).code === "checked") {
    return { ok: true, message: "הבקשה נסגרה. המערכת לא תפנה לספק שוב בבקשה הזאת." };
  }
  return {
    ok: true,
    message: "הבקשה נסגרה ולא תופק. אם ניסיון קודם כבר הגיע לספק, המערכת רק תבדוק אצל הספק אם המסמך הופק (בלי להפיק מסמך חדש), ואם כן תרשום אותו כאן או תשלח הודעה.",
  };
}
