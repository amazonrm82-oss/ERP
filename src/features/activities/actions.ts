"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { fail, invalid, formValues, ok, type FormState } from "@/lib/action-result";
import type { ActivityInsert } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { noteSchema, subjectSchema, SUBJECT_COLUMN, type TimelineSubject } from "./schema";

function subjectPath(orgId: string, subject: TimelineSubject): string | null {
  switch (subject.kind) {
    case "lead":
      return paths.lead(orgId, subject.id);
    case "contact":
      return paths.contact(orgId, subject.id);
    default:
      return null;
  }
}

/** Adds a user note to the timeline of a lead, contact, company or deal. */
export async function addNoteAction(
  orgId: string,
  subject: TimelineSubject,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }

  const parsed = noteSchema.safeParse(pick(formData, ["type", "body"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // RLS: allowed when the user can write in the organization and can see the record.
  const row: ActivityInsert = { organization_id: orgId, type: parsed.data.type, body: parsed.data.body };
  row[SUBJECT_COLUMN[parsedSubject.data.kind]] = parsedSubject.data.id;
  const { error } = await context.supabase.from("activities").insert(row);
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את ההערה. נסו שוב."), { values: formValues(formData) });
  }

  const path = subjectPath(orgId, parsedSubject.data);
  if (path) {
    revalidatePath(path);
  }
  return ok();
}
