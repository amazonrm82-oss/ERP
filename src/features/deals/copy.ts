import { z } from "zod";

import type { Json, StageKind } from "@/lib/database.types";
import { requiredId, requiredText } from "@/lib/validation";
import { inputName, type CustomValues, type FieldDefinition } from "@/features/custom-fields/types";
import { inputValue, parseCustomFields } from "@/features/custom-fields/values";

/**
 * DEAL-11: duplicating a deal and starting a follow-up deal for the same customer.
 * Pure rules shared by the window and the Server Actions (unit tested).
 */

// deals.name holds at most 200 characters (createDealSchema)
export const DEAL_NAME_MAX = 200;

const COPY_PREFIX = "עותק של ";
const FOLLOW_UP_PREFIX = "המשך: ";

/**
 * Cuts a text to the form's limit (zod counts UTF-16 units), whole code points only,
 * so an emoji is never split in half.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out.trimEnd();
}

/** "עותק של <name>", cut to the column's limit. */
export function copyName(name: string): string {
  return cut(`${COPY_PREFIX}${name.trim()}`, DEAL_NAME_MAX);
}

/** "המשך: <name>", the follow-up window's starting name, cut to the column's limit. */
export function followUpName(name: string): string {
  return cut(`${FOLLOW_UP_PREFIX}${name.trim()}`, DEAL_NAME_MAX);
}

type StageLike = { id: string; kind: StageKind };

/** The first open stage of a pipeline (stages in order), or null when it has none. */
export function firstOpenStage<T extends StageLike>(stages: T[]): T | null {
  return stages.find((stage) => stage.kind === "open") ?? null;
}

/**
 * The stage of a copy: the deal's own stage when the user keeps it and it is open,
 * else the first open stage. A copy never starts won or lost.
 */
export function copyStage<T extends StageLike>(stages: T[], currentStageId: string, keep: boolean): T | null {
  const current = stages.find((stage) => stage.id === currentStageId);
  if (keep && current?.kind === "open") {
    return current;
  }
  return firstOpenStage(stages);
}

/** An expected close date that has passed would make the copy overdue at once: it is left empty. */
export function copyCloseDate(date: string | null, today: string): string | null {
  return date && date >= today ? date : null;
}

/**
 * The custom field values a copy carries: only fields that are active today, each value
 * checked again with the form's own rule (parseCustomFields, values.ts; the database's
 * app.custom_value_ok mirrors it), as if a person typed the stored value into the field.
 * A value the field no longer accepts (an option taken off a list, a former member) is
 * left out and its key reported, so the user is told which fields were not copied.
 */
export function copyCustomFields(values: Json, definitions: FieldDefinition[]): { values: Record<string, Json>; skipped: string[] } {
  const out: Record<string, Json> = {};
  const skipped: string[] = [];
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { values: out, skipped };
  }
  const stored = values as CustomValues;
  for (const field of definitions) {
    const value = stored[field.key];
    if (value === null || value === undefined) continue;
    const name = inputName(field.key);
    const form = new FormData();
    if (field.type === "multi_select") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        skipped.push(field.key);
        continue;
      }
      for (const item of value as string[]) form.append(name, item);
    } else {
      form.set(name, inputValue(field, stored));
    }
    // "required" is checked by forms only; a copy never adds an empty field
    const parsed = parseCustomFields([{ ...field, isRequired: false }], form);
    const copied = parsed.values[field.key];
    if (parsed.errors[name] || copied === null || copied === undefined) {
      skipped.push(field.key);
    } else {
      out[field.key] = copied as Json;
    }
  }
  return { values: out, skipped };
}

// the deal page's notice after a copy: which custom fields were left out ("all": every one)
export const COPY_SKIPPED_PARAM = "copy_fields";
const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** The search parameter's value for skipped keys, or null when nothing was skipped. */
export function skippedParam(skipped: string[] | "all"): string | null {
  if (skipped === "all") return "all";
  return skipped.length > 0 ? skipped.join(",") : null;
}

/** The notice the deal page shows for that parameter, with the fields' current names; null for none or junk. */
export function skippedNotice(param: string | string[] | undefined, definitions: { key: string; label: string }[]): string | null {
  if (typeof param !== "string" || param === "") return null;
  if (param === "all") return "העסקה שוכפלה בלי השדות הנוספים, כי חלק מהערכים כבר לא תקינים.";
  const labels = param
    .split(",")
    .filter((key) => FIELD_KEY.test(key))
    .map((key) => definitions.find((field) => field.key === key)?.label)
    .filter((label): label is string => Boolean(label));
  if (labels.length === 0) return null;
  return labels.length === 1
    ? `העסקה שוכפלה בלי השדה "${labels[0]}", כי הערך שלו כבר לא תקין.`
    : `העסקה שוכפלה בלי השדות ${labels.map((label) => `"${label}"`).join(", ")}, כי הערכים שלהם כבר לא תקינים.`;
}

const checked = z
  .union([z.literal("on"), z.literal("1"), z.literal(""), z.null(), z.undefined()])
  .transform((value) => value === "on" || value === "1");

const dealName = requiredText(DEAL_NAME_MAX, "יש להזין שם לעסקה.", `שם העסקה ארוך מדי (עד ${DEAL_NAME_MAX} תווים).`);

export const DUPLICATE_FIELD_NAMES = ["name", "keep_stage"] as const;

export const duplicateDealSchema = z.object({
  name: dealName,
  keep_stage: checked,
});

export const FOLLOW_UP_FIELD_NAMES = ["name", "pipeline_id", "link"] as const;

export const followUpDealSchema = z.object({
  name: dealName,
  pipeline_id: requiredId("יש לבחור תהליך מכירה."),
  link: checked,
});
