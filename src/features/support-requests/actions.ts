"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { isSupportCategory, SUPPORT_MESSAGE_MAX, SUPPORT_SUBJECT_MAX, validPagePath } from "./categories";

const NOT_MEMBER = "אי אפשר לשלוח פנייה מהעסק הזה. בדקו שאתם מחוברים לעסק הנכון.";

/** USR-12: a person sends a support request from inside the business (with their session; the database names them). */
export async function sendSupportRequestAction(orgId: string, _prev: FormState<number>, formData: FormData): Promise<FormState<number>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const values = formValues(formData);
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const category = text("category");
  const subject = text("subject");
  const message = text("message");
  const page = formData.get("include_page") === "on" ? text("page_path") : "";
  const fieldErrors: Record<string, string> = {};
  if (!isSupportCategory(category)) fieldErrors.category = "יש לבחור נושא.";
  if (subject === "" || subject.length > SUPPORT_SUBJECT_MAX) fieldErrors.subject = `יש לכתוב כותרת של עד ${SUPPORT_SUBJECT_MAX} תווים.`;
  if (message === "" || message.length > SUPPORT_MESSAGE_MAX) fieldErrors.message = `יש לכתוב הודעה של עד ${SUPPORT_MESSAGE_MAX.toLocaleString("he-IL")} תווים.`;
  if (Object.keys(fieldErrors).length > 0) return fail("יש לתקן את השדות המסומנים.", { fieldErrors, values });

  const { error } = await context.supabase.from("support_requests").insert({
    organization_id: orgId,
    category,
    subject,
    message,
    // a page that does not fit is left out, never sent half
    page_path: page !== "" && validPagePath(page) ? page : null,
  });
  if (error) return fail(error.code === "42501" ? NOT_MEMBER : dbErrorMessage(error), { values });
  revalidatePath(paths.support(orgId));
  return { ok: true, message: "הפנייה נשלחה לצוות התמיכה. נעדכן אתכם כאן ובהתראה כשהיא תטופל.", data: Date.now() };
}
