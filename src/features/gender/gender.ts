// HEB-01: an optional gender on a lead or a contact, set only by a person or a mapped import column.
// The system never guesses it from a name. Mirrors the check constraints leads_gender_check /
// contacts_gender_check (migration gender); tests/unit/gender.test.ts reads the migration and compares.

export const GENDERS = ["male", "female", "unknown"] as const;
export type Gender = (typeof GENDERS)[number];

export const GENDER_LABELS: Record<Gender, string> = {
  male: "זכר",
  female: "נקבה",
  unknown: "לא ידוע",
};

export const GENDER_OPTIONS = GENDERS.map((value) => ({ value, label: GENDER_LABELS[value] }));

export function isGender(value: unknown): value is Gender {
  return typeof value === "string" && (GENDERS as readonly string[]).includes(value);
}

/** The Hebrew name of a stored gender, or null for none / an unknown code. */
export function genderLabel(value: string | null | undefined): string | null {
  return isGender(value) ? GENDER_LABELS[value] : null;
}

// What an import cell may say, after trimming and lower-casing. A closed list: anything else is
// reported and left empty, never guessed (and never read from the person's name).
const IMPORT_VALUES: Record<string, Gender> = {
  "זכר": "male",
  "ז": "male",
  "male": "male",
  "m": "male",
  "נקבה": "female",
  "נ": "female",
  "female": "female",
  "f": "female",
  "לא ידוע": "unknown",
  "לא ידועה": "unknown",
  "unknown": "unknown",
};

export const IMPORT_GENDER_VALUES = Object.keys(IMPORT_VALUES);

/** An import cell's gender: the code, null for an empty cell, or "invalid" for a value outside the list. */
export function importGender(cell: string | null | undefined): Gender | null | "invalid" {
  const value = (cell ?? "").trim().toLowerCase();
  if (value === "") return null;
  return IMPORT_VALUES[value] ?? "invalid";
}

/**
 * The gender a form sends, as a column to write ("" = not set). Written only when the form has the
 * field, so a form without it never empties a stored gender.
 */
export function genderFromForm(
  formData: FormData,
): { ok: true; patch: { gender?: Gender | null } } | { ok: false; message: string } {
  if (!formData.has("gender")) return { ok: true, patch: {} };
  const raw = formData.get("gender");
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return { ok: true, patch: { gender: null } };
  if (!isGender(value)) return { ok: false, message: GENDER_INVALID };
  return { ok: true, patch: { gender: value } };
}

export const GENDER_INVALID = "המגדר שנבחר אינו ברשימה.";
