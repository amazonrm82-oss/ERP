// AUT-03: the card's manual button. A person who may edit a lead, contact, company or deal runs an active rule of trigger
// "manual" on it (public.run_manual_automation: the conditions are checked; the run counts toward the plan's monthly runs
// and stops with them, like any other run; lead's decision, 26 October 2026).

export const MANUAL_ENTITIES = ["lead", "contact", "company", "deal"] as const;
export type ManualEntity = (typeof MANUAL_ENTITIES)[number];

export type ManualRule = { id: string; name: string };

export function isManualEntity(value: unknown): value is ManualEntity {
  return typeof value === "string" && (MANUAL_ENTITIES as readonly string[]).includes(value);
}

/** The rules from public.manual_automations' answer (anything else is dropped). */
export function manualRulesOf(data: unknown): ManualRule[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) =>
    item && typeof item === "object" && typeof (item as ManualRule).id === "string" && typeof (item as ManualRule).name === "string"
      ? [{ id: (item as ManualRule).id, name: (item as ManualRule).name }]
      : [],
  );
}

const STATUS_MESSAGES: Record<string, string> = {
  success: "האוטומציה רצה: כל הפעולות בוצעו.",
  partial: "האוטומציה רצה, אבל חלק מהפעולות נכשלו.",
  failed: "האוטומציה רצה, והפעולות נכשלו.",
};

const REASON_MESSAGES: Record<string, string> = {
  not_found: "האוטומציה כבר לא זמינה לרשומה הזו, או שאין הרשאה לערוך אותה.",
  conditions: "הרשומה לא עומדת בתנאים של האוטומציה, לכן היא לא רצה.",
  limit: "האוטומציה כבר רצה 20 פעמים היום על הרשומה הזו.",
};

const QUOTA_MESSAGE = "ההרצות החודשיות של החבילה נוצלו. האוטומציה תוכל לרוץ שוב בתחילת החודש הבא או אחרי הגדלת החבילה.";

/** public.run_manual_automation's answer -> {ok, message} in Hebrew. */
export function manualRunResult(data: unknown): { ok: boolean; message: string } {
  const answer = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  if (answer.ok === true) {
    return { ok: true, message: STATUS_MESSAGES[String(answer.status)] ?? "האוטומציה רצה." };
  }
  if (answer.reason === "limit" && answer.detail === "quota") return { ok: false, message: QUOTA_MESSAGE };
  return { ok: false, message: REASON_MESSAGES[String(answer.reason)] ?? "לא הצלחנו להפעיל את האוטומציה. נסו שוב." };
}
