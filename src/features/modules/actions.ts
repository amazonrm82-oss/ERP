"use server";

import { revalidatePath } from "next/cache";

import { saveTerms } from "@/features/terminology/save";
import { actionContext } from "@/lib/action-context";
import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים להפעיל ולכבות מודולים.";

type ModuleValues = { leads_enabled: boolean; companies_enabled: boolean; orders_enabled?: boolean };

/**
 * LEAD-08: saves the module switches with the user's session (owners and admins of a writable business). ORD-01: the
 * orders switch is sent only while the form shows it (the plan has the `orders` key); otherwise its value is kept.
 */
export async function saveModulesAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  // a checkbox that is not ticked is not sent at all: absent = off
  const values: ModuleValues = { leads_enabled: formData.get("leads_enabled") === "on", companies_enabled: formData.get("companies_enabled") === "on" };
  if (formData.get("orders_shown") === "1") values.orders_enabled = formData.get("orders_enabled") === "on";
  const supabase = context.supabase;
  const result = await saveTerms<ModuleValues>(
    {
      update: (org, v) => supabase.from("org_modules").update(v).eq("organization_id", org).select("id"),
      insert: (org, v) => supabase.from("org_modules").insert({ organization_id: org, ...v }).select("id"),
    },
    orgId,
    values,
  );
  if (!result.ok) return fail(result.error?.code === "42501" ? NOT_ADMIN : dbErrorMessage(result.error));
  // the menu, the "+" menu and many screens follow the switches
  revalidatePath(`/o/${orgId}`, "layout");
  return { ok: true, message: "ההגדרה נשמרה. התפריט והמסכים מתעדכנים בהתאם." };
}

const OFFER_FAILED = "לא הצלחנו לשמור. נסו שוב.";

/**
 * ORD-01 (owner, 19 October 2026): the one-time offer shown when a quote is accepted. "Switch on" turns the orders module on;
 * "not now" closes the offer for the whole business. Either way the offer does not come back. Owners and admins only (RLS).
 */
export async function answerOrdersOfferAction(orgId: string, switchOn: unknown): Promise<ActionResult> {
  if (!validArg(booleanArg, switchOn)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const supabase = context.supabase;
  const values = { orders_offer_closed_at: new Date().toISOString(), ...(switchOn ? { orders_enabled: true } : {}) };
  const result = await saveTerms<typeof values>(
    {
      update: (org, v) => supabase.from("org_modules").update(v).eq("organization_id", org).select("id"),
      insert: (org, v) => supabase.from("org_modules").insert({ organization_id: org, ...v }).select("id"),
    },
    orgId,
    values,
  );
  if (!result.ok) return fail(result.error?.code === "42501" ? NOT_ADMIN : result.error ? dbErrorMessage(result.error) : OFFER_FAILED);
  revalidatePath(`/o/${orgId}`, "layout");
  return ok();
}
