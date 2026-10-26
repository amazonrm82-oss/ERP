import { CHANNEL_OPTIONS, LOCALE_OPTIONS } from "@/features/contacts/preferences";
import type { FieldDefinition } from "@/features/custom-fields/types";

import type { Entity } from "./definitions";

// AUT-03: "a field changed" (trigger type field_changed, trigger_config {field, to?}). The engine compares the field's
// value after the change as text with `to` (app.automation_event_matches: a column, or a custom field "cf:<key>" through
// app.automation_field_value). Status and stage keep their own triggers ("סטטוס של ליד השתנה", "עסקה עברה שלב").
// Lead's default (no owner decision): the built-in fields below, and every active custom field; a value to wait for only
// where the field has a closed list of values.

export const FIELD_TRIGGER_ENTITIES = ["lead", "contact", "company", "deal"] as const;
export type FieldTriggerEntity = (typeof FIELD_TRIGGER_ENTITIES)[number];

/** Where the "to" choices of a built-in field come from (none = any change only). */
type ChoiceSource = "members" | "sources" | "teams" | "pipelines" | "channel" | "locale";

type BuiltinWatch = { key: string; label: string; choices?: ChoiceSource };

const OWNER: BuiltinWatch = { key: "owner_id", label: "אחראי", choices: "members" };
const TEAM: BuiltinWatch = { key: "team_id", label: "צוות", choices: "teams" };
const SOURCE: BuiltinWatch = { key: "source_id", label: "מקור", choices: "sources" };
const TAGS: BuiltinWatch = { key: "tag_ids", label: "תגיות" };
const CHANNEL: BuiltinWatch = { key: "preferred_channel", label: "ערוץ מועדף", choices: "channel" };
const LOCALE: BuiltinWatch = { key: "preferred_locale", label: "שפה מועדפת", choices: "locale" };

/** The built-in fields a "field changed" rule may watch, per record type (columns of the record's table). */
export const WATCH_FIELDS: Record<FieldTriggerEntity, BuiltinWatch[]> = {
  lead: [
    OWNER,
    TEAM,
    SOURCE,
    { key: "full_name", label: "שם" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "company_name", label: "שם החברה" },
    { key: "job_title", label: "תפקיד" },
    { key: "budget_agorot", label: "תקציב" },
    { key: "requested_product_id", label: "מוצר מבוקש" },
    CHANNEL,
    LOCALE,
    TAGS,
  ],
  contact: [
    OWNER,
    TEAM,
    SOURCE,
    { key: "full_name", label: "שם" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "job_title", label: "תפקיד" },
    { key: "company_id", label: "חברה" },
    { key: "type_id", label: "סוג" },
    { key: "city", label: "עיר" },
    { key: "birth_date", label: "תאריך לידה" },
    { key: "payment_terms", label: "תנאי תשלום" },
    CHANNEL,
    LOCALE,
    TAGS,
  ],
  company: [
    OWNER,
    TEAM,
    { key: "name", label: "שם" },
    { key: "phone", label: "טלפון" },
    { key: "email", label: "אימייל" },
    { key: "website", label: "אתר" },
    { key: "type_id", label: "סוג" },
    { key: "industry", label: "תחום" },
    { key: "city", label: "עיר" },
    { key: "parent_company_id", label: "שייכת ל" },
    { key: "payment_terms", label: "תנאי תשלום" },
    TAGS,
  ],
  deal: [
    OWNER,
    TEAM,
    SOURCE,
    { key: "pipeline_id", label: "תהליך מכירה", choices: "pipelines" },
    { key: "name", label: "שם" },
    { key: "amount_agorot", label: "שווי" },
    { key: "expected_close_date", label: "תאריך סגירה צפוי" },
    { key: "probability", label: "סיכוי" },
    { key: "contact_id", label: "איש קשר" },
    { key: "company_id", label: "חברה" },
    { key: "renewal_date", label: "תאריך החידוש" },
    TAGS,
  ],
};

const CUSTOM_PREFIX = "cf:";

export type FieldTriggerLookups = {
  fields: Partial<Record<Entity, FieldDefinition[]>>;
  members: Array<{ id: string; name: string }>;
  sources: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string }>;
};

export type WatchChoice = { key: string; label: string };

export function isFieldTriggerEntity(entity: string): entity is FieldTriggerEntity {
  return (FIELD_TRIGGER_ENTITIES as readonly string[]).includes(entity);
}

/** The fields a rule on this record type may watch: the built-in ones, then the active custom fields in their order. */
export function watchChoices(entity: Entity, lookups: Pick<FieldTriggerLookups, "fields">): WatchChoice[] {
  if (!isFieldTriggerEntity(entity)) return [];
  const custom = (lookups.fields[entity] ?? []).map((field) => ({ key: `${CUSTOM_PREFIX}${field.key}`, label: field.label }));
  return [...WATCH_FIELDS[entity].map(({ key, label }) => ({ key, label })), ...custom];
}

/** The values a rule may wait for on this field ("to"), or [] when it runs on any change only. */
export function watchValues(entity: Entity, field: string, lookups: FieldTriggerLookups): Array<{ value: string; label: string }> {
  if (!isFieldTriggerEntity(entity)) return [];
  if (field.startsWith(CUSTOM_PREFIX)) {
    const definition = (lookups.fields[entity] ?? []).find((f) => f.key === field.slice(CUSTOM_PREFIX.length));
    if (!definition) return [];
    if (definition.type === "select" || definition.type === "status") return definition.options.map((option) => ({ value: option, label: option }));
    if (definition.type === "checkbox") return [{ value: "true", label: "מסומן" }, { value: "false", label: "לא מסומן" }];
    if (definition.type === "user") return lookups.members.map((m) => ({ value: m.id, label: m.name }));
    return [];
  }
  const builtin = WATCH_FIELDS[entity].find((f) => f.key === field);
  switch (builtin?.choices) {
    case "members":
      return lookups.members.map((m) => ({ value: m.id, label: m.name }));
    case "sources":
      return lookups.sources.map((s) => ({ value: s.id, label: s.name }));
    case "teams":
      return lookups.teams.map((t) => ({ value: t.id, label: t.name }));
    case "pipelines":
      return lookups.pipelines.map((p) => ({ value: p.id, label: p.name }));
    case "channel":
      return CHANNEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
    case "locale":
      return LOCALE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
    default:
      return [];
  }
}

export type FieldTriggerConfig = { field: string; to?: string };

/** The builder's values -> the stored trigger setting, or a Hebrew message. An empty value = any change. */
export function fieldTriggerConfig(entity: Entity, input: { field?: string; to?: string }, lookups: FieldTriggerLookups): FieldTriggerConfig | string {
  if (!input.field) return "יש לבחור שדה.";
  if (!watchChoices(entity, lookups).some((choice) => choice.key === input.field)) return "השדה שנבחר כבר לא קיים או מוסתר.";
  const to = input.to?.trim();
  if (!to) return { field: input.field };
  if (!watchValues(entity, input.field, lookups).some((choice) => choice.value === to)) return "הערך שנבחר בטריגר כבר לא קיים.";
  return { field: input.field, to };
}

/** "השדה "אחראי" השתנה ל"דנה"", "השדה "עיר" השתנה". */
export function describeFieldTrigger(entity: Entity, config: Record<string, unknown>, lookups: FieldTriggerLookups): string {
  const field = typeof config.field === "string" ? config.field : "";
  const label = watchChoices(entity, lookups).find((choice) => choice.key === field)?.label ?? "שדה שנמחק או הוסתר";
  if (typeof config.to !== "string" || config.to === "") return `"${label}"`;
  const value = watchValues(entity, field, lookups).find((choice) => choice.value === config.to)?.label ?? "(נמחק)";
  return `"${label}" ל"${value}"`;
}
