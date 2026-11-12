import "server-only";

import { getLibrary } from "@/features/library/queries";
import { isLibraryItemOfferable } from "@/features/library/validity";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { zoneDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import type { LibraryRecord } from "./record";

export type SentLibraryLink = {
  id: string;
  itemTitle: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  // the database decides; this only hides the button from whoever surely may not
  canRevoke: boolean;
};

export type LibraryLinksCardData = {
  canWrite: boolean;
  // items that may be sent now: active, inside their window, a file item with its file
  offerable: Array<{ id: string; title: string; kind: "link" | "file" }>;
  links: SentLibraryLink[];
};

const SHOWN = 20;

/**
 * LIB-02: the record's tracked library links (RLS: whoever reads the record) and the items that may be sent now.
 * `canEditRecord` is the page's hint that the viewer may edit the record (owner (294) ב: they may turn a link off too).
 */
export async function getLibraryLinksCard(orgId: string, record: LibraryRecord, canEditRecord = false): Promise<LibraryLinksCardData> {
  const supabase = await createClient();
  const [context, library, rows] = await Promise.all([
    getOrgContext(orgId),
    getLibrary(orgId),
    supabase
      .from("library_links")
      .select("id, library_item_id, created_by, created_at, revoked_at, view_count, last_viewed_at")
      .eq("organization_id", orgId)
      .eq(`${record.kind}_id`, record.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SHOWN)
      .then((res) => must(res, "library links")),
  ]);
  const today = zoneDate(new Date(), context.org.timeZone);
  const titles = new Map(library.items.map((item) => [item.id, item.title]));
  const names = await getUserNames(rows.map((r) => r.created_by));
  const isAdmin = context.role === "owner" || context.role === "admin";
  return {
    canWrite: context.canWrite,
    offerable: library.items
      .filter((item) => isLibraryItemOfferable(item, today) && (item.kind === "link" || item.file !== null))
      .map((item) => ({ id: item.id, title: item.title, kind: item.kind })),
    links: rows.map((r) => ({
      id: r.id,
      itemTitle: titles.get(r.library_item_id) ?? null,
      createdBy: r.created_by,
      createdByName: r.created_by ? (names.get(r.created_by) ?? null) : null,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      viewCount: r.view_count,
      lastViewedAt: r.last_viewed_at,
      canRevoke: r.revoked_at === null && context.role !== "viewer" && (isAdmin || r.created_by === context.user.id || canEditRecord),
    })),
  };
}
