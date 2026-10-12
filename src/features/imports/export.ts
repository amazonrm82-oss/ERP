import "server-only";

import { strToU8, zipSync } from "fflate";

import { csvText } from "@/lib/csv";
import type { Database, Json } from "@/lib/database.types";
import { FILES_BUCKET } from "@/features/files/types";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

type TableName = keyof Database["public"]["Tables"];

// Everything a customer owns, one CSV per table. Raw columns (ids included, so
// files can be joined), plus readable names next to the ids that need them.
const TABLES: Array<{ table: TableName; file: string }> = [
  { table: "leads", file: "leads.csv" },
  { table: "contacts", file: "contacts.csv" },
  { table: "companies", file: "companies.csv" },
  { table: "deals", file: "deals.csv" },
  { table: "tasks", file: "tasks.csv" },
  { table: "activities", file: "activities.csv" },
  { table: "pipelines", file: "pipelines.csv" },
  { table: "stages", file: "stages.csv" },
  { table: "lead_statuses", file: "lead_statuses.csv" },
  { table: "lead_sources", file: "lead_sources.csv" },
  { table: "tags", file: "tags.csv" },
  { table: "field_definitions", file: "custom_fields.csv" },
  { table: "teams", file: "teams.csv" },
  { table: "files", file: "files.csv" },
];

// the files themselves go into the ZIP up to this total; past it, files.csv still lists them
const FILES_MAX_BYTES = 150 * 1024 * 1024;

const PAGE = 1000;
// readable names added next to these id columns
const LOOKUPS: Record<string, string> = {
  owner_id: "owner",
  created_by: "created_by_name",
  status_id: "status",
  source_id: "source",
  stage_id: "stage",
  pipeline_id: "pipeline",
  company_id: "company",
  contact_id: "contact",
  team_id: "team",
};

type Row = Record<string, unknown>;

async function fetchAll(table: TableName, orgId: string): Promise<Row[]> {
  const supabase = await createClient();
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    // every table here has organization_id and created_at; rows are handled as plain objects
    const { data, error } = await supabase
      .from(table as "leads")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      // rows written in one statement share created_at; without a tie-breaker a row can be skipped or repeated between pages (FXC-07)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`export of ${table} failed: ${error.message}`);
    rows.push(...(data as Row[]));
    if (data.length < PAGE) return rows;
  }
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return csvText(typeof value === "object" ? JSON.stringify(value) : String(value));
}

function toCsv(rows: Row[], names: Map<string, string>, tagNames: Map<string, string>): string {
  if (rows.length === 0) return "﻿";
  const customKeys = [...new Set(rows.flatMap((r) => (r.custom_fields && typeof r.custom_fields === "object" ? Object.keys(r.custom_fields as object) : [])))];
  const base = Object.keys(rows[0]).filter((k) => k !== "custom_fields");
  const columns: Array<{ header: string; get: (r: Row) => unknown }> = [];
  for (const k of base) {
    columns.push({ header: k, get: (r) => r[k] });
    if (LOOKUPS[k]) columns.push({ header: LOOKUPS[k], get: (r) => (typeof r[k] === "string" ? (names.get(r[k] as string) ?? "") : "") });
    if (k === "tag_ids") columns.push({ header: "tags", get: (r) => ((r.tag_ids as string[] | null) ?? []).map((id) => tagNames.get(id) ?? id).join("; ") });
  }
  for (const k of customKeys) columns.push({ header: `custom:${k}`, get: (r) => ((r.custom_fields as Record<string, Json> | null) ?? {})[k] });
  const lines = [columns.map((c) => cell(c.header)).join(","), ...rows.map((r) => columns.map((c) => cell(c.get(r))).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

const README = `ייצוא מלא של נתוני העסק.

כל קובץ CSV הוא טבלה אחת, ונפתח ב-Excel עם עברית תקינה.
עמודות id מקשרות בין הקבצים (למשל company_id באנשי קשר הוא id בקובץ companies.csv).
ליד כל מזהה של משתמש, סטטוס, מקור, שלב או חברה מופיעה גם עמודה עם השם.
עמודות custom:... הן השדות המותאמים. רשומות עם deleted_at נמצאות בסל המחזור.
סכומים (amount_agorot) הם באגורות: מחלקים ב-100 לקבלת שקלים.
הקבצים שצורפו לרשומות נמצאים בתיקייה files, בשם <id>-<שם הקובץ>, ו-files.csv אומר לאיזו רשומה כל אחד שייך.
`;

/** ZIP of every table, read with the user's session (RLS applies), and how many rows it holds. */
export async function buildFullExport(orgId: string): Promise<{ zip: Uint8Array; rows: number }> {
  const data = await Promise.all(TABLES.map(async (t) => ({ ...t, rows: await fetchAll(t.table, orgId) })));
  const supabase = await createClient();
  const members = must(await supabase.from("memberships").select("user_id").eq("organization_id", orgId), "memberships");
  const profiles = members.length
    ? must(await supabase.from("profiles").select("id, full_name, email").in("id", members.map((m) => m.user_id)), "profiles")
    : [];

  const names = new Map<string, string>();
  for (const p of profiles ?? []) names.set(p.id, p.full_name?.trim() || p.email || "");
  const tagNames = new Map<string, string>();
  for (const t of data) {
    for (const r of t.rows) {
      const id = r.id as string | undefined;
      if (!id) continue;
      if (t.table === "tags") tagNames.set(id, String(r.name ?? ""));
      if (["lead_statuses", "lead_sources", "stages", "pipelines", "companies", "teams"].includes(t.table)) names.set(id, String(r.name ?? ""));
      if (t.table === "contacts") names.set(id, String(r.full_name ?? r.email ?? ""));
    }
  }

  const files: Record<string, Uint8Array> = {};
  for (const t of data) files[t.file] = strToU8(toCsv(t.rows, names, tagNames));

  // the stored files, read with the same session (Storage follows the same rules)
  let total = 0;
  const skipped: string[] = [];
  const stored = data.find((t) => t.table === "files")?.rows ?? [];
  for (const f of stored) {
    const size = Number(f.size_bytes ?? 0);
    const name = `files/${String(f.id)}-${String(f.name).replace(/[\\/:*?"<>|]/g, "_")}`;
    if (total + size > FILES_MAX_BYTES) {
      skipped.push(String(f.name));
      continue;
    }
    // a stored file that cannot be read is listed as left out, like one over the size cap
    const { data: blob, error: blobError } = await supabase.storage.from(FILES_BUCKET).download(String(f.storage_path));
    if (blobError || !blob) {
      skipped.push(String(f.name));
      continue;
    }
    files[name] = new Uint8Array(await blob.arrayBuffer());
    total += size;
  }
  const note = skipped.length
    ? `\nלא נכנסו לקובץ הזה ${skipped.length} קבצים (הגודל הכולל עובר 150 MB, או שהקובץ לא נמצא). אפשר להוריד אותם מהרשומות עצמן.\n`
    : "";
  files["README.txt"] = strToU8(README + note);
  return { zip: zipSync(files, { level: 6 }), rows: data.reduce((sum, t) => sum + t.rows.length, 0) };
}
