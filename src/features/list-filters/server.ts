import "server-only";

import type { FieldDefinition } from "@/features/custom-fields/types";
import type { ListObject } from "@/features/list-columns/columns";
import { TASK_TYPE_OPTIONS } from "@/features/tasks/components/task-fields";
import { TIME_ZONE } from "@/lib/app";
import { zoneDate, zonedIso } from "@/lib/format";

import { OPS_BY_KIND, valueKind, type FilterField, type FilterKind, type FilterOp, type FilterTree } from "./model";
import { isCalendarDate } from "@/lib/calendar-date";

export type FilterObject = ListObject;

type Option = { value: string; label: string };
// a field with its database column (a custom field reads custom_fields->key);
// `plain`: the choices are plain values (an enum, a number), not ids; `scale`: a number shown in shekels, stored in agorot
type ServerField = FilterField & { column: string; plain?: boolean; scale?: number };

type Lookups = {
  statuses?: Option[];
  sources?: Option[];
  // the deals table: the stages of the pipeline on screen
  stages?: Option[];
  members: Option[];
  tags: Option[];
  fields: FieldDefinition[];
};

/** Every field a list can be filtered by, with the choices for list-like fields. */
export function filterFields(object: FilterObject, lookups: Lookups): ServerField[] {
  const owner: ServerField = { key: "owner", label: "בעלים", kind: "user", column: "owner_id", options: [{ value: "me", label: "אני" }, ...lookups.members] };
  const tag: ServerField = { key: "tag", label: "תגית", kind: "tag", column: "tag_ids", options: lookups.tags };
  const created: ServerField = { key: "created", label: "תאריך יצירה", kind: "date", column: "created_at" };
  const lastContact: ServerField = { key: "last_contact", label: "מגע אחרון", kind: "date", column: "last_contacted_at" };
  const text = (key: string, label: string, column: string): ServerField => ({ key, label, kind: "text", column });

  const builtIn: Record<FilterObject, ServerField[]> = {
    lead: [
      text("name", "שם", "full_name"),
      text("phone", "טלפון", "phone"),
      text("email", "אימייל", "email"),
      text("company", "חברה", "company_name"),
      text("job_title", "תפקיד", "job_title"),
      text("campaign", "קמפיין", "campaign"),
      { key: "status", label: "סטטוס", kind: "select", column: "status_id", options: lookups.statuses ?? [] },
      { key: "source", label: "מקור", kind: "select", column: "source_id", options: lookups.sources ?? [] },
      owner,
      tag,
      created,
      lastContact,
    ],
    contact: [
      text("name", "שם", "full_name"),
      text("phone", "טלפון", "phone"),
      text("email", "אימייל", "email"),
      text("job_title", "תפקיד", "job_title"),
      text("city", "עיר", "city"),
      { key: "source", label: "מקור", kind: "select", column: "source_id", options: lookups.sources ?? [] },
      owner,
      tag,
      { key: "birthday", label: "תאריך לידה", kind: "day", column: "birth_date" },
      created,
      lastContact,
    ],
    company: [
      text("name", "שם", "name"),
      text("phone", "טלפון", "phone"),
      text("email", "אימייל", "email"),
      text("city", "עיר", "city"),
      text("industry", "תחום", "industry"),
      text("tax_id", "ח.פ.", "tax_id"),
      text("website", "אתר", "website"),
      owner,
      tag,
      created,
    ],
    deal: [
      text("name", "שם", "name"),
      { key: "amount", label: "סכום (₪)", kind: "number", column: "amount_agorot", scale: 100 },
      { key: "stage", label: "שלב", kind: "select", column: "stage_id", options: lookups.stages ?? [] },
      {
        key: "status",
        label: "מצב",
        kind: "select",
        column: "status",
        plain: true,
        options: [
          { value: "open", label: "פתוחה" },
          { value: "won", label: "נסגרה בהצלחה" },
          { value: "lost", label: "אבודה" },
        ],
      },
      owner,
      tag,
      { key: "expected_close", label: "צפי סגירה", kind: "day", column: "expected_close_date" },
      created,
    ],
    // tasks have no tags and no custom fields
    task: [
      text("title", "כותרת", "title"),
      { key: "type", label: "סוג", kind: "select", column: "task_type", plain: true, options: TASK_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
      {
        key: "status",
        label: "מצב",
        kind: "select",
        column: "status",
        plain: true,
        options: [
          { value: "open", label: "פתוחה" },
          { value: "done", label: "הושלמה" },
          { value: "cancelled", label: "בוטלה" },
        ],
      },
      {
        key: "priority",
        label: "עדיפות",
        kind: "select",
        column: "priority",
        plain: true,
        options: [
          { value: "1", label: "גבוהה" },
          { value: "2", label: "רגילה" },
          { value: "3", label: "נמוכה" },
        ],
      },
      { ...owner, label: "אחראי" },
      { key: "due", label: "תאריך יעד", kind: "date", column: "due_at" },
      created,
    ],
  };

  const custom = lookups.fields.map((field): ServerField => {
    const kind: FilterKind =
      field.type === "number" ? "number" : field.type === "checkbox" ? "checkbox" : field.type === "date" ? "day" : field.type === "select" ? "select" : "text";
    // numbers and true/false compare as JSON; everything else as text
    const column = kind === "number" || kind === "checkbox" ? `custom_fields->${field.key}` : `custom_fields->>${field.key}`;
    return {
      key: `cf:${field.key}`,
      label: field.label,
      kind,
      column,
      options: kind === "select" ? field.options.map((option) => ({ value: option, label: option })) : undefined,
    };
  });
  return [...builtIn[object], ...custom];
}

/** The fields as the browser needs them (without database columns). */
export function publicFields(fields: ServerField[]): FilterField[] {
  return fields.map(({ key, label, kind, options }) => ({ key, label, kind, options }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// a value inside a PostgREST filter: double-quoted, so commas and parentheses cannot break out
const quote = (value: string) => `"${value.replace(/["\\]/g, "")}"`;

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type Context = { userId: string; now: Date; timeZone?: string };

/** One condition as a PostgREST filter, or null when it does not fit the field (it is then left out). */
function conditionFilter(field: ServerField, op: FilterOp, rawValue: string, ctx: Context): string | null {
  if (!OPS_BY_KIND[field.kind].includes(op)) return null;
  const c = field.column;
  const value = rawValue.trim();
  const needs = valueKind(field.kind, op);
  if (needs !== "none" && value === "") return null;

  if (op === "empty") {
    if (field.kind === "tag") return `${c}.eq.{}`;
    return field.kind === "text" ? `or(${c}.is.null,${c}.eq."")` : `${c}.is.null`;
  }
  if (op === "not_empty") {
    return field.kind === "text" ? `and(${c}.not.is.null,${c}.neq."")` : `${c}.not.is.null`;
  }

  switch (field.kind) {
    case "text":
      if (op === "contains") return `${c}.ilike.${quote(`*${value}*`)}`;
      if (op === "not_contains") return `or(${c}.is.null,${c}.not.ilike.${quote(`*${value}*`)})`;
      if (op === "equals") return `${c}.ilike.${quote(value.replace(/[*%_]/g, ""))}`;
      return null;
    case "select":
    case "user": {
      const chosen = field.kind === "user" && value === "me" ? ctx.userId : value;
      if (!field.options?.some((option) => option.value === value)) return null;
      // built-in list fields hold ids; a custom select holds the option's text
      const literal = c.startsWith("custom_fields") || field.plain ? quote(chosen) : UUID.test(chosen) ? chosen : null;
      if (!literal) return null;
      return op === "is" ? `${c}.eq.${literal}` : `or(${c}.is.null,${c}.neq.${literal})`;
    }
    case "tag":
      if (!UUID.test(value) || !field.options?.some((option) => option.value === value)) return null;
      return op === "has" ? `${c}.cs.{${value}}` : `${c}.not.cs.{${value}}`;
    case "number": {
      const typed = Number(value.replace(/,/g, ""));
      if (!Number.isFinite(typed)) return null;
      const number = field.scale ? Math.round(typed * field.scale) : typed;
      return `${c}.${op === "equals" ? "eq" : op}.${number}`;
    }
    case "checkbox":
      return op === "is_true" ? `${c}.eq.true` : `or(${c}.is.null,${c}.eq.false)`;
    case "date":
    case "day": {
      const zone = ctx.timeZone ?? TIME_ZONE;
      const today = zoneDate(ctx.now, zone);
      // a day as the column compares it: a timestamp at the start of that day in the organization's zone, or the plain date
      const bound = (day: string) => (field.kind === "date" ? quote(zonedIso(day, "00:00:00", zone)) : quote(day));
      const range = (from: string, toExclusive: string) => `and(${c}.gte.${bound(from)},${c}.lt.${bound(toExclusive)})`;
      if (op === "on_or_after" || op === "before") {
        if (!isCalendarDate(value)) return null;
        return op === "on_or_after" ? `${c}.gte.${bound(value)}` : `${c}.lt.${bound(value)}`;
      }
      if (op === "last_days" || op === "older_than_days") {
        const days = Number.parseInt(value, 10);
        if (!Number.isSafeInteger(days) || days < 0 || days > 3650) return null;
        return op === "last_days" ? range(addDays(today, -days), addDays(today, 1)) : `${c}.lt.${bound(addDays(today, -days))}`;
      }
      if (op === "this_week") {
        // the week starts on Sunday
        const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
        const sunday = addDays(today, -weekday);
        return range(sunday, addDays(sunday, 7));
      }
      if (op === "this_month") {
        const first = `${today.slice(0, 7)}-01`;
        const next = new Date(`${first}T12:00:00Z`);
        next.setUTCMonth(next.getUTCMonth() + 1);
        return range(first, next.toISOString().slice(0, 10));
      }
      return null;
    }
  }
}

/**
 * The whole filter as one PostgREST logic tree, for `.or(tree)`; null when no
 * condition could be used. `skipped` counts conditions that did not fit.
 */
export function filterToPostgrest(tree: FilterTree, fields: ServerField[], ctx: Context): { logic: string | null; skipped: number } {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  let skipped = 0;
  const groups: string[] = [];
  for (const group of tree.groups) {
    const parts: string[] = [];
    for (const condition of group.conditions) {
      const field = byKey.get(condition.field);
      const part = field ? conditionFilter(field, condition.op as FilterOp, condition.value ?? "", ctx) : null;
      if (part) parts.push(part);
      else skipped += 1;
    }
    if (parts.length > 0) groups.push(`${group.match === "all" ? "and" : "or"}(${parts.join(",")})`);
  }
  if (groups.length === 0) return { logic: null, skipped };
  return { logic: `${tree.match === "all" ? "and" : "or"}(${groups.join(",")})`, skipped };
}

export type PreparedFilter = {
  fields: FilterField[];
  tree: FilterTree | null;
  // for `.or()` on the list query; null when there is no usable filter
  logic: string | null;
  skipped: number;
};
