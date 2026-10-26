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

/** One test of a condition: a field, an op and (for equals / not_equals / in) a value. */
export type ConditionPart = {
  // a custom field's key, or a built-in field "builtin:<name>"
  field: string;
  op: ConditionOp;
  value?: Json;
};

export type FieldCondition = ConditionPart & {
  effect: ConditionEffect;
  // FLD-09 follow-up (owner, 15 October 2026): a deal field may hold a pipeline condition and a stage
  // condition together; it is enough that one of them holds. Only that pair (either order).
  or?: ConditionPart;
};

/** The built-in pair that may share one field's condition (main part and "or"), either way round. */
export const OR_PAIR: Record<string, string> = { "builtin:stage": "builtin:pipeline", "builtin:pipeline": "builtin:stage" };

/** The built-in field a second ("or") part of a deal condition is on, given the main part's field; null when none may be added. */
export function orFieldFor(objectType: FieldObject, field: string): string | null {
  return objectType === "deal" ? (OR_PAIR[field] ?? null) : null;
}

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
  // a pipeline condition holds in every stage of the pipeline, stages added later included
  deal: [
    { key: "builtin:pipeline", label: "תהליך מכירה", input: "pipeline_id" },
    { key: "builtin:stage", label: "שלב", input: "stage_id" },
  ],
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

function parsePart(raw: Json | null | undefined): ConditionPart | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { field, op, value } = raw as Record<string, Json | undefined>;
  if (typeof field !== "string" || field === "") return null;
  if (typeof op !== "string" || !(CONDITION_OPS as readonly string[]).includes(op)) return null;
  const part: ConditionPart = { field, op: op as ConditionOp };
  if (op === "filled" || op === "empty") return part;
  if (value === undefined || value === null) return null;
  if (op === "in" && !Array.isArray(value)) return null;
  if (op !== "in" && (Array.isArray(value) || typeof value === "object")) return null;
  return { ...part, value };
}

/** Reads a stored condition; anything that is not a valid shape is no condition. */
export function parseCondition(raw: Json | null | undefined): FieldCondition | null {
  const main = parsePart(raw);
  if (!main || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { effect, or } = raw as Record<string, Json | undefined>;
  if (typeof effect !== "string" || !(CONDITION_EFFECTS as readonly string[]).includes(effect)) return null;
  const condition: FieldCondition = { ...main, effect: effect as ConditionEffect };
  if (or === undefined || or === null) return condition;
  const second = parsePart(or);
  if (!second || OR_PAIR[main.field] !== second.field) return null;
  return { ...condition, or: second };
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
 * Whether the condition holds for these values: its main part, or its "or" part (a deal's pipeline
 * beside its stage). Pure; mirrors nothing in the database (the database never applies a condition).
 */
export function conditionHolds(condition: FieldCondition, values: ConditionValues): boolean {
  return partHolds(condition, values) || (condition.or !== undefined && partHolds(condition.or, values));
}

/** Whether one part holds. A multi_select holds a choice when it contains it. */
function partHolds(condition: ConditionPart, values: ConditionValues): boolean {
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
  if (condition.or && !(objectType ? BUILTIN_CONDITION_FIELDS[objectType].some((field) => field.key === condition.or?.field) : true)) return false;
  if (isBuiltinKey(condition.field)) {
    return objectType ? BUILTIN_CONDITION_FIELDS[objectType].some((field) => field.key === condition.field) : true;
  }
  const controller = definitions.find((field) => field.key === condition.field);
  return controller !== undefined && controller.isActive && !controller.condition && opsForType(controller.type).includes(condition.op);
}

export type FieldState = { visible: boolean; required: boolean };

/**
 * Whether a field shows and whether it is required, for these values. `files`: the edit card of a saved record, where a
 * file field can be filled (FLD-06 part B follow-up, owner 26 October 2026, answer 4 (ב)): there a "require" condition
 * holds for a file field too; anywhere else (a create form, a move, a table cell, bulk) it never asks for a file.
 */
export function fieldState(
  field: FieldDefinition,
  definitions: FieldDefinition[],
  values: ConditionValues,
  objectType?: FieldObject,
  options: { files?: boolean } = {},
): FieldState {
  const condition = field.condition ?? null;
  if (!condition || !conditionApplies(condition, definitions, objectType)) {
    return { visible: true, required: field.isRequired };
  }
  const holds = conditionHolds(condition, values);
  if (condition.effect === "show") {
    return holds ? { visible: true, required: field.isRequired } : { visible: false, required: false };
  }
  // FLD-06 part B: a file is added on the card after the record is saved, so only the edit card asks for it
  return { visible: true, required: field.isRequired || (holds && (field.type !== "file" || options.files === true)) };
}

/**
 * FLD-06 part B follow-up (owner, 26 October 2026, answers 3 and 4 (ב)): a file field the edit card requires, by its own
 * "required" box or by a "require" condition that holds for these values. Its file may be replaced by a new one, never
 * removed. App-only, like "required" itself.
 */
export function fileFieldRequired(field: FieldDefinition, definitions: FieldDefinition[], values: ConditionValues, objectType?: FieldObject): boolean {
  if (field.type !== "file" || !field.isActive) return false;
  const state = fieldState(field, definitions, values, objectType, { files: true });
  return state.visible && state.required;
}

/** Why a required file field's file is not removed (the edit card and the remove action). */
export function requiredFileKeptMessage(label: string): string {
  return `"${label}" הוא שדה חובה: אפשר להחליף את הקובץ, אבל לא להסיר אותו.`;
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

/** The value of a condition (or one part of it) as the editor's text choices. */
export function valueToChoices(condition: ConditionPart | null | undefined): string[] {
  if (!condition || condition.value === undefined || condition.value === null) return [];
  const values = Array.isArray(condition.value) ? condition.value : [condition.value];
  return values.map((value) => String(value));
}

/** What the condition editor sends. orOp / orChoices: the optional second part (a deal's pipeline beside its stage). */
export type ConditionInput = { effect: string; controller: string; op: string; choices: string[]; orOp?: string; orChoices?: string[] };

/** One part of the editor's input as a condition part, or why it cannot be saved. */
function buildPart(
  field: FieldDefinition,
  definitions: FieldDefinition[],
  objectType: FieldObject,
  builtins: BuiltinChoices,
  controllerKey: string,
  opInput: string,
  choices: string[],
): { ok: true; part: ConditionPart } | { ok: false; message: string } {
  const builtin = BUILTIN_CONDITION_FIELDS[objectType].find((item) => item.key === controllerKey);
  const controller = builtin ? null : controllerCandidates(field, definitions).find((item) => item.key === controllerKey);
  if (!builtin && !controller) return { ok: false, message: "יש לבחור שדה פעיל אחר, שאין לו תנאי משלו." };
  const ops = opsForType(controller ? controller.type : "builtin");
  if (!(ops as readonly string[]).includes(opInput)) return { ok: false, message: "יש לבחור תנאי שמתאים לשדה." };
  const op = opInput as ConditionOp;
  if (op === "filled" || op === "empty") return { ok: true, part: { field: controllerKey, op } };
  const allowed = new Set(controllerChoices(controllerKey, definitions, builtins).map((choice) => choice.value));
  const picked = [...new Set(choices.filter((choice) => allowed.has(choice)))];
  if (picked.length === 0 || picked.length !== new Set(choices).size) return { ok: false, message: "יש לבחור ערך מהרשימה." };
  if (op === "in") {
    if (picked.length > 50) return { ok: false, message: "אפשר לבחור עד 50 ערכים." };
    return { ok: true, part: { field: controllerKey, op, value: picked.map((choice) => choiceToValue(controllerKey, definitions, choice)) } };
  }
  if (picked.length !== 1) return { ok: false, message: "יש לבחור ערך אחד." };
  return { ok: true, part: { field: controllerKey, op, value: choiceToValue(controllerKey, definitions, picked[0]) } };
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
  input: ConditionInput,
): { ok: true; condition: FieldCondition | null } | { ok: false; message: string } {
  if (input.effect === "" || input.effect === "none") return { ok: true, condition: null };
  if (!(CONDITION_EFFECTS as readonly string[]).includes(input.effect)) return { ok: false, message: "יש לבחור מתי התנאי חל." };
  if (isController(field, definitions)) {
    return { ok: false, message: "שדה אחר תלוי בשדה הזה, ולכן אי אפשר להוסיף לו תנאי משלו." };
  }
  const effect = input.effect as ConditionEffect;
  const main = buildPart(field, definitions, objectType, builtins, input.controller, input.op, input.choices);
  if (!main.ok) return main;
  const orField = orFieldFor(objectType, input.controller);
  const orOp = input.orOp ?? "";
  if (!orField || orOp === "" || orOp === "none") return { ok: true, condition: { ...main.part, effect } };
  const second = buildPart(field, definitions, objectType, builtins, orField, orOp, input.orChoices ?? []);
  if (!second.ok) return second;
  return { ok: true, condition: { ...main.part, effect, or: second.part } };
}

/** The controlling field's name for the screen, or null when it is gone. */
function controllerLabel(key: string, definitions: FieldDefinition[], objectType: FieldObject): string | null {
  const builtin = BUILTIN_CONDITION_FIELDS[objectType].find((item) => item.key === key);
  if (builtin) return builtin.label;
  return definitions.find((field) => field.key === key)?.label ?? null;
}

function describePart(part: ConditionPart, definitions: FieldDefinition[], objectType: FieldObject, builtins: BuiltinChoices): string {
  const label = controllerLabel(part.field, definitions, objectType) ?? "שדה שנמחק";
  if (part.op === "filled" || part.op === "empty") return `"${label}" ${OP_LABELS[part.op]}`;
  const choices = controllerChoices(part.field, definitions, builtins);
  const names = valueToChoices(part).map((value) => choices.find((choice) => choice.value === value)?.label ?? "ערך שהוסר");
  return `"${label}" ${OP_LABELS[part.op]}: ${names.map((name) => `"${name}"`).join(", ")}`;
}

/** "מופיע רק כאשר "סטטוס" שווה ל "חדש"" (and "… או "שלב" …" with a second part) — for the field settings list. */
export function describeCondition(condition: FieldCondition, definitions: FieldDefinition[], objectType: FieldObject, builtins: BuiltinChoices): string {
  const lead = condition.effect === "show" ? "מופיע רק כאשר" : "חובה כאשר";
  const main = `${lead} ${describePart(condition, definitions, objectType, builtins)}`;
  return condition.or ? `${main}, או כאשר ${describePart(condition.or, definitions, objectType, builtins)}` : main;
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
  const removedValue = (part: ConditionPart): boolean => {
    if (part.op === "filled" || part.op === "empty") return false;
    // built-in lists are loaded only on the settings page; without them nothing is known
    if (isBuiltinKey(part.field) && !(part.field in builtins)) return false;
    const choices = controllerChoices(part.field, definitions, builtins);
    return valueToChoices(part).some((value) => !choices.some((choice) => choice.value === value));
  };
  if (removedValue(condition) || (condition.or !== undefined && removedValue(condition.or))) {
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

function sameChoices(stored: ConditionPart | undefined, choices: string[]): boolean {
  const a = [...valueToChoices(stored)].sort();
  const b = [...new Set(choices)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** True when the editor's inputs say exactly what is stored (then nothing is re-checked or sent). */
export function sameAsStored(stored: FieldCondition | null | undefined, input: ConditionInput): boolean {
  if (!stored) return input.effect === "" || input.effect === "none";
  if (stored.effect !== input.effect || stored.field !== input.controller || stored.op !== input.op) return false;
  if (!sameChoices(stored, input.choices)) return false;
  const orOp = input.orOp === "none" ? "" : (input.orOp ?? "");
  if (!stored.or) return orOp === "";
  return stored.or.op === orOp && sameChoices(stored.or, input.orChoices ?? []);
}

/** A required custom field's value is missing (same rule as parseCustomFields: a box must be ticked). */
function requiredValueMissing(field: FieldDefinition, value: Json | undefined): boolean {
  if (field.type === "checkbox") return value !== true;
  if (Array.isArray(value)) return value.length === 0;
  return isEmptyCustomValue(value ?? null);
}

/**
 * FLD-09 (owner, 14 October 2026): the fields a change of a built-in field (a lead's status, a deal's
 * stage) would leave required by their condition and empty on the record. Only fields with a
 * condition that applies count; a field required by its own box alone is the record form's business.
 * Used by the board, the table cells (which then ask for the values) and bulk actions (which skip).
 */
export function missingRequiredAfter(
  definitions: FieldDefinition[],
  values: ConditionValues,
  objectType: FieldObject,
  change: ConditionValues,
): FieldDefinition[] {
  const after: ConditionValues = { ...values, ...change };
  return definitions.filter(
    (field) =>
      field.condition !== null &&
      field.condition !== undefined &&
      // FLD-06 part B follow-up: a file is asked only by the edit card, never by a move
      field.type !== "file" &&
      conditionApplies(field.condition, definitions, objectType) &&
      fieldState(field, definitions, after, objectType).required &&
      requiredValueMissing(field, after[field.key]),
  );
}

/** "חסר שדה חובה: תקציב, תאריך חתימה" (the owner's wording) */
export function missingFieldsMessage(fields: Array<{ label: string }>): string {
  return `חסר שדה חובה: ${fields.map((field) => field.label).join(", ")}`;
}

/**
 * FLD-09 follow-up (owner, 15 October 2026): a deal field's condition after its pipeline is deleted.
 * Every part on "builtin:pipeline" loses that pipeline's id and every part on "builtin:stage" the ids
 * of its stages: a list keeps its other values, a part with one value on it (or a list left empty)
 * goes, filled / empty stay. One part left becomes the condition; none left = no condition. Mirrors
 * app.condition_without_pipeline() (test 108 compares them); the database applies it when the
 * pipeline is deleted, the delete window uses it to name the fields.
 */
export function conditionWithoutPipeline(condition: FieldCondition | null, pipelineId: string, stageIds: readonly string[]): FieldCondition | null {
  if (!condition) return null;
  const prune = (part: ConditionPart): ConditionPart | null => {
    const ids: readonly string[] = part.field === "builtin:pipeline" ? [pipelineId] : part.field === "builtin:stage" ? stageIds : [];
    if (ids.length === 0) return part;
    if (part.op === "in" && Array.isArray(part.value)) {
      const left = part.value.filter((value) => !(typeof value === "string" && ids.includes(value)));
      return left.length === 0 ? null : { ...part, value: left };
    }
    if ((part.op === "equals" || part.op === "not_equals") && typeof part.value === "string" && ids.includes(part.value)) return null;
    return part;
  };
  const { effect, or, ...rest } = condition;
  const main = prune(rest);
  const second = or ? prune(or) : null;
  if (!main && !second) return null;
  if (!main) return { ...(second as ConditionPart), effect };
  return second ? { ...main, effect, or: second } : { ...main, effect };
}

/** The fields whose condition deleting this pipeline changes or removes (the delete window names them). */
export function fieldsAffectedByPipelineDelete(definitions: FieldDefinition[], pipelineId: string, stageIds: readonly string[]): FieldDefinition[] {
  return definitions.filter((field) => {
    const condition = field.condition ?? null;
    return condition !== null && JSON.stringify(conditionWithoutPipeline(condition, pipelineId, stageIds)) !== JSON.stringify(condition);
  });
}

/**
 * The delete window's question: how many conditions go with the pipeline (one per field: a field's condition
 * is removed, or the part based on the pipeline and its stages is) and which fields (owner, 15 October 2026).
 */
export function pipelineDeleteQuestion(pipelineName: string, fieldLabels: string[]): string {
  const question = `למחוק את תהליך המכירה "${pipelineName}"?`;
  if (fieldLabels.length === 0) return question;
  const names = fieldLabels.map((label) => `"${label}"`).join(", ");
  return fieldLabels.length === 1
    ? `${question} תנאי אחד מבוסס עליו ויוסר, בשדה ${names}.`
    : `${question} ${fieldLabels.length} תנאים מבוססים עליו ויוסרו, בשדות: ${names}.`;
}
