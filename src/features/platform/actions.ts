"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { fail, formValues, type FormState } from "@/lib/action-result";
import { getSessionUser } from "@/lib/auth";
import type { Json, OrgStatus } from "@/lib/database.types";
import { SESSION_EXPIRED } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

const ORG_STATUSES = ["trial", "active", "past_due", "read_only", "suspended", "cancelled"] as const;

/** Errors of the platform functions in plain Hebrew. */
function platformError(error: { code?: string; hint?: string; message?: string }): string {
  if (error.code === "42501") return "אין לך הרשאה לפעולה הזו, או שהאימות הדו-שלבי פג. התחברו מחדש ונסו שוב.";
  if (error.hint === "platform:last_owner") return "אי אפשר להסיר את בעל הפלטפורמה האחרון.";
  if (error.code === "P0002") return error.message?.includes("email") ? "אין משתמש עם האימייל הזה. הוא צריך להירשם קודם." : "לא נמצא.";
  if (error.code === "22023") return "הנתונים אינם תקינים. בדקו את השדות ונסו שוב.";
  return "הפעולה נכשלה. נסו שוב.";
}

async function client() {
  if (!(await getSessionUser())) return null;
  return createClient();
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

function parseJsonObject(raw: string): Json | null {
  if (raw === "") return {};
  try {
    const value = JSON.parse(raw) as Json;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function updateSubscriptionAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(orgId)) return fail(SESSION_EXPIRED);
  const seatsText = text(formData, "seats");
  const trialText = text(formData, "trial_ends_on");
  const seats = seatsText === "" ? null : Number(seatsText);
  if (seats !== null && (!Number.isInteger(seats) || seats < 1 || seats > 10_000)) {
    return fail("מספר המושבים אינו תקין.", { values: formValues(formData) });
  }
  if (trialText !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(trialText)) {
    return fail("התאריך אינו תקין.", { values: formValues(formData) });
  }
  const { error } = await supabase.rpc("platform_update_subscription", {
    p_org: orgId,
    p_plan_key: text(formData, "plan_key"),
    p_seats: seats,
    // end of that day in Israel
    p_trial_ends_at: trialText === "" ? null : new Date(`${trialText}T23:59:59+03:00`).toISOString(),
    p_reason: text(formData, "reason"),
  });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminOrg(orgId));
  return { ok: true, message: "נשמר." };
}

export async function setOverridesAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(orgId)) return fail(SESSION_EXPIRED);
  const limits = parseJsonObject(text(formData, "limits"));
  const features = parseJsonObject(text(formData, "features"));
  if (limits === null || features === null) {
    return fail('יש לכתוב JSON של אובייקט, למשל {"max_users": 50}.', { values: formValues(formData) });
  }
  const { error } = await supabase.rpc("platform_set_overrides", { p_org: orgId, p_limits: limits, p_features: features, p_reason: text(formData, "reason") });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminOrg(orgId));
  return { ok: true, message: "נשמר." };
}

export async function setOrgStatusAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(orgId)) return fail(SESSION_EXPIRED);
  const status = z.enum(ORG_STATUSES).safeParse(text(formData, "status"));
  if (!status.success) return fail("יש לבחור מצב.", { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_set_org_status", { p_org: orgId, p_status: status.data as OrgStatus, p_reason: text(formData, "reason") });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminOrg(orgId));
  return { ok: true, message: "נשמר." };
}

const shekels = (value: string) => {
  const n = Number(value.replace(/[,₪\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

export async function updatePlanAction(planKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const monthly = shekels(text(formData, "price_monthly"));
  const annual = shekels(text(formData, "price_annual"));
  const limits = parseJsonObject(text(formData, "limits"));
  const features = parseJsonObject(text(formData, "features"));
  if (monthly === null || annual === null) return fail("המחיר אינו תקין.", { values: formValues(formData) });
  if (limits === null || features === null) return fail("המגבלות והיכולות צריכות להיות JSON של אובייקט.", { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_update_plan", {
    p_key: planKey,
    p_name_he: text(formData, "name_he"),
    p_price_monthly_agorot: monthly,
    p_price_annual_agorot: annual,
    p_limits: limits,
    p_features: features,
    p_is_public: formData.get("is_public") === "on",
  });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminPlans);
  return { ok: true, message: "נשמר." };
}

export async function setStaffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const role = z.enum(["owner", "support", "finance", "readonly", "remove"]).safeParse(text(formData, "role"));
  const email = z.email().safeParse(text(formData, "email"));
  if (!role.success || !email.success) return fail("יש להזין אימייל ולבחור תפקיד.", { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_set_staff", { p_email: email.data, p_role: role.data === "remove" ? null : role.data });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminStaff);
  return { ok: true, message: "נשמר." };
}

/** Support opens a customer's organization (read-only). Logged on both sides. */
export async function openSupportAction(orgId: string): Promise<{ ok: false; message: string }> {
  const supabase = await client();
  if (!supabase || !isUuid(orgId)) return fail(SESSION_EXPIRED);
  const { error } = await supabase.rpc("platform_open_support", { p_org: orgId });
  if (error) {
    return fail(error.hint === "platform:no_grant" ? "הלקוח לא אישר גישת תמיכה, או שהאישור פג." : platformError(error));
  }
  redirect(paths.org(orgId));
}
