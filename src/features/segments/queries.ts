import "server-only";

import { cache } from "react";

import { prepareListFilter } from "@/features/list-filters/prepare";
import { getListColumns } from "@/features/list-columns/queries";
import { leadDisplayName } from "@/features/leads/display";
import { contactDisplayName } from "@/features/contacts/display";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { segmentFilter, type SegmentKind, type SegmentObject } from "./model";
import type { FilterTree } from "@/features/list-filters/model";

export type Segment = {
  id: string;
  objectType: SegmentObject;
  kind: SegmentKind;
  name: string;
  // a dynamic segment's filter; null on a static one, or when the stored filter no longer reads as one
  filter: FilterTree | null;
  createdAt: string;
};

type SegmentDbRow = { id: string; object_type: string; kind: string; name: string; filter: unknown; created_at: string };

function toSegment(row: SegmentDbRow): Segment {
  return {
    id: row.id,
    objectType: row.object_type === "contact" ? "contact" : "lead",
    kind: row.kind === "static" ? "static" : "dynamic",
    name: row.name,
    filter: row.kind === "dynamic" ? segmentFilter(row.filter) : null,
    createdAt: row.created_at,
  };
}

/** The business's segments, by name; every member reads them (SEG-01). Memoized per request. */
export const listSegments = cache(async (orgId: string): Promise<Segment[]> => {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("segments")
      .select("id, object_type, kind, name, filter, created_at")
      .eq("organization_id", orgId)
      .order("name")
      .order("id")
      .limit(500),
    "segments",
  );
  return rows.map(toSegment);
});

/** The static segments of one record type, as choices for "add to segment". */
export async function staticSegmentOptions(orgId: string, objectType: SegmentObject): Promise<Array<{ value: string; label: string }>> {
  return (await listSegments(orgId)).filter((s) => s.kind === "static" && s.objectType === objectType).map((s) => ({ value: s.id, label: s.name }));
}

export async function getSegment(orgId: string, segmentId: string): Promise<Segment | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("segments").select("id, object_type, kind, name, filter, created_at").eq("organization_id", orgId).eq("id", segmentId).maybeSingle(),
    "segment",
  );
  return row ? toSegment(row) : null;
}

export type SegmentMember = { id: string; recordId: string; name: string; addedAt: string };

const MEMBERS_PAGE = 50;

/**
 * One page of a static segment's members, newest first. A member row is seen only with its record (the policy), and
 * records in the recycle bin are left out of the page.
 */
export async function listSegmentMembers(
  orgId: string,
  segment: Segment,
  page: number,
): Promise<{ members: SegmentMember[]; hasMore: boolean; total: number }> {
  const supabase = await createClient();
  const column = segment.objectType === "lead" ? "lead_id" : "contact_id";
  const from = (page - 1) * MEMBERS_PAGE;
  const [rowsResult, countResult] = await Promise.all([
    supabase
      .from("segment_members")
      .select("id, lead_id, contact_id, created_at")
      .eq("organization_id", orgId)
      .eq("segment_id", segment.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + MEMBERS_PAGE),
    supabase.from("segment_members").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("segment_id", segment.id),
  ]);
  const rows = must(rowsResult, "segment_members");
  must(countResult, "segment_members count");
  const total = countResult.count ?? 0;
  const hasMore = rows.length > MEMBERS_PAGE;
  const shown = rows.slice(0, MEMBERS_PAGE);
  const ids = shown.map((r) => (column === "lead_id" ? r.lead_id : r.contact_id)).filter((id): id is string => id !== null);

  const names = new Map<string, string>();
  if (ids.length > 0) {
    if (segment.objectType === "lead") {
      const records = must(
        await supabase.from("leads").select("id, full_name, email, phone").eq("organization_id", orgId).is("deleted_at", null).in("id", ids),
        "segment leads",
      );
      for (const r of records) names.set(r.id, leadDisplayName({ fullName: r.full_name, email: r.email, phone: r.phone }));
    } else {
      const records = must(
        await supabase.from("contacts").select("id, full_name, email, phone").eq("organization_id", orgId).is("deleted_at", null).in("id", ids),
        "segment contacts",
      );
      for (const r of records) names.set(r.id, contactDisplayName({ fullName: r.full_name, email: r.email, phone: r.phone }));
    }
  }
  const members = shown.flatMap((r) => {
    const recordId = column === "lead_id" ? r.lead_id : r.contact_id;
    const name = recordId ? names.get(recordId) : undefined;
    return recordId && name !== undefined ? [{ id: r.id, recordId, name, addedAt: r.created_at }] : [];
  });
  return { members, hasMore, total };
}

/**
 * How many live records a dynamic segment holds now, counted with the user's session (so, the records the user
 * reads), and how many of its conditions the list no longer knows (a field or a choice that was removed).
 */
export async function countDynamicSegment(orgId: string, segment: Segment, userId: string): Promise<{ count: number; skipped: number } | null> {
  if (!segment.filter) return null;
  const columns = await getListColumns(orgId, segment.objectType);
  const prepared = await prepareListFilter(orgId, segment.objectType, JSON.stringify(segment.filter), userId, columns.fields);
  const supabase = await createClient();
  let query = supabase.from(segment.objectType === "lead" ? "leads" : "contacts").select("id", { count: "exact", head: true }).eq("organization_id", orgId).is("deleted_at", null);
  if (prepared.logic) query = query.or(prepared.logic);
  const result = await query;
  must(result, "segment count");
  return { count: result.count ?? 0, skipped: prepared.skipped };
}
