// The pure part of the full export (SPEC 12.4): which tables go in, how a table
// becomes a CSV, and the readable names put next to ids. No database here, so
// the unit tests can check it; export.ts reads the rows and builds the ZIP.

import { OCCASIONS } from "@/features/calendar-days/holidays";
import { WEEKDAYS_LONG } from "@/lib/calendar-grid";
import { csvText } from "@/lib/csv";
import type { Database, Json } from "@/lib/database.types";

type Tables = Database["public"]["Tables"];

// Only a table whose rows carry organization_id, id and created_at can be
// exported: the read filters by the first and pages in the order of the others.
export type ExportTableName = {
  [K in keyof Tables]: Tables[K]["Row"] extends { organization_id: string; id: string; created_at: string } ? K : never;
}[keyof Tables];

// Everything a customer owns, one CSV per table. Raw columns (ids included, so
// files can be joined), plus readable names next to the ids that need them.
// Every table here has organization_id, id and created_at (the read orders by them).
export const EXPORT_TABLES: ReadonlyArray<{ table: ExportTableName; file: string }> = [
  { table: "leads", file: "leads.csv" },
  { table: "contacts", file: "contacts.csv" },
  { table: "companies", file: "companies.csv" },
  { table: "deals", file: "deals.csv" },
  { table: "tasks", file: "tasks.csv" },
  { table: "activities", file: "activities.csv" },
  { table: "meetings", file: "meetings.csv" },
  { table: "meeting_participants", file: "meeting_participants.csv" },
  { table: "pipelines", file: "pipelines.csv" },
  { table: "stages", file: "stages.csv" },
  { table: "lead_statuses", file: "lead_statuses.csv" },
  { table: "lead_sources", file: "lead_sources.csv" },
  { table: "disqualify_reasons", file: "disqualify_reasons.csv" },
  { table: "record_type_options", file: "record_types.csv" },
  { table: "tags", file: "tags.csv" },
  { table: "field_definitions", file: "custom_fields.csv" },
  { table: "teams", file: "teams.csv" },
  { table: "org_calendar_settings", file: "calendar_settings.csv" },
  { table: "files", file: "files.csv" },
];

// readable names added next to these id columns
export const LOOKUPS: Record<string, string> = {
  owner_id: "owner",
  created_by: "created_by_name",
  user_id: "user",
  status_id: "status",
  source_id: "source",
  stage_id: "stage",
  pipeline_id: "pipeline",
  company_id: "company",
  contact_id: "contact",
  meeting_id: "meeting",
  team_id: "team",
  type_id: "type",
};

export type ExportRow = Record<string, unknown>;

const OCCASION_NAMES = new Map<string, string>(OCCASIONS.map((o) => [o.key, o.name]));

// readable columns added next to these coded ones (the rest days of CAL-03)
const READABLE: Record<string, { header: string; get: (value: unknown) => string }> = {
  // 0 = Sunday … 6 = Saturday
  rest_weekdays: {
    header: "rest_days",
    get: (value) => (Array.isArray(value) ? value.map((d) => WEEKDAYS_LONG[Number(d)] ?? String(d)).join("; ") : ""),
  },
  // a key the app no longer knows stays as it is
  rest_occasions: {
    header: "rest_occasion_names",
    get: (value) => (Array.isArray(value) ? value.map((k) => OCCASION_NAMES.get(String(k)) ?? String(k)).join("; ") : ""),
  },
};

// tables whose rows are named by their name column
const NAMED_BY_NAME = new Set<string>(["lead_statuses", "lead_sources", "stages", "pipelines", "companies", "teams", "record_type_options"]);

/**
 * id -> readable name for the LOOKUPS columns: people from their profiles, and
 * the rows of the exported tables that other rows point to; plus tag names.
 */
export function exportNames(
  data: ReadonlyArray<{ table: ExportTableName; rows: ExportRow[] }>,
  profiles: ReadonlyArray<{ id: string; full_name: string | null; email: string | null }>,
): { names: Map<string, string>; tagNames: Map<string, string> } {
  const names = new Map<string, string>();
  for (const p of profiles) names.set(p.id, p.full_name?.trim() || p.email || "");
  const tagNames = new Map<string, string>();
  for (const t of data) {
    for (const r of t.rows) {
      const id = r.id as string | undefined;
      if (!id) continue;
      if (t.table === "tags") tagNames.set(id, String(r.name ?? ""));
      if (NAMED_BY_NAME.has(t.table)) names.set(id, String(r.name ?? ""));
      if (t.table === "contacts") names.set(id, String(r.full_name ?? r.email ?? ""));
      if (t.table === "meetings") names.set(id, String(r.title ?? ""));
    }
  }
  return { names, tagNames };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return csvText(typeof value === "object" ? JSON.stringify(value) : String(value));
}

/** One table as CSV for Excel: BOM, CRLF, a name column after each id in LOOKUPS, custom fields as custom:<key>. */
export function toCsv(rows: ExportRow[], names: Map<string, string>, tagNames: Map<string, string>): string {
  if (rows.length === 0) return "﻿";
  const customKeys = [...new Set(rows.flatMap((r) => (r.custom_fields && typeof r.custom_fields === "object" ? Object.keys(r.custom_fields as object) : [])))];
  const base = Object.keys(rows[0]).filter((k) => k !== "custom_fields");
  const columns: Array<{ header: string; get: (r: ExportRow) => unknown }> = [];
  for (const k of base) {
    columns.push({ header: k, get: (r) => r[k] });
    if (LOOKUPS[k]) columns.push({ header: LOOKUPS[k], get: (r) => (typeof r[k] === "string" ? (names.get(r[k] as string) ?? "") : "") });
    if (READABLE[k]) columns.push({ header: READABLE[k].header, get: (r) => READABLE[k].get(r[k]) });
    if (k === "tag_ids") columns.push({ header: "tags", get: (r) => ((r.tag_ids as string[] | null) ?? []).map((id) => tagNames.get(id) ?? id).join("; ") });
  }
  for (const k of customKeys) columns.push({ header: `custom:${k}`, get: (r) => ((r.custom_fields as Record<string, Json> | null) ?? {})[k] });
  const lines = [columns.map((c) => cell(c.header)).join(","), ...rows.map((r) => columns.map((c) => cell(c.get(r))).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

export const EXPORT_README = `ייצוא מלא של נתוני העסק.

כל קובץ CSV הוא טבלה אחת, ונפתח ב-Excel עם עברית תקינה.
עמודות id מקשרות בין הקבצים (למשל company_id באנשי קשר הוא id בקובץ companies.csv).
ליד כל מזהה של משתמש, סטטוס, מקור, שלב, חברה או פגישה מופיעה גם עמודה עם השם.
עמודות custom:... הן השדות המותאמים. רשומות עם deleted_at נמצאות בסל המחזור.
סכומים (amount_agorot) הם באגורות: מחלקים ב-100 לקבלת שקלים.
הפגישות נמצאות ב-meetings.csv (owner הוא מי שקבע את הפגישה), והמשתתפים בכל פגישה ב-meeting_participants.csv.
ימי המנוחה של העסק נמצאים ב-calendar_settings.csv: rest_weekdays הם ימי השבוע (0 = ראשון עד 6 = שבת), holidays_rest אומר אם החגים הם ימי מנוחה, holiday_eves_rest אם ערבי החג, ו-rest_occasions מועדים נוספים שבחרתם. אם הקובץ ריק, ההגדרות הן ברירת המחדל: שישי ושבת וחגים.
הקבצים שצורפו לרשומות נמצאים בתיקייה files, בשם <id>-<שם הקובץ>, ו-files.csv אומר לאיזו רשומה כל אחד שייך.
`;
