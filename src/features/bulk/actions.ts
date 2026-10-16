"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { lossReasonIdByName } from "@/features/deal-loss-reasons/server";
import { closedAtFor, closeDateError } from "@/features/deals/close-window";
import { addBulkOnboardingTasks } from "@/features/deals/onboarding-server";
import { setLeadStatus } from "@/features/leads/status";
import { missingFieldsMessage } from "@/features/custom-fields/conditions";
import { missingAfterChange } from "@/features/custom-fields/required-server";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { TIME_ZONE } from "@/lib/app";
import { zoneDate } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { productBulkAction, productUndoAction } from "@/features/products/bulk-server";
import { setTrashed, type TrashableTable } from "@/lib/record-trash";
import { isRecordType, RECORD_TYPES } from "@/lib/record-types";

// Bulk actions on the rows picked in a list (LST-07). Each record is changed on
// its own, with the user's session, so the usual rules hold row by row: a row
// the user may not change is skipped and counted, and the rest still go through.
// "product": the product catalog (LST-09); its changes live in src/features/products/bulk-server.ts
export type BulkObject = "lead" | "contact" | "company" | "deal" | "task" | "product";
export type BulkChange =
  | { kind: "owner"; ownerId: string | null }
  // a lead's status (lead_statuses id), a task's status (open | done | cancelled), or a product's (active | inactive | archived)
  | { kind: "status"; statusId: string; reason?: string }
  // a product's category (null = none)
  | { kind: "category"; categoryId: string | null }
  // close: a move into a won stage (DEAL-04 bulk window): one close date for all, and onboarding tasks when asked
  | { kind: "stage"; stageId: string; reason?: string; close?: BulkClose }
  | { kind: "tag"; tagId: string }
  | { kind: "trash" };
// what each changed row was before, so the change can be undone (FXU-06)
// a deal's stage also brings back its loss reason (DEAL-03): the picked one, else its stored text;
// and its close date (DEAL-04), which a change of won/lost would otherwise stamp anew
export type BulkUndoRow = {
  id: string;
  owner?: string | null;
  status?: string;
  reason?: string | null;
  stage?: string;
  lossReasonId?: string | null;
  lossText?: string | null;
  closedAt?: string | null;
  tag?: string;
  // a product (LST-09): its active flag, whether it was archived, and its category
  active?: boolean;
  archived?: boolean;
  category?: string | null;
};
export type BulkClose = { closedDate: string; onboarding: boolean };
export type BulkUndo = { kind: BulkChange["kind"]; rows: BulkUndoRow[] };
// tasks: the onboarding tasks of a bulk move into a won stage, when they were asked for
// missing (FLD-09): records skipped because the new status / stage would leave a conditionally required
// field empty (counted in skipped too), with the reason to show
export type BulkOutcome = {
  done: number;
  skipped: number;
  undo: BulkUndo;
  tasks?: { created: number; existing: number; failed: number };
  missing?: { count: number; reason: string };
};

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
const BEFORE_COLUMNS: Record<Exclude<BulkObject, "product">, string> = {
  lead: "id, tag_ids, owner_id, status_id, disqualify_reason",
  contact: "id, tag_ids, owner_id",
  company: "id, tag_ids, owner_id",
  deal: "id, name, tag_ids, owner_id, stage_id, lost_reason_id, lost_reason, closed_at, contact_id, company_id",
  task: "id, owner_id, status",
};
type BeforeRow = {
  id: string;
  name?: string;
  contact_id?: string | null;
  company_id?: string | null;
  tag_ids?: string[];
  owner_id?: string | null;
  status_id?: string;
  disqualify_reason?: string | null;
  stage_id?: string;
  lost_reason_id?: string | null;
  lost_reason?: string | null;
  closed_at?: string | null;
  status?: string;
};
// longer free text is not carried through the browser; undo then leaves the text as it is
const LOSS_TEXT_MAX = 2000;

// the shape of BulkChange, checked at runtime (FXC-08)
const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner"), ownerId: z.string().nullable() }),
  z.object({ kind: z.literal("status"), statusId: z.string(), reason: z.string().max(2000).nullish() }),
  z.object({
    kind: z.literal("stage"),
    stageId: z.string(),
    reason: z.string().max(2000).nullish(),
    close: z.object({ closedDate: z.string().max(10), onboarding: z.boolean() }).optional(),
  }),
  z.object({ kind: z.literal("tag"), tagId: z.string() }),
  z.object({ kind: z.literal("category"), categoryId: z.string().nullable() }),
  z.object({ kind: z.literal("trash") }),
]);

export async function bulkAction(orgId: string, object: BulkObject, ids: string[], change: BulkChange): Promise<ActionResult<BulkOutcome>> {
  if (!validArg(changeSchema, change) || !validArg(z.array(z.string()), ids)) {
    return fail(INVALID_ARGS);
  }
  if ((object !== "product" && !isRecordType(object)) || !Array.isArray(ids) || ids.length === 0) {
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
  if (object === "product") {
    if (change.kind !== "status" && change.kind !== "category") return fail("פעולה לא מוכרת.");
    return productBulkAction(supabase, orgId, unique, change);
  }
  if (change.kind === "category") return fail("לרשומות האלה אין קטגוריה.");
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

  // FLD-09 (owner, 14 October 2026): a record the new status or stage would leave with an empty
  // conditionally required field is skipped and reported; nothing asks for the values here
  let missing: BulkOutcome["missing"];
  const conditionalChange: Record<string, string> | null =
    object === "lead" && change.kind === "status" && isUuid(change.statusId)
      ? { "builtin:status": change.statusId }
      : object === "deal" && change.kind === "stage" && isUuid(change.stageId)
        ? { "builtin:stage": change.stageId }
        : null;
  if (conditionalChange) {
    const found = await missingAfterChange(orgId, object as "lead" | "deal", live.map((row) => row.id), conditionalChange);
    if (!found.ok) return fail(dbErrorMessage(found.error));
    if (found.missing.size > 0) {
      const labels = [...new Set([...found.missing.values()].flat().map((field) => field.label))];
      missing = { count: found.missing.size, reason: missingFieldsMessage(labels.map((label) => ({ label }))) };
      live = live.filter((row) => !found.missing.has(row.id));
    }
  }

  let changed: BeforeRow[] = [];
  let undoRows: BulkUndoRow[] = [];
  let tasks: BulkOutcome["tasks"];
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
      // DEAL-03: an optional loss reason, by name; the database drops it unless the stage is a lost one
      const lossReason = await lossReasonIdByName(supabase, orgId, change.reason);
      if (!lossReason.ok) return fail(lossReason.message);
      // DEAL-04: a move into a won stage carries one close date for the deals that enter it
      const won = await wonMove(supabase, orgId, change.stageId, change.close, live);
      if (!won.ok) return fail(won.message);
      // a stage of another pipeline is refused by the (pipeline_id, stage_id) foreign key, and that deal is skipped
      changed = await eachLimited(live, async (row) => {
        const closedAt = won.move && won.move.entering.has(row.id) ? { closed_at: won.move.closedAt } : {};
        const { data, error: rowError } = await supabase
          .from("deals")
          .update({ stage_id: change.stageId, ...(lossReason.id ? { lost_reason_id: lossReason.id } : {}), ...closedAt })
          .eq("organization_id", orgId)
          .eq("id", row.id)
          .is("deleted_at", null)
          .select("id");
        return !rowError && data.length > 0;
      });
      undoRows = changed.map((row) => ({
        id: row.id,
        stage: row.stage_id,
        lossReasonId: row.lost_reason_id ?? null,
        lossText: row.lost_reason && row.lost_reason.length > LOSS_TEXT_MAX ? undefined : (row.lost_reason ?? null),
        closedAt: row.closed_at ?? null,
      }));
      if (won.move && change.close?.onboarding) {
        // only for the deals that moved into won now; the move stands even when a task fails
        const entered = changed.filter((row) => won.move!.entering.has(row.id));
        tasks = await addBulkOnboardingTasks(
          supabase,
          orgId,
          entered.map((row) => ({ id: row.id, name: row.name ?? "", ownerId: row.owner_id ?? null, contactId: row.contact_id ?? null, companyId: row.company_id ?? null })),
          won.move.today,
          won.move.timeZone,
        );
        revalidatePath(paths.tasks(orgId));
      }
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
  return ok({
    done: changed.length,
    skipped: unique.length - changed.length,
    undo: { kind: change.kind, rows: undoRows },
    ...(tasks ? { tasks } : {}),
    ...(missing ? { missing } : {}),
  });
}

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];
type WonMove = { entering: Set<string>; closedAt: string; today: string; timeZone: string };

/**
 * DEAL-04: when the target stage is a won one, the close date of the bulk window
 * (required, not in the future, in the organization's zone) and the picked deals
 * that enter won now (from an open or lost stage); a won to won move keeps its date.
 */
async function wonMove(
  supabase: Supabase,
  orgId: string,
  stageId: string,
  close: BulkClose | undefined,
  rows: BeforeRow[],
): Promise<{ ok: true; move: WonMove | null } | { ok: false; message: string }> {
  const { data: target, error } = await supabase.from("stages").select("kind").eq("organization_id", orgId).eq("id", stageId).maybeSingle();
  if (error) return { ok: false, message: dbErrorMessage(error) };
  if (target?.kind !== "won") return { ok: true, move: null };
  const fromIds = [...new Set(rows.map((row) => row.stage_id).filter((id): id is string => Boolean(id)))];
  const [{ data: org, error: orgError }, { data: from, error: fromError }] = await Promise.all([
    supabase.from("organizations").select("timezone").eq("id", orgId).maybeSingle(),
    fromIds.length > 0 ? supabase.from("stages").select("id, kind").eq("organization_id", orgId).in("id", fromIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (orgError) return { ok: false, message: dbErrorMessage(orgError) };
  if (fromError) return { ok: false, message: dbErrorMessage(fromError) };
  const timeZone = org?.timezone || TIME_ZONE;
  const now = new Date();
  const today = zoneDate(now, timeZone);
  const day = close?.closedDate ?? "";
  const dateError = closeDateError(day, today);
  if (dateError) return { ok: false, message: dateError };
  const wonStages = new Set((from ?? []).filter((stage) => stage.kind === "won").map((stage) => stage.id));
  const entering = new Set(rows.filter((row) => !row.stage_id || !wonStages.has(row.stage_id)).map((row) => row.id));
  return { ok: true, move: { entering, closedAt: closedAtFor(day, today, now, timeZone), today, timeZone } };
}

const undoSchema = z.object({
  kind: z.enum(["owner", "status", "stage", "tag", "category", "trash"]),
  rows: z
    .array(
      z.object({
        id: z.guid(),
        owner: z.guid().nullish(),
        status: z.string().max(40).optional(),
        reason: z.string().max(500).nullish(),
        stage: z.guid().optional(),
        lossReasonId: z.guid().nullish(),
        lossText: z.string().max(LOSS_TEXT_MAX).nullish(),
        closedAt: z.iso.datetime({ offset: true }).nullish(),
        tag: z.guid().optional(),
        active: z.boolean().optional(),
        archived: z.boolean().optional(),
        category: z.guid().nullish(),
      }),
    )
    .max(MAX_IDS),
});

/**
 * Puts back what a bulk action changed (FXU-06), row by row with the user's
 * session: the same rules as any change, so nothing the user may not do.
 */
export async function undoBulkAction(orgId: string, object: BulkObject, undo: BulkUndo): Promise<ActionResult<{ done: number }>> {
  if ((object !== "product" && !isRecordType(object)) || !validArg(undoSchema, undo)) {
    return fail(INVALID_ARGS);
  }
  if (undo.rows.length === 0) return ok({ done: 0 });
  const context = await actionContext(orgId, ...undo.rows.map((row) => row.id));
  if (!context.ok) {
    return context;
  }
  const { supabase } = context;
  if (object === "product") {
    if (undo.kind !== "status" && undo.kind !== "category") return fail(INVALID_ARGS);
    return productUndoAction(supabase, orgId, undo.kind, undo.rows);
  }
  const table = RECORD_TYPES[object].table;
  // one column of one row; the table differs by object, the column is checked by the database
  const update = async (
    id: string,
    values: { owner_id?: string | null; stage_id?: string; lost_reason_id?: string | null; lost_reason?: string; closed_at?: string | null; status?: (typeof TASK_STATUSES)[number] },
  ) => {
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
      if (object === "deal") {
        undone = await eachLimited(undo.rows, async (row) => {
          if (!row.stage) return false;
          // the reason goes back with the stage (the database refuses a reason that was hidden since; that row is not undone),
          // and so does the close date in the same update (deals_sync_stage_close keeps a date a person sends)
          const moved = await update(row.id, {
            stage_id: row.stage,
            ...(row.lossReasonId !== undefined ? { lost_reason_id: row.lossReasonId } : {}),
            ...(row.closedAt !== undefined ? { closed_at: row.closedAt } : {}),
          });
          // old free text without a picked reason: a second step, since clearing a picked reason also clears its text
          if (moved && !row.lossReasonId && row.lossText) {
            // counted as undone only when the text came back too
            return update(row.id, { lost_reason: row.lossText });
          }
          return moved;
        });
      }
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
