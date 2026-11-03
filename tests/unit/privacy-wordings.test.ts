import { describe, expect, it } from "vitest";

import { MARKETING_CONSENT_VERSION } from "@/features/intake/marketing-consent";
import { consentWordings, noticeMissing, PRIVACY_NOTICE_VERSION, privacyNoticeParagraph } from "@/features/privacy-center/wordings";

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
    expect(PRIVACY_NOTICE_VERSION).toBe("notice-draft-2");
    expect(privacyNoticeParagraph(full)).toBe(
      "סטודיו גל (גל כהן, מספר עוסק 123456782) אוסף ושומר את הפרטים שמסרתם לנו, כמו שם, טלפון ואימייל, ואת תוכן הפניות שלכם. " +
        "אנחנו משתמשים בהם כדי לחזור אליכם, לתת לכם את השירות ולנהל את הקשר איתכם. " +
        "המידע נשמר במערכת לניהול לקוחות של ספק חיצוני, שמעבד אותו בשבילנו בלבד. " +
        "לא נשלח לכם פרסומות בלי הסכמה מפורשת, ואפשר לבטל הסכמה כזו בכל עת. " +
        "אתם רשאים לבקש לעיין במידע שלכם, לתקן אותו או למחוק אותו. " +
        "לפניות בנושא פרטיות אפשר לפנות לאחראי/ת הפרטיות של העסק: office@example.co.il או 04-1234567, הרצל 1, חיפה.",
    );
  });

  it("marks what is missing instead of inventing it", () => {
    const bare = { ...full, legalName: null, taxId: null, address: null, email: null, phone: " " };
    const text = privacyNoticeParagraph(bare);
    expect(text.startsWith("סטודיו גל אוסף")).toBe(true);
    expect(text).toContain("[להשלים: אימייל או טלפון]");
    expect(text).toContain("[להשלים: כתובת]");
    // owner (74) ג: the role, never a person's name; the officer is not an input of the paragraph at all
    expect(text).toContain("לאחראי/ת הפרטיות של העסק");
    expect(Object.keys(full)).not.toContain("officerName");
    expect(noticeMissing(bare)).toEqual(["אימייל או טלפון לפניות", "כתובת"]);
    expect(noticeMissing(full)).toEqual([]);
  });

  it("does not repeat a registered name equal to the display name", () => {
    expect(privacyNoticeParagraph({ ...full, legalName: "סטודיו גל", taxId: null }).startsWith("סטודיו גל אוסף")).toBe(true);
  });

  it("shows the form consent wording with the version saved with every consent (CAP-07), unchanged", () => {
    const consent = consentWordings("סטודיו גל");
    expect(consent.version).toBe(MARKETING_CONSENT_VERSION);
    expect(consent.items.map((item) => item.channel)).toEqual(["email", "sms", "whatsapp"]);
    expect(consent.items[0].text).toBe("אני מאשר/ת לקבל עדכונים ופרסומות באימייל מהעסק סטודיו גל. אפשר לבטל את ההסכמה בכל עת.");
  });
});
