"use server";

import { askedField, type MoveRefusal } from "@/features/custom-fields/required-move";
import { missingAfterChange } from "@/features/custom-fields/required-server";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { lossReasonIdByName } from "@/features/deal-loss-reasons/server";
import { stageRequiredFields } from "@/features/deals/stage-required";
import { INVALID_ARGS, optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isUuid } from "@/lib/paths";

import { moveRecord, revalidateMove, STAGE_GONE, STATUS_GONE } from "./server";

type MoveObject = "lead" | "deal";

function validObject(object: unknown): object is MoveObject {
  return object === "lead" || object === "deal";
}

/**
 * FLD-09: a status (lead) or stage (deal) chosen on a board or in a table cell, and the same move again
 * from RequiredFieldsDialog with the fields it asked for (formData). reason: a lead's "not relevant"
 * reason, or a deal's loss reason by name (the cell picks by name); a reason the window sends wins.
 */
export async function moveRecordAction(
  orgId: string,
  object: MoveObject,
  id: string,
  targetId: string,
  reason: string | null,
  formData: FormData | null,
): Promise<ActionResult | MoveRefusal> {
  if (!validObject(object) || !validArg(optionalTextArg(500), reason) || (formData !== null && !(formData instanceof FormData))) {
    return fail(INVALID_ARGS);
  }
  if (!isUuid(targetId)) return fail(object === "lead" ? STATUS_GONE : STAGE_GONE);
  const context = await actionContext(orgId, id);
  if (!context.ok) return context;

  // a lead's window may send the "not relevant" reason again; a deal's loss reason comes only by name
  const sent = object === "lead" ? formData?.get("disqualify_reason") : undefined;
  const why = (typeof sent === "string" ? sent : reason)?.trim().slice(0, 500) || null;
  let result;
  if (object === "lead") {
    result = await moveRecord(context.supabase, orgId, id, { object, statusId: targetId, reason: why }, formData);
  } else {
    const loss = await lossReasonIdByName(context.supabase, orgId, why);
    if (!loss.ok) return fail(loss.message);
    result = await moveRecord(context.supabase, orgId, id, { object, stageId: targetId, loss: loss.id ? { lost_reason_id: loss.id } : undefined }, formData);
  }
  if (result.ok) revalidateMove(orgId, object, id);
  return result;
}

/**
 * FLD-09: the fields a move would leave required and empty, as a window shows them (the won window asks
 * for them up front). Read with the user's session; nothing is saved.
 */
export async function missingForMoveAction(
  orgId: string,
  object: MoveObject,
  id: string,
  targetId: string,
): Promise<ActionResult<{ fields: FieldDefinition[]; amountRequired: boolean }>> {
  if (!validObject(object)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, id, targetId);
  if (!context.ok) return context;
  // only the won window reads this, and it asks the amount itself (DEAL-05): it marks it required when the stage says so
  const [found, stage] = await Promise.all([
    missingAfterChange(orgId, object, [id], { [object === "lead" ? "builtin:status" : "builtin:stage"]: targetId }, ["amount"]),
    object === "deal"
      ? context.supabase.from("stages").select("required_fields").eq("organization_id", orgId).eq("id", targetId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (!found.ok) return fail(dbErrorMessage(found.error));
  if (stage.error) return fail(dbErrorMessage(stage.error));
  return ok({ fields: (found.missing.get(id) ?? []).map(askedField), amountRequired: stageRequiredFields(stage.data?.required_fields).includes("amount") });
}
