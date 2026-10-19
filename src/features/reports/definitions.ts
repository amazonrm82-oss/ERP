// The built-in reports (SPEC 11.1; meetings: CAL-11; referrals: CON-06; products: RPT-01; categories, profit: DLI-06; quotes: QUO-17). Shared by the index, the report page and the export.

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
];

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
