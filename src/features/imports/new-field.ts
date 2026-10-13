// IMP-01: a new custom field made from an imported column, while mapping.
// Pure helpers, shared by the wizard (browser) and the unit tests.

import { FIELD_TYPES, type FieldType } from "@/features/custom-fields/types";

// A "user" field stores a member's id, which a file never holds; it is left out here.
export const IMPORT_NEW_FIELD_TYPES: readonly FieldType[] = FIELD_TYPES.filter((type) => type !== "user");

// A list field made from a column gets at most this many choices (the field settings allow 100);
// a longer choice than the field settings allow (100 characters) is left out.
export const MAX_COLUMN_OPTIONS = 50;
const MAX_OPTION_LENGTH = 100;

// the type is guessed from this many filled cells, so a big file stays quick
const SAMPLE_SIZE = 500;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^(https?:\/\/|www\.)\S+\.\S+$/i;
const PHONE_RE = /^\+?[\d\s\-().]{7,24}$/;
const NUMBER_RE = /^-?[\d,]*\.?\d+$/;

/** The filled cells of one column, trimmed. */
export function columnValues(rows: string[][], index: number): string[] {
  const values: string[] = [];
  for (const row of rows) {
    const value = (row[index] ?? "").trim();
    if (value) values.push(value);
  }
  return values;
}

/** The choices of a list field made from a column: distinct values in file order, at most 50. */
export function columnOptions(values: string[], type: FieldType): { options: string[]; more: boolean } {
  const seen = new Set<string>();
  for (const value of values) {
    // a multiple choice in a file is one cell with commas, the way the import reads it
    const parts = type === "multi_select" ? value.split(/[,;\n]/) : [value];
    for (const part of parts) {
      const option = part.trim();
      if (option && option.length <= MAX_OPTION_LENGTH) seen.add(option);
    }
  }
  const all = [...seen];
  return { options: all.slice(0, MAX_COLUMN_OPTIONS), more: all.length > MAX_COLUMN_OPTIONS };
}

/**
 * A cheap guess of the field type from the column's values. Only a type that the import
 * reads as written is suggested (a date only as 2026-10-13); anything else is short text.
 */
export function suggestFieldType(values: string[]): FieldType {
  const sample = values.slice(0, SAMPLE_SIZE);
  if (sample.length === 0) return "text";
  const all = (test: (value: string) => boolean) => sample.every(test);
  if (all((v) => v.length <= 254 && EMAIL_RE.test(v))) return "email";
  if (all((v) => ISO_DATE_RE.test(v))) return "date";
  if (all((v) => URL_RE.test(v))) return "url";
  if (all((v) => NUMBER_RE.test(v))) {
    // a number with a leading 0 and 9-10 digits is a phone that kept its 0
    return all((v) => /^0\d{8,9}$/.test(v)) ? "phone" : "number";
  }
  if (all((v) => PHONE_RE.test(v) && v.replace(/\D/g, "").length >= 9)) return "phone";
  if (sample.some((v) => v.length > 500)) return "long_text";
  const distinct = new Set(sample).size;
  // few values that repeat a lot: a list
  if (sample.length >= 6 && distinct <= 10 && distinct * 3 <= sample.length && sample.every((v) => v.length <= MAX_OPTION_LENGTH)) return "select";
  return "text";
}
