"use server";

import { revalidatePath } from "next/cache";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { shareNoteTextSchema, subjectSchema, SUBJECT_COLUMN, type TimelineSubject } from "@/features/activities/schema";
import { pickerQuery } from "@/components/ui/search-picker-logic";
import { getOrgModules } from "@/features/modules/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type FormState } from "@/lib/action-result";
import type { ActivityInsert } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND } from "@/lib/errors";
import { recordPage } from "@/lib/record-types";

import { shareSearchHits, type SearchRecordsAnswer } from "./records";
import { markSharedNote, NOTE_MAX, SHARE_NOTE_TYPE } from "./share";

const SEARCH_FAILED = "החיפוש נכשל. נסו שוב.";

/**
 * WAB-06: the record picker of "הערה לרשומה". The global search (public.search_records, security invoker: RLS decides
 * what is found) with the user's session; leads, contacts, companies and deals only, switched-off modules left out.
 * A hit's id is "<kind>:<uuid>"; the note is saved by addNoteAction, which checks the rights again.
 */
export async function searchShareRecordsAction(orgId: string, query: string): Promise<SearchPickerResult> {
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") {
    return { hits: [] };
  }
  const term = pickerQuery(query);
  if (term === null) {
    return { hits: [] };
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return { error: context.message };
  }
  const { data, error } = await context.supabase.rpc("search_records", { p_org: orgId, p_query: term, p_limit: 6 });
  if (error) {
    return { error: SEARCH_FAILED };
  }
  const [modules, terms] = await Promise.all([getOrgModules(orgId), getOrgTerms(orgId)]);
  return { hits: shareSearchHits(data as SearchRecordsAnswer, modules, terms) };
}

const NOTE_EMPTY = "יש לכתוב את ההערה לפני השמירה.";
const NOTE_TOO_LONG = "ההערה ארוכה מדי (עד 5,000 תווים).";
const SHARE_NOTE_NO_EDIT = "אין לכם הרשאה לערוך את הרשומה הזו, ולכן אי אפשר לשמור עליה הערת שיתוף. בחרו רשומה אחרת.";

/**
 * WAB-06 (owner, 27 October 2026, answer (ב)): saves what was shared as a "הערת שיתוף" ('share_note') on a record: the mark
 * "שותף מהטלפון", then the text, by the person, with the user's session. It is not contact with the customer, so a lead
 * saved from a share still waits for an answer. The database lets only someone who may edit the record write one
 * (activities_insert). Text may be empty only when an image goes with it (the image is then a file of this note, REC-07).
 */
export async function addShareNoteAction(
  orgId: string,
  subject: TimelineSubject,
  text: string,
  withImage: boolean,
): Promise<FormState<{ id: string }>> {
  const parsedSubject = subjectSchema.safeParse(subject);
  if (!parsedSubject.success || typeof withImage !== "boolean") {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, parsedSubject.data.id);
  if (!context.ok) {
    return context;
  }
  const parsed = shareNoteTextSchema.safeParse(text);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? NOTE_TOO_LONG;
    return fail(message, { fieldErrors: { body: message } });
  }
  const cleaned = parsed.data ?? "";
  const body = markSharedNote(cleaned);
  if (body.split("\n").slice(1).join("\n").trim() === "" && !withImage) {
    return fail(NOTE_EMPTY, { fieldErrors: { body: NOTE_EMPTY } });
  }
  if (body.length > NOTE_MAX) {
    return fail(NOTE_TOO_LONG, { fieldErrors: { body: NOTE_TOO_LONG } });
  }
  const row: ActivityInsert = { organization_id: orgId, type: SHARE_NOTE_TYPE, body };
  row[SUBJECT_COLUMN[parsedSubject.data.kind]] = parsedSubject.data.id;
  const { data, error } = await context.supabase.from("activities").insert(row).select("id").single();
  if (error) {
    // a share note needs edit rights on the record (owner's question pending, DECISIONS.md WAB-06): say so plainly
    if (error.code === "42501") {
      return fail(SHARE_NOTE_NO_EDIT);
    }
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את ההערה. נסו שוב."));
  }
  revalidatePath(recordPage(parsedSubject.data.kind, orgId, parsedSubject.data.id));
  return ok({ id: data.id });
}
