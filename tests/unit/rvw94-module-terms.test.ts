import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { anomalyRuleText } from "@/features/anomaly-alerts/settings";
import { ANOMALY_ALERT_DEFAULTS } from "@/features/anomaly-alerts/settings";
import { businessPageTexts } from "@/features/business-page/texts";
import { libraryRecipientTexts } from "@/features/library-links/texts";
import { prefillRecipientTexts, prefillRecordLabels } from "@/features/prefill-links/texts";
import { billingDealRow, billingEventLabel, billingFromDealTexts, billingsEmptyText } from "@/features/recurring-billing/texts";
import { reviewDealWonLabel, reviewHowItWorks, reviewOnlySince } from "@/features/review-requests/texts";
import { DEFAULT_TERMS, resolveTerms } from "@/features/terminology/terms";

// RVW-94 (FLD-10, the RVW-49 rule): the business page, review requests, recurring billing, anomaly alerts, library links and
// prefill links name leads, contacts and deals in the business's own words. With no choice the texts read today's words; with
// other words nothing of today's words is left.

const OTHER = resolveTerms({ contact: "patient", lead: "inquiry", deal: "case" });
const TODAY_WORDS = /ליד|עסק(ה|את|אות)|איש( ה)?קשר|אנשי( ה)?קשר/;

const ROOT = process.cwd();
const MODULES = ["business-page", "review-requests", "recurring-billing", "anomaly-alerts", "library-links", "prefill-links"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The code with its comments removed (line comments and block comments), so only strings and JSX text remain. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// public pages and server code that never show these words to staff, or name a field (תאריך לידה)
const ALLOWED = new Set(["src/features/prefill-links/fields.ts"]);

describe("RVW-94: the new modules use the business's words", () => {
  it("each module reads the terms", () => {
    for (const area of MODULES) {
      const code = files(join(ROOT, "src/features", area)).map((f) => readFileSync(f, "utf8")).join("\n");
      expect(code, area).toMatch(/@\/features\/terminology\/(terms|queries)"/);
    }
  });

  it("no screen text of these modules holds a fixed lead, deal or contact word", () => {
    for (const area of MODULES) {
      for (const file of files(join(ROOT, "src/features", area))) {
        const rel = file.slice(ROOT.length + 1);
        if (ALLOWED.has(rel)) continue;
        expect(withoutComments(readFileSync(file, "utf8")), rel).not.toMatch(TODAY_WORDS);
      }
    }
  });

  it("are today's texts with today's words", () => {
    expect(reviewDealWonLabel(DEFAULT_TERMS)).toBe("אחרי שעסקה נסגרה בהצלחה");
    expect(reviewHowItWorks(DEFAULT_TERMS, 90)).toContain("ההודעה יוצאת לאיש הקשר של העסקה או של הפגישה, ואם לפגישה יש רק ליד, לליד:");
    expect(reviewOnlySince(DEFAULT_TERMS)).toBe("הבקשה נשלחת רק על עסקאות ופגישות מהרגע שהפעלתם, לא על מה שהיה לפני.");
    expect(businessPageTexts(DEFAULT_TERMS)).toMatchObject({
      showForm: 'טופס "צרו קשר" (כל פנייה נכנסת כליד)',
      routingLegend: "למי הולכים הלידים מהטופס",
      routingDefault: "לפי חלוקת הלידים של העסק",
      ownerLabel: "מי מקבל את הלידים",
      ownerMissing: "בחרו מי יקבל את הלידים.",
      teamHint: "הלידים מתחלקים בין חברי הצוות.",
    });
    expect(businessPageTexts(DEFAULT_TERMS).ownerHint).toBe(
      "בחופשה הליד עובר לממלא המקום. בלי ממלא מקום זמין הליד נשאר בלי אחראי, והבעלים ומנהלי המערכת מקבלים התראה. אם האדם יעזוב או יהפוך לצופה, הלידים יחזרו לחלוקה של העסק.",
    );
    expect(billingFromDealTexts(DEFAULT_TERMS)).toEqual({
      title: "ליצור חיוב חוזר מהעסקה?",
      description: "השורות החוזרות של העסקה מועתקות לחיוב חוזר חדש של הלקוח, עם המחירים שלהן. בכל מחזור תיווצר משימה להפקת מסמך.",
      button: "חיוב חוזר מהעסקה",
    });
    expect(billingDealRow(DEFAULT_TERMS)).toEqual({ label: "עסקה", link: "העסקה שממנה נוצר" });
    expect(billingsEmptyText(DEFAULT_TERMS)).toBe('פותחים כרטיס של איש קשר או חברה ולוחצים על "חיוב חוזר חדש".');
    expect(billingEventLabel("deal_unlinked", DEFAULT_TERMS)).toBe("הקישור לעסקה הוסר: העסקה מוזגה לעסקה של לקוח אחר");
    expect(billingEventLabel("paused", DEFAULT_TERMS)).toBe("הושהה");
    expect(billingEventLabel("unknown_kind", DEFAULT_TERMS)).toBe("unknown_kind");
    expect(anomalyRuleText("lead_drop", ANOMALY_ALERT_DEFAULTS)).toMatch(/^מקור לידים קבוע/);
    expect(libraryRecipientTexts("lead", DEFAULT_TERMS).intro).toMatch(/^שולחים לליד פריט/);
    expect(libraryRecipientTexts("contact", DEFAULT_TERMS).revokeText).toBe("איש הקשר לא יוכל לפתוח את הפריט מהקישור הזה.");
    expect(libraryRecipientTexts("company", DEFAULT_TERMS).revokeText).toBe("החברה לא תוכל לפתוח את הפריט מהקישור הזה.");
    expect(prefillRecipientTexts("contact", DEFAULT_TERMS).intro).toMatch(/^שולחים לאיש הקשר קישור אישי/);
    expect(prefillRecordLabels(DEFAULT_TERMS)).toEqual({ lead: "ליד", contact: "איש קשר" });
  });

  it("follow the business's words, gender included", () => {
    expect(reviewDealWonLabel(OTHER)).toBe("אחרי שתיק נסגר בהצלחה");
    expect(reviewHowItWorks(OTHER, 90)).toContain("ההודעה יוצאת למטופל של התיק או של הפגישה, ואם לפגישה יש רק פנייה, לפנייה:");
    expect(businessPageTexts(OTHER).routingLegend).toBe("למי הולכות הפניות מהטופס");
    expect(businessPageTexts(OTHER).teamHint).toBe("הפניות מתחלקות בין חברי הצוות.");
    expect(businessPageTexts(OTHER).ownerHint).toContain("בחופשה הפנייה עוברת לממלא המקום");
    expect(billingDealRow(OTHER)).toEqual({ label: "תיק", link: "התיק שממנו נוצר" });
    expect(billingEventLabel("deal_unlinked", OTHER)).toBe("הקישור לתיק הוסר: התיק מוזג לתיק של לקוח אחר");
    expect(anomalyRuleText("lead_drop", ANOMALY_ALERT_DEFAULTS, OTHER)).toMatch(/^מקור פניות קבוע/);
    expect(libraryRecipientTexts("lead", OTHER).revokeText).toBe("הפנייה לא תוכל לפתוח את הפריט מהקישור הזה.");
    expect(libraryRecipientTexts("deal", OTHER).intro).toMatch(/^שולחים למטופל פריט/);
    expect(prefillRecipientTexts("lead", OTHER).revokeText).toMatch(/^הפנייה לא תוכל/);
    expect(prefillRecordLabels(OTHER)).toEqual({ lead: "פנייה", contact: "מטופל" });
    const all = [
      reviewDealWonLabel(OTHER),
      reviewHowItWorks(OTHER, 90),
      reviewOnlySince(OTHER),
      ...Object.values(businessPageTexts(OTHER)),
      ...Object.values(billingFromDealTexts(OTHER)),
      ...Object.values(billingDealRow(OTHER)),
      billingsEmptyText(OTHER),
      billingEventLabel("deal_unlinked", OTHER),
      anomalyRuleText("lead_drop", ANOMALY_ALERT_DEFAULTS, OTHER),
      ...(["lead", "contact", "company", "deal"] as const).flatMap((k) => Object.values(libraryRecipientTexts(k, OTHER))),
      ...(["lead", "contact"] as const).flatMap((k) => Object.values(prefillRecipientTexts(k, OTHER))),
      ...Object.values(prefillRecordLabels(OTHER)),
    ];
    for (const text of all) expect(text).not.toMatch(TODAY_WORDS);
  });
});
