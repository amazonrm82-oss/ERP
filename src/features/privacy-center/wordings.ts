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
// * notice-draft-2 (owner, 3 November 2026, answer (74) ג): the contact line names the role "אחראי/ת הפרטיות" with the
//   business's own contact details, never a person's name (the privacy officer's name is not an input of the paragraph).
// * notice-draft-3 (owner, 12 November 2026, LEGAL-2 (4); section 11 of the privacy law after amendment 13): the paragraph
//   says that giving the details is voluntary, the purpose, who controls the information and how to reach them, to whom
//   it is passed (the system's provider, as processor) and the rights of access and correction. The same version covers
//   the short notice every public form shows under it (publicFormNotice), built from what the page knows.

export const PRIVACY_NOTICE_VERSION = "notice-draft-3";

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
    `${name}${who ? ` (${who})` : ""} הוא בעל השליטה במידע שאתם מוסרים לנו, כמו שם, טלפון ואימייל, ותוכן הפניות שלכם.`,
    "מסירת הפרטים היא מרצון, ואין חובה לפי חוק למסור אותם. בלי פרטי קשר לא נוכל לחזור אליכם.",
    "אנחנו משתמשים בהם כדי לחזור אליכם, לתת לכם את השירות ולנהל את הקשר איתכם.",
    "המידע נשמר במערכת לניהול לקוחות של ספק חיצוני, שמעבד אותו בשבילנו בלבד. לא נמסור אותו לאחרים, אלא אם החוק מחייב.",
    "לא נשלח לכם פרסומות בלי הסכמה מפורשת, ואפשר לבטל הסכמה כזו בכל עת.",
    "אתם רשאים לעיין במידע שלכם, ולבקש לתקן אותו או למחוק אותו.",
    `לפניות בנושא פרטיות אפשר לפנות לאחראי/ת הפרטיות של העסק: ${contact}, ${address}.`,
  ].join(" ");
}

/** The business's name and contact a public page answers for its notice (`notice` of intake_form and others). */
export type PublicNoticeContact = { business: string | null; email: string | null; phone: string | null };

const noticeText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? clean(value) : null;

/** The `notice` object of a public page function ({name, email, phone}), or null when it is not one. */
export function noticeContactFrom(value: unknown): PublicNoticeContact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return { business: noticeText(raw.name, 200), email: noticeText(raw.email, 254), phone: noticeText(raw.phone, 40) };
}

/** One piece of the short notice: plain text, or an address or phone shown left to right (`ltr`). */
export type NoticePart = { text: string; ltr?: true };

/**
 * The short notice under a public form (LEGAL-2 (4), version PRIVACY_NOTICE_VERSION): voluntary, the purpose, who
 * controls the information and how to reach them, the processor it goes to, and the rights. Built only from what the
 * page already knows; without a contact it points to the business the page names. In parts, so the page can show each
 * email and phone left to right.
 */
export function publicFormNoticeParts(contact: PublicNoticeContact): NoticePart[] {
  const business = clean(contact.business);
  const who = business ? `לעסק ${business}` : "לעסק שהדף הזה שלו";
  const reach = [clean(contact.email), clean(contact.phone)].filter((v): v is string => Boolean(v));
  const head = [
    `הפרטים שתמסרו כאן נמסרים ${who}, שהוא בעל השליטה במידע, כדי לחזור אליכם ולתת לכם את השירות.`,
    "מסירת הפרטים היא מרצון, ואין חובה לפי חוק למסור אותם.",
    "המידע נשמר במערכת Mexuz, שמעבדת אותו בשביל העסק בלבד, ולא יימסר לאחרים אלא אם החוק מחייב.",
    "אתם רשאים לעיין במידע שלכם ולבקש לתקן אותו",
  ].join(" ");
  if (reach.length === 0) return [{ text: `${head}, בפנייה לעסק.` }];
  const parts: NoticePart[] = [{ text: `${head}, בפנייה לעסק: ` }];
  reach.forEach((value, index) => {
    if (index > 0) parts.push({ text: " או " });
    parts.push({ text: value, ltr: true });
  });
  parts.push({ text: "." });
  return parts;
}

/** The short notice as one string (the parts joined). */
export function publicFormNotice(contact: PublicNoticeContact): string {
  return publicFormNoticeParts(contact)
    .map((part) => part.text)
    .join("");
}
