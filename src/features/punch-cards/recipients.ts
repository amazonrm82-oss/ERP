// PKG-06 (owner's answers (149) א, (150) ג, (151) ג, 9 November 2026): a punch card line of a quote or an order may name its
// service recipient, so a parent pays and a child takes part, a company pays and an employee takes part. The document and the
// money stay on the payer; the card opens on the recipient. The database judges who may be the recipient
// (app.punch_recipient_linked: a CON-06 relation of the payer, either way, or an employee of the paying company) and
// freezes it with the document; public.punch_card_recipient_options lists the choices.

export type RecipientDocKind = "quote" | "order";
export type RecipientHow = "payer" | "relation" | "employee";
export type RecipientOption = { id: string; name: string; how: RecipientHow };

/** A line's recipient as the page shows it; `punch` is false on every line that is not a punch card. */
export type LineRecipient = { punch: boolean; recipientId: string | null; recipientName: string | null };

export const RECIPIENT_LABEL = "מקבל השירות";
export const PAYER_CHOICE = "המשלם עצמו";

const HOW_TEXT: Record<RecipientHow, string> = { payer: "המשלם", relation: "קשר של המשלם", employee: "עובד בחברה המשלמת" };

export function isRecipientHow(value: unknown): value is RecipientHow {
  return value === "payer" || value === "relation" || value === "employee";
}

/** "דנה (קשר של המשלם)" for the choice list. */
export function recipientOptionLabel(option: RecipientOption): string {
  return `${option.name || "ללא שם"} (${HOW_TEXT[option.how]})`;
}

/** The read-only line under a punch card line: who gets the card. */
export function recipientLine(recipientName: string | null): string {
  return recipientName ? `${RECIPIENT_LABEL}: ${recipientName}` : `${RECIPIENT_LABEL}: ${PAYER_CHOICE}`;
}

// (151) the business's choice for the customer's card messages (punch_card_alert_settings.notices_to)
export const NOTICES_TO = ["both", "payer"] as const;
export type NoticesTo = (typeof NOTICES_TO)[number];
export const NOTICES_TO_LABELS: Record<NoticesTo, string> = {
  both: "למקבל השירות, וגם למשלם כשהוא לא המקבל",
  payer: "רק למשלם",
};
export function isNoticesTo(value: unknown): value is NoticesTo {
  return value === "both" || value === "payer";
}
