// The pure part of the full export (SPEC 12.4): which tables go in, how a table
// becomes a CSV, and the readable names put next to ids. No database here, so
// the unit tests can check it; export.ts reads the rows and builds the ZIP.

import { OCCASIONS } from "@/features/calendar-days/holidays";
import { channelTypeLabel } from "@/features/contacts/channels";
import { dealContactRoleLabel } from "@/features/deal-contacts/roles";
import { WEEKDAYS_LONG } from "@/lib/calendar-grid";
import { csvText } from "@/lib/csv";
import type { Database, Json } from "@/lib/database.types";

type Tables = Database["public"]["Tables"];

type Row<K extends keyof Tables> = Tables[K]["Row"];

// A table whose rows carry organization_id and created_at can be exported: the
// read filters by the first and pages in created_at order, ties broken by the
// row's key. Most tables are keyed by id; a link table without one (team_members,
// deal_contacts) names its primary key columns instead.
type WithId = {
  [K in keyof Tables]: Row<K> extends { organization_id: string; id: string; created_at: string } ? K : never;
}[keyof Tables];
type WithoutId = {
  [K in keyof Tables]: Row<K> extends { organization_id: string; created_at: string } ? (Row<K> extends { id: string } ? never : K) : never;
}[keyof Tables];

export type ExportTableName = WithId | WithoutId;

export type ExportTable =
  | { table: WithId; file: string }
  | { [K in WithoutId]: { table: K; file: string; key: readonly [Extract<keyof Row<K>, string>, ...Extract<keyof Row<K>, string>[]] } }[WithoutId];

/** The columns that, after created_at, order a table's rows deterministically. */
export function exportKey(t: ExportTable): readonly string[] {
  return "key" in t ? t.key : ["id"];
}

// Everything a customer owns, one CSV per table. Raw columns (ids included, so
// files can be joined), plus readable names next to the ids that need them.
// Every table here has organization_id, created_at and a key (the read orders by them).
export const EXPORT_TABLES: ReadonlyArray<ExportTable> = [
  { table: "leads", file: "leads.csv" },
  { table: "contacts", file: "contacts.csv" },
  { table: "contact_channels", file: "contact_channels.csv" },
  { table: "companies", file: "companies.csv" },
  { table: "deals", file: "deals.csv" },
  { table: "deal_contacts", file: "deal_contacts.csv", key: ["deal_id", "contact_id"] },
  { table: "tasks", file: "tasks.csv" },
  { table: "activities", file: "activities.csv" },
  { table: "meetings", file: "meetings.csv" },
  { table: "meeting_participants", file: "meeting_participants.csv" },
  { table: "pipelines", file: "pipelines.csv" },
  { table: "stages", file: "stages.csv" },
  { table: "lead_statuses", file: "lead_statuses.csv" },
  { table: "lead_sources", file: "lead_sources.csv" },
  { table: "disqualify_reasons", file: "disqualify_reasons.csv" },
  { table: "deal_loss_reasons", file: "deal_loss_reasons.csv" },
  { table: "record_type_options", file: "record_types.csv" },
  { table: "tags", file: "tags.csv" },
  { table: "field_definitions", file: "custom_fields.csv" },
  { table: "teams", file: "teams.csv" },
  { table: "team_members", file: "team_members.csv", key: ["team_id", "user_id"] },
  { table: "whatsapp_templates", file: "whatsapp_templates.csv" },
  // GOL-01
  { table: "goals", file: "goals.csv" },
  // PRD-04
  { table: "product_categories", file: "product_categories.csv" },
  { table: "product_units", file: "product_units.csv" },
  { table: "org_calendar_settings", file: "calendar_settings.csv" },
  { table: "org_document_settings", file: "document_settings.csv" },
  { table: "org_bank_details", file: "bank_details.csv" },
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
  deal_id: "deal",
  meeting_id: "meeting",
  team_id: "team",
  type_id: "type",
  // PRD-04: a subcategory's top category
  parent_id: "parent",
};

export type ExportRow = Record<string, unknown>;

const OCCASION_NAMES = new Map<string, string>(OCCASIONS.map((o) => [o.key, o.name]));

// readable columns added next to these coded ones; `table` limits one to the table it was made for
const READABLE: Record<string, { header: string; get: (value: unknown, row: ExportRow) => string; table?: ExportTableName }> = {
  // the rest days of CAL-03; 0 = Sunday … 6 = Saturday
  rest_weekdays: {
    header: "rest_days",
    get: (value) => (Array.isArray(value) ? value.map((d) => WEEKDAYS_LONG[Number(d)] ?? String(d)).join("; ") : ""),
  },
  // a key the app no longer knows stays as it is
  rest_occasions: {
    header: "rest_occasion_names",
    get: (value) => (Array.isArray(value) ? value.map((k) => OCCASION_NAMES.get(String(k)) ?? String(k)).join("; ") : ""),
  },
  // CON-03: the contact's role in the deal; a code this version does not know stays empty
  role: { header: "role_name", table: "deal_contacts", get: (value) => dealContactRoleLabel(typeof value === "string" ? value : null) ?? "" },
  // CON-01: the type of a further phone or email (mobile, work…)
  label: {
    header: "label_name",
    table: "contact_channels",
    get: (value, row) =>
      row.kind === "phone" || row.kind === "email" ? (channelTypeLabel(row.kind, typeof value === "string" ? value : null) ?? "") : "",
  },
};

// tables whose rows are named by their name column
const NAMED_BY_NAME = new Set<string>(["lead_statuses", "lead_sources", "stages", "pipelines", "companies", "teams", "record_type_options", "product_categories", "product_units"]);

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
      if (t.table === "deals") names.set(id, String(r.name ?? ""));
    }
  }
  return { names, tagNames };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return csvText(typeof value === "object" ? JSON.stringify(value) : String(value));
}

/** One table as CSV for Excel: BOM, CRLF, a name column after each id in LOOKUPS, custom fields as custom:<key>. */
export function toCsv(rows: ExportRow[], names: Map<string, string>, tagNames: Map<string, string>, table?: ExportTableName): string {
  if (rows.length === 0) return "﻿";
  const customKeys = [...new Set(rows.flatMap((r) => (r.custom_fields && typeof r.custom_fields === "object" ? Object.keys(r.custom_fields as object) : [])))];
  const base = Object.keys(rows[0]).filter((k) => k !== "custom_fields");
  const columns: Array<{ header: string; get: (r: ExportRow) => unknown }> = [];
  for (const k of base) {
    columns.push({ header: k, get: (r) => r[k] });
    if (LOOKUPS[k]) columns.push({ header: LOOKUPS[k], get: (r) => (typeof r[k] === "string" ? (names.get(r[k] as string) ?? "") : "") });
    const readable = READABLE[k];
    if (readable && (!readable.table || readable.table === table)) columns.push({ header: readable.header, get: (r) => readable.get(r[k], r) });
    if (k === "tag_ids") columns.push({ header: "tags", get: (r) => ((r.tag_ids as string[] | null) ?? []).map((id) => tagNames.get(id) ?? id).join("; ") });
  }
  for (const k of customKeys) columns.push({ header: `custom:${k}`, get: (r) => ((r.custom_fields as Record<string, Json> | null) ?? {})[k] });
  const lines = [columns.map((c) => cell(c.header)).join(","), ...rows.map((r) => columns.map((c) => cell(c.get(r))).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

export const EXPORT_README = `ייצוא מלא של נתוני העסק.

כל קובץ CSV הוא טבלה אחת, ונפתח ב-Excel עם עברית תקינה.
עמודות id מקשרות בין הקבצים (למשל company_id באנשי קשר הוא id בקובץ companies.csv).
ליד כל מזהה של משתמש, סטטוס, מקור, שלב, חברה, איש קשר, עסקה או פגישה מופיעה גם עמודה עם השם.
עמודות custom:... הן השדות המותאמים. רשומות עם deleted_at נמצאות בסל המחזור.
סכומים (amount_agorot) הם באגורות: מחלקים ב-100 לקבלת שקלים.
הפגישות נמצאות ב-meetings.csv (owner הוא מי שקבע את הפגישה), והמשתתפים בכל פגישה ב-meeting_participants.csv.
ימי המנוחה של העסק נמצאים ב-calendar_settings.csv: rest_weekdays הם ימי השבוע (0 = ראשון עד 6 = שבת), holidays_rest אומר אם החגים הם ימי מנוחה, holiday_eves_rest אם ערבי החג, ו-rest_occasions מועדים נוספים שבחרתם. אם הקובץ ריק, ההגדרות הן ברירת המחדל: שישי ושבת וחגים.
היעדים נמצאים ב-goals.csv: scope הוא user (חבר צוות), team (צוות) או org (כל העסק); period הוא month, quarter או year מ-period_start; metric הוא won_amount (הכנסה שנסגרה, target באגורות), won_deals, leads_handled או meetings_held.
המעמד של העסק במע"מ נמצא ב-document_settings.csv: vat_status הוא licensed (עוסק מורשה או חברה בע"מ), exempt (עוסק פטור), nonprofit (עמותה או מלכ"ר) או other (מעמד אחר, ששמו ב-vat_status_other, ו-other_charges_vat אומר אם הוא גובה מע"מ). legal_form היא צורת ההתאגדות. באותו קובץ פרטי העסק שמופיעים במסמכים: legal_name (שם רשמי), tax_id (מספר עוסק או ח.פ., 9 ספרות), address_line, city ו-postal_code (כתובת), phone ו-email (פרטי קשר במסמכים, והאימייל גם בהזמנות ליומן). פרטי הבנק להעברה נמצאים ב-bank_details.csv: bank_name, bank_branch, bank_account ו-bank_account_name (רק בעלים ומנהלי מערכת רואים אותם במערכת).
קטגוריות המוצרים נמצאות ב-product_categories.csv (parent_id היא הקטגוריה הראשית של תת-קטגוריה), ויחידות המידה ב-product_units.csv.
טלפונים ומיילים נוספים של אנשי קשר נמצאים ב-contact_channels.csv (kind הוא phone או email, ו-label_name הוא הסוג: נייד, עבודה וכו'). הטלפון והמייל הראשיים נמצאים ב-contacts.csv.
אנשי הקשר בכל עסקה נמצאים ב-deal_contacts.csv, עם התפקיד שלהם בעסקה (role_name).
חברי כל צוות נמצאים ב-team_members.csv (is_manager אומר אם הוא מנהל הצוות), ותבניות הודעות הוואטסאפ ב-whatsapp_templates.csv.
הקבצים שצורפו לרשומות נמצאים בתיקייה files, בשם <id>-<שם הקובץ>, ו-files.csv אומר לאיזו רשומה כל אחד שייך.
`;
