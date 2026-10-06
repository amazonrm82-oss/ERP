import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { ImportJobRow } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type ImportJobItem = ImportJobRow & { createdByName: string | null };

/** The latest imports the user may see (their own; admins see everyone's). */
export async function listImportJobs(orgId: string): Promise<ImportJobItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("import_jobs")
    .select("*")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`import jobs query failed: ${error.message}`);
  }
  const names = await getUserNames(data.map((job) => job.created_by));
  return data.map((job) => ({ ...job, createdByName: job.created_by ? (names.get(job.created_by) ?? null) : null }));
}
