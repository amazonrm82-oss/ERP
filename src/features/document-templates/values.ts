// SGN-01: the values a template's merge fields are filled with in the preview. Pure, so it is unit-tested.

import { isCalendarDate } from "@/lib/calendar-date";

/** "YYYY-MM-DD" as "DD.MM.YYYY"; anything else (or nothing) is null. */
export function dayText(day: string | null | undefined): string | null {
  if (typeof day !== "string" || !isCalendarDate(day)) return null;
  const [year, month, date] = day.split("-");
  return `${date}.${month}.${year}`;
}

/** The parts that hold text, joined with ", "; null when none does. */
export function joinParts(parts: ReadonlyArray<string | null | undefined>): string | null {
  const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(", ") : null;
}

export type BusinessDocumentFacts = {
  name: string;
  legalName: string | null;
  taxId: string | null;
  addressLine: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  userName: string;
  /** the business's today, "YYYY-MM-DD" */
  today: string;
};

/** The business's merge values (every record type). The registered name falls back to the display name. */
export function businessDocumentValues(facts: BusinessDocumentFacts): Record<string, string> {
  const values: Record<string, string | null> = {
    "שם העסק": facts.name.trim() || null,
    "השם הרשום של העסק": facts.legalName?.trim() || facts.name.trim() || null,
    "מספר העוסק": facts.taxId?.trim() || null,
    "כתובת העסק": joinParts([facts.addressLine, facts.city]),
    "טלפון העסק": facts.phone?.trim() || null,
    "אימייל העסק": facts.email?.trim() || null,
    "שם הנציג": facts.userName.trim() || null,
    "תאריך היום": dayText(facts.today),
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
}
