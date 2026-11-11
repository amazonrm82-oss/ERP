import { describe, expect, it } from "vitest";

import { CONVERTED_LEADS_MAX, convertedLeadsNote, fromLeadLine, recordDocumentsFilter } from "@/features/signatures/record-filter";
import { CONTACT_TERMS, LEAD_TERMS } from "@/features/terminology/terms";

const CONTACT = "11111111-1111-4111-8111-111111111111";
const LEAD_A = "22222222-2222-4222-8222-222222222222";
const LEAD_B = "33333333-3333-4333-8333-333333333333";

// RVW-83: a contact's card lists its own documents and those of the leads converted into it (read with the user's session).
describe("record documents filter (RVW-83)", () => {
  it("keeps the record's own column for every type, and for a contact without converted leads", () => {
    expect(recordDocumentsFilter("lead", LEAD_A)).toEqual({ kind: "eq", column: "lead_id", value: LEAD_A });
    expect(recordDocumentsFilter("deal", CONTACT, [LEAD_A])).toEqual({ kind: "eq", column: "deal_id", value: CONTACT });
    expect(recordDocumentsFilter("company", CONTACT, [LEAD_A])).toEqual({ kind: "eq", column: "company_id", value: CONTACT });
    expect(recordDocumentsFilter("contact", CONTACT)).toEqual({ kind: "eq", column: "contact_id", value: CONTACT });
  });

  it("adds a contact's converted leads, once each, ids only", () => {
    expect(recordDocumentsFilter("contact", CONTACT, [LEAD_A, LEAD_B, LEAD_A, "x),lead_id.not.is.null"])).toEqual({
      kind: "or",
      filter: `contact_id.eq.${CONTACT},lead_id.in.(${LEAD_A},${LEAD_B})`,
    });
  });

  it("looks at no more than the cap", () => {
    const many = Array.from({ length: CONVERTED_LEADS_MAX + 5 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const filter = recordDocumentsFilter("contact", CONTACT, many);
    expect(filter.kind).toBe("or");
    if (filter.kind === "or") expect(filter.filter.split(",").length).toBe(CONVERTED_LEADS_MAX + 1);
  });

  it("names the cap of converted leads in the business's words", () => {
    expect(CONVERTED_LEADS_MAX).toBe(20);
    expect(convertedLeadsNote(LEAD_TERMS.lead, CONTACT_TERMS.contact)).toBe("מוצגים מסמכים של 20 הלידים האחרונים שהומרו לאיש הקשר הזה");
    expect(convertedLeadsNote(LEAD_TERMS.inquiry, CONTACT_TERMS.customer)).toBe("מוצגים מסמכים של 20 הפניות האחרונות שהומרו ללקוח הזה");
  });

  it("says the document was sent while the record was a lead, in the business's word", () => {
    expect(fromLeadLine("ליד")).toBe("נשלח לפני ההמרה, כשהרשומה הייתה ליד.");
    expect(fromLeadLine("פנייה")).toBe("נשלח לפני ההמרה, כשהרשומה הייתה פנייה.");
  });
});
