// RVW-49 (FLD-10 on the orders screens): every text of the orders module that names a deal or a contact, in the business's
// own words. Pure, unit tested (tests/unit/money-terms.test.ts). "לקוח" stays: it is the order's customer (a contact or a
// company), not the contact's name in the business.

import { byGender, withPrefixThe, type OrgTerms } from "@/features/terminology/terms";

import type { OrderSource } from "./schema";

/** The record card's empty line: "עוד אין הזמנות לעסקה." / "…לתיק." / "…ללקוח." / "…לחברה." */
export function ordersEmptyText(kind: "deal" | "contact" | "company", terms: OrgTerms): string {
  const to = kind === "deal" ? withPrefixThe("ל", terms.deal) : kind === "contact" ? withPrefixThe("ל", terms.contact) : "לחברה";
  return `עוד אין הזמנות ${to}.`;
}

/** The won deal's "order from the deal" button and its question. */
export function orderFromDealTexts(terms: OrgTerms): { title: string; description: string; button: string } {
  const deal = terms.deal;
  return {
    title: `ליצור הזמנה מ${deal.theSingular}?`,
    description: `תיווצר הזמנה ממוספרת עם השורות של ${deal.theSingular} כפי שהן: מחיר, מע״מ וחיוב. אם ${withPrefixThe("ל", deal)} יש הצעת מחיר שאושרה, יוצרים את ההזמנה מההצעה.`,
    button: `הזמנה מ${deal.theSingular}`,
  };
}

/** Where an order came from: "ידנית", "מהצעת מחיר", "מעסקה" / "מתיק". */
export function orderSourceLabels(terms: OrgTerms): Record<OrderSource, string> {
  return { manual: "ידנית", quote: "מהצעת מחיר", deal: `מ${terms.deal.singular}` };
}

/** The delivery contact picker's label and its fallback name. */
export function deliveryContactLabel(terms: OrgTerms): string {
  return `${terms.contact.singular} לאספקה`;
}

/** The shipping address hint: copied from the contact or the company when the order was made. */
export function shippingAddressHint(terms: OrgTerms): string {
  return `הועתקה מ${terms.contact.theSingular} או מהחברה כשההזמנה נוצרה. שינוי כאן לא משנה את הכרטיס שלהם.`;
}

/** The orders list: its description and its empty state. */
export function ordersListTexts(terms: OrgTerms): { description: string; empty: string } {
  const { deal, contact } = terms;
  return {
    description: `כל ההזמנות של ${deal.thePlural}, ${contact.thePlural} והחברות שאתם רואים. הזמנה יוצרים מהצעת מחיר שאושרה, מ${deal.singular} ש${byGender(deal, "נסגר", "נסגרה")} בהצלחה, או ידנית מכרטיס של ${contact.singular}, חברה או ${deal.singular}.`,
    empty: `הזמנה יוצרים מהצעת מחיר שאושרה, מ${deal.singular} ש${byGender(deal, "נסגר", "נסגרה")}, או בכרטיס "הזמנות" של ${contact.singular}, חברה או ${deal.singular}.`,
  };
}
