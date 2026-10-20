import "server-only";

import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { HOLDER_COLUMN, type FileHolderKind, type HolderFile, type HolderFiles } from "./holder";
import { versionGroups } from "./versions";

/**
 * The files of these documents or payments that the user may see (RLS follows each one). The history is read from every
 * row, a waiting upload included, so the line never breaks; only confirmed files are shown.
 */
export async function listHolderFiles(orgId: string, kind: FileHolderKind, holderIds: string[]): Promise<{ files: Map<string, HolderFiles>; names: Map<string, string> }> {
  const files = new Map<string, HolderFiles>();
  if (holderIds.length === 0) return { files, names: new Map() };
  const column = HOLDER_COLUMN[kind];
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("files")
      .select("id, name, mime_type, size_bytes, uploaded_by, created_at, previous_id, accounting_document_id, payment_id, unconfirmed_since")
      .eq("organization_id", orgId)
      .in(column, holderIds)
      .order("created_at", { ascending: true })
      .order("id")
      .limit(1000),
    `${kind} files`,
  );
  for (const holderId of holderIds) {
    const own = rows.filter((r) => r[column] === holderId);
    const [group] = versionGroups(own.map((r) => ({ ...r, previousId: r.previous_id, createdAt: r.created_at })));
    if (!group) continue;
    const shown = [group.current, ...group.earlier]
      .filter((r) => r.unconfirmed_since === null)
      .map((r): HolderFile => ({ id: r.id, name: r.name, mimeType: r.mime_type, sizeBytes: r.size_bytes, uploadedBy: r.uploaded_by, createdAt: r.created_at }));
    files.set(holderId, { current: shown[0] ?? null, earlier: shown.slice(1), latestId: group.current.id });
  }
  const names = await getUserNames(rows.map((r) => r.uploaded_by));
  return { files, names };
}
