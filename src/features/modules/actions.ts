"use server";

import { revalidatePath } from "next/cache";

import { saveTerms } from "@/features/terminology/save";
import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים להפעיל ולכבות מודולים.";

type ModuleValues = { leads_enabled: boolean; companies_enabled: boolean };

/** LEAD-08: saves the two module switches with the user's session (owners and admins of a writable business). */
export async function saveModulesAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  // a checkbox that is not ticked is not sent at all: absent = off
  const values: ModuleValues = { leads_enabled: formData.get("leads_enabled") === "on", companies_enabled: formData.get("companies_enabled") === "on" };
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
