"use server";

import { revalidatePath } from "next/cache";

import { fail, formValues, type ActionResult, type FormState } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { isCalendarDate } from "@/lib/calendar-date";
import { SESSION_EXPIRED } from "@/lib/errors";
import { zonedIso, zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { BANNER_MAX_LENGTH, BANNER_MAX_ORGS, bannerText, parseOrgIds } from "./banners";
import { addDays } from "./subprocessors";

function bannerError(error: { code?: string }): string {
  if (error.code === "42501") return "אין לכם הרשאה לפעולה הזו, או שהאימות הדו-שלבי פג. התחברו מחדש ונסו שוב.";
  if (error.code === "22023") return "הנתונים אינם תקינים: בדקו את הטקסט, התאריכים, העסקים או החבילה.";
  if (error.code === "P0002") return "ההודעה לא נמצאה.";
  return "הפעולה נכשלה. נסו שוב.";
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/**
 * ADM-04: the platform owner or support adds a banner. Days are in Israel time: it shows from the start day's
 * beginning (or now) until the end of the end day.
 */
export async function addBannerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const values = formValues(formData);
  const body = bannerText(text(formData, "body"));
  if (body === "" || body.length > BANNER_MAX_LENGTH) return fail(`יש לכתוב הודעה של עד ${BANNER_MAX_LENGTH} תווים.`, { values });
  const severity = text(formData, "severity");
  if (severity !== "info" && severity !== "warning") return fail("יש לבחור סוג הודעה.", { values });
  const today = zoneDate(new Date());
  const startDay = text(formData, "starts_on") || today;
  const endDay = text(formData, "ends_on");
  if (!isCalendarDate(startDay) || startDay < today) return fail("תאריך ההתחלה צריך להיות היום או אחריו.", { values });
  if (!isCalendarDate(endDay) || endDay < startDay) return fail("יש לבחור תאריך סיום, לא לפני תאריך ההתחלה.", { values });
  if (endDay > addDays(startDay, 365)) return fail("הודעה מוצגת עד שנה לכל היותר.", { values });

  const target = text(formData, "target");
  let orgs: string[] | null = null;
  let plan: string | null = null;
  if (target === "orgs") {
    const parsed = parseOrgIds(text(formData, "orgs"));
    if (parsed.rest !== "") return fail("ברשימת העסקים יש טקסט שאינו מזהה עסק. הדביקו מזהים מכרטיסי העסקים.", { values });
    if (parsed.ids.length === 0 || parsed.ids.length > BANNER_MAX_ORGS) return fail(`יש לרשום בין 1 ל-${BANNER_MAX_ORGS} עסקים.`, { values });
    orgs = parsed.ids;
  } else if (target === "plan") {
    plan = text(formData, "plan");
    if (plan === "") return fail("יש לבחור חבילה.", { values });
  } else if (target !== "all") {
    return fail("יש לבחור למי ההודעה.", { values });
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_add_system_banner", {
    p_body: body,
    p_severity: severity,
    p_dismissable: severity === "info" || formData.get("dismissable") === "on",
    p_starts_at: startDay === today ? null : zonedIso(startDay, "00:00"),
    p_ends_at: zonedIso(addDays(endDay, 1), "00:00"),
    p_target_kind: target,
    p_orgs: orgs,
    p_plan: plan,
  });
  if (error) return fail(bannerError(error), { values });
  revalidatePath(paths.adminBanners);
  return { ok: true, message: "ההודעה נשמרה." };
}

/** ADM-04: ends a banner now; it disappears on the next page load. */
export async function endBannerAction(bannerId: string): Promise<ActionResult> {
  if (!isUuid(bannerId) || !(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_end_system_banner", { p_id: bannerId });
  if (error) return fail(bannerError(error));
  revalidatePath(paths.adminBanners);
  return { ok: true, message: "ההודעה הוסרה." };
}
