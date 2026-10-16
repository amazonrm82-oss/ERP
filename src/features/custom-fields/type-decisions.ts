import type { FieldType } from "./types";

// FLD-06: every place that switches on a custom field's type, and what it does with each type added after FLD-01.
// The unit test field-type-switches fails when a type is added to FIELD_TYPES without a decision here for every
// place, and when a source file starts switching on types without being listed. "handled": the place has its own
// behaviour for the type; "excluded": the type is left out of it on purpose (the note says why).

// The types FLD-01 put on the screens; every place was written for them.
export const BASELINE_FIELD_TYPES: readonly FieldType[] = [
  "text", "long_text", "number", "currency", "percent", "rating", "select", "multi_select", "checkbox",
  "date", "datetime", "phone", "email", "url", "il_id", "il_company_id", "user",
];

export type TypeDecision = "handled" | "excluded";

export type SwitchPlace = {
  // what the place does with a field's type
  what: string;
  decisions: Partial<Record<FieldType, TypeDecision>>;
  note?: string;
};

const ALL_HANDLED = { rich_text: "handled", duration: "handled", status: "handled" } as const;

/** Source files (relative to the repository) and database objects that switch on a custom field's type. */
export const FIELD_TYPE_SWITCHES: Record<string, SwitchPlace> = {
  // the database
  "sql:app.custom_value_ok": { what: "value check of every write", decisions: ALL_HANDLED },
  "sql:field_definitions_field_type_check": { what: "the accepted types", decisions: ALL_HANDLED },
  "sql:field_definitions_option_colors_check": {
    what: "option colours",
    decisions: { rich_text: "excluded", duration: "excluded", status: "handled" },
    note: "only a status field has colours",
  },
  "sql:app.field_settings_check (unique)": {
    what: "which types may be unique (FLD-07)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "a status names a group, not one record; rich text and durations are not identifiers",
  },
  "sql:app.field_condition_check (equals/in)": {
    what: "controllers of a condition (FLD-09)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "the new types take 'filled' / 'empty' only; a status 'equals' condition is a follow-up",
  },
  "sql:app.lead_score_rule_check": {
    what: "score rule operators (LEAD-05)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "'filled' / 'empty' only, as conditions; equals / more-than for status and duration are a follow-up",
  },
  "sql:lead_routing_rules (select field)": {
    what: "routing by a field (CAP-08)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "routing reads a select field only",
  },
  "sql:app.date_trigger fields": {
    what: "automation date triggers",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "date and datetime only",
  },

  // the app
  "src/features/custom-fields/types.ts": { what: "types, labels, types with options", decisions: ALL_HANDLED },
  "src/features/custom-fields/values.ts": { what: "parse, input value, display", decisions: ALL_HANDLED },
  "src/features/custom-fields/components/custom-field-inputs.tsx": { what: "the record form input", decisions: ALL_HANDLED },
  "src/features/custom-fields/components/custom-field-value.tsx": { what: "card value (status badge, rich text)", decisions: ALL_HANDLED },
  "src/features/custom-fields/components/field-editor.tsx": { what: "field settings (status colours)", decisions: ALL_HANDLED },
  "src/features/custom-fields/conditions.ts": {
    what: "condition operators and choices (FLD-09)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "mirrors the database: 'filled' / 'empty' only",
  },
  "src/features/custom-fields/live-conditions.ts": { what: "reading a controller from the form", decisions: ALL_HANDLED, note: "text value, as select" },
  "src/features/custom-fields/server.ts": { what: "typed values kept after a failed submit", decisions: ALL_HANDLED, note: "one input each" },
  "src/features/custom-fields/settings.ts": {
    what: "unique types and defaults (FLD-07)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "never unique (mirrors the database); a default is allowed for all three",
  },
  "src/features/list-filters/server.ts": { what: "list filters", decisions: ALL_HANDLED, note: "rich text as text, duration in minutes, status as a list" },
  "src/features/list-columns/components/list-table.tsx": { what: "list cells", decisions: ALL_HANDLED },
  "src/features/deals/components/deal-card-fields.tsx": { what: "board card fields", decisions: ALL_HANDLED },
  "src/features/lead-score/rules.ts": {
    what: "score rule operators (LEAD-05)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "mirrors the database: 'filled' / 'empty' only",
  },
  "src/features/automations/set-field.ts": { what: "set_field value (AUT-01)", decisions: ALL_HANDLED },
  "src/features/automations/components/rule-builder.tsx": { what: "set_field input (AUT-01)", decisions: ALL_HANDLED },
  "src/features/deals/copy.ts": { what: "copying a deal's values (DEAL-11)", decisions: ALL_HANDLED, note: "through inputValue / parseCustomFields" },
  "src/features/imports/new-field.ts": {
    what: "type guess for a new field from an import column (IMP-01)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "never guessed; a person may still pick them, and the values are read by parseCustomFields",
  },
  "src/features/industry-templates/templates.ts": {
    what: "industry templates (FLD-05)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "the templates use the older types only",
  },
  "src/features/intake/fields.ts": {
    what: "public form fields (FORM_EXCLUDED_TYPES)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "part A keeps them off public forms; a visitor's text is plain (REC-04)",
  },
  "src/features/intake/components/form-fields-builder.tsx": {
    what: "form builder 'show if' choices",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "the types are not offered on forms (FORM_EXCLUDED_TYPES)",
  },
  "src/features/intake/components/public-lead-form.tsx": {
    what: "public form inputs",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "FORM_EXCLUDED_TYPES",
  },
  "src/features/intake/public-validate.ts": {
    what: "public form messages",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "FORM_EXCLUDED_TYPES",
  },
  "src/features/intake/schema.ts": {
    what: "form builder save check",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "FORM_EXCLUDED_TYPES",
  },
  "src/features/lead-distribution/queries.ts": {
    what: "routing fields (CAP-08)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" },
    note: "select fields only, as the database",
  },
};
