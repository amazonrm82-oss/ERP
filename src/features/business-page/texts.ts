// RVW-94 (FLD-10 on the business page settings): every text that names the leads the page's form makes, in the business's
// own words. Pure, unit tested (tests/unit/rvw94-module-terms.test.ts).

import { byGender, type OrgTerms } from "@/features/terminology/terms";

export type BusinessPageTexts = {
  showForm: string;
  routingLegend: string;
  routingDefault: string;
  ownerLabel: string;
  ownerHint: string;
  ownerMissing: string;
  teamHint: string;
};

export function businessPageTexts(terms: OrgTerms): BusinessPageTexts {
  const lead = terms.lead;
  return {
    showForm: `טופס "צרו קשר" (כל פנייה נכנסת כ${lead.singular})`,
    routingLegend: `למי ${byGender(lead, "הולכים", "הולכות")} ${lead.thePlural} מהטופס`,
    routingDefault: `לפי חלוקת ${lead.thePlural} של העסק`,
    ownerLabel: `מי מקבל את ${lead.thePlural}`,
    ownerHint:
      `בחופשה ${lead.theSingular} ${byGender(lead, "עובר", "עוברת")} לממלא המקום. בלי ממלא מקום זמין ${lead.theSingular} ` +
      `${byGender(lead, "נשאר", "נשארת")} בלי אחראי, והבעלים ומנהלי המערכת מקבלים התראה. אם האדם יעזוב או יהפוך לצופה, ` +
      `${lead.thePlural} יחזרו לחלוקה של העסק.`,
    ownerMissing: `בחרו מי יקבל את ${lead.thePlural}.`,
    teamHint: `${lead.thePlural} ${byGender(lead, "מתחלקים", "מתחלקות")} בין חברי הצוות.`,
  };
}
