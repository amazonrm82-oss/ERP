import { z } from "zod";

// Advanced list filters (LST-05): conditions on any field, custom fields
// included, in groups joined by "all" or "any", with dates relative to today.
// The filter travels in the URL as JSON (`f=`); the server checks every field,
// operator and value against the list's fields before it builds a query.

// "idle": days since the last contact (LEAD-02); a record never contacted counts from its creation
export type FilterKind = "text" | "select" | "user" | "tag" | "date" | "number" | "checkbox" | "day" | "idle";

export type FilterOp =
  | "contains"
  | "not_contains"
  | "equals"
  | "is"
  | "is_not"
  | "has"
  | "has_not"
  | "gt"
  | "lt"
  | "on_or_after"
  | "before"
  | "last_days"
  | "older_than_days"
  | "this_week"
  | "this_month"
  | "idle_days"
  | "is_true"
  | "is_false"
  | "empty"
  | "not_empty";

export const OPS_BY_KIND: Record<FilterKind, FilterOp[]> = {
  text: ["contains", "not_contains", "equals", "empty", "not_empty"],
  select: ["is", "is_not", "empty", "not_empty"],
  user: ["is", "is_not", "empty", "not_empty"],
  tag: ["has", "has_not", "empty"],
  number: ["equals", "gt", "lt", "empty", "not_empty"],
  checkbox: ["is_true", "is_false"],
  // a timestamp (created, last contact) and a plain date (a custom date field)
  date: ["on_or_after", "before", "last_days", "older_than_days", "this_week", "this_month", "empty", "not_empty"],
  day: ["on_or_after", "before", "last_days", "older_than_days", "this_week", "this_month", "empty", "not_empty"],
  idle: ["idle_days"],
};

export const OP_LABELS: Record<FilterOp, string> = {
  contains: "מכיל",
  not_contains: "לא מכיל",
  equals: "שווה ל",
  is: "הוא",
  is_not: "אינו",
  has: "יש",
  has_not: "אין",
  gt: "גדול מ",
  lt: "קטן מ",
  on_or_after: "מתאריך",
  before: "לפני",
  last_days: "ב-X הימים האחרונים",
  older_than_days: "לפני יותר מ-X ימים",
  this_week: "השבוע",
  this_month: "החודש",
  idle_days: "X ימים או יותר",
  is_true: "מסומן",
  is_false: "לא מסומן",
  empty: "ריק",
  not_empty: "לא ריק",
};

/** What value an operator needs: none, a typed text, a number of days, a date, or a choice from the field's options. */
export function valueKind(kind: FilterKind, op: FilterOp): "none" | "text" | "number" | "days" | "date" | "option" {
  if (["empty", "not_empty", "this_week", "this_month", "is_true", "is_false"].includes(op)) return "none";
  if (op === "last_days" || op === "older_than_days" || op === "idle_days") return "days";
  if (op === "on_or_after" || op === "before") return "date";
  if (kind === "select" || kind === "user" || kind === "tag") return "option";
  if (kind === "number") return "number";
  return "text";
}

// what a list offers to filter by; the server adds the database column
export type FilterField = { key: string; label: string; kind: FilterKind; options?: Array<{ value: string; label: string }> };

const condition = z.object({ field: z.string().max(60), op: z.string().max(30), value: z.string().max(200).optional() });
const group = z.object({ match: z.enum(["all", "any"]), conditions: z.array(condition).min(1).max(10) });
export const filterTreeSchema = z.object({ match: z.enum(["all", "any"]), groups: z.array(group).min(1).max(5) });

export type FilterCondition = z.infer<typeof condition>;
export type FilterGroup = z.infer<typeof group>;
export type FilterTree = z.infer<typeof filterTreeSchema>;

/** The filter from the URL, or null when there is none or it cannot be read. */
export function parseFilterParam(raw: string): FilterTree | null {
  if (!raw || raw.length > 4000) return null;
  try {
    const parsed = filterTreeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Number of conditions, for the button's label. */
export function conditionCount(tree: FilterTree | null): number {
  return tree ? tree.groups.reduce((sum, g) => sum + g.conditions.length, 0) : 0;
}
