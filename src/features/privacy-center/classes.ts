// PRK-01: how a custom field is marked for the privacy center (field_definitions.privacy_class, constraint
// field_definitions_privacy_class_check in migration field_privacy_class; tests/unit/privacy-center.test.ts reads it).
// Information only: the mark decides nothing about who reads the field.

export const PRIVACY_CLASSES = ["personal", "sensitive"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export const PRIVACY_CLASS_LABELS: Record<PrivacyClass, string> = {
  personal: "מידע אישי",
  sensitive: "מידע רגיש",
};

export const PRIVACY_CLASS_HINT =
  "מידע אישי: פרט שמזהה אדם או מספר עליו. מידע רגיש: בריאות, מצב משפחתי, אמונה, עבר פלילי, נתונים כספיים ודומיהם. הסימון מופיע במרכז הפרטיות ולא משנה מי רואה את השדה.";

export function isPrivacyClass(value: unknown): value is PrivacyClass {
  return typeof value === "string" && (PRIVACY_CLASSES as readonly string[]).includes(value);
}

/** The form's value ("" = not marked) as the column's value. */
export function privacyClassFromForm(value: FormDataEntryValue | null): PrivacyClass | null {
  return isPrivacyClass(value) ? value : null;
}
