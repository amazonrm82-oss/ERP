import { z } from "zod";

import { optionalText, requiredText } from "@/lib/validation";

export const SUBJECT_KINDS = ["lead", "contact", "company", "deal"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

// The record a timeline belongs to.
export type TimelineSubject = { kind: SubjectKind; id: string };

export const subjectSchema = z.object({
  kind: z.enum(SUBJECT_KINDS),
  id: z.guid(),
});

// what a person can log on a record; the reports count these as contact with the customer
export const LOGGED_TYPES = [
  { value: "note", label: "הערה" },
  { value: "call", label: "שיחה" },
  { value: "meeting", label: "פגישה" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "email", label: "אימייל" },
  { value: "sms", label: "SMS" },
] as const;

const LOGGED_TYPE_VALUES = ["note", "call", "meeting", "whatsapp", "email", "sms"] as const;

// REC-01: what a person logged can be pinned to the top of the timeline; system events cannot.
// Several entries may be pinned at once; pinned ones come first, newest first, then the rest.
export const PINNABLE_TYPES = LOGGED_TYPE_VALUES;

export function isPinnableType(type: string): boolean {
  return (PINNABLE_TYPES as readonly string[]).includes(type);
}

/**
 * UI hint for the pin button, mirroring the activities_update policy: the organization is writable
 * for the user, and the user wrote the entry or is an owner/admin. The database still decides.
 */
export function canPinHint(
  item: { type: string; createdBy: string | null },
  viewer: { userId: string; role: string; canWrite: boolean },
): boolean {
  if (!viewer.canWrite || !isPinnableType(item.type)) {
    return false;
  }
  return item.createdBy === viewer.userId || viewer.role === "owner" || viewer.role === "admin";
}

// REC-06: the timeline can show one kind of activity. The key travels in the record page's URL
// (`?tl=call`), so a shared link and the back button keep the filter.
export const TIMELINE_FILTERS = [
  { key: "all", label: "הכול" },
  { key: "note", label: "הערות", types: ["note"] },
  { key: "call", label: "שיחות", types: ["call"] },
  { key: "meeting", label: "פגישות", types: ["meeting"] },
  { key: "message", label: "הודעות", types: ["whatsapp", "email", "sms"] },
  // everything the system wrote: status and stage changes, conversions, repeat inquiries
  { key: "system", label: "שינויים", excludeTypes: LOGGED_TYPE_VALUES },
] as const satisfies ReadonlyArray<{ key: string; label: string; types?: readonly string[]; excludeTypes?: readonly string[] }>;

export type TimelineFilterKey = (typeof TIMELINE_FILTERS)[number]["key"];
export type TimelineFilter = { key: TimelineFilterKey; types: readonly string[] | null; excludeTypes: readonly string[] | null };

/** The filter named in the URL; anything unknown (or repeated) means "all". */
export function parseTimelineFilter(value: unknown): TimelineFilter {
  const found = typeof value === "string" ? TIMELINE_FILTERS.find((f) => f.key === value) : undefined;
  const filter = found ?? TIMELINE_FILTERS[0];
  return {
    key: filter.key,
    types: "types" in filter ? filter.types : null,
    excludeTypes: "excludeTypes" in filter ? filter.excludeTypes : null,
  };
}

/** Link to a record page with the timeline filtered (none for "all"), landing on the timeline. */
export function timelineFilterHref(recordHref: string, key: TimelineFilterKey): string {
  return key === "all" ? `${recordHref}#timeline-title` : `${recordHref}?tl=${key}#timeline-title`;
}

export const noteSchema = z.object({
  type: z.preprocess((value) => (value === null || value === "" ? "note" : value), z.enum(LOGGED_TYPE_VALUES, { error: "יש לבחור סוג." })),
  body: requiredText(5000, "יש לכתוב את ההערה לפני השמירה.", "ההערה ארוכה מדי (עד 5,000 תווים)."),
});

export const SUBJECT_COLUMN = {
  lead: "lead_id",
  contact: "contact_id",
  company: "company_id",
  deal: "deal_id",
} as const satisfies Record<SubjectKind, string>;

// TASK-02: how a call ended; kept in the activity's metadata.outcome
export const CALL_OUTCOMES = [
  { value: "answered", label: "ענה" },
  { value: "no_answer", label: "לא ענה" },
  { value: "voicemail", label: "תא קולי" },
  { value: "call_back", label: "ביקש שנחזור אליו" },
] as const;
export const CALL_OUTCOME_LABEL: Record<string, string> = Object.fromEntries(CALL_OUTCOMES.map((o) => [o.value, o.label]));

export const NEXT_STEPS = [
  { value: "none", label: "בלי משימה" },
  { value: "tomorrow", label: "מחר" },
  { value: "week", label: "בעוד שבוע" },
] as const;

export const callLogSchema = z.object({
  outcome: z.enum(["answered", "no_answer", "voicemail", "call_back"], { error: "יש לבחור איך הסתיימה השיחה." }),
  body: optionalText(5000, "ההערה ארוכה מדי (עד 5,000 תווים)."),
  next: z.preprocess((value) => value ?? "none", z.enum(["none", "tomorrow", "week"], { error: "יש לבחור מה הלאה." })),
  next_title: optionalText(300, "הכותרת ארוכה מדי (עד 300 תווים)."),
});
