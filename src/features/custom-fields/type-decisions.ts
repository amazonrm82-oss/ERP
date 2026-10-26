import type { FieldType } from "./types";

// FLD-06 (parts A and B): every place that switches on a custom field's type, and what it does with each type added after FLD-01.
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

const ALL_HANDLED = {
  rich_text: "handled", duration: "handled", status: "handled",
  address: "handled", record_link: "handled", file: "handled",
} as const;
// FLD-06 part B: none of the three (the note of each place says why)
const B_EXCLUDED = { address: "excluded", record_link: "excluded", file: "excluded" } as const;
// FLD-06 part B: an address is plain text there; a record link and a file hold ids
const B_ADDRESS_ONLY = { address: "handled", record_link: "excluded", file: "excluded" } as const;

/** Source files (relative to the repository) and database objects that switch on a custom field's type. */
export const FIELD_TYPE_SWITCHES: Record<string, SwitchPlace> = {
  // the database
  "sql:app.custom_value_ok": {
    what: "value check of every write",
    decisions: ALL_HANDLED,
    note: "part B: what a record link or a file names is checked by app.check_custom_fields for a person's write; conversion copies a link only to the same target and never a file (app.carry_custom_fields)",
  },
  "sql:field_definitions_field_type_check": { what: "the accepted types", decisions: ALL_HANDLED },
  "sql:field_definitions_option_colors_check": {
    what: "option colours",
    decisions: { rich_text: "excluded", duration: "excluded", status: "handled" , ...B_EXCLUDED },
    note: "only a status field has colours. Part B: no colours",
  },
  "sql:app.field_settings_check (unique)": {
    what: "which types may be unique (FLD-07)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "a status names a group, not one record; rich text and durations are not identifiers. Part B: an address is not an identifier; a record link or a file names one record's own thing (and has no default, field_definitions_part_b_check)",
  },
  "sql:app.field_condition_check (equals/in)": {
    what: "controllers of a condition (FLD-09)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "the new types take 'filled' / 'empty' only; a status 'equals' condition is a follow-up. Part B: 'filled' / 'empty' only (a file field's stored value counts)",
  },
  "sql:app.lead_score_rule_check": {
    what: "score rule operators (LEAD-05)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "'filled' / 'empty' only, as conditions; equals / more-than for status and duration are a follow-up. Part B: 'filled' / 'empty' only",
  },
  "sql:lead_routing_rules (select field)": {
    what: "routing by a field (CAP-08)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "routing reads a select field only. Part B: select fields only",
  },
  "sql:app.date_trigger fields": {
    what: "automation date triggers",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "date and datetime only. Part B: date and datetime only",
  },

  // the app
  "src/features/custom-fields/types.ts": { what: "types, labels, types with options", decisions: ALL_HANDLED },
  "src/features/custom-fields/values.ts": { what: "parse, input value, display", decisions: ALL_HANDLED },
  "src/features/custom-fields/components/custom-field-inputs.tsx": { what: "the record form input", decisions: ALL_HANDLED },
  "src/features/custom-fields/components/custom-field-value.tsx": { what: "card value (status badge, rich text)", decisions: ALL_HANDLED },
  "src/features/custom-fields/components/field-editor.tsx": { what: "field settings (status colours)", decisions: ALL_HANDLED },
  "src/features/custom-fields/conditions.ts": {
    what: "condition operators and choices (FLD-09)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "mirrors the database: 'filled' / 'empty' only. Part B: 'filled' / 'empty' only; a 'require' condition never asks for a file (fieldState)",
  },
  "src/features/custom-fields/live-conditions.ts": { what: "reading a controller from the form", decisions: ALL_HANDLED, note: "text value, as select" },
  "src/features/custom-fields/server.ts": { what: "typed values kept after a failed submit", decisions: ALL_HANDLED, note: "one input each" },
  "src/features/custom-fields/settings.ts": {
    what: "unique types and defaults (FLD-07)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "never unique (mirrors the database); a default is allowed for all three. Part B: never unique; an address takes a default, a record link or a file does not (canHaveDefault), and a file field is never required (canBeRequired)",
  },
  "src/features/list-filters/server.ts": {
    what: "list filters",
    decisions: { rich_text: "handled", duration: "handled", status: "handled", ...B_ADDRESS_ONLY },
    note: "rich text as text, duration in minutes, status as a list. Part B: an address as text; a record link or a file holds an id, not filterable yet (a 'filled / empty' kind is a follow-up)",
  },
  "src/features/list-columns/components/list-table.tsx": {
    what: "list cells",
    decisions: ALL_HANDLED,
    note: "part B: an address as text; a record link or a file by name with a link (withFieldRefs, as the viewer reads it), and those two columns do not sort (sortableField)",
  },
  "src/features/deals/components/deal-card-fields.tsx": {
    what: "board card fields",
    decisions: { rich_text: "handled", duration: "handled", status: "handled", ...B_ADDRESS_ONLY },
    note: "part B: an address as text; boardCatalog leaves out a record link or a file (a dragged card does not read other records' names)",
  },
  "src/features/lead-score/rules.ts": {
    what: "score rule operators (LEAD-05)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "mirrors the database: 'filled' / 'empty' only. Part B: 'filled' / 'empty' only",
  },
  "src/features/automations/set-field.ts": {
    what: "set_field value (AUT-01)",
    decisions: { rich_text: "handled", duration: "handled", status: "handled", ...B_ADDRESS_ONLY },
    note: "part B: an automation never sets a record link or a file (automationSettable; the database refuses it in a run, *_cf_zz_automation_guard)",
  },
  "src/features/automations/components/rule-builder.tsx": {
    what: "set_field input (AUT-01)",
    decisions: { rich_text: "handled", duration: "handled", status: "handled", ...B_ADDRESS_ONLY },
    note: "part B: a record link or a file is never offered",
  },
  "src/features/deals/copy.ts": {
    what: "copying a deal's values (DEAL-11)",
    decisions: { rich_text: "handled", duration: "handled", status: "handled", address: "handled", record_link: "handled", file: "excluded" },
    note: "through inputValue / parseCustomFields; part B: a record link is copied (the database judges it for the copier), a file is not (it belongs to the original deal; parseCustomFields skips it)",
  },
  "src/features/imports/new-field.ts": {
    what: "type guess for a new field from an import column (IMP-01)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "never guessed; a person may still pick them, and the values are read by parseCustomFields. Part B: never guessed; createImportFieldAction refuses a record link or a file field (an address is picked by hand)",
  },
  "src/features/industry-templates/templates.ts": {
    what: "industry templates (FLD-05)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "the templates use the older types only. Part B: the templates use the older types only",
  },
  "src/features/intake/fields.ts": {
    what: "public form fields (FORM_EXCLUDED_TYPES)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_ADDRESS_ONLY },
    note: "part A keeps them off public forms; a visitor's text is plain (REC-04). Part B: an address is a line a visitor types; a record link names a record of the business and a file needs the saved record",
  },
  "src/features/intake/components/form-fields-builder.tsx": {
    what: "form builder 'show if' choices",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "the types are not offered on forms (FORM_EXCLUDED_TYPES). Part B: the 'show if' choices are select fields; an address shows as 'filled'",
  },
  "src/features/intake/components/public-lead-form.tsx": {
    what: "public form inputs",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_ADDRESS_ONLY },
    note: "FORM_EXCLUDED_TYPES. Part B: an address takes the plain text input; the others are not on forms",
  },
  "src/features/intake/public-validate.ts": {
    what: "public form messages",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_ADDRESS_ONLY },
    note: "FORM_EXCLUDED_TYPES. Part B: an address is read by parseCustomFields; the others are not on forms",
  },
  "src/features/intake/schema.ts": {
    what: "form builder save check",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_ADDRESS_ONLY },
    note: "FORM_EXCLUDED_TYPES. Part B: FORM_EXCLUDED_TYPES",
  },
  "src/features/lead-distribution/queries.ts": {
    what: "routing fields (CAP-08)",
    decisions: { rich_text: "excluded", duration: "excluded", status: "excluded" , ...B_EXCLUDED },
    note: "select fields only, as the database. Part B: select fields only",
  },
};
