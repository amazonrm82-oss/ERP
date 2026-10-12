// The ten built-in reports (SPEC 11.1). Shared by the index, the report page and the export.

export type ReportFilter = "period" | "owner" | "pipeline";

export type ReportDefinition = {
  key: string;
  title: string;
  description: string;
  filters: ReportFilter[];
};

export const REPORTS: ReportDefinition[] = [
  { key: "sources", title: "לידים לפי מקור", description: "כמות, אחוז המרה והכנסה לכל מקור וקמפיין.", filters: ["period", "owner"] },
  { key: "funnel", title: "משפך המרה", description: "כמה עברו מכל שלב לשלב הבא, והיכן נושרים.", filters: ["period", "owner", "pipeline"] },
  { key: "response", title: "זמן תגובה לליד", description: "זמן ממוצע עד מגע ראשון, לפי אחראי.", filters: ["period", "owner"] },
  { key: "reps", title: "ביצועי חברי הצוות", description: "עסקאות שנסגרו, סכום ואחוז סגירה בהצלחה לכל חבר צוות.", filters: ["period", "pipeline"] },
  { key: "activity", title: "פעילות", description: "שיחות, פגישות, הודעות ומשימות לחבר צוות וליום.", filters: ["period", "owner"] },
  { key: "forecast", title: "תחזית הכנסות", description: "שווי משוקלל של עסקאות פתוחות לפי חודש סגירה צפוי.", filters: ["owner", "pipeline"] },
  { key: "lost", title: "סיבות הפסד", description: "למה עסקאות אובדות, באיזה שלב ואצל מי.", filters: ["period", "owner", "pipeline"] },
  { key: "cycle", title: "אורך מחזור מכירה", description: "ימים מליד לסגירה, וימים בכל שלב.", filters: ["period", "owner", "pipeline"] },
  { key: "stuck", title: "עסקאות תקועות", description: "עסקאות פתוחות בלי פעילות, או בלי משימה או פגישה הבאה.", filters: ["owner", "pipeline"] },
  { key: "revenue", title: "הכנסות", description: "הכנסה שנסגרה לפי חודש, אחראי ולקוח.", filters: ["period", "owner", "pipeline"] },
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
};

export type ReportView = {
  kpis: Array<{ label: string; value: string; hint?: string }>;
  sections: ReportSection[];
  note?: string;
};
