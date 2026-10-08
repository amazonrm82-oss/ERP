"use server";

import { revalidatePath } from "next/cache";

import { setLeadStatus } from "@/features/leads/status";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { setTrashed } from "@/lib/record-trash";

// Bulk actions on the rows picked in a list (LST-07). Each record is changed on
// its own, with the user's session, so the usual rules hold row by row: a row
// the user may not change is skipped and counted, and the rest still go through.
export type BulkObject = "lead" | "contact" | "company";
export type BulkChange =
  | { kind: "owner"; ownerId: string | null }
  | { kind: "status"; statusId: string; reason?: string }
  | { kind: "tag"; tagId: string }
  | { kind: "trash" };
export type BulkOutcome = { done: number; skipped: number };

const TABLE = {
  lead: "leads",
  contact: "contacts",
  company: "companies",
} as const;
const LIST = {
  lead: paths.leads,
  contact: paths.contacts,
  company: paths.companies,
} as const;
// one page of a list; more than that is not picked at once
const MAX_IDS = 100;
// rows changed at the same time
const PARALLEL = 8;

async function eachLimited<T>(items: T[], run: (item: T) => Promise<boolean>): Promise<number> {
  let done = 0;
  for (let i = 0; i < items.length; i += PARALLEL) {
    const results = await Promise.all(items.slice(i, i + PARALLEL).map(run));
    done += results.filter(Boolean).length;
  }
  return done;
}

export async function bulkAction(orgId: string, object: BulkObject, ids: string[], change: BulkChange): Promise<ActionResult<BulkOutcome>> {
  if (!(object in TABLE) || !Array.isArray(ids) || ids.length === 0) {
    return fail("לא נבחרו רשומות.");
  }
  if (ids.length > MAX_IDS) {
    return fail(`אפשר לבחור עד ${MAX_IDS} רשומות בפעולה אחת.`);
  }
  const unique = [...new Set(ids)];
  const context = await actionContext(orgId, ...unique);
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const table = TABLE[object];

  // the picked rows the user can see; the rest are counted as skipped
  const { data: rows, error } = await supabase
    .from(table as "leads")
    .select("id, tag_ids")
    .eq("organization_id", orgId)
    .in("id", unique)
    .is("deleted_at", null);
  if (error) {
    return fail(dbErrorMessage(error));
  }
  let live = rows;
  if (object === "lead" && change.kind === "status") {
    // a converted lead keeps its status
    const { data: open, error: openError } = await supabase.from("leads").select("id").eq("organization_id", orgId).in("id", unique).is("converted_at", null);
    if (openError) return fail(dbErrorMessage(openError));
    const openIds = new Set(open.map((row) => row.id));
    live = rows.filter((row) => openIds.has(row.id));
  }

  let done = 0;
  switch (change.kind) {
    case "owner": {
      if (change.ownerId !== null && !isUuid(change.ownerId)) return fail("יש לבחור בעלים.");
      done = await eachLimited(live, async (row) => {
        const { data } = await supabase
          .from(table as "leads")
          .update({ owner_id: change.ownerId })
          .eq("organization_id", orgId)
          .eq("id", row.id)
          .is("deleted_at", null)
          .select("id");
        return (data?.length ?? 0) > 0;
      });
      break;
    }
    case "status": {
      if (object !== "lead") return fail("לרשומות האלה אין סטטוס.");
      if (!isUuid(change.statusId)) return fail("יש לבחור סטטוס.");
      const reason = change.reason?.trim().slice(0, 500) || null;
      // the status's own rules first (it exists, it is not "converted", "not relevant" needs a reason)
      const { data: status } = await supabase.from("lead_statuses").select("kind").eq("organization_id", orgId).eq("id", change.statusId).maybeSingle();
      if (!status) return fail("הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.");
      if (status.kind === "converted") return fail('כדי לסמן ליד כ"הומר" יש להשתמש בכפתור ההמרה.');
      if (status.kind === "disqualified" && !reason) return fail("יש לציין למה הלידים לא רלוונטיים.");
      done = await eachLimited(live, async (row) => (await setLeadStatus(supabase, orgId, row.id, change.statusId, reason)).ok);
      break;
    }
    case "tag": {
      if (!isUuid(change.tagId)) return fail("יש לבחור תגית.");
      const { data: tag } = await supabase.from("tags").select("id").eq("organization_id", orgId).eq("id", change.tagId).maybeSingle();
      if (!tag) return fail("התגית כבר לא קיימת. רעננו את הדף ונסו שוב.");
      done = await eachLimited(live, async (row) => {
        // already tagged counts as done
        if ((row.tag_ids ?? []).includes(tag.id)) return true;
        const { data } = await supabase
          .from(table as "leads")
          .update({ tag_ids: [...(row.tag_ids ?? []), tag.id] })
          .eq("organization_id", orgId)
          .eq("id", row.id)
          .is("deleted_at", null)
          .select("id");
        return (data?.length ?? 0) > 0;
      });
      break;
    }
    case "trash": {
      done = await eachLimited(live, async (row) => (await setTrashed(supabase, table, orgId, row.id, true)).ok);
      break;
    }
    default:
      return fail("פעולה לא מוכרת.");
  }

  revalidatePath(LIST[object](orgId));
  return ok({ done, skipped: unique.length - done });
}
