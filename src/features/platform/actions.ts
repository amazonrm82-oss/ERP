"use server";

import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { fail, formValues, type ActionResult, type FormState } from "@/lib/action-result";
import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { sessionCheck } from "@/lib/auth";
import type { OrgStatus } from "@/lib/database.types";
import { dbErrorMessage, SESSION_EXPIRED, SUBPROCESSOR_IN_FORCE, SUBPROCESSOR_NOTICE, VAT_RATE_FUTURE_ONLY } from "@/lib/errors";
import { zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { IDENTITY_CHECKS } from "./labels";
import { parsePlanJson } from "./plan-json";
import { collapseSpaces, firstNoticeDay, normalizeWebsite, SUBPROCESSORS_CACHE_TAG } from "./subprocessors";
import { isFutureVatDay, parseVatPercent } from "./vat-rates";
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
  if (!(await sessionCheck()).ok) return null;
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
    // is_public follows the plan's availability (migration plan_pricing); this value is overruled
    p_is_public: true,
  });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminPlans);
  return { ok: true, message: "נשמר." };
}

export async function setPlanAvailabilityAction(planKey: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const availability = z.enum(["hidden", "coming_soon", "available"]).safeParse(text(formData, "availability"));
  if (!availability.success) return fail("יש לבחור מצב.", { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_set_plan_availability", { p_key: planKey, p_availability: availability.data });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminPlans);
  return { ok: true, message: "נשמר." };
}

/** BIL-08: the platform owner turns the trial-end transition on or off (logged in the database). */
export async function setTrialEndAction(enabled: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, enabled)) return fail(INVALID_ARGS);
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const { error } = await supabase.rpc("platform_set_trial_end", { p_enabled: enabled });
  if (error) return fail(platformError(error));
  revalidatePath(paths.adminPlans);
  return { ok: true };
}

/** BIL-09: the platform owner turns the cancel-after-suspension stage on or off (logged in the database). */
export async function setSuspensionCancelAction(enabled: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, enabled)) return fail(INVALID_ARGS);
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const { error } = await supabase.rpc("platform_set_suspension_cancel", { p_enabled: enabled });
  if (error) return fail(platformError(error));
  revalidatePath(paths.adminPlans);
  return { ok: true };
}

/** The platform owner turns the new-lead notices of suspended businesses on or off (logged in the database). */
export async function setSuspendedLeadNoticesAction(enabled: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, enabled)) return fail(INVALID_ARGS);
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const { error } = await supabase.rpc("platform_set_suspended_lead_notices", { p_enabled: enabled });
  if (error) return fail(platformError(error));
  revalidatePath(paths.adminPlans);
  return { ok: true };
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

/** ADM-01: the fields of a VAT rate form, checked before the database checks them again. */
function vatRateFields(formData: FormData): { ok: true; day: string; rateBp: number; note: string | null } | { ok: false; message: string } {
  const day = text(formData, "effective_from");
  const rateBp = parseVatPercent(text(formData, "rate"));
  const note = text(formData, "note");
  if (!isCalendarDate(day)) return { ok: false, message: "יש לבחור תאריך תחילה." };
  if (!isFutureVatDay(day, zoneDate(new Date()))) return { ok: false, message: VAT_RATE_FUTURE_ONLY };
  if (rateBp === null) return { ok: false, message: "השיעור צריך להיות מספר בין 0 ל-100, עם עד שתי ספרות אחרי הנקודה." };
  if (note.length > 200) return { ok: false, message: "ההערה ארוכה מדי (עד 200 תווים)." };
  return { ok: true, day, rateBp, note: note === "" ? null : note };
}

/** ADM-01: the platform owner adds a VAT rate that starts on a future day (logged in the database). */
export async function addVatRateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const fields = vatRateFields(formData);
  if (!fields.ok) return fail(fields.message, { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_add_vat_rate", { p_effective_from: fields.day, p_rate_bp: fields.rateBp, p_note: fields.note });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminVat);
  return { ok: true, message: "השיעור נוסף." };
}

/** ADM-01: corrects a VAT rate that has not started yet. */
export async function updateVatRateAction(rateId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(rateId)) return fail(SESSION_EXPIRED);
  const fields = vatRateFields(formData);
  if (!fields.ok) return fail(fields.message, { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_update_vat_rate", { p_id: rateId, p_effective_from: fields.day, p_rate_bp: fields.rateBp, p_note: fields.note });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminVat);
  return { ok: true, message: "נשמר." };
}

/** ADM-01: removes a VAT rate that has not started yet (the row is marked cancelled). */
export async function removeVatRateAction(rateId: string): Promise<ActionResult> {
  const supabase = await client();
  if (!supabase || !isUuid(rateId)) return fail(SESSION_EXPIRED);
  const { error } = await supabase.rpc("platform_remove_vat_rate", { p_id: rateId });
  if (error) return fail(platformError(error));
  revalidatePath(paths.adminVat);
  return { ok: true };
}

type SubprocessorFields = {
  name: string;
  purpose: string;
  data: string;
  location: string | null;
  website: string | null;
  day: string;
};

/** ADM-01: the fields of a subprocessor form, checked before the database checks them again. */
function subprocessorFields(formData: FormData): { ok: true; fields: SubprocessorFields } | { ok: false; message: string } {
  const name = collapseSpaces(text(formData, "name"));
  const purpose = collapseSpaces(text(formData, "purpose"));
  const data = collapseSpaces(text(formData, "data_categories"));
  const location = collapseSpaces(text(formData, "location"));
  const website = normalizeWebsite(text(formData, "website"));
  const day = text(formData, "effective_from");
  if (name === "" || name.length > 120) return { ok: false, message: "יש למלא שם (עד 120 תווים)." };
  if (purpose === "" || purpose.length > 500) return { ok: false, message: "יש למלא תפקיד (עד 500 תווים)." };
  if (data === "" || data.length > 500) return { ok: false, message: "יש למלא איזה מידע הספק רואה (עד 500 תווים)." };
  if (location.length > 120) return { ok: false, message: "המיקום ארוך מדי (עד 120 תווים)." };
  if (website === undefined) return { ok: false, message: "כתובת האתר צריכה להתחיל ב-https://, בלי רווחים." };
  if (!isCalendarDate(day)) return { ok: false, message: "יש לבחור תאריך תחילה." };
  return { ok: true, fields: { name, purpose, data, location: location === "" ? null : location, website, day } };
}

const subprocessorArgs = (f: SubprocessorFields) => ({
  p_name: f.name,
  p_purpose: f.purpose,
  p_data_categories: f.data,
  p_location: f.location,
  p_website: f.website,
  p_effective_from: f.day,
});

/** ADM-01: the platform owner adds a subprocessor from a day at least 14 days ahead; business owners are told (database). */
export async function addSubprocessorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase) return fail(SESSION_EXPIRED);
  const checked = subprocessorFields(formData);
  if (!checked.ok) return fail(checked.message, { values: formValues(formData) });
  if (checked.fields.day < firstNoticeDay(zoneDate(new Date()))) return fail(SUBPROCESSOR_NOTICE, { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_add_subprocessor", subprocessorArgs(checked.fields));
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminSubprocessors);
  updateTag(SUBPROCESSORS_CACHE_TAG);
  revalidatePath(paths.legal("subprocessors"));
  return { ok: true, message: "קבלן המשנה נוסף, ובעלי העסקים קיבלו הודעה." };
}

/**
 * ADM-01: corrects an entry that has not started (a new name or day needs 14 days again and is announced again),
 * or fills a missing location or website of one in force. The database refuses anything else.
 */
export async function updateSubprocessorAction(entryId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(entryId)) return fail(SESSION_EXPIRED);
  const checked = subprocessorFields(formData);
  if (!checked.ok) return fail(checked.message, { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_update_subprocessor", { p_id: entryId, ...subprocessorArgs(checked.fields) });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminSubprocessors);
  updateTag(SUBPROCESSORS_CACHE_TAG);
  revalidatePath(paths.legal("subprocessors"));
  return { ok: true, message: "נשמר." };
}

/** ADM-01: removes an entry that has not started (marked cancelled, never deleted). */
export async function removeSubprocessorAction(entryId: string): Promise<ActionResult> {
  const supabase = await client();
  if (!supabase || !isUuid(entryId)) return fail(SESSION_EXPIRED);
  const { error } = await supabase.rpc("platform_remove_subprocessor", { p_id: entryId });
  if (error) return fail(platformError(error));
  revalidatePath(paths.adminSubprocessors);
  updateTag(SUBPROCESSORS_CACHE_TAG);
  revalidatePath(paths.legal("subprocessors"));
  return { ok: true };
}

/** ADM-01: sets, moves or clears (empty field) the future end day of an entry. */
export async function endSubprocessorAction(entryId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const supabase = await client();
  if (!supabase || !isUuid(entryId)) return fail(SESSION_EXPIRED);
  const day = text(formData, "ends_on");
  if (day !== "" && !isCalendarDate(day)) return fail("התאריך אינו תקין.", { values: formValues(formData) });
  if (day !== "" && day <= zoneDate(new Date())) return fail(SUBPROCESSOR_IN_FORCE, { values: formValues(formData) });
  const { error } = await supabase.rpc("platform_end_subprocessor", { p_id: entryId, p_ends_on: day === "" ? null : day });
  if (error) return fail(platformError(error), { values: formValues(formData) });
  revalidatePath(paths.adminSubprocessors);
  updateTag(SUBPROCESSORS_CACHE_TAG);
  revalidatePath(paths.legal("subprocessors"));
  return { ok: true, message: day === "" ? "תאריך הסיום בוטל." : "תאריך הסיום נשמר." };
}
