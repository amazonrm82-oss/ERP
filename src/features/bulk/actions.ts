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
// what each changed row was before, so the change can be undone (FXU-06)
export type BulkUndoRow = { id: string; owner?: string | null; status?: string; reason?: string | null; stage?: string; tag?: string };
export type BulkUndo = { kind: BulkChange["kind"]; rows: BulkUndoRow[] };
export type BulkOutcome = { done: number; skipped: number; undo: BulkUndo };

const TASK_STATUSES = ["open", "done", "cancelled"] as const;
// one page of a list; more than that is not picked at once
const MAX_IDS = 100;
// rows changed at the same time
const PARALLEL = 8;

// the items whose change went through
async function eachLimited<T>(items: T[], run: (item: T) => Promise<boolean>): Promise<T[]> {
  const done: T[] = [];
  for (let i = 0; i < items.length; i += PARALLEL) {
    const slice = items.slice(i, i + PARALLEL);
    const results = await Promise.all(slice.map(run));
    slice.forEach((item, k) => results[k] && done.push(item));
  }
  return done;
}

// the columns a change may need to put back
const BEFORE_COLUMNS: Record<BulkObject, string> = {
  lead: "id, tag_ids, owner_id, status_id, disqualify_reason",
  contact: "id, tag_ids, owner_id",
  company: "id, tag_ids, owner_id",
  deal: "id, tag_ids, owner_id, stage_id",
  task: "id, owner_id, status",
};
type BeforeRow = {
  id: string;
  tag_ids?: string[];
  owner_id?: string | null;
  status_id?: string;
  disqualify_reason?: string | null;
  stage_id?: string;
  status?: string;
};

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
  const { data, error } = await supabase
    .from(table as "leads")
    .select(BEFORE_COLUMNS[object] as "id")
    .eq("organization_id", orgId)
    .in("id", unique)
    .is("deleted_at", null);
  if (error) {
    return fail(dbErrorMessage(error));
  }
  const rows = data as unknown as BeforeRow[];
  let live: BeforeRow[] = rows;
  if (object === "lead" && change.kind === "status") {
    // a converted lead keeps its status
    const { data: open, error: openError } = await supabase.from("leads").select("id").eq("organization_id", orgId).in("id", unique).is("converted_at", null);
    if (openError) return fail(dbErrorMessage(openError));
    const openIds = new Set(open.map((row) => row.id));
    live = rows.filter((row) => openIds.has(row.id));
  }

  let changed: BeforeRow[] = [];
  let undoRows: BulkUndoRow[] = [];
  switch (change.kind) {
    case "owner": {
      if (change.ownerId !== null && !isUuid(change.ownerId)) return fail("יש לבחור אחראי.");
      changed = await eachLimited(live, async (row) => {
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
      undoRows = changed.map((row) => ({ id: row.id, owner: row.owner_id ?? null }));
      break;
    }
    case "status": {
      if (object === "task") {
        const status = TASK_STATUSES.find((s) => s === change.statusId);
        if (!status) return fail("יש לבחור מצב.");
        // completed_at is stamped (and cleared) by the database from the status
        changed = await eachLimited(live, async (row) => {
          const { data, error: rowError } = await supabase.from("tasks").update({ status }).eq("organization_id", orgId).eq("id", row.id).is("deleted_at", null).select("id");
          return !rowError && data.length > 0;
        });
        undoRows = changed.map((row) => ({ id: row.id, status: row.status }));
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
      if (status.kind === "disqualified") {
        // LEAD-03: from the organization's list when it keeps one (setLeadStatus checks each row again)
        const { data: reasons, error: reasonsError } = await supabase.from("disqualify_reasons").select("name").eq("organization_id", orgId).eq("is_active", true);
        if (reasonsError) return fail(dbErrorMessage(reasonsError));
        if (reasons.length > 0 && !reasons.some((row) => row.name === reason)) return fail("יש לבחור סיבה מהרשימה.");
      }
      changed = await eachLimited(live, async (row) => (await setLeadStatus(supabase, orgId, row.id, change.statusId, reason)).ok);
      undoRows = changed.map((row) => ({ id: row.id, status: row.status_id, reason: row.disqualify_reason ?? null }));
      break;
    }
    case "stage": {
      if (object !== "deal") return fail("לרשומות האלה אין שלב.");
      if (!isUuid(change.stageId)) return fail("יש לבחור שלב.");
      // a stage of another pipeline is refused by the (pipeline_id, stage_id) foreign key, and that deal is skipped
      changed = await eachLimited(live, async (row) => {
        const { data, error: rowError } = await supabase
          .from("deals")
          .update({ stage_id: change.stageId })
          .eq("organization_id", orgId)
          .eq("id", row.id)
          .is("deleted_at", null)
          .select("id");
        return !rowError && data.length > 0;
      });
      undoRows = changed.map((row) => ({ id: row.id, stage: row.stage_id }));
      break;
    }
    case "tag": {
      if (object === "task") return fail("למשימות אין תגיות.");
      if (!isUuid(change.tagId)) return fail("יש לבחור תגית.");
      const { data: tag, error: tagError } = await supabase.from("tags").select("id").eq("organization_id", orgId).eq("id", change.tagId).maybeSingle();
      if (tagError) return fail(dbErrorMessage(tagError));
      if (!tag) return fail("התגית כבר לא קיימת. רעננו את הדף ונסו שוב.");
      // added in the database, so a tag someone else added meanwhile stays (FXD-04)
      changed = await eachLimited(live, async (row) => {
        const { data, error: rowError } = await supabase.rpc("change_record_tags", { p_table: table, p_org: orgId, p_id: row.id, p_add: [tag.id], p_remove: [] });
        return !rowError && data === true;
      });
      // undo takes the tag off only where this action put it
      undoRows = changed.filter((row) => !(row.tag_ids ?? []).includes(tag.id)).map((row) => ({ id: row.id, tag: tag.id }));
      break;
    }
    case "trash": {
      if (object === "task") return fail("משימות לא עוברות לסל המחזור.");
      changed = await eachLimited(live, async (row) => (await setTrashed(supabase, table as TrashableTable, orgId, row.id, true)).ok);
      undoRows = changed.map((row) => ({ id: row.id }));
      break;
    }
    default:
      return fail("פעולה לא מוכרת.");
  }

  revalidatePath(RECORD_TYPES[object].list(orgId));
  return ok({ done: changed.length, skipped: unique.length - changed.length, undo: { kind: change.kind, rows: undoRows } });
}

const undoSchema = z.object({
  kind: z.enum(["owner", "status", "stage", "tag", "trash"]),
  rows: z
    .array(
      z.object({
        id: z.guid(),
        owner: z.guid().nullish(),
        status: z.string().max(40).optional(),
        reason: z.string().max(500).nullish(),
        stage: z.guid().optional(),
        tag: z.guid().optional(),
      }),
    )
    .max(MAX_IDS),
});

/**
 * Puts back what a bulk action changed (FXU-06), row by row with the user's
 * session: the same rules as any change, so nothing the user may not do.
 */
export async function undoBulkAction(orgId: string, object: BulkObject, undo: BulkUndo): Promise<ActionResult<{ done: number }>> {
  if (!isRecordType(object) || !validArg(undoSchema, undo)) {
    return fail(INVALID_ARGS);
  }
  if (undo.rows.length === 0) return ok({ done: 0 });
  const context = await actionContext(orgId, ...undo.rows.map((row) => row.id));
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  const table = RECORD_TYPES[object].table;
  // one column of one row; the table differs by object, the column is checked by the database
  const update = async (id: string, values: { owner_id?: string | null; stage_id?: string; status?: (typeof TASK_STATUSES)[number] }) => {
    const { data, error } = await supabase
      .from(table as "leads")
      .update(values as never)
      .eq("organization_id", orgId)
      .eq("id", id)
      .is("deleted_at", null)
      .select("id");
    return !error && data.length > 0;
  };

  let undone: BulkUndoRow[] = [];
  switch (undo.kind) {
    case "owner":
      undone = await eachLimited(undo.rows, (row) => update(row.id, { owner_id: row.owner ?? null }));
      break;
    case "status":
      if (object === "task") {
        undone = await eachLimited(undo.rows, async (row) => {
          const status = TASK_STATUSES.find((s) => s === row.status);
          return status ? update(row.id, { status }) : false;
        });
      } else if (object === "lead") {
        undone = await eachLimited(undo.rows, async (row) => (row.status ? (await setLeadStatus(supabase, orgId, row.id, row.status, row.reason ?? null)).ok : false));
      }
      break;
    case "stage":
      if (object === "deal") undone = await eachLimited(undo.rows, (row) => (row.stage ? update(row.id, { stage_id: row.stage }) : Promise.resolve(false)));
      break;
    case "tag":
      if (object !== "task") {
        undone = await eachLimited(undo.rows, async (row) => {
          if (!row.tag) return false;
          const { data, error } = await supabase.rpc("change_record_tags", { p_table: table, p_org: orgId, p_id: row.id, p_add: [], p_remove: [row.tag] });
          return !error && data === true;
        });
      }
      break;
    case "trash":
      if (object !== "task") undone = await eachLimited(undo.rows, async (row) => (await setTrashed(supabase, table as TrashableTable, orgId, row.id, false)).ok);
      break;
  }
  revalidatePath(RECORD_TYPES[object].list(orgId));
  return ok({ done: undone.length });
}
