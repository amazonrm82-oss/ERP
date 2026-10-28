import { byGender, DEFAULT_TERMS, type OrgTerms } from "@/features/terminology/terms";

// The built-in reports (SPEC 11.1; source_revenue: SEG-02; meetings: CAL-11; referrals: CON-06; products: RPT-01; categories, profit: DLI-06; quotes: QUO-17; debt_aging: BAL-03; collection: COL-06). Shared by the index, the report page and the export.

export type ReportFilter = "period" | "owner" | "pipeline";

export type ReportDefinition = {
  key: string;
  title: string;
  description: string;
  filters: ReportFilter[];
  // the label of the person filter when it is not the record's owner ("אחראי")
  ownerLabel?: string;
  // DLI-06: shown, opened and exported only by those who may see costs (canViewCosts); the SQL answers nothing to others
  costs?: true;
  // QUO-17: a report of a plan capability, shown, opened and exported only while the business has it
  feature?: "quotes";
  // BAL-03: shown, opened and exported only by those who open a customer's ledger (BAL-01: owners, admins, managers and
  // holders of record_payments) with the balances, documents and payments keys; the SQL answers {allowed: false} to others
  balances?: true;
  // COL-06: shown, opened and exported only by those who open the collection screen (COL-01: BAL-01's rule with the
  // collection, documents and payments keys); the SQL answers {allowed: false} to others
  collection?: true;
  // LEAD-08: a report about one module only, left out of the index while the business has that module switched off
  module?: "leads";
};

export const REPORTS: ReportDefinition[] = [
  { key: "sources", title: "לידים לפי מקור", description: "כמות, אחוז המרה והכנסה לכל מקור וקמפיין.", filters: ["period", "owner"], module: "leads" },
  { key: "funnel", title: "משפך המרה", description: "כמה עברו מכל שלב לשלב הבא, והיכן נושרים.", filters: ["period", "owner", "pipeline"] },
  { key: "response", title: "זמן תגובה לליד", description: "זמן עד מגע ראשון ואחוז הלידים שנענו בתוך היעד, לפי אחראי, מקור ושעה.", filters: ["period", "owner"], module: "leads" },
  { key: "reps", title: "ביצועי חברי הצוות", description: "עסקאות שנסגרו, סכום ואחוז סגירה בהצלחה לכל חבר צוות.", filters: ["period", "pipeline"] },
  { key: "activity", title: "פעילות", description: "שיחות, פגישות, הודעות ומשימות לחבר צוות וליום.", filters: ["period", "owner"] },
  { key: "forecast", title: "תחזית הכנסות", description: "שווי משוקלל של עסקאות פתוחות לפי חודש סגירה צפוי, מול יעד ההכנסה, לפי חבר צוות ושלב.", filters: ["owner", "pipeline"] },
  { key: "lost", title: "סיבות הפסד", description: "למה עסקאות אובדות, באיזה שלב ואצל מי.", filters: ["period", "owner", "pipeline"] },
  { key: "cycle", title: "אורך מחזור מכירה", description: "ימים מליד לסגירה, וימים בכל שלב.", filters: ["period", "owner", "pipeline"] },
  { key: "stuck", title: "עסקאות תקועות", description: "עסקאות פתוחות שנמצאות בשלב יותר מדי זמן, או בלי משימה או פגישה הבאה.", filters: ["owner", "pipeline"] },
  { key: "revenue", title: "הכנסות", description: "הכנסה שנסגרה לפי חודש, אחראי ולקוח.", filters: ["period", "owner", "pipeline"] },
  // SEG-02: revenue by the first source of the deal's lead or contact
  {
    key: "source_revenue",
    title: "הכנסה לפי מקור וקמפיין",
    description: "הכנסה מעסקאות שנסגרו, לפי המקור הראשון והקמפיין של הליד או איש הקשר שממנו הגיעו.",
    filters: ["period", "owner", "pipeline"],
  },
  // RPT-01
  { key: "products", title: "הכנסה לפי מוצר", description: "מה נמכר בעסקאות שנסגרו: כמות, מספר עסקאות וסכום לכל מוצר.", filters: ["period", "owner", "pipeline"] },
  // DLI-06
  { key: "categories", title: "הכנסה לפי קטגוריה", description: "מה נמכר בעסקאות שנסגרו לפי קטגוריית המוצר: מספר עסקאות וסכום.", filters: ["period", "owner", "pipeline"] },
  {
    key: "profit",
    title: "רווח גולמי",
    description: "הכנסה, עלות ורווח גולמי לכל מוצר בעסקאות שנסגרו, לפי העלות שנשמרה בכל שורה.",
    filters: ["period", "owner", "pipeline"],
    costs: true,
  },
  { key: "meetings", title: "פגישות", description: "פגישות לפי מארגן, אחוז אי-הגעה, ופגישות שהובילו לעסקה שנסגרה.", filters: ["period", "owner"], ownerLabel: "מארגן" },
  // CON-06
  { key: "referrals", title: "הפניות", description: "מי הפנה אליכם אנשי קשר, כמה מהם הפכו ללקוחות ומה ההכנסה מהם.", filters: ["period"] },
  // QUO-17
  {
    key: "quotes",
    title: "הצעות מחיר",
    description:
      "כמה הצעות נשלחו, אחוז האישור, הזמן עד אישור ושווי ההצעות הפתוחות. הצעה שנשלחה לה גרסה חדשה נספרת פעם אחת, בחודש שבו נשלחה הגרסה האחרונה, ולכן נתוני חודש קודם יכולים להשתנות. תוספת להצעה נספרת כהצעה בפני עצמה, גם באחוז האישור ובשווי שאושר.",
    filters: ["period", "owner"],
    feature: "quotes",
  },
  // BAL-03
  {
    key: "debt_aging",
    title: "גיול חובות",
    description: "החוב הפתוח של כל הלקוחות לפי ותק: טרם הגיע מועד התשלום, 0 עד 30, 31 עד 60, 61 עד 90 ומעל 90 יום באיחור.",
    filters: ["owner"],
    balances: true,
  },
  // COL-06
  {
    key: "collection",
    title: "גבייה",
    description: "כמה נגבה בכל חודש, בכל אמצעי תשלום ואצל כל נציג, ותוך כמה ימים בממוצע לקוחות משלמים מסמך עד הסוף.",
    filters: ["period", "owner"],
    ownerLabel: "נציג",
    collection: true,
  },
];

/**
 * FLD-10 part two: a report's title and description in the business's own words. Only the reports that name leads, deals
 * or contacts differ; with today's words every text equals the definition's (unit test).
 */
export function reportTexts(report: ReportDefinition, terms: OrgTerms = DEFAULT_TERMS): { title: string; description: string } {
  const { lead, deal, contact } = terms;
  const closed = `${deal.plural} שנסגרו`;
  const open = `${deal.plural} ${byGender(deal, "פתוחים", "פתוחות")}`;
  switch (report.key) {
    case "sources":
      return { title: `${lead.plural} לפי מקור`, description: report.description };
    case "response":
      return {
        title: `זמן תגובה ל${lead.singular}`,
        description: `זמן עד מגע ראשון ואחוז ${lead.thePlural} שנענו בתוך היעד, לפי אחראי, מקור ושעה.`,
      };
    case "reps":
      return { title: report.title, description: `${closed}, סכום ואחוז סגירה בהצלחה לכל חבר צוות.` };
    case "forecast":
      return { title: report.title, description: `שווי משוקלל של ${open} לפי חודש סגירה צפוי, מול יעד ההכנסה, לפי חבר צוות ושלב.` };
    case "lost":
      return { title: report.title, description: `למה ${deal.plural} ${byGender(deal, "אובדים", "אובדות")}, באיזה שלב ואצל מי.` };
    case "cycle":
      return { title: report.title, description: `ימים מ${lead.singular} לסגירה, וימים בכל שלב.` };
    case "stuck":
      return {
        title: `${deal.plural} ${byGender(deal, "תקועים", "תקועות")}`,
        description: `${open} ${byGender(deal, "שנמצאים", "שנמצאות")} בשלב יותר מדי זמן, או בלי משימה או פגישה הבאה.`,
      };
    case "source_revenue":
      return {
        title: report.title,
        description: `הכנסה מ${closed}, לפי המקור הראשון והקמפיין של ה${lead.singular} או ${contact.theSingular} שממנו הגיעו.`,
      };
    case "products":
      return { title: report.title, description: `מה נמכר ב${closed}: כמות, מספר ${deal.plural} וסכום לכל מוצר.` };
    case "categories":
      return { title: report.title, description: `מה נמכר ב${closed} לפי קטגוריית המוצר: מספר ${deal.plural} וסכום.` };
    case "profit":
      return { title: report.title, description: `הכנסה, עלות ורווח גולמי לכל מוצר ב${closed}, לפי העלות שנשמרה בכל שורה.` };
    case "meetings":
      return { title: report.title, description: `פגישות לפי מארגן, אחוז אי-הגעה, ופגישות שהובילו ל${deal.singular} ${byGender(deal, "שנסגר", "שנסגרה")}.` };
    case "referrals":
      return { title: report.title, description: `מי הפנה אליכם ${contact.plural}, כמה מהם הפכו ללקוחות ומה ההכנסה מהם.` };
    default:
      return { title: report.title, description: report.description };
  }
}

export function findReport(key: string): ReportDefinition | undefined {
  return REPORTS.find((report) => report.key === key);
}

export type ColumnKind = "text" | "number" | "money" | "percent" | "days" | "minutes";

export type ReportColumn = { key: string; label: string; kind: ColumnKind };

export type ReportRow = Record<string, string | number | null> & { _href?: string | null };

export type ReportSection = {
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  // column drawn as a bar next to its value
  bar?: string;
  empty: string;
  note?: string;
  // the section's element id, for links to it ("#overdue-deals"); a page may also render it its own way
  anchor?: string;
  // COL-06: a section of links only, shown on screen and left out of the CSV and Excel files
  exported?: false;
};

// GOL-04: an open deal whose expected close date has passed, for the forecast screen's actions
export type OverdueDeal = {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string;
  pipelineId: string;
  stageName: string | null;
  amount: number;
  weighted: number;
  expected: string;
};

export type ReportView = {
  kpis: Array<{ label: string; value: string; hint?: string }>;
  sections: ReportSection[];
  note?: string;
  overdueDeals?: OverdueDeal[];
  // all of them; overdueDeals holds the 200 oldest
  overdueTotal?: number;
};
