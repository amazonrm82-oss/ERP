/**
 * LND-13 (owner, 13 October 2026; built with LND-20 v2): the landing page's "תודיעו לי כשנפתח" for a coming-soon plan. What the
 * browser and the server share: the consent wording (a DRAFT, until the lawyer edits it) and its version, which the database
 * accepts only from its own closed list (app.landing_waitlist_wording_known), and the honeypot's name.
 */
export const WAITLIST_CONSENT_VERSION = "waitlist-draft-1";

// DRAFT wording (version waitlist-draft-1)
export const WAITLIST_CONSENT_TEXT = "אני מאשר/ת לקבל מ-Mexuz הודעה אחת באימייל כשהחבילה תיפתח, עם קישור להסרה.";

/** A field people never see; a bot that fills it is answered like a success and nothing is stored. */
export const WAITLIST_HONEYPOT = "website";

/** A honeypot is filled when it holds anything but nothing: a bot may send a number, true, an array or an object. */
export function honeypotFilled(value: unknown): boolean {
  return !(value === undefined || value === null || value === "");
}

export const WAITLIST_TEXTS = {
  received: "תודה! נודיע לך כשהחבילה תיפתח.",
  email: "כתובת האימייל לא תקינה.",
  consent: "צריך לסמן את האישור כדי שנוכל לשלוח את ההודעה.",
  plan: "החבילה הזאת לא מחכה לפתיחה.",
  error: "משהו השתבש. נסו שוב בעוד רגע.",
} as const;
