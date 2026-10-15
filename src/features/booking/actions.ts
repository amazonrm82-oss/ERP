"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import type { BookingPageInsert, Json } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { bookingPagesPath } from "./paths";
import { BOOKING_FIELD_NAMES, bookingPageSchema, questionsFromForm } from "./schema";

// CAL-10: each person manages their own booking pages, owners and admins all of them (RLS decides; 0 rows / 42501).

/** A new question id: short, unique enough within one page, and fixed once saved. */
function newQuestionId(): string {
  return `q${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** The form's fields as a row; the rep is the user unless an admin picked someone. */
function parsePage(formData: FormData, userId: string) {
  const parsed = bookingPageSchema.safeParse(pick(formData, BOOKING_FIELD_NAMES));
  if (!parsed.success) {
    return { ok: false as const, state: invalid(parsed.error, formData) };
  }
  const questions = questionsFromForm(formData, newQuestionId);
  if (!questions.ok) {
    return { ok: false as const, state: fail(questions.message, { values: formValues(formData) }) };
  }
  const { user_id, ...rest } = parsed.data;
  const row: Omit<BookingPageInsert, "organization_id"> = { ...rest, user_id: user_id ?? userId, questions: questions.questions as unknown as Json };
  return { ok: true as const, row };
}

export async function addBookingPageAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = parsePage(formData, context.user.id);
  if (!parsed.ok) {
    return parsed.state;
  }
  const { error } = await context.supabase.from("booking_pages").insert({ organization_id: orgId, ...parsed.row });
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את הדף. נסו שוב."), { values: formValues(formData) });
  }
  revalidatePath(bookingPagesPath(orgId));
  return { ok: true, message: "הדף נוצר." };
}

export async function updateBookingPageAction(orgId: string, pageId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, pageId);
  if (!context.ok) {
    return context;
  }
  const parsed = parsePage(formData, context.user.id);
  if (!parsed.ok) {
    return parsed.state;
  }
  // the rep changes only when the form had the field (an admin's form)
  const row: Partial<Omit<BookingPageInsert, "organization_id">> = { ...parsed.row };
  if (!formData.has("user_id")) delete row.user_id;
  const { data, error } = await context.supabase.from("booking_pages").update(row).eq("organization_id", orgId).eq("id", pageId).select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור. נסו שוב."), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(bookingPagesPath(orgId));
  return { ok: true, message: "הדף נשמר." };
}

/** Meetings already booked through the page stay; only the page and its link go. */
export async function deleteBookingPageAction(orgId: string, pageId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, pageId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("booking_pages").delete().eq("organization_id", orgId).eq("id", pageId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(bookingPagesPath(orgId));
  return ok();
}
