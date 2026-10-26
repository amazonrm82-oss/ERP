import "server-only";

import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";
import type { ListObject } from "@/features/list-columns/columns";
import { CHANNEL_OPTIONS, LOCALE_OPTIONS } from "@/features/contacts/preferences";
import { INDUSTRIES } from "@/features/onboarding/options";
import { BILLING_LABELS, BILLINGS, PRODUCT_KIND_LABELS, PRODUCT_KINDS, VAT_KIND_LABELS, VAT_KINDS } from "@/features/products/schema";
import { DOCUMENT_LIST_STATUS_LABELS, DOCUMENT_LIST_STATUSES } from "@/features/documents/list";
import { DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES } from "@/features/documents/schema";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PAYMENT_STATUS_LABELS, PAYMENT_STATUSES } from "@/features/payments/schema";
import { QUOTE_STATUS_LABELS, QUOTE_STATUSES } from "@/features/quotes/schema";
import { TASK_TYPE_OPTIONS } from "@/features/tasks/components/task-fields";
import { TIME_ZONE } from "@/lib/app";
import { zoneDate, zonedIso } from "@/lib/format";

import { OPS_BY_KIND, valueKind, type FilterField, type FilterKind, type FilterOp, type FilterTree } from "./model";
import { isCalendarDate } from "@/lib/calendar-date";

// How a list filters a custom field of each type (null: not filterable). A Record, so a new type does not build
// until it has its entry (FLD-06; src/features/custom-fields/type-decisions.ts).
const FILTER_KINDS: Record<FieldType, FilterKind | null> = {
  text: "text",
  long_text: "text",
  rich_text: "text",
  number: "number",
  currency: "number",
  percent: "number",
  rating: "number",
  duration: "number",
  select: "select",
  status: "select",
  user: "select",
  multi_select: null,
  checkbox: "checkbox",
  date: "day",
  datetime: null,
  phone: "text",
  email: "text",
  url: "text",
  il_id: "text",
  il_company_id: "text",
  // FLD-06 part B: an address is text; a record link and a file hold ids: only "filled" / "empty" (owner, 26 October 2026)
  address: "text",
  record_link: "presence",
  file: "presence",
};

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
  // contacts and companies: the organization's types (CON-02)
  types?: Option[];
  // tasks: the business's activity and task types (TASK-08), hidden ones too
  activityTypes?: Option[];
  // contacts: the live companies, for the primary company (CON-05)
  companies?: Option[];
  // products (LST-09): the catalog's categories (with their parent) and units of measure
  categories?: Option[];
  units?: Option[];
  // PAY-03: contacts and companies offer "יש יתרת זכות" only where the business sees money
  money?: boolean;
  members: Option[];
  tags: Option[];
  fields: FieldDefinition[];
};

/** Every field a list can be filtered by, with the choices for list-like fields. */
export function filterFields(object: FilterObject, lookups: Lookups): ServerField[] {
  const owner: ServerField = { key: "owner", label: "אחראי", kind: "user", column: "owner_id", options: [{ value: "me", label: "אני" }, ...lookups.members] };
  const tag: ServerField = { key: "tag", label: "תגית", kind: "tag", column: "tag_ids", options: lookups.tags };
  const created: ServerField = { key: "created", label: "תאריך יצירה", kind: "date", column: "created_at" };
  const lastContact: ServerField = { key: "last_contact", label: "מגע אחרון", kind: "date", column: "last_contacted_at" };
  // LEAD-02: "no contact for X days"; a record never contacted counts from the day it was created
  const noContact: ServerField = { key: "no_contact", label: "ימים בלי מגע", kind: "idle", column: "last_contacted_at" };
  const text = (key: string, label: string, column: string): ServerField => ({ key, label, kind: "text", column });
  const type: ServerField = { key: "type", label: "סוג", kind: "select", column: "type_id", options: lookups.types ?? [] };
  // PAY-03: the computed field public.has_credit (the cards' rule; false without the money keys)
  const credit: ServerField[] = lookups.money ? [{ key: "has_credit", label: "יש יתרת זכות", kind: "checkbox", column: "has_credit" }] : [];

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
      // LEAD-05: the score the business's rules give
      { key: "score", label: "ציון", kind: "number", column: "score" },
      created,
      lastContact,
      noContact,
    ],
    contact: [
      text("name", "שם", "full_name"),
      text("phone", "טלפון", "phone"),
      text("email", "אימייל", "email"),
      text("job_title", "תפקיד", "job_title"),
      text("city", "עיר", "city"),
      // CON-05: the primary company; "ריק" = contacts without a primary company
      { key: "primary_company", label: "חברה ראשית", kind: "select", column: "company_id", options: lookups.companies ?? [] },
      { key: "source", label: "מקור", kind: "select", column: "source_id", options: lookups.sources ?? [] },
      type,
      // CON-10: stored codes, picked from the closed lists
      { key: "locale", label: "שפה מועדפת", kind: "select", column: "preferred_locale", plain: true, options: [...LOCALE_OPTIONS] },
      { key: "channel", label: "ערוץ מועדף", kind: "select", column: "preferred_channel", plain: true, options: [...CHANNEL_OPTIONS] },
      owner,
      tag,
      { key: "birthday", label: "יום הולדת", kind: "day", column: "birth_date" },
      ...credit,
      created,
      lastContact,
      noContact,
    ],
    company: [
      text("name", "שם", "name"),
      text("phone", "טלפון", "phone"),
      text("email", "אימייל", "email"),
      text("city", "עיר", "city"),
      // the stored value is an English key, so it is picked from the list (FXU-12)
      { key: "industry", label: "ענף", kind: "select", column: "industry", plain: true, options: INDUSTRIES.map((o) => ({ value: o.value, label: o.label })) },
      text("tax_id", "ח.פ.", "tax_id"),
      text("website", "אתר", "website"),
      type,
      owner,
      tag,
      ...credit,
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
      // DEAL-07: "not empty" = a recurring deal (a filter by kind needs its values in app.export_choice_values(); follow-up)
      { key: "recurring_amount", label: "סכום חוזר (חודשי או שנתי, ₪)", kind: "number", column: "recurring_amount_agorot", scale: 100 },
      { key: "renewal", label: "תאריך חידוש", kind: "day", column: "renewal_date" },
      created,
    ],
    // tasks have no tags and no custom fields
    task: [
      text("title", "כותרת", "title"),
      { key: "type", label: "סוג", kind: "select", column: "task_type", plain: true, options: TASK_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
      // TASK-08: the business's own type of the task (activity_type_id); the code above stays for every task
      { key: "activity_type", label: "סוג מהרשימה", kind: "select", column: "activity_type_id", options: lookups.activityTypes ?? [] },
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
    // LST-09: the product catalog (no owner, tags or custom fields); the page's own selects keep the status
    product: [
      text("name", "שם", "name"),
      text("sku", 'מק"ט', "sku"),
      text("barcode", "ברקוד", "barcode"),
      text("description", "תיאור", "description"),
      { key: "category", label: "קטגוריה", kind: "select", column: "category_id", options: lookups.categories ?? [] },
      { key: "unit", label: "יחידה", kind: "select", column: "unit_id", options: lookups.units ?? [] },
      { key: "kind", label: "סוג", kind: "select", column: "kind", plain: true, options: PRODUCT_KINDS.map((k) => ({ value: k, label: PRODUCT_KIND_LABELS[k] })) },
      { key: "vat", label: 'מע"מ', kind: "select", column: "vat_kind", plain: true, options: VAT_KINDS.map((k) => ({ value: k, label: VAT_KIND_LABELS[k] })) },
      { key: "billing", label: "חיוב", kind: "select", column: "billing", plain: true, options: BILLINGS.map((k) => ({ value: k, label: BILLING_LABELS[k] })) },
      // the price as typed (before or with VAT, as the product says)
      { key: "price", label: "מחיר (₪)", kind: "number", column: "price_agorot", scale: 100 },
      { key: "active", label: "פעיל", kind: "checkbox", column: "is_active" },
      created,
    ],
    // LST-09: the quotes list (no tags or custom fields); the customer's name is not filtered (it is read from the deal or contact)
    quote: [
      text("title", "כותרת", "title"),
      text("number", "מספר", "number_display"),
      { key: "status", label: "מצב", kind: "select", column: "status", plain: true, options: QUOTE_STATUSES.map((s) => ({ value: s, label: QUOTE_STATUS_LABELS[s] })) },
      owner,
      { key: "quote_date", label: "תאריך ההצעה", kind: "day", column: "quote_date" },
      { key: "valid_until", label: "בתוקף עד", kind: "day", column: "valid_until" },
      { key: "sent", label: "תאריך שליחה", kind: "date", column: "sent_at" },
      // the total with VAT, as the quote shows it
      { key: "total", label: "סכום (₪)", kind: "number", column: "total_agorot", scale: 100 },
      created,
    ],
    // LST-09: the accounting documents (no tags or custom fields); the customer's name is not filtered (read from the
    // deal or contact); who recorded it is a user choice on created_by
    document: [
      text("number", "מספר", "number"),
      { key: "type", label: "סוג", kind: "select", column: "doc_type", plain: true, options: DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] })) },
      { key: "date", label: "תאריך המסמך", kind: "day", column: "doc_date" },
      { key: "amount", label: "סכום (₪)", kind: "number", column: "amount_agorot", scale: 100 },
      { key: "status", label: "מצב", kind: "select", column: "status", plain: true, options: DOCUMENT_LIST_STATUSES.map((s) => ({ value: s, label: DOCUMENT_LIST_STATUS_LABELS[s] })) },
      { ...owner, key: "recorder", label: "נרשם על ידי", column: "created_by" },
      { ...created, label: "תאריך הרישום" },
    ],
    // LST-09: the payments (no tags or custom fields; the note is not filtered: it stays on the record's card)
    payment: [
      { key: "amount", label: "סכום (₪)", kind: "number", column: "amount_agorot", scale: 100 },
      { key: "date", label: "תאריך התשלום", kind: "day", column: "paid_on" },
      { key: "method", label: "אמצעי תשלום", kind: "select", column: "method", plain: true, options: PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] })) },
      { key: "installments", label: "מספר תשלומים", kind: "number", column: "installments" },
      text("reference", "אסמכתא", "reference"),
      { key: "status", label: "מצב", kind: "select", column: "status", plain: true, options: PAYMENT_STATUSES.map((s) => ({ value: s, label: PAYMENT_STATUS_LABELS[s] })) },
      { ...owner, key: "recorder", label: "נרשם על ידי", column: "created_by" },
      { ...created, label: "תאריך הרישום" },
    ],
  };

  // a multiple choice (a JSON array) and a date with time are not filterable yet (FILTER_KINDS: null)
  const custom = lookups.fields
    .filter((field) => FILTER_KINDS[field.type] !== null)
    .map((field): ServerField => {
      const kind = FILTER_KINDS[field.type] as FilterKind;
      // numbers and true/false compare as JSON; everything else as text
      const column = kind === "number" || kind === "checkbox" ? `custom_fields->${field.key}` : `custom_fields->>${field.key}`;
      return {
        key: `cf:${field.key}`,
        // FLD-06: a duration is filtered in minutes, as it is stored
        label: field.type === "duration" ? `${field.label} (בדקות)` : field.label,
        kind,
        column,
        // a sum is typed in shekels and stored in agorot
        ...(field.type === "currency" ? { scale: 100 } : {}),
        options:
          field.type === "user"
            ? lookups.members
            : kind === "select"
              ? field.options.map((option) => ({ value: option, label: option }))
              : undefined,
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
    return field.kind === "text" || field.kind === "presence" ? `or(${c}.is.null,${c}.eq."")` : `${c}.is.null`;
  }
  if (op === "not_empty") {
    return field.kind === "text" || field.kind === "presence" ? `and(${c}.not.is.null,${c}.neq."")` : `${c}.not.is.null`;
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
    case "presence":
      // only "filled" / "empty", answered above
      return null;
    case "idle": {
      // the last contact is older than X days (the same bound as "older_than_days"); a record never
      // contacted counts from its creation, so one created in those days is not idle yet
      const days = Number.parseInt(value, 10);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(days) || days > 3650) return null;
      const zone = ctx.timeZone ?? TIME_ZONE;
      const bound = quote(zonedIso(addDays(zoneDate(ctx.now, zone), -days), "00:00:00", zone));
      return `or(${c}.lt.${bound},and(${c}.is.null,created_at.lt.${bound}))`;
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

/**
 * Only the conditions `filterToPostgrest()` would use, in their groups; null when none fits.
 * The list export logs this (RVW-4), so a condition the list left out is not kept.
 */
export function appliedFilter(tree: FilterTree, fields: ServerField[], ctx: Context): FilterTree | null {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const groups = tree.groups
    .map((group) => ({
      match: group.match,
      conditions: group.conditions.filter((condition) => {
        const field = byKey.get(condition.field);
        return field ? conditionFilter(field, condition.op as FilterOp, condition.value ?? "", ctx) !== null : false;
      }),
    }))
    .filter((group) => group.conditions.length > 0);
  return groups.length > 0 ? { match: tree.match, groups } : null;
}

export type PreparedFilter = {
  fields: FilterField[];
  tree: FilterTree | null;
  // for `.or()` on the list query; null when there is no usable filter
  logic: string | null;
  skipped: number;
  // the conditions the list applied (`tree` without the ones left out); for the export's audit entry
  applied: FilterTree | null;
};
