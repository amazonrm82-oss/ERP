import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { readCounts, type ImportCounts } from "./rules";

export type BackgroundRequestRow = {
  id: string;
  kind: "import" | "export";
  status: string;
  entityType: string | null;
  fileName: string | null;
  totalRows: number | null;
  rowsDone: number;
  counts: ImportCounts;
  message: string | null;
  downloadable: boolean;
  fileExpiresAt: string | null;
  createdAt: string;
  finishedAt: string | null;
};

/** IMP-04: the person's own background orders of the last 7 days and those still open (RLS: own rows only). */
export async function listBackgroundRequests(orgId: string): Promise<BackgroundRequestRow[]> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const rows = must(
    await supabase
      .from("background_requests")
      .select("id, kind, status, entity_type, file_name, total_rows, rows_done, counts, result_message, file_path, file_expires_at, created_at, finished_at")
      .eq("organization_id", orgId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(20),
    "background_requests",
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "export" ? "export" : "import",
    status: r.status,
    entityType: r.entity_type,
    fileName: r.file_name,
    totalRows: r.total_rows,
    rowsDone: r.rows_done,
    counts: readCounts(r.counts),
    message: r.result_message,
    downloadable: r.kind === "export" && r.status === "done" && Boolean(r.file_path) && Boolean(r.file_expires_at) && Date.parse(r.file_expires_at as string) > now,
    fileExpiresAt: r.file_expires_at,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }));
}
