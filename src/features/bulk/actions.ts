"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { setLeadStatus } from "@/features/leads/status";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isUuid } from "@/lib/paths";
import { setTrashed, type TrashableTable } from "@/lib/record-trash";
import { isRecordType, RECORD_TYPES } from "@/lib/record-types";

// Bulk actions on the rows picked in a list (LST-07). Each record is changed on
// its own, with the user's session, so the usual rules hold row by row: a row
// the user may not change is skipped and counted, and the rest still go through.
export type BulkObject = "lead" | "contact" | "company" | "deal" | "task";
export type BulkChange =
  | { kind: "owner"; ownerId: string | null }
  // a lead's status (lead_statuses id), or a task's status (open | done | cancelled)
  | { kind: "status"; statusId: string; reason?: string }
  | { kind: "stage"; stageId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "trash" };
export type BulkOutcome = { done: number; skipped: number };

const TASK_STATUSES = ["open", "done", "cancelled"] as const;
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

// the shape of BulkChange, checked at runtime (FXC-08)
const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), ownerId: z.string().nullable() }),
  z.object({ kind: z.literal("status"), statusId: z.string(), reason: z.string().max(2000).nullish() }),
  z.object({ kind: z.literal("stage"), stageId: z.string() }),
  z.object({ kind: z.literal("tag"), tagId: z.string() }),
  z.object({ kind: z.literal("trash") }),
]);

export async function bulkAction(orgId: string, object: BulkObject, ids: string[], change: BulkChange): Promise<ActionResult<BulkOutcome>> {
  if (!validArg(changeSchema, change) || !validArg(z.array(z.string()), ids)) {
    return fail(INVALID_ARGS);
  }
  if (!isRecordType(object) || !Array.isArray(ids) || ids.length === 0) {
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
  const table = RECORD_TYPES[object].table;

  // the picked rows the user can see; the rest are counted as skipped
  // tasks have no tags
  const { data: rows, error } = await supabase
    .from(table as "leads")
    .select((object === "task" ? "id" : "id, tag_ids") as "id, tag_ids")
    .eq("organization_id", orgId)
    .in("id", unique)
    .is("deleted_at", null);
  if (error) {
    return fail(dbErrorMessage(error));
  }
  let live: Array<{ id: string; tag_ids?: string[] }> = rows;
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
        // a row that fails or that the user may not change is counted as skipped
        const { data, error: rowError } = await supabase
          .from(table as "leads")
          .update({ owner_id: change.ownerId })
          .eq("organization_id", orgId)
          .eq("id", row.id)
          .is("deleted_at", null)
          .select("id");
        return !rowError && data.length > 0;
      });
      break;
    }
    case "status": {
      if (object === "task") {
        const status = TASK_STATUSES.find((s) => s === change.statusId);
        if (!status) return fail("יש לבחור מצב.");
        // completed_at is stamped (and cleared) by the database from the status
        done = await eachLimited(live, async (row) => {
          const { data, error: rowError } = await supabase.from("tasks").update({ status }).eq("organization_id", orgId).eq("id", row.id).is("deleted_at", null).select("id");
          return !rowError && data.length > 0;
        });
        break;
      }
      if (object !== "lead") return fail("לרשומות האלה אין סטטוס.");
      if (!isUuid(change.statusId)) return fail("יש לבחור סטטוס.");
      const reason = change.reason?.trim().slice(0, 500) || null;
      // the status's own rules first (it exists, it is not "converted", "not relevant" needs a reason)
      const { data: status, error: statusError } = await supabase.from("lead_statuses").select("kind").eq("organization_id", orgId).eq("id", change.statusId).maybeSingle();
      if (statusError) return fail(dbErrorMessage(statusError));
      if (!status) return fail("הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.");
      if (status.kind === "converted") return fail('כדי לסמן ליד כ"הומר" יש להשתמש בכפתור ההמרה.');
      if (status.kind === "disqualified" && !reason) return fail("יש לציין למה הלידים לא רלוונטיים.");
      done = await eachLimited(live, async (row) => (await setLeadStatus(supabase, orgId, row.id, change.statusId, reason)).ok);
      break;
    }
    case "stage": {
      if (object !== "deal") return fail("לרשומות האלה אין שלב.");
      if (!isUuid(change.stageId)) return fail("יש לבחור שלב.");
      // a stage of another pipeline is refused by the (pipeline_id, stage_id) foreign key, and that deal is skipped
      done = await eachLimited(live, async (row) => {
        const { data, error: rowError } = await supabase
          .from("deals")
          .update({ stage_id: change.stageId })
          .eq("organization_id", orgId)
          .eq("id", row.id)
          .is("deleted_at", null)
          .select("id");
        return !rowError && data.length > 0;
      });
      break;
    }
    case "tag": {
      if (object === "task") return fail("למשימות אין תגיות.");
      if (!isUuid(change.tagId)) return fail("יש לבחור תגית.");
      const { data: tag, error: tagError } = await supabase.from("tags").select("id").eq("organization_id", orgId).eq("id", change.tagId).maybeSingle();
      if (tagError) return fail(dbErrorMessage(tagError));
      if (!tag) return fail("התגית כבר לא קיימת. רעננו את הדף ונסו שוב.");
      // added in the database, so a tag someone else added meanwhile stays (FXD-04)
      done = await eachLimited(live, async (row) => {
        const { data, error: rowError } = await supabase.rpc("change_record_tags", { p_table: table, p_org: orgId, p_id: row.id, p_add: [tag.id], p_remove: [] });
        return !rowError && data === true;
      });
      break;
    }
    case "trash": {
      if (object === "task") return fail("משימות לא עוברות לסל המחזור.");
      done = await eachLimited(live, async (row) => (await setTrashed(supabase, table as TrashableTable, orgId, row.id, true)).ok);
      break;
    }
    default:
      return fail("פעולה לא מוכרת.");
  }

  revalidatePath(RECORD_TYPES[object].list(orgId));
  return ok({ done, skipped: unique.length - done });
}
