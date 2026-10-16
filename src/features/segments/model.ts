import { z } from "zod";

import { filterTreeSchema, type FilterTree } from "@/features/list-filters/model";
import type { MembershipRole } from "@/lib/database.types";
import { requiredText } from "@/lib/validation";

// SEG-01: a segment is a group of leads or of contacts. A dynamic one is a saved list filter (LST-05), worked out
// whenever it is opened; a static one is a hand-picked list of records.
export const SEGMENT_OBJECTS = ["lead", "contact"] as const;
export type SegmentObject = (typeof SEGMENT_OBJECTS)[number];
export const SEGMENT_KINDS = ["dynamic", "static"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const SEGMENT_OBJECT_LABELS: Record<SegmentObject, string> = { lead: "לידים", contact: "אנשי קשר" };
export const SEGMENT_KIND_LABELS: Record<SegmentKind, string> = { dynamic: "לפי סינון", static: "רשימה ידנית" };

// the database's cap on a static segment (app.segment_members_check)
export const SEGMENT_MEMBERS_MAX = 10000;
// how many records one "add to segment" sends: a page of the list at most
export const SEGMENT_ADD_MAX = 200;

export const SEGMENTS_NOT_IN_PLAN = "סגמנטים אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\".";

export const segmentNameSchema = z.object({
  name: requiredText(80, "יש לתת שם לסגמנט.", "השם ארוך מדי (עד 80 תווים)."),
});

export const newSegmentSchema = segmentNameSchema.extend({
  object_type: z.enum(SEGMENT_OBJECTS, { error: "יש לבחור לידים או אנשי קשר." }),
  kind: z.enum(SEGMENT_KINDS, { error: "יש לבחור סוג סגמנט." }),
});

/** Who writes segments: owners, admins and managers of a business that takes changes (the database decides too). */
export function canWriteSegments(role: MembershipRole, canWrite: boolean): boolean {
  return canWrite && (role === "owner" || role === "admin" || role === "manager");
}

/** A stored filter read back: the list filter it was saved from, or null when it no longer reads as one. */
export function segmentFilter(raw: unknown): FilterTree | null {
  const parsed = filterTreeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The filter a form sent, as JSON text, checked like the list's own `f=` parameter. */
export function readSegmentFilter(raw: FormDataEntryValue | null): FilterTree | null {
  const text = typeof raw === "string" ? raw : "";
  if (!text || text.length > 4000) return null;
  try {
    return segmentFilter(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The list page that shows a dynamic segment: the list with the segment's filter. */
export function segmentListHref(listPath: string, filter: FilterTree): string {
  return `${listPath}?${new URLSearchParams({ f: JSON.stringify(filter) }).toString()}`;
}

/** "X נוספו" after adding records to a static segment. */
export function addedNotice(added: number, skipped: number, segmentName: string): string {
  const head = added === 0 ? "לא נוספו רשומות" : added === 1 ? "רשומה אחת נוספה" : `${added} רשומות נוספו`;
  const tail = skipped === 0 ? "" : ` ${skipped === 1 ? "רשומה אחת דולגה" : `${skipped} דולגו`}: כבר בסגמנט, או שאין הרשאה.`;
  return `${head} לסגמנט "${segmentName}".${tail}`;
}
