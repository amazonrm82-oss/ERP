import { describe, expect, it } from "vitest";

import { IMPORT_ENTITIES, importEntityLabel } from "@/features/imports/fields";
import { REPORTS, reportTexts } from "@/features/reports/definitions";
import { CONTACT_TERMS, DEAL_TERMS, DEFAULT_TERMS, LEAD_TERMS, resolveTerms, withPrefixThe } from "@/features/terminology/terms";

// FLD-10 part two: record pages, reports and the import wizard in the business's own words.
describe("the business's words beyond the lists (FLD-10 part two)", () => {
  it("ל, ב and כ swallow the article; a construct form takes the letter as it is", () => {
    const expected: Record<string, string> = {
      "איש קשר": "לאיש הקשר",
      לקוח: "ללקוח",
      מטופל: "למטופל",
      תלמיד: "לתלמיד",
      חבר: "לחבר",
      ליד: "לליד",
      פנייה: "לפנייה",
      מתעניין: "למתעניין",
      עסקה: "לעסקה",
      הזדמנות: "להזדמנות",
      תיק: "לתיק",
    };
    for (const term of [...Object.values(CONTACT_TERMS), ...Object.values(LEAD_TERMS), ...Object.values(DEAL_TERMS)]) {
      expect(withPrefixThe("ל", term), term.singular).toBe(expected[term.singular]);
    }
    expect(withPrefixThe("ב", DEAL_TERMS.case)).toBe("בתיק");
    expect(withPrefixThe("כ", CONTACT_TERMS.contact)).toBe("כאיש הקשר");
  });

  it("with today's words, every report keeps its title and description", () => {
    for (const report of REPORTS) {
      expect(reportTexts(report, DEFAULT_TERMS), report.key).toEqual({ title: report.title, description: report.description });
    }
  });

  it("reports name leads, deals and contacts in the business's words, in the right gender", () => {
    const terms = resolveTerms({ contact: "customer", lead: "inquiry", deal: "case" });
    const text = (key: string) => reportTexts(REPORTS.find((r) => r.key === key)!, terms);
    expect(text("sources").title).toBe("פניות לפי מקור");
    expect(text("response").title).toBe("זמן תגובה לפנייה");
    expect(text("response").description).toContain("אחוז הפניות שנענו");
    expect(text("stuck").title).toBe("תיקים תקועים");
    expect(text("stuck").description).toMatch(/^תיקים פתוחים שנמצאים/);
    expect(text("lost").description).toBe("למה תיקים אובדים, באיזה שלב ואצל מי.");
    expect(text("meetings").description).toContain("שהובילו לתיק שנסגר.");
    expect(text("referrals").description).toContain("מי הפנה אליכם לקוחות");
    // no record word: unchanged
    expect(text("funnel")).toEqual({ title: "משפך המרה", description: REPORTS.find((r) => r.key === "funnel")!.description });
  });

  it("the import wizard names leads, contacts and deals in the business's words; other objects keep theirs", () => {
    for (const entity of IMPORT_ENTITIES) {
      expect(importEntityLabel(entity.value, DEFAULT_TERMS)).toBe(entity.label);
    }
    const terms = resolveTerms({ contact: "patient", lead: "prospect", deal: "opportunity" });
    expect(importEntityLabel("lead", terms)).toBe("מתעניינים");
    expect(importEntityLabel("contact", terms)).toBe("מטופלים");
    expect(importEntityLabel("deal", terms)).toBe("הזדמנויות");
    expect(importEntityLabel("company", terms)).toBe("חברות");
    expect(importEntityLabel("unknown", terms)).toBe("");
  });
});
