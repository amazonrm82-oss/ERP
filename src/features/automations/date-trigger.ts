import type { FieldDefinition } from "@/features/custom-fields/types";

import type { Entity } from "./definitions";

// AUT-03: the "X days before or after a date" trigger ('date_reached'). The engine (app.scheduled_date_reached,
// migration 020225) reads {field, days, direction} and runs once per record and date, on the day in the business's
// time zone, from 08:00. These helpers only turn the builder's values into the stored setting and back.

/** The built-in date fields per record type; app.automation_date_fields() in the migration holds the same keys. */
export const DATE_TRIGGER_FIELDS: Record<Entity, Array<{ key: string; label: string }>> = {
  lead: [{ key: "created_at", label: "תאריך היצירה" }],
  contact: [{ key: "created_at", label: "תאריך היצירה" }],
  company: [{ key: "created_at", label: "תאריך היצירה" }],
  deal: [
    { key: "created_at", label: "תאריך היצירה" },
    { key: "expected_close_date", label: "תאריך הסגירה הצפוי" },
    { key: "renewal_date", label: "תאריך החידוש" },
    { key: "recurring_start_date", label: "תחילת החיוב החוזר" },
  ],
  task: [
    { key: "created_at", label: "תאריך היצירה" },
    { key: "due_at", label: "מועד המשימה" },
  ],
};

export const DATE_TRIGGER_MAX_DAYS = 365;
export const DATE_TRIGGER_HOUR = 8;
export const DATE_DIRECTIONS = ["before", "after", "on"] as const;
export type DateDirection = (typeof DATE_DIRECTIONS)[number];

const CUSTOM_PREFIX = "cf:";
const CUSTOM_DATE_TYPES = new Set(["date", "datetime"]);

type FieldsLookup = { fields: Partial<Record<Entity, FieldDefinition[]>> };

/** The date fields a rule on this record type may watch: the built-in ones, then the active custom date fields. */
export function dateTriggerChoices(entity: Entity, lookups: FieldsLookup): Array<{ key: string; label: string }> {
  const custom = (lookups.fields[entity] ?? [])
    .filter((field) => CUSTOM_DATE_TYPES.has(field.type))
    .map((field) => ({ key: `${CUSTOM_PREFIX}${field.key}`, label: field.label }));
  return [...DATE_TRIGGER_FIELDS[entity], ...custom];
}

export type DateTriggerConfig = { field: string; days: number; direction: "before" | "after" };

/** The builder's values -> the stored trigger setting, or a Hebrew message. "On the day" is 0 days after. */
export function dateTriggerConfig(
  entity: Entity,
  input: { field?: string; days?: number; direction?: DateDirection },
  lookups: FieldsLookup,
): DateTriggerConfig | string {
  if (!input.field) return "יש לבחור שדה תאריך.";
  if (!dateTriggerChoices(entity, lookups).some((choice) => choice.key === input.field)) return "שדה התאריך שנבחר כבר לא קיים או מוסתר.";
  const direction = input.direction ?? "on";
  if (direction === "on") return { field: input.field, days: 0, direction: "after" };
  const days = input.days ?? 0;
  if (!Number.isInteger(days) || days < 1 || days > DATE_TRIGGER_MAX_DAYS) return `יש לבחור בין 1 ל-${DATE_TRIGGER_MAX_DAYS} ימים.`;
  return { field: input.field, days, direction };
}

/** A stored setting -> the builder's values. */
export function dateTriggerDraft(config: Record<string, unknown>): { field: string; days: string; direction: DateDirection } {
  const field = typeof config.field === "string" ? config.field : "";
  const days = typeof config.days === "number" ? config.days : 0;
  const direction: DateDirection = days === 0 ? "on" : config.direction === "before" ? "before" : "after";
  return { field, days: days === 0 ? "1" : String(days), direction };
}

/** "30 ימים לפני תאריך החידוש", "ביום תאריך היצירה", "יום אחד אחרי מועד המשימה". */
export function describeDateTrigger(entity: Entity, config: Record<string, unknown>, lookups: FieldsLookup): string {
  const field = typeof config.field === "string" ? config.field : "";
  const label = dateTriggerChoices(entity, lookups).find((choice) => choice.key === field)?.label ?? "שדה תאריך שנמחק או הוסתר";
  const days = typeof config.days === "number" ? config.days : 0;
  if (days === 0) return `ביום ${label}`;
  const amount = days === 1 ? "יום אחד" : `${days} ימים`;
  return `${amount} ${config.direction === "before" ? "לפני" : "אחרי"} ${label}`;
}
