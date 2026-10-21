import { describe, expect, it } from "vitest";

import { documentsListTexts } from "@/features/documents/texts";
import { deliveryContactLabel, orderFromDealTexts, orderSourceLabels, ordersEmptyText, ordersListTexts, shippingAddressHint } from "@/features/orders/texts";
import { wonOrderText } from "@/features/orders/won";
import { paymentsListTexts } from "@/features/payments/texts";
import { DEFAULT_TERMS, resolveTerms } from "@/features/terminology/terms";

// RVW-49 (FLD-10): the orders, documents and payments screens name deals and contacts in the business's own words. With no
// choice the texts are today's, word for word; with other words nothing of today's words is left.

const OTHER = resolveTerms({ contact: "patient", lead: null, deal: "case" });
const TODAY_WORDS = /עסק(ה|את)|איש( ה)?קשר|אנשי( ה)?קשר/;

describe("orders texts", () => {
  it("are today's texts with today's words", () => {
    expect(ordersEmptyText("deal", DEFAULT_TERMS)).toBe("עוד אין הזמנות לעסקה.");
    expect(ordersEmptyText("contact", DEFAULT_TERMS)).toBe("עוד אין הזמנות לאיש הקשר.");
    expect(ordersEmptyText("company", DEFAULT_TERMS)).toBe("עוד אין הזמנות לחברה.");
    expect(orderFromDealTexts(DEFAULT_TERMS)).toEqual({
      title: "ליצור הזמנה מהעסקה?",
      description: "תיווצר הזמנה ממוספרת עם השורות של העסקה כפי שהן: מחיר, מע״מ וחיוב. אם לעסקה יש הצעת מחיר שאושרה, יוצרים את ההזמנה מההצעה.",
      button: "הזמנה מהעסקה",
    });
    expect(orderSourceLabels(DEFAULT_TERMS)).toEqual({ manual: "ידנית", quote: "מהצעת מחיר", deal: "מעסקה" });
    expect(deliveryContactLabel(DEFAULT_TERMS)).toBe("איש קשר לאספקה");
    expect(shippingAddressHint(DEFAULT_TERMS)).toBe("הועתקה מאיש הקשר או מהחברה כשההזמנה נוצרה. שינוי כאן לא משנה את הכרטיס שלהם.");
    expect(ordersListTexts(DEFAULT_TERMS)).toEqual({
      description: "כל ההזמנות של העסקאות, אנשי הקשר והחברות שאתם רואים. הזמנה יוצרים מהצעת מחיר שאושרה, מעסקה שנסגרה בהצלחה, או ידנית מכרטיס של איש קשר, חברה או עסקה.",
      empty: 'הזמנה יוצרים מהצעת מחיר שאושרה, מעסקה שנסגרה, או בכרטיס "הזמנות" של איש קשר, חברה או עסקה.',
    });
    expect(wonOrderText({ ok: false, message: "שגיאה" })).toBe("העסקה נסגרה, אבל ההזמנה לא נוצרה: שגיאה");
  });

  it("follow the business's words, gender included", () => {
    expect(ordersEmptyText("deal", OTHER)).toBe("עוד אין הזמנות לתיק.");
    expect(ordersEmptyText("contact", OTHER)).toBe("עוד אין הזמנות למטופל.");
    expect(orderFromDealTexts(OTHER).title).toBe("ליצור הזמנה מהתיק?");
    expect(orderFromDealTexts(OTHER).button).toBe("הזמנה מהתיק");
    expect(orderSourceLabels(OTHER).deal).toBe("מתיק");
    expect(deliveryContactLabel(OTHER)).toBe("מטופל לאספקה");
    expect(ordersListTexts(OTHER).description).toContain("מתיק שנסגר בהצלחה");
    expect(wonOrderText({ ok: false, message: "שגיאה" }, OTHER)).toBe("התיק נסגר, אבל ההזמנה לא נוצרה: שגיאה");
    for (const text of [
      ...Object.values(orderFromDealTexts(OTHER)),
      ...Object.values(ordersListTexts(OTHER)),
      ...Object.values(orderSourceLabels(OTHER)),
      ordersEmptyText("deal", OTHER),
      ordersEmptyText("contact", OTHER),
      deliveryContactLabel(OTHER),
      shippingAddressHint(OTHER),
    ]) {
      expect(text).not.toMatch(TODAY_WORDS);
    }
  });
});

describe("documents and payments list texts", () => {
  it("name deals and contacts in the business's words", () => {
    expect(documentsListTexts(DEFAULT_TERMS).description).toBe(
      "כל החשבוניות והקבלות שנרשמו בעסקאות ובאנשי קשר שאתם רואים. מסמך רושמים ומבטלים בכרטיס של העסקה או איש הקשר.",
    );
    expect(paymentsListTexts(DEFAULT_TERMS).empty).toBe('תשלום שהתקבל רושמים בכרטיס "תשלומים" של עסקה או איש קשר.');
    expect(paymentsListTexts(OTHER).description).toBe("כל התשלומים שנרשמו בתיקים ובמטופלים שאתם רואים. תשלום רושמים ומעדכנים בכרטיס של התיק או המטופל.");
    for (const text of [...Object.values(documentsListTexts(OTHER)), ...Object.values(paymentsListTexts(OTHER))]) {
      expect(text).not.toMatch(TODAY_WORDS);
    }
  });
});
