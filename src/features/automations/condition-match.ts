// AUT-05: the rule that judges an automation's conditions, mirrored from app.automation_condition_tree (migration
// automation_conditions). Both run the cases of tests/unit/fixtures/automation-conditions.json; keep them in step.
//
// conditions: an array whose items all must hold. An item is a leaf {field, op, value?, on?} judged on records[on ?? "self"],
// an "or" group {any: [item, ...]} (2..10 items, no group inside), {kind: "hours", value: "in" | "out"} or
// {kind: "weekday", days: [0..6]}. Anything else does not hold.

export type ConditionRecords = Partial<Record<"self" | "contact" | "company" | "deal" | "lead", Record<string, unknown> | null>>;
export type ConditionContext = { in_hours?: boolean; weekday?: number };

export const LINKS = ["contact", "company", "deal", "lead"] as const;
export type ConditionLink = (typeof LINKS)[number];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The text PostgreSQL's `#>> '{}'` / `->>` gives for a JSON value (strings bare, everything else as JSON text).
 * One difference cannot be mirrored: PostgreSQL keeps a number's written form ("1.0", "10.50"), while JSON.parse here
 * makes it 1 / 10.5. It cannot reach the engine from the builder: a person may save only text values
 * (app.automation_condition_item_ok), and the fields the builder's conditions read are ids, tags, task types and
 * amount_agorot (bigint, never written with a fraction). The fixture holds the text cases that do occur.
 */
function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => (typeof v === "string" ? JSON.stringify(v) : (jsonText(v) ?? "null"))).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${JSON.stringify(k)}: ${typeof v === "string" ? JSON.stringify(v) : (jsonText(v) ?? "null")}`)
    .join(", ")}}`;
}

const NUMBER = /^-?[0-9.]+$/;

/** A number comparison raises in the database when a side passes the pattern but is no number ("1.2.3"); so does this. */
function numeric(text: string): number {
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) throw new Error(`invalid input syntax for type numeric: "${text}"`);
  return Number(text);
}

/** One leaf on one record (app.automation_condition_leaf). */
export function conditionLeafMatch(record: Record<string, unknown> | null | undefined, cond: Record<string, unknown>): boolean {
  const field = cond.field;
  if (!isObject(record) || typeof field !== "string" || !/^[a-z_]{1,40}$/.test(field)) return false;
  const actual = record[field];
  const text = jsonText(actual);
  const value = cond.value === undefined ? null : jsonText(cond.value);
  const empty = text === null || text === "" || text === "[]";
  switch (cond.op) {
    case "eq":
      return text === value;
    case "neq":
      return text !== value;
    case "empty":
      return empty;
    case "not_empty":
      return !empty;
    case "gte":
    case "lte":
      if (text === null || value === null || !NUMBER.test(text) || !NUMBER.test(value)) return false;
      return cond.op === "gte" ? numeric(text) >= numeric(value) : numeric(text) <= numeric(value);
    case "has_tag":
      return Array.isArray(actual) && typeof value === "string" && actual.some((v) => v === value);
    default:
      return false;
  }
}

/** One item (app.automation_condition_item). */
export function conditionItemMatch(item: unknown, records: ConditionRecords, ctx: ConditionContext, group = true): boolean {
  if (!isObject(item)) return false;
  if ("any" in item) {
    const any = item.any;
    if (!group || !Array.isArray(any) || any.length < 2 || any.length > 10) return false;
    return any.some((sub) => conditionItemMatch(sub, records, ctx, false));
  }
  if ("kind" in item) {
    if (item.kind === "hours") {
      return typeof ctx.in_hours === "boolean" && (item.value === "in" || item.value === "out") && ctx.in_hours === (item.value === "in");
    }
    if (item.kind === "weekday") {
      return Array.isArray(item.days) && typeof ctx.weekday === "number" && item.days.some((d) => typeof d === "number" && d === ctx.weekday);
    }
    return false;
  }
  const on = item.on === undefined || item.on === null ? "self" : item.on;
  if (on !== "self" && !LINKS.includes(on as ConditionLink)) return false;
  return conditionLeafMatch(records[on as keyof ConditionRecords], item);
}

/** The whole list (app.automation_condition_tree): every item holds; no list = no conditions. */
export function conditionTreeMatch(conditions: unknown, records: ConditionRecords, ctx: ConditionContext): boolean {
  if (conditions === null || conditions === undefined) return true;
  if (!Array.isArray(conditions)) return false;
  return conditions.every((item) => conditionItemMatch(item, records, ctx, true));
}
