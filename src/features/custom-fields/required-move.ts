import { FORM_INVALID } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";

import { missingFieldsMessage } from "./conditions";
import { inputName, type FieldDefinition } from "./types";
import { parseCustomFields } from "./values";

// FLD-09 (owner, 14 October 2026): one mechanism for every place that moves a lead's status or a deal's
// stage by hand (board, table cell, the record card's status form and stage menu, the won window). When
// the new status or stage makes a conditionally required field required and it is empty, nothing is
// saved: the answer names the fields (missing), the place shows them (in its own form, or in
// RequiredFieldsDialog), and the next send carries them, saved with the move in one update
// ({"$merge": …}). Pure: shared by the server check and the unit tests.

/** Hidden input sent with the asked fields: from then on an empty field is a field error, not a question. */
export const REQUIRED_ASKED_FIELD = "required_fields_asked";

/**
 * A move refused because fields it makes required are empty. missing: the fields as the form shows them
 * (required, no condition). fieldErrors only once the fields were asked and sent.
 */
export type MoveRefusal = {
  ok: false;
  message: string;
  missing: FieldDefinition[];
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
};

/** Whether an answer is a refusal that asks for fields. */
export function isMoveRefusal(result: unknown): result is MoveRefusal {
  if (typeof result !== "object" || result === null) return false;
  const value = result as { ok?: unknown; missing?: unknown };
  return value.ok === false && Array.isArray(value.missing) && value.missing.length > 0;
}

/** The field as the move asks for it: required, writable, without its condition. */
export function askedField(field: FieldDefinition): FieldDefinition {
  return { ...field, isRequired: true, isReadOnly: false, condition: null };
}

/**
 * The fields a move leaves required and empty, against what the form sent. Nothing missing: no patch.
 * Fields not asked yet (no form, or a form without the marker): a refusal that names them. Asked: the
 * values, or field errors for the ones still empty or invalid. values: what the form sent, kept on a refusal.
 */
export function requiredAnswer(
  missing: FieldDefinition[],
  formData: FormData | null,
  values?: Record<string, string>,
): { ok: true; patch: Record<string, Json> | undefined } | MoveRefusal {
  const fields = missing.map(askedField);
  if (fields.length === 0) return { ok: true, patch: undefined };
  if (!formData || formData.get(REQUIRED_ASKED_FIELD) !== "1") {
    return { ok: false, message: missingFieldsMessage(fields), missing: fields, ...(values ? { values } : {}) };
  }
  const parsed = parseCustomFields(fields, formData);
  // DEAL-05: the deal's contact is asked as a choice of contacts, not of the business's users
  const contactInput = inputName("builtin:contact_id");
  if (parsed.errors[contactInput]) parsed.errors[contactInput] = parsed.errors[contactInput] === "יש למלא את השדה." ? parsed.errors[contactInput] : "יש לבחור איש קשר מהרשימה.";
  if (Object.keys(parsed.errors).length > 0) {
    return { ok: false, message: FORM_INVALID, missing: fields, fieldErrors: parsed.errors, ...(values ? { values } : {}) };
  }
  const patch: Record<string, Json> = {};
  for (const field of fields) {
    const value = parsed.values[field.key];
    if (value !== undefined) patch[field.key] = value;
  }
  return { ok: true, patch };
}

/**
 * The fields a form shows after a refusal: the refused move's, while the form still points at the same
 * target (name: the input that holds it, e.g. "stage_id"). Another target picked since: none.
 */
export function askedFieldsFor(state: unknown, name: string, current: string): FieldDefinition[] {
  if (!isMoveRefusal(state)) return [];
  const sent = state.values?.[name];
  return sent === undefined || sent === current ? state.missing : [];
}
