import {
  MARKETING_CONSENT_CHANNELS,
  MARKETING_CONSENT_LABELS,
  MARKETING_CONSENT_VERSION,
  marketingConsentWording,
  type MarketingConsentChannel,
} from "@/features/intake/marketing-consent";

// PRK-04: ready wordings for the business. Both are DRAFTS until the lawyer edits them (owner, 8 October 2026).
// * The form consent wording is CAP-07's (app.marketing_consent_wording, version MARKETING_CONSENT_VERSION, saved with
//   every consent the form records, consents.wording_version). It is shown here, never changed here: a new text is a
//   new version in a new migration, the owner's call.
// * The privacy-notice paragraph is for the business's own site or forms. It is not stored with anything, so its
//   version lives here; any change to the text below is a new PRIVACY_NOTICE_VERSION (tests/unit/privacy-wordings.test.ts
//   pins the text of this version).

export const PRIVACY_NOTICE_VERSION = "notice-draft-1";

export const WORDINGS_DRAFT_NOTE = "נוסח טיוטה, עד שעורך דין יאשר אותו. כדאי שעורך הדין של העסק יעבור עליו לפני שמפרסמים.";

export type ConsentWording = { channel: MarketingConsentChannel; label: string; text: string };

/** The consent box text per channel, as the business's forms show it, with the version saved with every consent. */
export function consentWordings(businessName: string): { version: string; items: ConsentWording[] } {
  return {
    version: MARKETING_CONSENT_VERSION,
    items: MARKETING_CONSENT_CHANNELS.map((channel) => ({
      channel,
      label: MARKETING_CONSENT_LABELS[channel],
      text: marketingConsentWording(channel, businessName),
    })),
  };
}

export type NoticeDetails = {
  // the display name (customer-facing communication uses it)
  businessName: string;
  legalName: string | null;
  taxId: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  officerName: string | null;
};

const clean = (value: string | null | undefined): string | null => {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
};

const missing = (what: string) => `[להשלים: ${what}]`;

/** The details the paragraph still needs, for the line above it ("missing: ..."). */
export function noticeMissing(details: NoticeDetails): string[] {
  const out: string[] = [];
  if (!clean(details.email) && !clean(details.phone)) out.push("אימייל או טלפון לפניות");
  if (!clean(details.address)) out.push("כתובת");
  return out;
}

/** The privacy-notice paragraph of this version, filled with the business's details; a missing detail is marked. */
export function privacyNoticeParagraph(details: NoticeDetails): string {
  const name = clean(details.businessName) ?? missing("שם העסק");
  const legal = clean(details.legalName);
  const taxId = clean(details.taxId);
  const who = [legal && legal !== name ? legal : null, taxId ? `מספר עוסק ${taxId}` : null].filter(Boolean).join(", ");
  const contact = [clean(details.email), clean(details.phone)].filter(Boolean).join(" או ") || missing("אימייל או טלפון");
  const address = clean(details.address) ?? missing("כתובת");
  return [
    `${name}${who ? ` (${who})` : ""} אוסף ושומר את הפרטים שמסרתם לנו, כמו שם, טלפון ואימייל, ואת תוכן הפניות שלכם.`,
    "אנחנו משתמשים בהם כדי לחזור אליכם, לתת לכם את השירות ולנהל את הקשר איתכם.",
    "המידע נשמר במערכת לניהול לקוחות של ספק חיצוני, שמעבד אותו בשבילנו בלבד.",
    "לא נשלח לכם פרסומות בלי הסכמה מפורשת, ואפשר לבטל הסכמה כזו בכל עת.",
    "אתם רשאים לבקש לעיין במידע שלכם, לתקן אותו או למחוק אותו.",
    `לפניות בנושא פרטיות: ${contact}, ${address}.`,
  ].join(" ");
}
