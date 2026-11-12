import { describe, expect, it } from "vitest";

import { MARKETING_CONSENT_VERSION } from "@/features/intake/marketing-consent";
import { consentWordings, noticeContactFrom, noticeMissing, PRIVACY_NOTICE_VERSION, privacyNoticeParagraph, publicFormNotice, publicFormNoticeParts } from "@/features/privacy-center/wordings";

const full = {
  businessName: "סטודיו גל",
  legalName: "גל כהן",
  taxId: "123456782",
  address: "הרצל 1, חיפה",
  email: "office@example.co.il",
  phone: "04-1234567",
};

// PRK-04: the privacy-notice paragraph is versioned in code. This pins the text of PRIVACY_NOTICE_VERSION: a change to the
// wording fails here until the version moves on too (and the expected text below is updated with it).
describe("privacy wordings (PRK-04)", () => {
  it("pins the notice text of its version", () => {
    expect(PRIVACY_NOTICE_VERSION).toBe("notice-draft-3");
    expect(privacyNoticeParagraph(full)).toBe(
      "סטודיו גל (גל כהן, מספר עוסק 123456782) הוא בעל השליטה במידע שאתם מוסרים לנו, כמו שם, טלפון ואימייל, ותוכן הפניות שלכם. " +
        "מסירת הפרטים היא מרצון, ואין חובה לפי חוק למסור אותם. בלי פרטי קשר לא נוכל לחזור אליכם. " +
        "אנחנו משתמשים בהם כדי לחזור אליכם, לתת לכם את השירות ולנהל את הקשר איתכם. " +
        "המידע נשמר במערכת לניהול לקוחות של ספק חיצוני, שמעבד אותו בשבילנו בלבד. לא נמסור אותו לאחרים, אלא אם החוק מחייב. " +
        "לא נשלח לכם פרסומות בלי הסכמה מפורשת, ואפשר לבטל הסכמה כזו בכל עת. " +
        "אתם רשאים לעיין במידע שלכם, ולבקש לתקן אותו או למחוק אותו. " +
        "לפניות בנושא פרטיות אפשר לפנות לאחראי/ת הפרטיות של העסק: office@example.co.il או 04-1234567, הרצל 1, חיפה.",
    );
  });

  // LEGAL-2 (4): the short notice under every public form, of the same version: voluntary, purpose, the controller and
  // a way to reach it, the processor, the rights of access and correction
  it("pins the short notice under public forms, built from what the page knows", () => {
    expect(publicFormNotice({ business: "סטודיו גל", email: "office@example.co.il", phone: "04-1234567" })).toBe(
      "הפרטים שתמסרו כאן נמסרים לעסק סטודיו גל, שהוא בעל השליטה במידע, כדי לחזור אליכם ולתת לכם את השירות. " +
        "מסירת הפרטים היא מרצון, ואין חובה לפי חוק למסור אותם. " +
        "המידע נשמר במערכת Mexuz, שמעבדת אותו בשביל העסק בלבד, ולא יימסר לאחרים אלא אם החוק מחייב. " +
        "אתם רשאים לעיין במידע שלכם ולבקש לתקן אותו, בפנייה לעסק: office@example.co.il או 04-1234567.",
    );
    // the email and the phone are their own parts, shown left to right
    const parts = publicFormNoticeParts({ business: "סטודיו גל", email: "office@example.co.il", phone: "04-1234567" });
    expect(parts.filter((p) => p.ltr).map((p) => p.text)).toEqual(["office@example.co.il", "04-1234567"]);
    expect(parts.map((p) => p.text).join("")).toBe(publicFormNotice({ business: "סטודיו גל", email: "office@example.co.il", phone: "04-1234567" }));
    const bare = publicFormNotice({ business: null, email: null, phone: " " });
    expect(bare.startsWith("הפרטים שתמסרו כאן נמסרים לעסק שהדף הזה שלו,")).toBe(true);
    expect(bare.endsWith("ולבקש לתקן אותו, בפנייה לעסק.")).toBe(true);
  });

  it("reads the page function's notice object and nothing else", () => {
    expect(noticeContactFrom({ name: "סטודיו גל", email: "a@b.co", phone: "+972501234567", extra: "x" })).toEqual({ business: "סטודיו גל", email: "a@b.co", phone: "+972501234567" });
    expect(noticeContactFrom({ name: "סטודיו גל" })).toEqual({ business: "סטודיו גל", email: null, phone: null });
    expect(noticeContactFrom({ name: 5, email: "x".repeat(300) })).toEqual({ business: null, email: null, phone: null });
    expect(noticeContactFrom(null)).toBeNull();
    expect(noticeContactFrom([])).toBeNull();
  });

  it("marks what is missing instead of inventing it", () => {
    const bare = { ...full, legalName: null, taxId: null, address: null, email: null, phone: " " };
    const text = privacyNoticeParagraph(bare);
    expect(text.startsWith("סטודיו גל הוא בעל השליטה")).toBe(true);
    expect(text).toContain("[להשלים: אימייל או טלפון]");
    expect(text).toContain("[להשלים: כתובת]");
    // owner (74) ג: the role, never a person's name; the officer is not an input of the paragraph at all
    expect(text).toContain("לאחראי/ת הפרטיות של העסק");
    expect(Object.keys(full)).not.toContain("officerName");
    expect(noticeMissing(bare)).toEqual(["אימייל או טלפון לפניות", "כתובת"]);
    expect(noticeMissing(full)).toEqual([]);
  });

  it("does not repeat a registered name equal to the display name", () => {
    expect(privacyNoticeParagraph({ ...full, legalName: "סטודיו גל", taxId: null }).startsWith("סטודיו גל הוא בעל השליטה")).toBe(true);
  });

  it("shows the form consent wording with the version saved with every consent (CAP-07), unchanged", () => {
    const consent = consentWordings("סטודיו גל");
    expect(consent.version).toBe(MARKETING_CONSENT_VERSION);
    expect(consent.items.map((item) => item.channel)).toEqual(["email", "sms", "whatsapp"]);
    expect(consent.items[0].text).toBe("אני מאשר/ת לקבל עדכונים ופרסומות באימייל מהעסק סטודיו גל. אפשר לבטל את ההסכמה בכל עת.");
  });
});
