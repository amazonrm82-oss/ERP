// SMS-01: the business's SMS sender name (org_message_settings.sms_sender_name), what the customer's phone shows as the
// sender. Israeli sender rules as the providers apply them: 2..11 Latin letters and digits with at least one letter, or a
// phone number the business answers on (local 0X..., international 972..., 1700/1800). Mirrors app.sms_sender_name_ok
// (migration sms_a_sender); both run tests/unit/fixtures/sms-sender-names.json. Empty = the platform account's default.

const NAME = /^[A-Za-z0-9]{2,11}$/;
const HAS_LETTER = /[A-Za-z]/;
const LOCAL_PHONE = /^0[2-9][0-9]{7,8}$/;
const INTERNATIONAL_PHONE = /^[+]?972[2-9][0-9]{7,8}$/;
const SPECIAL_PHONE = /^1[78]00[0-9]{6}$/;

/** Whether a value may be stored as the sender name, exactly as given (no trimming: store what passes). */
export function smsSenderNameOk(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return (NAME.test(value) && HAS_LETTER.test(value)) || LOCAL_PHONE.test(value) || INTERNATIONAL_PHONE.test(value) || SPECIAL_PHONE.test(value);
}

/** The form's value as it is stored: trimmed, and a phone's spaces and dashes taken out; "" = none. */
export function smsSenderNameInput(raw: string): string {
  const trimmed = raw.trim();
  return /^[+0-9][0-9 -]*$/.test(trimmed) ? trimmed.replace(/[ -]/g, "") : trimmed;
}

export const SMS_SENDER_NAME_HELP =
  "עד 11 אותיות באנגלית וספרות (לפחות אות אחת), למשל MyShop, או מספר הטלפון של העסק. בלי רווחים וסימנים. שדה ריק: שם השולח הכללי של המערכת.";

export const SMS_SENDER_NAME_INVALID = "שם השולח לא תקין. אפשר עד 11 אותיות באנגלית וספרות (לפחות אות אחת), או מספר טלפון.";

// SMS-01b (owner (211) א): a number is only the business's own phone, verified once by an SMS code; a letter name waits for
// the provider's approval (a platform owner or support marks it); until then the verified number, else the platform default.
// The rule lives in the database (trigger org_message_settings_sms_sender, app.sms_effective_sender); this is the screen's view.

export const SMS_SENDER_PENDING = "ממתין לאישור הספק";
export const SMS_SENDER_REJECTED = "השם נדחה על ידי הספק";

/** = app.sms_sender_is_number(): a sender value of the phone shapes. */
export function smsSenderIsNumber(value: string): boolean {
  return LOCAL_PHONE.test(value) || INTERNATIONAL_PHONE.test(value) || SPECIAL_PHONE.test(value);
}

/** An Israeli phone as E.164 for the screen's comparisons (0XXXXXXXXX / 972... / +972...); null = not one. */
export function israeliE164(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/[^0-9+]/g, "");
  if (/^0[2-9][0-9]{7,8}$/.test(digits)) return `+972${digits.slice(1)}`;
  if (/^\+?972[2-9][0-9]{7,8}$/.test(digits)) return `+${digits.replace(/^\+/, "")}`;
  return null;
}

export type SmsSender = {
  name: string | null;
  // the verified number, while it is still the business's phone
  verifiedPhone: string | null;
  businessPhone: string | null;
  nameState: "none" | "number" | "pending" | "approved" | "rejected";
  // what goes out now: the approved name, else the verified number, else null (the platform's default)
  effective: string | null;
};

export function smsSenderState(input: {
  name: string | null;
  verifiedPhone: string | null;
  approved: boolean;
  rejected?: boolean;
  businessPhone: string | null;
}): SmsSender {
  const business = israeliE164(input.businessPhone);
  const verified = input.verifiedPhone && business && input.verifiedPhone === business ? input.verifiedPhone : null;
  const nameState = !input.name
    ? "none"
    : smsSenderIsNumber(input.name)
      ? "number"
      : input.approved
        ? "approved"
        : input.rejected
          ? "rejected"
          : "pending";
  return {
    name: input.name,
    verifiedPhone: verified,
    businessPhone: input.businessPhone,
    nameState,
    effective: nameState === "approved" ? input.name : verified,
  };
}

/** The Hebrew answer of public.sms_sender_verify_start / sms_sender_verify. */
export function senderCheckMessage(answer: unknown): { ok: boolean; message: string } {
  const r = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  if (r.ok === true) return { ok: true, message: "" };
  switch (r.reason) {
    case "no_phone":
      return { ok: false, message: "לעסק אין מספר טלפון בפרטי העסק. מוסיפים אותו ב\"פרטי העסק\" ומנסים שוב." };
    case "cooldown":
      return { ok: false, message: "היו יותר מדי ניסיונות. אפשר לנסות שוב בעוד חצי שעה." };
    case "rate":
      return { ok: false, message: "נשלחו כבר שלושה קודים בשעה האחרונה. אפשר לנסות שוב מאוחר יותר." };
    case "no_code":
      return { ok: false, message: "אין קוד פעיל. שלחו קוד חדש." };
    case "expired":
      return { ok: false, message: "הקוד פג. שלחו קוד חדש." };
    case "wrong":
      return { ok: false, message: typeof r.left === "number" && r.left > 0 ? `הקוד שגוי. נשארו ${r.left} ניסיונות.` : "הקוד שגוי." };
    default:
      return { ok: false, message: "לא הצלחנו. נסו שוב." };
  }
}
