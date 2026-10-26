import { z } from "zod";

import { checkbox, optionalText, requiredText } from "@/lib/validation";

import { ACTIVITY_BASES, BASE_LABELS } from "@/features/activity-types/types";
import { MENTION_MAX, mentionIds } from "@/features/mentions/token";

import { sanitizeNote } from "./markdown";

// REC-04: what a person writes is stored as cleaned Markdown (see markdown.ts)
const NOTE_MAX = 5000;
const NOTE_TOO_LONG = "ההערה ארוכה מדי (עד 5,000 תווים).";
// RVW-3: anything longer than this is refused before any cleaning or parsing runs. Twice the
// limit, because the cleaning still has to remove what the browser adds: a textarea sends each
// line break as "\r\n" (two characters, one after cleaning), and the limit is checked after trimming.
export const NOTE_RAW_MAX = NOTE_MAX * 2;

const cleanNote = (value: unknown, ctx: z.RefinementCtx) => {
  if (typeof value !== "string") return value;
  if (value.length > NOTE_RAW_MAX) {
    ctx.addIssue({ code: "custom", message: NOTE_TOO_LONG });
    return z.NEVER;
  }
  return sanitizeNote(value);
};

export const SUBJECT_KINDS = ["lead", "contact", "company", "deal"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

// The record a timeline belongs to.
export type TimelineSubject = { kind: SubjectKind; id: string };

export const subjectSchema = z.object({
  kind: z.enum(SUBJECT_KINDS),
  id: z.guid(),
});

// what a person can log on a record; the reports count these as contact with the customer. TASK-08: the business names
// them through its list of types (src/features/activity-types/types.ts, which holds the built-in names)
export const LOGGED_TYPES = ACTIVITY_BASES.map((value) => ({ value, label: BASE_LABELS[value] }));

const LOGGED_TYPE_VALUES = ["note", "call", "meeting", "whatsapp", "email", "sms"] as const;

// REC-01: what a person logged can be pinned to the top of the timeline; system events cannot.
// Several entries may be pinned at once; pinned ones come first, newest first, then the rest.
export const PINNABLE_TYPES = LOGGED_TYPE_VALUES;

export function isPinnableType(type: string): boolean {
  return (PINNABLE_TYPES as readonly string[]).includes(type);
}

// REC-05: the author may edit or delete what they logged for 24 hours; after that only an owner or admin.
export const NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

type Viewer = {
  userId: string;
  role: string;
  canWrite: boolean;
  // REC-01: the viewer is a manager of the team of the record whose timeline this is
  managesRecordTeam?: boolean;
};

/**
 * UI hint for editing and deleting an entry (REC-05), mirroring the database: the organization
 * is writable for the user, and the user is an owner/admin, or wrote the entry less than 24 hours
 * ago (policy activities_delete, trigger activities_edit_window). The database still decides.
 */
export function canEditNoteHint(item: { type: string; createdBy: string | null; createdAt: string }, viewer: Viewer, now: number): boolean {
  if (!viewer.canWrite || !isPinnableType(item.type)) {
    return false;
  }
  if (viewer.role === "owner" || viewer.role === "admin") {
    return true;
  }
  // a team manager may pin a colleague's entry (canPinHint), never edit it
  if (item.createdBy !== viewer.userId) {
    return false;
  }
  const created = Date.parse(item.createdAt);
  return Number.isFinite(created) && now - created < NOTE_EDIT_WINDOW_MS;
}

/**
 * GAP-12: an owner or admin of a writable business may remove a wrong note an import wrote (type 'import_note'), as the
 * activities_delete policy allows them any entry. Nobody edits it here, and nobody else removes it.
 */
export function canRemoveImportNoteHint(item: { type: string }, viewer: Viewer): boolean {
  return viewer.canWrite && item.type === "import_note" && (viewer.role === "owner" || viewer.role === "admin");
}

/**
 * REC-01: who sees the pin button, mirroring the activities_update policy: the organization is
 * writable for the user, and the user wrote the entry, is an owner/admin, or is a manager of the
 * record's team (owner's decision, 12 October 2026: pin and unpin only). No time limit: the 24
 * hours of REC-05 apply to what the entry says, not to pinning it.
 */
export function canPinHint(item: { type: string; createdBy: string | null }, viewer: Viewer): boolean {
  if (!viewer.canWrite || !isPinnableType(item.type)) {
    return false;
  }
  return (
    item.createdBy === viewer.userId ||
    viewer.role === "owner" ||
    viewer.role === "admin" ||
    (viewer.role === "manager" && viewer.managesRecordTeam === true)
  );
}

/**
 * REC-01: whether a user manages a team, mirroring app.manages_team(): they are a manager of the
 * team itself or of one of its parent teams (at most 10 levels up, as in the database).
 */
export function managesTeamChain(
  teamId: string | null,
  teams: ReadonlyArray<{ id: string; parentTeamId: string | null }>,
  managedTeamIds: ReadonlySet<string>,
): boolean {
  const parents = new Map(teams.map((team) => [team.id, team.parentTeamId]));
  let current = teamId;
  for (let depth = 0; current && depth < 10 && parents.has(current); depth += 1) {
    if (managedTeamIds.has(current)) {
      return true;
    }
    current = parents.get(current) ?? null;
  }
  return false;
}

// Said when an edit or a delete touched nothing.
export const NOTE_LOCKED = "לא ניתן לשנות את הרשומה הזו. ייתכן שנמחקה, או שעברו 24 שעות מאז שנכתבה (אחרי זה רק מנהל מערכת יכול לשנות או למחוק אותה).";

// GAP-12: said when removing an import's note touched nothing
export const IMPORT_NOTE_LOCKED = "לא ניתן למחוק את ההערה הזו. ייתכן שכבר נמחקה. הערה מייבוא מוחקים בעלים ומנהלי מערכת בלבד.";

// GAP-05: only a note can be private (check activities_private_note in the database)
export const PRIVATE_NOTE_TYPE = "note";
export const PRIVATE_ONLY_NOTE = "רק הערה יכולה להיות פרטית. שיחות, פגישות והודעות גלויות לכל מי שרואה את הרשומה.";
// the hint next to the checkbox: who will see the note
export const PRIVATE_NOTE_HINT = "תוצג רק לך ולמנהלי המערכת של העסק.";

// REC-02: a private note is seen by its author and the admins only, so it tells nobody;
// the app refuses a mention there instead of saving one that goes nowhere
export const PRIVATE_NO_MENTIONS = "אי אפשר לאזכר אנשים בהערה פרטית. הסירו את האזכור או בטלו את הסימון.";
export const TOO_MANY_MENTIONS = `אפשר לאזכר עד ${MENTION_MAX} אנשים בהערה אחת.`;

const fewMentions = (body: string) => mentionIds(body).length <= MENTION_MAX;

export const noteEditSchema = z
  .object({
    body: z.preprocess(cleanNote, requiredText(NOTE_MAX, "יש לכתוב את ההערה לפני השמירה.", NOTE_TOO_LONG)),
    // GAP-05: sent only by the edit box of a note; absent means "leave it as it is"
    private_field: z.preprocess((value) => value === "1", z.boolean()),
    private: checkbox,
  })
  .refine((note) => fewMentions(note.body), { path: ["body"], message: TOO_MANY_MENTIONS })
  .refine((note) => !(note.private_field && note.private) || mentionIds(note.body).length === 0, {
    path: ["private"],
    message: PRIVATE_NO_MENTIONS,
  });

// REC-06: the timeline can show one kind of activity. The key travels in the record page's URL
// (`?tl=call`), so a shared link and the back button keep the filter.
export const TIMELINE_FILTERS = [
  { key: "all", label: "הכול" },
  // GAP-12: a note from an imported file is a note, not a change
  { key: "note", label: "הערות", types: ["note", "import_note"] },
  { key: "call", label: "שיחות", types: ["call"] },
  { key: "meeting", label: "פגישות", types: ["meeting"] },
  { key: "message", label: "הודעות", types: ["whatsapp", "email", "sms"] },
  // everything the system wrote: status and stage changes, conversions, repeat inquiries
  { key: "system", label: "שינויים", excludeTypes: [...LOGGED_TYPE_VALUES, "import_note"] },
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

export const noteSchema = z
  .object({
    type: z.preprocess((value) => (value === null || value === "" ? "note" : value), z.enum(LOGGED_TYPE_VALUES, { error: "יש לבחור סוג." })),
    body: z.preprocess(cleanNote, requiredText(NOTE_MAX, "יש לכתוב את ההערה לפני השמירה.", NOTE_TOO_LONG)),
    // GAP-05: "me and the organization's admins"
    private: checkbox,
  })
  .refine((note) => !note.private || note.type === PRIVATE_NOTE_TYPE, { path: ["private"], message: PRIVATE_ONLY_NOTE })
  .refine((note) => fewMentions(note.body), { path: ["body"], message: TOO_MANY_MENTIONS })
  .refine((note) => !note.private || mentionIds(note.body).length === 0, { path: ["private"], message: PRIVATE_NO_MENTIONS });

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
  body: z.preprocess(cleanNote, optionalText(NOTE_MAX, NOTE_TOO_LONG)),
  next: z.preprocess((value) => value ?? "none", z.enum(["none", "tomorrow", "week"], { error: "יש לבחור מה הלאה." })),
  next_title: optionalText(300, "הכותרת ארוכה מדי (עד 300 תווים)."),
});
