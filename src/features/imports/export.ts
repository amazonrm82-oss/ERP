import "server-only";

import { strToU8, zipSync } from "fflate";

import { EXPORT_README, EXPORT_TABLES, exportNames, type ExportRow, type ExportTableName, toCsv } from "@/features/imports/export-build";
import { FILES_BUCKET } from "@/features/files/types";
import { must } from "@/lib/db-read";
import { readAllPages } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

// the files themselves go into the ZIP up to this total; past it, files.csv still lists them
const FILES_MAX_BYTES = 150 * 1024 * 1024;

async function fetchAll(table: ExportTableName, orgId: string): Promise<ExportRow[]> {
  const supabase = await createClient();
  // past PostgREST's 1,000-row cap page by page (RVW-2); every table here has organization_id, id and created_at
  const { rows } = await readAllPages<ExportRow>(async (from, to) => {
    const { data, error } = await supabase
      .from(table as "leads")
      .select("*")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true })
      // rows written in one statement share created_at; without a tie-breaker a row can be skipped or repeated between pages (FXC-07)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`export of ${table} failed: ${error.message}`);
    return data as ExportRow[];
  });
  return rows;
}

/** ZIP of every table, read with the user's session (RLS applies), and how many rows it holds. */
export async function buildFullExport(orgId: string): Promise<{ zip: Uint8Array; rows: number }> {
  const data = await Promise.all(EXPORT_TABLES.map(async (t) => ({ ...t, rows: await fetchAll(t.table, orgId) })));
  const supabase = await createClient();
  const members = must(await supabase.from("memberships").select("user_id").eq("organization_id", orgId), "memberships");
  const profiles = members.length
    ? must(await supabase.from("profiles").select("id, full_name, email").in("id", members.map((m) => m.user_id)), "profiles")
    : [];

  const { names, tagNames } = exportNames(data, profiles ?? []);

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
  files["README.txt"] = strToU8(EXPORT_README + note);
  return { zip: zipSync(files, { level: 6 }), rows: data.reduce((sum, t) => sum + t.rows.length, 0) };
}
