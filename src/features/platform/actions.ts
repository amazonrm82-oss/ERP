"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { fail, formValues, type FormState } from "@/lib/action-result";
import { getSessionUser } from "@/lib/auth";
import type { OrgStatus } from "@/lib/database.types";
import { dbErrorMessage, SESSION_EXPIRED } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { IDENTITY_CHECKS } from "./labels";
import { parsePlanJson } from "./plan-json";
import { isCalendarDate } from "@/lib/calendar-date";

const ORG_STATUSES = ["trial", "active", "past_due", "read_only", "suspended", "cancelled"] as const;

/** Errors of the platform functions in plain Hebrew. */
function platformError(error: { code?: string; hint?: string; message?: string }): string {
  if (error.code === "42501") return "אין לכם הרשאה לפעולה הזו, או שהאימות הדו-שלבי פג. התחברו מחדש ונסו שוב.";
  if (error.hint === "platform:last_owner") return "אי אפשר להסיר את בעל הפלטפורמה האחרון.";
  if (error.code === "P0002") return error.message?.includes("email") ? "אין משתמש עם האימייל הזה. הוא צריך להירשם קודם." : "לא נמצא.";
  if (error.code === "22023") return "הנתונים אינם תקינים. בדקו את השדות ונסו שוב.";
  // hints the app already words (plan:hidden and the like)
  if (error.code === "P0001" && error.hint) return dbErrorMessage(error);
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

export async function updateSubscriptionAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(orgId)) return fail(SESSION_EXPIRED);
  const seatsText = text(formData, "seats");
  const trialText = text(formData, "trial_ends_on");
  const seats = seatsText === "" ? null : Number(seatsText);
  if (seats !== null && (!Number.isInteger(seats) || seats < 1 || seats > 10_000)) {
    return fail("מספר המושבים אינו תקין.", { values: formValues(formData) });
  }
  if (trialText !== "" && !isCalendarDate(trialText)) {
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
  const limits = parsePlanJson(text(formData, "limits"), "limits");
  if (!limits.ok) return fail(limits.message, { values: formValues(formData) });
  const features = parsePlanJson(text(formData, "features"), "features");
  if (!features.ok) return fail(features.message, { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_set_overrides", { p_org: orgId, p_limits: limits.value, p_features: features.value, p_reason: text(formData, "reason") });
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
  const limits = parsePlanJson(text(formData, "limits"), "limits");
  const features = parsePlanJson(text(formData, "features"), "features");
  if (monthly === null || annual === null) return fail("המחיר אינו תקין.", { values: formValues(formData) });
  if (!limits.ok) return fail(limits.message, { values: formValues(formData) });
  if (!features.ok) return fail(features.message, { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_update_plan", {
    p_key: planKey,
    p_name_he: text(formData, "name_he"),
    p_price_monthly_agorot: monthly,
    p_price_annual_agorot: annual,
    p_limits: limits.value,
    p_features: features.value,
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

/** Support resets two-step verification of a user who lost the authenticator and the backup codes. */
export async function platformResetMfaAction(userId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(userId)) return fail(SESSION_EXPIRED);
  const check = text(formData, "check");
  const reason = text(formData, "reason");
  if (!(check in IDENTITY_CHECKS) || reason === "") {
    return fail("יש לבחור איך זוהה המשתמש ולכתוב סיבה.", { values: formValues(formData) });
  }
  if (formData.get("confirm") !== "on") {
    return fail("יש לאשר שהזיהוי בוצע.", { values: formValues(formData) });
  }
  const { error } = await supabase.rpc("platform_reset_mfa", { p_user: userId, p_reason: reason, p_check: check });
  if (error) {
    if (error.hint === "mfa_reset:none") return fail("אימות דו-שלבי כבר לא פעיל אצל המשתמש.");
    return fail(platformError(error), { values: formValues(formData) });
  }
  revalidatePath(paths.adminUsers);
  return { ok: true, message: "האימות הדו-שלבי אופס, והמשתמש נותק מכל המכשירים. בכניסה הבאה יגדיר אימות מחדש." };
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
