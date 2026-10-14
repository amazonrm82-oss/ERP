"use client";

import { REQUIRED_ASKED_FIELD } from "../required-move";
import type { FieldDefinition } from "../types";
import { CustomFieldInputs } from "./custom-field-inputs";

/**
 * FLD-09: the fields a move makes required and are empty, inside the form that makes the move (the
 * lead's status form, the deal's stage menu, the won window, RequiredFieldsDialog). The hidden marker
 * tells the server they were asked, so an empty one is a field error. Renders nothing without fields.
 */
export function AskedFields({
  object,
  fields,
  submitted,
  errors,
}: {
  object: "lead" | "deal";
  fields: FieldDefinition[];
  submitted?: Record<string, string>;
  errors?: Record<string, string>;
}) {
  if (fields.length === 0) return null;
  return (
    <fieldset className="min-w-0 space-y-3 rounded-md border border-line bg-canvas p-3">
      <legend className="px-1 text-sm font-medium text-ink">צריך למלא כדי להעביר</legend>
      <p className="text-sm text-ink-soft">{object === "lead" ? "בסטטוס הזה" : "בשלב הזה"} השדות האלה הם חובה. הם נשמרים יחד עם ההעברה.</p>
      <input type="hidden" name={REQUIRED_ASKED_FIELD} value="1" />
      <CustomFieldInputs definitions={fields} submitted={submitted} errors={errors} />
    </fieldset>
  );
}
