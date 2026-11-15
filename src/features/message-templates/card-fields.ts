import { SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";

import { MERGE_FIELD_NAMES, MERGE_FIELD_PATTERN, OPTIONAL_PART_PATTERN } from "./fields";

// EML-02 (15 November 2026, the owner's first live send): a message sent from a record's card, or by an automation's step,
// fills only these fields (= app.card_message_fields(), migration card_email_fields; tests/unit/card-fields.test.ts reads it):
// the customer's names, the rep's name, and the business's name, phone and address. A marketing message's {קישור הסרה} is
// filled too (the composer mints it). Any other field ({קישור להצעה}, {תוקף}: a send from the quote screen; {תוכן העדכון}:
// typed by a person) would end the message 'unfilled_field', so such a template is shown disabled and is never queued (the
// database refuses it too, hint record_message:unfillable_field). Nothing is typed in the dialog: the queue holds ids only.

export const CARD_MESSAGE_FIELDS = ["שם פרטי", "שם מלא", "שם הנציג", "שם העסק", "טלפון העסק", "כתובת העסק"] as const;

const UNSUBSCRIBE_LINK = "קישור הסרה";
const KNOWN = new Set(MERGE_FIELD_NAMES);
const FILLABLE = new Set<string>(CARD_MESSAGE_FIELDS);

type TemplateText = { messageType: string | null; subject?: string | null; body: string };

/**
 * The merge fields of a template that a card's or an automation's message leaves without a value, without braces, in order,
 * each once (= app.card_unfillable_fields). A field inside an optional part ("{, ב-{מיקום}}") is not counted: the part
 * disappears when it has no value.
 */
export function cardUnfillableFields(template: TemplateText): string[] {
  const text = `${template.subject ?? ""}\n${template.body}`.replace(OPTIONAL_PART_PATTERN, "");
  const marketing = !(SERVICE_MESSAGE_TYPES as readonly string[]).includes(template.messageType ?? "marketing");
  const found: string[] = [];
  for (const match of text.matchAll(MERGE_FIELD_PATTERN)) {
    const name = match[1];
    if (!KNOWN.has(name) || FILLABLE.has(name) || (marketing && name === UNSUBSCRIBE_LINK) || found.includes(name)) continue;
    found.push(name);
  }
  return found;
}

/** "חסר בכרטיס: {X}, {Y}" for a template the card cannot fill, else null. */
export function cardMissingText(missing: readonly string[]): string | null {
  return missing.length > 0 ? `חסר בכרטיס: ${missing.map((name) => `{${name}}`).join(", ")}` : null;
}

/** The same for an automation's step. */
export function automationMissingText(missing: readonly string[]): string | null {
  return missing.length > 0 ? `חסר באוטומציה: ${missing.map((name) => `{${name}}`).join(", ")}` : null;
}

/**
 * The card's message for the database's refusal 'record_message:unfillable_field', naming the missing fields from the
 * error's detail ("קישור להצעה, תוקף"); null for any other error.
 */
export function cardFieldsErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { hint?: unknown; details?: unknown; detail?: unknown };
  if (e.hint !== "record_message:unfillable_field") return null;
  const raw = typeof e.details === "string" ? e.details : typeof e.detail === "string" ? e.detail : "";
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => KNOWN.has(name));
  const missing = cardMissingText(names);
  return missing
    ? `התבנית לא תישלח מהכרטיס. ${missing}. בחרו תבנית אחרת, או בקשו מבעלי העסק לתקן אותה.`
    : "בתבנית יש שדה שלא מתמלא בשליחה מהכרטיס, ולכן היא לא תישלח. בחרו תבנית אחרת, או בקשו מבעלי העסק לתקן אותה.";
}

/**
 * Owner, 15 November 2026: the card's send dialog offers only the templates the card fills; the others are not shown at
 * all, and one line says how many were left out.
 */
export function splitCardTemplates<T extends TemplateText>(templates: readonly T[]): { offered: T[]; hidden: number } {
  const offered = templates.filter((t) => cardUnfillableFields(t).length === 0);
  return { offered, hidden: templates.length - offered.length };
}

/** The line under the picker while some templates are left out (DRAFT wording); null when none are. */
export function hiddenTemplatesText(hidden: number): string | null {
  if (hidden <= 0) return null;
  return hidden === 1
    ? "תבנית אחת לא מוצגת כי יש בה שדות שהכרטיס לא ממלא."
    : `${hidden} תבניות לא מוצגות כי יש בהן שדות שהכרטיס לא ממלא.`;
}
