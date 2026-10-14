import type { Json } from "@/lib/database.types";

import { isEmptyCustomValue } from "./settings";
import type { FieldDefinition, FieldObject, FieldType } from "./types";

// FLD-09: a custom field that shows, or becomes required, depending on the value of
// another field (field_definitions.condition). The database checks the shape when it is
// written (app.field_condition_check, migration conditional_fields); what the condition
// does is app-only, like "required": "show" hides the field in forms and cards (its
// stored value is kept), "require" makes the record forms demand it. Public forms,
// imports, conversions and server paths never apply it.

export const CONDITION_OPS = ["equals", "not_equals", "in", "filled", "empty"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const CONDITION_EFFECTS = ["show", "require"] as const;
export type ConditionEffect = (typeof CONDITION_EFFECTS)[number];

export type FieldCondition = {
  // a custom field's key, or a built-in field "builtin:<name>"
  field: string;
  op: ConditionOp;
  value?: Json;
  effect: ConditionEffect;
};

export const BUILTIN_PREFIX = "builtin:";

/**
 * The marker input a record form puts inside each conditional field's fieldset: it is posted only
 * while the field shows in the browser (a hidden fieldset is disabled). On an edit the server skips a
 * conditional field whose marker did not arrive, so a stale screen never clears or demands a field
 * the person could not see.
 */
export function shownMarkerName(key: string): string {
  return `cond_shown_${key}`;
}

export type BuiltinConditionField = {
  key: string;
  label: string;
  // the form input that holds it, and the record's column
  input: string;
};

/** Built-in fields a condition may depend on (same list as app.field_condition_check). Their values are ids. */
export const BUILTIN_CONDITION_FIELDS: Record<FieldObject, BuiltinConditionField[]> = {
  lead: [
    { key: "builtin:status", label: "סטטוס", input: "status_id" },
    { key: "builtin:source", label: "מקור", input: "source_id" },
  ],
  deal: [{ key: "builtin:stage", label: "שלב", input: "stage_id" }],
  contact: [{ key: "builtin:type", label: "סוג איש קשר", input: "type_id" }],
  company: [{ key: "builtin:type", label: "סוג חברה", input: "type_id" }],
};

/** Controlling custom field types per op (same rule as the database). */
const EQUALS_TYPES: readonly FieldType[] = ["select", "multi_select", "checkbox", "rating"];
const IN_TYPES: readonly FieldType[] = ["select", "multi_select", "rating"];

export function opsForType(type: FieldType | "builtin"): ConditionOp[] {
  if (type === "builtin") return ["equals", "not_equals", "in", "filled", "empty"];
  const ops: ConditionOp[] = [];
  if (EQUALS_TYPES.includes(type)) ops.push("equals", "not_equals");
  if (IN_TYPES.includes(type)) ops.push("in");
  if (type !== "checkbox") ops.push("filled", "empty");
  return ops;
}

export const OP_LABELS: Record<ConditionOp, string> = {
  equals: "שווה ל",
  not_equals: "שונה מ",
  in: "אחד מ",
  filled: "מלא",
  empty: "ריק",
};

/** Reads a stored condition; anything that is not a valid shape is no condition. */
export function parseCondition(raw: Json | null | undefined): FieldCondition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { field, op, value, effect } = raw as Record<string, Json | undefined>;
  if (typeof field !== "string" || field === "") return null;
  if (typeof op !== "string" || !(CONDITION_OPS as readonly string[]).includes(op)) return null;
  if (typeof effect !== "string" || !(CONDITION_EFFECTS as readonly string[]).includes(effect)) return null;
  const condition: FieldCondition = { field, op: op as ConditionOp, effect: effect as ConditionEffect };
  if (op === "filled" || op === "empty") return condition;
  if (value === undefined || value === null) return null;
  if (op === "in" && !Array.isArray(value)) return null;
  if (op !== "in" && (Array.isArray(value) || typeof value === "object")) return null;
  return { ...condition, value };
}

export function isBuiltinKey(key: string): boolean {
  return key.startsWith(BUILTIN_PREFIX);
}

/** Values a condition reads: custom values by key, built-in ones by "builtin:<name>". */
export type ConditionValues = Record<string, Json | undefined>;

function sameValue(a: Json | undefined, b: Json): boolean {
  return a === b;
}

/**
 * Whether the condition holds for these values. Pure; mirrors nothing in the database
 * (the database never applies a condition). A multi_select holds a choice when it contains it.
 */
export function conditionHolds(condition: FieldCondition, values: ConditionValues): boolean {
  const current = values[condition.field];
  const empty = isEmptyCustomValue(current ?? null) || (Array.isArray(current) && current.length === 0);
  switch (condition.op) {
    case "filled":
      return !empty;
    case "empty":
      return empty;
    case "equals":
    case "not_equals": {
      const target = condition.value;
      if (target === undefined) return false;
      const match = Array.isArray(current) ? current.some((item) => sameValue(item, target)) : sameValue(current, target);
      // an unticked checkbox is false
      const checkboxFalse = target === false && (current === undefined || current === null);
      const equal = match || checkboxFalse;
      return condition.op === "equals" ? equal : !equal;
    }
    case "in": {
      const targets = Array.isArray(condition.value) ? condition.value : [];
      if (Array.isArray(current)) return current.some((item) => targets.some((target) => sameValue(item, target)));
      return targets.some((target) => sameValue(current, target));
    }
  }
}

/**
 * The controlling custom field, when the condition still applies: it exists among these
 * definitions (the active ones, in a record form or card) and its type still takes the op.
 * A built-in field always applies. Otherwise the condition is ignored (the field always
 * shows, and is required only by its own box).
 */
export function conditionApplies(condition: FieldCondition, definitions: FieldDefinition[], objectType?: FieldObject): boolean {
  if (isBuiltinKey(condition.field)) {
    return objectType ? BUILTIN_CONDITION_FIELDS[objectType].some((field) => field.key === condition.field) : true;
  }
  const controller = definitions.find((field) => field.key === condition.field);
  return controller !== undefined && controller.isActive && !controller.condition && opsForType(controller.type).includes(condition.op);
}

export type FieldState = { visible: boolean; required: boolean };

/** Whether a field shows and whether it is required, for these values. */
export function fieldState(field: FieldDefinition, definitions: FieldDefinition[], values: ConditionValues, objectType?: FieldObject): FieldState {
  const condition = field.condition ?? null;
  if (!condition || !conditionApplies(condition, definitions, objectType)) {
    return { visible: true, required: field.isRequired };
  }
  const holds = conditionHolds(condition, values);
  if (condition.effect === "show") {
    return holds ? { visible: true, required: field.isRequired } : { visible: false, required: false };
  }
  return { visible: true, required: field.isRequired || holds };
}

/** True when any of these fields has a condition that applies (so the form must watch its values). */
export function hasConditions(definitions: FieldDefinition[], objectType?: FieldObject): boolean {
  return definitions.some((field) => field.condition && conditionApplies(field.condition, definitions, objectType));
}

/** The custom fields that may control others: active, without a condition of their own, of a type that takes some op. */
export function controllerCandidates(field: FieldDefinition | null, definitions: FieldDefinition[]): FieldDefinition[] {
  return definitions.filter(
    (other) => other.key !== field?.key && other.isActive && !other.condition && other.type !== "user" && opsForType(other.type).length > 0,
  );
}

/** True when another field depends on this one (it may then not get a condition: no chains). */
export function isController(field: FieldDefinition, definitions: FieldDefinition[]): boolean {
  return definitions.some((other) => other.key !== field.key && other.condition?.field === field.key);
}

export type BuiltinChoices = Record<string, Array<{ value: string; label: string }>>;

/** The values a controlling field offers in the condition editor (choices, or yes/no, or 1..5). */
export function controllerChoices(key: string, definitions: FieldDefinition[], builtins: BuiltinChoices): Array<{ value: string; label: string }> {
  if (isBuiltinKey(key)) return builtins[key] ?? [];
  const controller = definitions.find((field) => field.key === key);
  if (!controller) return [];
  if (controller.type === "select" || controller.type === "multi_select") return controller.options.map((option) => ({ value: option, label: option }));
  if (controller.type === "checkbox") return [{ value: "true", label: "מסומן" }, { value: "false", label: "לא מסומן" }];
  if (controller.type === "rating") return [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} מתוך 5` }));
  return [];
}

/** A choice from the editor (always text) as the JSON value stored for that controller. */
export function choiceToValue(key: string, definitions: FieldDefinition[], choice: string): Json {
  const controller = isBuiltinKey(key) ? null : definitions.find((field) => field.key === key);
  if (controller?.type === "checkbox") return choice === "true";
  if (controller?.type === "rating") return Number(choice);
  return choice;
}

/** The value of a condition as the editor's text choices. */
export function valueToChoices(condition: FieldCondition | null): string[] {
  if (!condition || condition.value === undefined || condition.value === null) return [];
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  return values.map((value) => String(value));
}

/**
 * Builds the condition the field settings form sends, or explains why it cannot be saved.
 * Mirrors the database's checks for what the screen can know (the database decides).
 */
export function buildCondition(
  field: FieldDefinition,
  definitions: FieldDefinition[],
  objectType: FieldObject,
  builtins: BuiltinChoices,
  input: { effect: string; controller: string; op: string; choices: string[] },
): { ok: true; condition: FieldCondition | null } | { ok: false; message: string } {
  if (input.effect === "" || input.effect === "none") return { ok: true, condition: null };
  if (!(CONDITION_EFFECTS as readonly string[]).includes(input.effect)) return { ok: false, message: "יש לבחור מתי התנאי חל." };
  if (isController(field, definitions)) {
    return { ok: false, message: "שדה אחר תלוי בשדה הזה, ולכן אי אפשר להוסיף לו תנאי משלו." };
  }
  const effect = input.effect as ConditionEffect;
  const builtin = BUILTIN_CONDITION_FIELDS[objectType].find((item) => item.key === input.controller);
  const controller = builtin ? null : controllerCandidates(field, definitions).find((item) => item.key === input.controller);
  if (!builtin && !controller) return { ok: false, message: "יש לבחור שדה פעיל אחר, שאין לו תנאי משלו." };
  const ops = opsForType(controller ? controller.type : "builtin");
  if (!(ops as readonly string[]).includes(input.op)) return { ok: false, message: "יש לבחור תנאי שמתאים לשדה." };
  const op = input.op as ConditionOp;
  if (op === "filled" || op === "empty") return { ok: true, condition: { field: input.controller, op, effect } };
  const allowed = new Set(controllerChoices(input.controller, definitions, builtins).map((choice) => choice.value));
  const picked = [...new Set(input.choices.filter((choice) => allowed.has(choice)))];
  if (picked.length === 0 || picked.length !== new Set(input.choices).size) return { ok: false, message: "יש לבחור ערך מהרשימה." };
  if (op === "in") {
    if (picked.length > 50) return { ok: false, message: "אפשר לבחור עד 50 ערכים." };
    return { ok: true, condition: { field: input.controller, op, value: picked.map((choice) => choiceToValue(input.controller, definitions, choice)), effect } };
  }
  if (picked.length !== 1) return { ok: false, message: "יש לבחור ערך אחד." };
  return { ok: true, condition: { field: input.controller, op, value: choiceToValue(input.controller, definitions, picked[0]), effect } };
}

/** The controlling field's name for the screen, or null when it is gone. */
function controllerLabel(key: string, definitions: FieldDefinition[], objectType: FieldObject): string | null {
  const builtin = BUILTIN_CONDITION_FIELDS[objectType].find((item) => item.key === key);
  if (builtin) return builtin.label;
  return definitions.find((field) => field.key === key)?.label ?? null;
}

/** "מופיע רק כאשר "סטטוס" שווה ל "חדש"" — for the field settings list. */
export function describeCondition(condition: FieldCondition, definitions: FieldDefinition[], objectType: FieldObject, builtins: BuiltinChoices): string {
  const lead = condition.effect === "show" ? "מופיע רק כאשר" : "חובה כאשר";
  const label = controllerLabel(condition.field, definitions, objectType) ?? "שדה שנמחק";
  if (condition.op === "filled" || condition.op === "empty") return `${lead} "${label}" ${OP_LABELS[condition.op]}`;
  const choices = controllerChoices(condition.field, definitions, builtins);
  const names = valueToChoices(condition).map((value) => choices.find((choice) => choice.value === value)?.label ?? "ערך שהוסר");
  return `${lead} "${label}" ${OP_LABELS[condition.op]}: ${names.map((name) => `"${name}"`).join(", ")}`;
}

/**
 * Why a saved condition no longer works, or null. All definitions of the type (hidden ones
 * included) are passed. The condition is then ignored by the forms and cards.
 */
export function conditionReminder(
  field: FieldDefinition,
  definitions: FieldDefinition[],
  objectType: FieldObject,
  builtins: BuiltinChoices,
): string | null {
  const condition = field.condition;
  if (!condition) return null;
  if (isBuiltinKey(condition.field)) {
    if (!BUILTIN_CONDITION_FIELDS[objectType].some((item) => item.key === condition.field)) return "התנאי של השדה לא תקין, ולכן השדה מופיע תמיד. עדכנו את התנאי.";
  } else {
    const controller = definitions.find((other) => other.key === condition.field);
    if (!controller) return "השדה שהתנאי תלוי בו נמחק, ולכן השדה מופיע תמיד. עדכנו או הסירו את התנאי.";
    if (!controller.isActive) return `השדה "${controller.label}" שהתנאי תלוי בו מוסתר, ולכן השדה מופיע תמיד. הציגו אותו שוב או עדכנו את התנאי.`;
    if (!conditionApplies(condition, definitions, objectType)) return "התנאי של השדה כבר לא מתאים לשדה שהוא תלוי בו, ולכן השדה מופיע תמיד. עדכנו את התנאי.";
  }
  if (condition.op === "filled" || condition.op === "empty") return null;
  const choices = controllerChoices(condition.field, definitions, builtins);
  // built-in lists are loaded only on the settings page; without them nothing is known
  if (isBuiltinKey(condition.field) && !(condition.field in builtins)) return null;
  const missing = valueToChoices(condition).filter((value) => !choices.some((choice) => choice.value === value));
  if (missing.length > 0) {
    return condition.effect === "show"
      ? "ערך שהתנאי בודק הוסר מהרשימה, אז ייתכן שהשדה לא יופיע אף פעם. עדכנו את התנאי."
      : "ערך שהתנאי בודק הוסר מהרשימה. עדכנו את התנאי.";
  }
  return null;
}

/**
 * The condition values of a submitted form: the custom values (parsed), the built-in inputs
 * the action writes, and for the rest what the record holds (stored).
 */
export function conditionValuesFromForm(
  objectType: FieldObject,
  formData: FormData,
  parsed: Record<string, Json | undefined>,
  stored: { custom?: Record<string, Json | undefined>; builtins?: Record<string, string | null> } = {},
  // the built-in fields ("builtin:status") the action writes from this form; any other input is ignored
  written: readonly string[] = [],
): ConditionValues {
  const values: ConditionValues = { ...(stored.custom ?? {}) };
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) values[key] = value;
  }
  for (const builtin of BUILTIN_CONDITION_FIELDS[objectType]) {
    if (written.includes(builtin.key) && formData.has(builtin.input)) {
      const raw = formData.get(builtin.input);
      values[builtin.key] = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
    } else {
      values[builtin.key] = stored.builtins?.[builtin.key] ?? null;
    }
  }
  return values;
}

/** True when the editor's inputs say exactly what is stored (then nothing is re-checked or sent). */
export function sameAsStored(stored: FieldCondition | null | undefined, input: { effect: string; controller: string; op: string; choices: string[] }): boolean {
  if (!stored) return input.effect === "" || input.effect === "none";
  if (stored.effect !== input.effect || stored.field !== input.controller || stored.op !== input.op) return false;
  const a = [...valueToChoices(stored)].sort();
  const b = [...new Set(input.choices)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
