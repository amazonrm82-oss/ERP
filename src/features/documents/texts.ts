// RVW-49 (FLD-10 on the documents list): the texts that name a deal or a contact, in the business's own words. Pure, unit
// tested (tests/unit/money-terms.test.ts).

import type { OrgTerms } from "@/features/terminology/terms";

export function documentsListTexts(terms: OrgTerms): { description: string; empty: string } {
  const { deal, contact } = terms;
  return {
    description: `כל החשבוניות והקבלות שנרשמו ב${deal.plural} וב${contact.plural} שאתם רואים. מסמך רושמים ומבטלים בכרטיס של ${deal.theSingular} או ${contact.theSingular}.`,
    empty: `חשבונית או קבלה שהופקה בתוכנת הנהלת החשבונות רושמים בכרטיס "מסמכים חשבונאיים" של ${deal.singular} או ${contact.singular}.`,
  };
}
