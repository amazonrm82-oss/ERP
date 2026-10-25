// AUT-05: the builder's conditions: "or" groups, a condition on a linked record, working hours and the weekday.
// Stored shape and engine rule: migration automation_conditions and condition-match.ts.

import type { Json } from "@/lib/database.types";

import type { ConditionLink } from "./condition-match";
import { CONDITIONS, TASK_TYPES, type ConditionOption, type Entity } from "./definitions";
import type { Lookups } from "./queries";

/** A condition in the builder: a field condition (on the record itself, or on a linked one), or a time condition. */
export type ConditionLeaf = { key: string; value: string; on?: ConditionLink };
/** An "or" group: one of its conditions is enough. */
export type ConditionGroup = { any: ConditionLeaf[] };
export type ConditionItem = ConditionLeaf | ConditionGroup;

export const MAX_CONDITION_ITEMS = 10;
export const MAX_GROUP_ITEMS = 10;
export const MAX_CONDITION_LEAVES = 20;

export const isGroup = (item: ConditionItem): item is ConditionGroup => "any" in item;

/** The linked records a rule's record type can test, by the column that points at them (owner: basic fields only). */
export const LINKS_FOR: Record<Entity, ConditionLink[]> = {
  lead: [],
  contact: ["company"],
  company: [],
  deal: ["contact", "company"],
  task: ["lead", "contact", "company", "deal"],
};

export const LINK_LABELS: Record<ConditionLink, string> = {
  contact: "איש הקשר",
  company: "החברה",
  deal: "העסקה",
  lead: "הליד",
};

/** Time conditions, judged when the rule runs (and again at a retry). */
export const TIME_CONDITIONS = [
  { key: "hours", label: "שעות העבודה של האחראי" },
  { key: "weekday", label: "היום בשבוע" },
] as const;
export const HOURS_CHOICES = [
  { value: "in", label: "בשעות העבודה" },
  { value: "out", label: "מחוץ לשעות העבודה" },
] as const;
/** 0 = Sunday, as the engine counts. */
export const WEEKDAYS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"] as const;

const isTimeKey = (key: string) => TIME_CONDITIONS.some((t) => t.key === key);

/** The field conditions offered for a record type, on the record itself or on one linked record. */
export function fieldConditionsFor(entity: Entity, on?: ConditionLink): ConditionOption[] {
  const target: Entity = on ?? entity;
  return CONDITIONS.filter((c) => c.entities.includes(target));
}

export function knownConditionKey(key: string): boolean {
  return isTimeKey(key) || CONDITIONS.some((c) => c.key === key);
}

/** The weekday choice as stored in the builder: "0,2,4" -> [0, 2, 4] (sorted, unique, 0..6), or null when none is valid. */
export function weekdaysFrom(value: string): number[] | null {
  const days = [...new Set(value.split(",").map((d) => d.trim()).filter((d) => /^[0-6]$/.test(d)).map(Number))].sort((a, b) => a - b);
  return days.length > 0 ? days : null;
}

export function countLeaves(items: ConditionItem[]): number {
  return items.reduce((sum, item) => sum + (isGroup(item) ? item.any.length : 1), 0);
}

type DbCondition = Record<string, unknown>;
type StoredCondition = Record<string, Json>;
const has = (list: Array<{ id: string }>, id: string | undefined) => !id || list.some((item) => item.id === id);

/** One builder condition -> its stored form, or an error message. */
function leafToDb(leaf: ConditionLeaf, entity: Entity, lookups: Lookups): StoredCondition | string {
  if (leaf.key === "hours") {
    if (leaf.on) return "תנאי הזמן חל על הרשומה עצמה.";
    if (leaf.value !== "in" && leaf.value !== "out") return "יש לבחור בשעות העבודה או מחוץ להן.";
    return { kind: "hours", value: leaf.value };
  }
  if (leaf.key === "weekday") {
    if (leaf.on) return "תנאי הזמן חל על הרשומה עצמה.";
    const days = weekdaysFrom(leaf.value);
    if (!days) return "יש לבחור לפחות יום אחד.";
    return { kind: "weekday", days };
  }
  if (leaf.on && !LINKS_FOR[entity].includes(leaf.on)) return "הרשומה המקושרת לא מתאימה לסוג הרשומה.";
  const option = CONDITIONS.find((c) => c.key === leaf.key);
  if (!option || !option.entities.includes(leaf.on ?? entity)) return "אחד התנאים לא מתאים לסוג הרשומה.";
  let value: string | undefined = leaf.value || undefined;
  if (option.input === "source" && !has(lookups.sources, value)) return "המקור שנבחר כבר לא קיים.";
  if (option.input === "status" && !has(lookups.statuses, value)) return "הסטטוס שנבחר כבר לא קיים.";
  if (option.input === "tag" && !has(lookups.tags, value)) return "התגית שנבחרה כבר לא קיימת.";
  if (option.input === "pipeline" && !has(lookups.pipelines, value)) return "תהליך המכירה שנבחר כבר לא קיים.";
  if (option.input === "shekels") {
    const shekels = Number(String(value).replace(/[,\s₪]/g, ""));
    if (!Number.isFinite(shekels) || shekels < 0) return "יש להזין סכום תקין בתנאי.";
    value = String(Math.round(shekels * 100));
  }
  const stored: StoredCondition =
    option.op === "empty" || value === undefined ? { field: option.field, op: option.op } : { field: option.field, op: option.op, value };
  return leaf.on ? { ...stored, on: leaf.on } : stored;
}

/** The builder's conditions -> the stored list, or an error message. */
export function conditionsToDb(items: ConditionItem[], entity: Entity, lookups: Lookups): StoredCondition[] | string {
  if (items.length > MAX_CONDITION_ITEMS) return `עד ${MAX_CONDITION_ITEMS} תנאים.`;
  if (countLeaves(items) > MAX_CONDITION_LEAVES) return `עד ${MAX_CONDITION_LEAVES} תנאים בסך הכול, כולל אלה שבתוך קבוצות "או".`;
  const out: StoredCondition[] = [];
  for (const item of items) {
    if (isGroup(item)) {
      if (item.any.length < 2 || item.any.length > MAX_GROUP_ITEMS) return `בקבוצת "או" יש 2 עד ${MAX_GROUP_ITEMS} תנאים.`;
      const any: StoredCondition[] = [];
      for (const leaf of item.any) {
        const stored = leafToDb(leaf, entity, lookups);
        if (typeof stored === "string") return stored;
        any.push(stored);
      }
      out.push({ any });
    } else {
      const stored = leafToDb(item, entity, lookups);
      if (typeof stored === "string") return stored;
      out.push(stored);
    }
  }
  return out;
}

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));
const linkOf = (value: unknown): ConditionLink | undefined =>
  typeof value === "string" && (["contact", "company", "deal", "lead"] as string[]).includes(value) ? (value as ConditionLink) : undefined;

/** One stored condition -> the builder's, or null when the builder does not know it (it is then left out). */
function leafFromDb(c: DbCondition, entity: Entity): ConditionLeaf | null {
  if (c.kind === "hours") return c.value === "in" || c.value === "out" ? { key: "hours", value: c.value } : null;
  if (c.kind === "weekday") return Array.isArray(c.days) ? { key: "weekday", value: c.days.map(String).join(",") } : null;
  const on = linkOf(c.on);
  if (c.on !== undefined && (!on || !LINKS_FOR[entity].includes(on))) return null;
  const option = CONDITIONS.find((o) => o.field === c.field && o.op === c.op && o.entities.includes(on ?? entity));
  if (!option) return null;
  const value = option.input === "shekels" ? str(Number(c.value ?? 0) / 100) : str(c.value);
  return { key: option.key, value: option.input === "none" ? "" : value, ...(on ? { on } : {}) };
}

/** The stored list -> the builder's conditions (unknown ones left out; a group left with one condition becomes that one). */
export function conditionsFromDb(stored: DbCondition[], entity: Entity): ConditionItem[] {
  return stored.flatMap((c): ConditionItem[] => {
    if (Array.isArray(c.any)) {
      const any = (c.any as DbCondition[]).flatMap((sub) => {
        const leaf = typeof sub === "object" && sub !== null ? leafFromDb(sub, entity) : null;
        return leaf ? [leaf] : [];
      });
      if (any.length === 0) return [];
      return any.length === 1 ? [any[0]] : [{ any }];
    }
    const leaf = leafFromDb(c, entity);
    return leaf ? [leaf] : [];
  });
}

const nameIn = (list: Array<{ id: string; name: string }>, id: unknown) => list.find((item) => item.id === id)?.name ?? "(נמחק)";

function describeLeaf(c: DbCondition, lookups: Lookups): string {
  if (c.kind === "hours") return c.value === "out" ? "מחוץ לשעות העבודה של האחראי" : "בשעות העבודה של האחראי";
  if (c.kind === "weekday") {
    const days = Array.isArray(c.days) ? c.days.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6) : [];
    return days.length === 1 ? `ביום ${WEEKDAYS[days[0]]}` : `בימים ${days.map((d) => WEEKDAYS[d]).join(", ")}`;
  }
  const option = CONDITIONS.find((o) => o.field === c.field && o.op === c.op);
  if (!option) return "תנאי לא מוכר";
  let text: string;
  switch (option.input) {
    case "source":
      text = `${option.label} ${nameIn(lookups.sources, c.value)}`;
      break;
    case "status":
      text = `${option.label} ${nameIn(lookups.statuses, c.value)}`;
      break;
    case "tag":
      text = `${option.label} ${nameIn(lookups.tags, c.value)}`;
      break;
    case "pipeline":
      text = `${option.label} ${nameIn(lookups.pipelines, c.value)}`;
      break;
    case "shekels":
      text = `${option.label} ${(Number(c.value) / 100).toLocaleString("he-IL")}`;
      break;
    case "task_type":
      text = `${option.label} ${TASK_TYPES.find((t) => t.value === c.value)?.label ?? c.value}`;
      break;
    default:
      text = option.label;
  }
  const on = linkOf(c.on);
  return on ? `${LINK_LABELS[on]}: ${text}` : text;
}

/** One line per stored condition, in Hebrew; an "or" group reads "אחד מאלה: … או …". */
export function describeConditions(stored: DbCondition[], lookups: Lookups): string[] {
  return stored.map((c) =>
    Array.isArray(c.any)
      ? `אחד מאלה: ${(c.any as DbCondition[]).map((sub) => (typeof sub === "object" && sub !== null ? describeLeaf(sub, lookups) : "תנאי לא מוכר")).join(" או ")}`
      : describeLeaf(c, lookups),
  );
}

/** Keeps the conditions that still fit a record type (after the trigger changes); a group left with one becomes that one. */
export function fitConditions(items: ConditionItem[], entity: Entity): ConditionItem[] {
  const fits = (leaf: ConditionLeaf) =>
    isTimeKey(leaf.key)
      ? !leaf.on
      : (!leaf.on || LINKS_FOR[entity].includes(leaf.on)) && fieldConditionsFor(entity, leaf.on).some((c) => c.key === leaf.key);
  return items.flatMap((item): ConditionItem[] => {
    if (!isGroup(item)) return fits(item) ? [item] : [];
    const any = item.any.filter(fits);
    return any.length === 0 ? [] : any.length === 1 ? [any[0]] : [{ any }];
  });
}

/** What the builder sends: an empty value is left out (the server asks for it where it is needed). */
export function conditionsPayload(items: ConditionItem[]): unknown[] {
  const leaf = (l: ConditionLeaf) => ({ key: l.key, ...(l.value ? { value: l.value } : {}), ...(l.on ? { on: l.on } : {}) });
  return items.map((item) => (isGroup(item) ? { any: item.any.map(leaf) } : leaf(item)));
}
