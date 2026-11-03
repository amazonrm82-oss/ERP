import "server-only";

import { must } from "@/lib/db-read";
import { readAllPagesByIds } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import type { LibraryItemKind } from "@/lib/database.types";

export type LibraryCategory = { id: string; name: string; isActive: boolean; position: number };

export type LibraryFile = { id: string; name: string; mimeType: string; sizeBytes: number };

export type LibraryItem = {
  id: string;
  kind: LibraryItemKind;
  title: string;
  description: string | null;
  categoryId: string | null;
  url: string | null;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  // a file item's current file: its newest confirmed one (null when it has none yet)
  file: LibraryFile | null;
  // an upload to it has not finished (it may be under way, or abandoned)
  uploadWaiting: boolean;
};

function currentFile(row: (LibraryFile & { createdAt: string }) | undefined): LibraryFile | null {
  return row ? { id: row.id, name: row.name, mimeType: row.mimeType, sizeBytes: row.sizeBytes } : null;
}

/** LIB-01: the whole library of a business (every member reads it; at most 1,000 items). */
export async function getLibrary(orgId: string): Promise<{ categories: LibraryCategory[]; items: LibraryItem[] }> {
  const supabase = await createClient();
  const [categoryRows, itemRows] = await Promise.all([
    supabase
      .from("library_categories")
      .select("id, name, is_active, position")
      .eq("organization_id", orgId)
      .order("position")
      .order("name")
      .order("id")
      .then((res) => must(res, "library categories")),
    supabase
      .from("library_items")
      .select("id, kind, title, description, category_id, url, valid_from, valid_until, is_active")
      .eq("organization_id", orgId)
      .order("title")
      .order("id")
      .limit(1000)
      .then((res) => must(res, "library items")),
  ]);
  const fileItemIds = itemRows.filter((r) => r.kind === "file").map((r) => r.id);
  const fileRows = await readAllPagesByIds(fileItemIds, async (ids, from, to) =>
    must(
      await supabase
        .from("files")
        .select("id, name, mime_type, size_bytes, unconfirmed_since, library_item_id, created_at")
        .eq("organization_id", orgId)
        .in("library_item_id", ids)
        .order("id")
        .range(from, to),
      "library files",
    ),
  );
  const fileOf = new Map<string, LibraryFile & { createdAt: string }>();
  const waiting = new Set<string>();
  for (const row of fileRows) {
    if (!row.library_item_id) continue;
    if (row.unconfirmed_since !== null) {
      waiting.add(row.library_item_id);
      continue;
    }
    // the newest confirmed row is the current file (an earlier one stays only until a replacement removes it)
    const seen = fileOf.get(row.library_item_id);
    if (seen && (seen.createdAt > row.created_at || (seen.createdAt === row.created_at && seen.id > row.id))) continue;
    fileOf.set(row.library_item_id, { id: row.id, name: row.name, mimeType: row.mime_type, sizeBytes: row.size_bytes, createdAt: row.created_at });
  }
  return {
    categories: categoryRows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active, position: r.position })),
    items: itemRows.map((r) => ({
      id: r.id,
      kind: r.kind === "file" ? "file" : "link",
      title: r.title,
      description: r.description,
      categoryId: r.category_id,
      url: r.url,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
      isActive: r.is_active,
      file: currentFile(fileOf.get(r.id)),
      uploadWaiting: waiting.has(r.id),
    })),
  };
}
