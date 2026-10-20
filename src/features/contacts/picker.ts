// The contact search picker's pure parts (unit tested): how a contact is named and described in the hits, and the ids a
// search leaves out. The search itself is searchContactsAction (picker-actions.ts), with the user's session.

import { isUuid } from "@/lib/paths";
import type { SearchPickerHit } from "@/components/ui/search-picker-logic";

export const CONTACT_FALLBACK_NAME = "איש קשר ללא שם";
/** Most ids a search may leave out (a deal's linked contacts and the like). */
export const PICKER_EXCLUDE_MAX = 200;

type ContactRow = { id: string; full_name: string | null; email: string | null; phone: string | null };

/** A contact's name for a picker: the full name, else the email, else the phone. */
export function contactPickerName(row: Omit<ContactRow, "id">): string {
  for (const value of [row.full_name, row.email, row.phone]) {
    const text = (value ?? "").trim();
    if (text !== "") return text;
  }
  return CONTACT_FALLBACK_NAME;
}

/** One hit: the name, and under it the phone and email that are not the name already. */
export function contactHit(row: ContactRow): SearchPickerHit {
  const label = contactPickerName(row);
  const detail = [row.phone, row.email]
    .map((value) => (value ?? "").trim())
    .filter((value) => value !== "" && value !== label)
    .join(" · ");
  return { id: row.id, label, detail: detail === "" ? null : detail };
}

/** The ids a search leaves out: valid ids only, each once, at most PICKER_EXCLUDE_MAX; null when the list is not ids. */
export function pickerExclude(ids: unknown): string[] | null {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > PICKER_EXCLUDE_MAX * 2) return null;
  if (!ids.every((id) => typeof id === "string" && isUuid(id))) return null;
  return [...new Set(ids as string[])].slice(0, PICKER_EXCLUDE_MAX);
}
