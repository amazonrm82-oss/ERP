// Lead score rules (LEAD-05). Mirrors migration lead_score: the field keys and their
// operators (app.lead_score_rule_check), the activity types (app.lead_score_activity_types) and
// the suggested rules (app.seed_lead_score_rules);
// tests/unit/lead-score.test.ts reads the migration and compares. The score itself is
// computed in the database only (leads.score, trigger leads_zz_score).

import type { FieldDefinition, FieldType } from "@/features/custom-fields/types";
import { formatMoney, formatNumber, parseMoneyToAgorot } from "@/lib/format";

export const SCORE_RULES_MAX = 50;
export const SCORE_POINTS_MIN = -100;
export const SCORE_POINTS_MAX = 100;
export const SCORE_ACTIVITY_MAX = 100;

export const SCORE_OPS = ["filled", "empty", "eq", "neq", "gte", "lte"] as const;
export type ScoreOp = (typeof SCORE_OPS)[number];

// what the value is: none, an option picked from a list, a sum in shekels (stored in agorot), a number, a count
export type ValueKind = "none" | "option" | "money" | "number" | "count";

export type BuiltInScoreField = { key: string; label: string; ops: readonly ScoreOp[] };

export const SCORE_BUILT_IN: readonly BuiltInScoreField[] = [
  { key: "source", label: "מקור", ops: ["eq", "neq"] },
  { key: "status", label: "סטטוס", ops: ["eq", "neq"] },
  { key: "tag", label: "תגית", ops: ["eq", "neq"] },
  { key: "owner", label: "אחראי", ops: ["filled", "empty"] },
  { key: "email", label: "אימייל", ops: ["filled", "empty"] },
  { key: "phone", label: "טלפון", ops: ["filled", "empty"] },
  { key: "company", label: "חברה", ops: ["filled", "empty"] },
  { key: "job_title", label: "תפקיד", ops: ["filled", "empty"] },
  { key: "campaign", label: "קמפיין", ops: ["filled", "empty"] },
  { key: "message", label: "תוכן הפנייה", ops: ["filled", "empty"] },
  { key: "product", label: "מוצר מבוקש", ops: ["filled", "empty"] },
  { key: "budget", label: "תקציב", ops: ["filled", "empty", "gte", "lte"] },
  // asked for a call-back in a public form (SPD-05), as a new lead or a repeat inquiry
  { key: "callback", label: "בקשה לחזור אליהם בטופס", ops: ["filled", "empty"] },
];

/**
 * The five rules a new business starts with (owner, 14 October 2026), and what the
 * rules screen's "הוסף את הכללים המוצעים" adds for a business that has none.
 */
export const SUGGESTED_RULES: ReadonlyArray<{ field: string; op: ScoreOp; value: string | null; points: number }> = [
  { field: "email", op: "filled", value: null, points: 10 },
  { field: "phone", op: "filled", value: null, points: 10 },
  { field: "activity:call", op: "gte", value: "1", points: 10 },
  { field: "activity:meeting", op: "gte", value: "1", points: 20 },
  { field: "callback", op: "filled", value: null, points: 15 },
];

export const SCORE_ACTIVITY_TYPES = [
  { value: "call", one: "שיחה אחת", plural: "שיחות" },
  { value: "meeting", one: "פגישה אחת", plural: "פגישות" },
  { value: "whatsapp", one: "הודעת WhatsApp אחת", plural: "הודעות WhatsApp" },
  { value: "email", one: "אימייל אחד", plural: "אימיילים" },
  { value: "sms", one: "הודעת SMS אחת", plural: "הודעות SMS" },
  { value: "note", one: "הערה אחת", plural: "הערות" },
  { value: "inquiry", one: "פנייה חוזרת אחת", plural: "פניות חוזרות" },
] as const;

export const CF_PREFIX = "cf:";
export const ACTIVITY_PREFIX = "activity:";

const NUMBER_TYPES: readonly FieldType[] = ["number", "currency", "percent", "rating"];

/** The operators a custom field of this type takes (none: the type cannot be scored). */
export function customFieldOps(type: FieldType): readonly ScoreOp[] {
  if (type === "checkbox") return ["eq"];
  if (type === "select" || type === "multi_select") return ["filled", "empty", "eq", "neq"];
  if (NUMBER_TYPES.includes(type)) return ["filled", "empty", "gte", "lte"];
  return ["filled", "empty"];
}

export type ScoreLookups = {
  statuses: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  // the business's active lead custom fields
  fields: FieldDefinition[];
};

/** One rule's field as the form offers it: its operators and what its value is. */
export type ScoreFieldChoice = {
  key: string;
  label: string;
  group: "lead" | "custom" | "activity";
  ops: readonly ScoreOp[];
  // what each operator's value is (plain data, so the form in the browser gets it too)
  kinds: Partial<Record<ScoreOp, ValueKind>>;
  options?: Array<{ value: string; label: string }>;
};

function kindsOf(ops: readonly ScoreOp[], kind: (op: ScoreOp) => ValueKind): Partial<Record<ScoreOp, ValueKind>> {
  return Object.fromEntries(ops.map((op) => [op, kind(op)]));
}

/** What the value of a field's operator is ("none" for an operator the field does not take). */
export function valueKindOf(choice: Pick<ScoreFieldChoice, "kinds">, op: ScoreOp): ValueKind {
  return choice.kinds[op] ?? "none";
}

export function scoreFieldChoices(lookups: ScoreLookups): ScoreFieldChoice[] {
  const option = (op: ScoreOp): ValueKind => (op === "eq" || op === "neq" ? "option" : "none");
  const builtIn = SCORE_BUILT_IN.map((field): ScoreFieldChoice => {
    const options =
      field.key === "source"
        ? lookups.sources.map((s) => ({ value: s.id, label: s.name }))
        : field.key === "status"
          ? lookups.statuses.map((s) => ({ value: s.id, label: s.name }))
          : field.key === "tag"
            ? lookups.tags.map((t) => ({ value: t.id, label: t.name }))
            : undefined;
    return {
      key: field.key,
      label: field.label,
      group: "lead",
      ops: field.ops,
      kinds: kindsOf(field.ops, field.key === "budget" ? (op) => (op === "gte" || op === "lte" ? "money" : "none") : option),
      options,
    };
  });
  const custom = lookups.fields
    .filter((field) => field.isActive)
    .map((field): ScoreFieldChoice => ({
      key: `${CF_PREFIX}${field.key}`,
      label: field.label,
      group: "custom",
      ops: customFieldOps(field.type),
      kinds: kindsOf(customFieldOps(field.type), (op) =>
        op === "gte" || op === "lte" ? (field.type === "currency" ? "money" : "number") : op === "eq" || op === "neq" ? "option" : "none",
      ),
      options:
        field.type === "checkbox"
          ? [
              { value: "true", label: "מסומן" },
              { value: "false", label: "לא מסומן" },
            ]
          : field.type === "select" || field.type === "multi_select"
            ? field.options.map((o) => ({ value: o, label: o }))
            : undefined,
    }));
  const activity = SCORE_ACTIVITY_TYPES.map(
    (type): ScoreFieldChoice => ({ key: `${ACTIVITY_PREFIX}${type.value}`, label: type.plural, group: "activity", ops: ["gte"], kinds: { gte: "count" } }),
  );
  return [...builtIn, ...custom, ...activity];
}

/** The words of an operator for a field (the form's second list). */
export function opLabel(choice: Pick<ScoreFieldChoice, "key" | "group">, op: ScoreOp): string {
  if (choice.group === "activity") return "לפחות";
  if (choice.key === "tag") return op === "eq" ? "יש את התגית" : "אין את התגית";
  if (choice.key === "callback") return op === "filled" ? "ביקשו" : "לא ביקשו";
  switch (op) {
    case "filled":
      return "מלא";
    case "empty":
      return "ריק";
    case "eq":
      return "הוא";
    case "neq":
      return "אינו";
    case "gte":
      return "לפחות";
    case "lte":
      return "לכל היותר";
  }
}

export type ScoreRule = { id: string; field: string; op: string; value: string | null; points: number; isActive: boolean };

/** A rule in plain Hebrew, e.g. "המקור הוא פייסבוק", "לפחות 2 שיחות". `known` is false when its field or value is gone. */
export function describeRule(rule: Pick<ScoreRule, "field" | "op" | "value">, lookups: ScoreLookups): { text: string; known: boolean } {
  const choice = scoreFieldChoices(lookups).find((c) => c.key === rule.field);
  const op = rule.op as ScoreOp;
  if (!choice || !choice.ops.includes(op)) {
    return { text: "שדה שהוסר או שהשתנה", known: false };
  }
  if (choice.group === "activity") {
    const count = Number(rule.value);
    const type = SCORE_ACTIVITY_TYPES.find((t) => `${ACTIVITY_PREFIX}${t.value}` === rule.field);
    return { text: count === 1 && type ? `לפחות ${type.one} בציר הזמן` : `לפחות ${formatNumber(count)} ${choice.label} בציר הזמן`, known: true };
  }
  if (choice.key === "callback") {
    return { text: op === "filled" ? "ביקשו בטופס שנחזור אליהם" : "לא ביקשו בטופס שנחזור אליהם", known: true };
  }
  const kind = valueKindOf(choice, op);
  if (kind === "none") {
    return { text: `${choice.label}: ${opLabel(choice, op)}`, known: true };
  }
  if (kind === "option") {
    const picked = choice.options?.find((o) => o.value === rule.value);
    if (!picked) return { text: `${choice.label}: ערך שהוסר`, known: false };
    if (choice.key === "tag") return { text: `${opLabel(choice, op)} "${picked.label}"`, known: true };
    return { text: `${choice.label} ${opLabel(choice, op)} "${picked.label}"`, known: true };
  }
  const amount = Number(rule.value);
  const shown = kind === "money" ? formatMoney(amount) : formatNumber(amount);
  return { text: `${choice.label} ${opLabel(choice, op)} ${shown}`, known: true };
}

/** "+10" / "−5" for a number of points. */
export function pointsText(points: number): string {
  return points > 0 ? `+${points}` : `−${Math.abs(points)}`;
}

export type RuleInput = { field: string; op: string; value: string; direction: string; points: string };
export type ParsedRule = { field: string; op: ScoreOp; value: string | null; points: number };

const NUMBER_RE = /^-?\d{1,15}(\.\d{1,4})?$/;

/** Checks a rule typed in the form against the business's fields, and turns it into what the table stores. */
export function parseRule(input: RuleInput, lookups: ScoreLookups): { ok: true; rule: ParsedRule } | { ok: false; fieldErrors: Record<string, string> } {
  const choice = scoreFieldChoices(lookups).find((c) => c.key === input.field);
  if (!choice) return { ok: false, fieldErrors: { field: "יש לבחור על מה הכלל." } };
  const op = input.op as ScoreOp;
  if (!choice.ops.includes(op)) return { ok: false, fieldErrors: { op: "יש לבחור תנאי." } };

  const raw = input.value.trim();
  let value: string | null = null;
  switch (valueKindOf(choice, op)) {
    case "none":
      break;
    case "option":
      if (!choice.options?.some((o) => o.value === raw)) return { ok: false, fieldErrors: { value: "יש לבחור ערך מהרשימה." } };
      value = raw;
      break;
    case "money": {
      const agorot = raw === "" ? null : parseMoneyToAgorot(raw);
      if (agorot === null || agorot > 999_999_999_999_999) return { ok: false, fieldErrors: { value: "יש להזין סכום בשקלים." } };
      value = String(agorot);
      break;
    }
    case "number":
      if (!NUMBER_RE.test(raw)) return { ok: false, fieldErrors: { value: "יש להזין מספר." } };
      value = raw;
      break;
    case "count": {
      const count = Number(raw);
      if (!/^\d{1,3}$/.test(raw) || count < 1 || count > SCORE_ACTIVITY_MAX) return { ok: false, fieldErrors: { value: `יש להזין מספר בין 1 ל-${SCORE_ACTIVITY_MAX}.` } };
      value = String(count);
      break;
    }
  }

  const amount = Number(input.points.trim());
  if (!/^\d{1,3}$/.test(input.points.trim()) || amount < 1 || amount > SCORE_POINTS_MAX) {
    return { ok: false, fieldErrors: { points: `יש להזין מספר נקודות בין 1 ל-${SCORE_POINTS_MAX}.` } };
  }
  if (input.direction !== "add" && input.direction !== "subtract") return { ok: false, fieldErrors: { direction: "יש לבחור אם להוסיף או להוריד." } };
  return { ok: true, rule: { field: choice.key, op, value, points: input.direction === "add" ? amount : -amount } };
}
