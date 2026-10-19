import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";

import { isMoveRefusal, type MoveRefusal } from "@/features/custom-fields/required-move";
import { requiredForMove } from "@/features/custom-fields/required-server";
import type { DealLoss } from "@/features/deal-loss-reasons/schema";
import { validateStatusChoice, writeLeadStatus } from "@/features/leads/status";
import { fail, formValues, ok, type ActionResult } from "@/lib/action-result";
import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { RECORD_TYPES, recordPage } from "@/lib/record-types";

// FLD-09 (owner, 14 October 2026): one path for every move of a lead's status or a deal's stage by a
// person: the leads and deals boards, the table cells, the lead card's status form, the deal card's
// stage menu and the forecast / cleanup lists. The new status or stage may make conditionally required
// fields required; when one is empty nothing is saved and the answer (MoveRefusal) names the fields;
// the place asks for them and sends again, and the fields are saved with the move in one update
// ({"$merge": …}). App-only: bulk, automations, imports, conversion and server writers never come here.

export const STATUS_GONE = "הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.";
export const STAGE_GONE = "השלב שנבחר כבר לא קיים. רעננו את הדף ונסו שוב.";
export const NO_LONGER_OPEN = "העסקה כבר לא פתוחה. רעננו את הדף.";

export type MoveSpec =
  // reason: the "not relevant" reason (RVW-9), checked before the fields
  | { object: "lead"; statusId: string; reason: string | null }
  // loss: DEAL-03 reason and competitor; expectOpen: only a deal still open (GOL-04 / MNY-05 lists)
  | { object: "deal"; stageId: string; loss?: Partial<DealLoss>; expectOpen?: boolean };

export type MoveResult = ActionResult | MoveRefusal;

/**
 * Moves one record with the user's session. formData: what the place sent (null for a drag or a cell's
 * first try); it carries the asked fields once they were asked. The lead's reason and the fields are
 * judged together, so a window that asks for the fields also asks for a reason that does not pass:
 * a save never fails on a reason it had no input for.
 */
export async function moveRecord(
  supabase: SupabaseClient<Database>,
  orgId: string,
  id: string,
  spec: MoveSpec,
  formData: FormData | null,
): Promise<MoveResult> {
  const values = formData ? formValues(formData) : undefined;
  if (spec.object === "lead") {
    const [choice, required] = await Promise.all([
      validateStatusChoice(supabase, orgId, spec.statusId, spec.reason),
      requiredForMove(orgId, "lead", id, { "builtin:status": spec.statusId }, formData),
    ]);
    if (!choice.ok) {
      if (!choice.needsReason) return fail(choice.message, { values });
      const reasonError = { disqualify_reason: choice.message };
      return isMoveRefusal(required)
        ? { ...required, message: choice.message, fieldErrors: { ...required.fieldErrors, ...reasonError } }
        : fail(choice.message, { fieldErrors: reasonError, values });
    }
    if (!required.ok) return required;
    const written = await writeLeadStatus(supabase, orgId, id, spec.statusId, choice.reason, required.merge);
    return written.ok ? ok() : fail(written.message, { values });
  }

  const required = await requiredForMove(orgId, "deal", id, { "builtin:stage": spec.stageId }, formData);
  if (!required.ok) return required;
  // A stage of another pipeline (or organization) is rejected by the (pipeline_id, stage_id) foreign
  // key: 23503. A loss reason on a stage that is not lost is dropped by the database (deals_sync_stage_loss).
  let update = supabase
    .from("deals")
    .update({
      stage_id: spec.stageId,
      ...(spec.loss ?? {}),
      // DEAL-05: the stage's required built-in fields, asked with the move
      ...(required.columns ?? {}),
      ...(required.merge === undefined ? {} : { custom_fields: required.merge }),
    })
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("deleted_at", null);
  if (spec.expectOpen) update = update.eq("status", "open");
  const { data, error } = await update.select("id");
  if (error) {
    return fail(error.code === "23503" ? STAGE_GONE : dbErrorMessage(error, "לא הצלחנו להעביר את העסקה. נסו שוב."), { values });
  }
  if (data.length === 0) {
    return fail(spec.expectOpen ? NO_LONGER_OPEN : NOT_FOUND_OR_FORBIDDEN);
  }
  return ok();
}

/** After a move: the list, the business's home and the record's page. */
export function revalidateMove(orgId: string, object: "lead" | "deal", id: string) {
  revalidatePath(RECORD_TYPES[object].list(orgId));
  revalidatePath(paths.org(orgId));
  revalidatePath(recordPage(object, orgId, id));
}
