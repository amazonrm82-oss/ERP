// RVW-49 (FLD-10 on the payments list): the texts that name a deal or a contact, in the business's own words. Pure, unit
// tested (tests/unit/money-terms.test.ts).

import type { OrgTerms } from "@/features/terminology/terms";

export function paymentsListTexts(terms: OrgTerms): { description: string; empty: string } {
  const { deal, contact } = terms;
  return {
    description: `כל התשלומים שנרשמו ב${deal.plural} וב${contact.plural} שאתם רואים. תשלום רושמים ומעדכנים בכרטיס של ${deal.theSingular} או ${contact.theSingular}.`,
    empty: `תשלום שהתקבל רושמים בכרטיס "תשלומים" של ${deal.singular} או ${contact.singular}.`,
  };
}
