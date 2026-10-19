"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";

import {
  confirmsName,
  DEAL_NAME_MAX,
  ERASE_CHANGED,
  ERASE_DEAL_NAME,
  ERASE_EXTRA,
  ERASE_EXTRA_MAX,
  ERASE_NEEDS_SECOND_STEP,
  ERASE_NOT_READY,
  ERASE_REASON,
  ERASE_TABLE,
  previewFrom,
  REASON_MAX,
  resultSchema,
  type ErasePreview,
} from "./erase";

const kindArg = z.enum(["lead", "contact"]);
const extraArg = z.array(z.object({ type: z.enum(["leads", "contacts"]), id: z.uuid() })).max(200);
const optionsArg = z.object({
  confirmName: z.string().max(400),
  personRequest: z.boolean(),
  reason: z.string().trim().min(1).max(REASON_MAX),
  extra: extraArg,
  dealNames: z.record(z.uuid(), z.string().trim().min(1).max(DEAL_NAME_MAX)),
});

function eraseError(error: { code?: string; hint?: string; message?: string }): string {
  if (error.hint === "mfa:self_first") return ERASE_NEEDS_SECOND_STEP;
  // the person's records changed while the removal waited for them (retryable)
  if (error.hint === "person_erase:changed") return ERASE_CHANGED;
  if (error.hint === "person_erase:deal_name") return ERASE_DEAL_NAME;
  if (error.hint === "person_erase:reason") return ERASE_REASON;
  if (error.hint === "person_erase:extra") return ERASE_EXTRA;
  if (error.hint === "person_erase:extra_max") return ERASE_EXTRA_MAX;
  // the deleting function is pasted by the owner; until then the database does not know it
  if (error.code === "PGRST202" || error.code === "42883") return ERASE_NOT_READY;
  return dbErrorMessage(error, "לא הצלחנו למחוק. נסו שוב.");
}

/**
 * PRV-03: what removing this person takes, for the confirmation window (owners and admins, second step). `extra` are the
 * offered records of the same phone or email that stay ticked; the counts follow them.
 */
export async function previewPersonEraseAction(orgId: string, kind: unknown, id: string, extra: unknown = []): Promise<ActionResult<ErasePreview>> {
  if (!validArg(kindArg, kind) || !validArg(extraArg, extra)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, id);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("privacy_erase_preview", { p_org: orgId, p_type: ERASE_TABLE[kind], p_id: id, p_extra: extra });
  if (error) return fail(eraseError(error));
  const preview = previewFrom(data);
  return preview ? ok(preview) : fail("לא הצלחנו לקרוא מה יימחק. נסו שוב.");
}

/**
 * PRV-03: removes the person (the record, its conversion relatives and the ticked records of the same phone or email) and
 * erases them from the audit log, in one call. The typed name is checked against the preview again on the server; the
 * database decides everything else (deal names, the reason, the offered records).
 */
export async function erasePersonAction(orgId: string, kind: unknown, id: string, options: unknown): Promise<ActionResult<{ paused: boolean }>> {
  if (!validArg(kindArg, kind) || !validArg(optionsArg, options)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, id);
  if (!context.ok) return context;
  const table = ERASE_TABLE[kind];
  const read = await context.supabase.rpc("privacy_erase_preview", { p_org: orgId, p_type: table, p_id: id, p_extra: options.extra });
  if (read.error) return fail(eraseError(read.error));
  const preview = previewFrom(read.data);
  if (!preview) return fail("לא הצלחנו לקרוא מה יימחק. נסו שוב.");
  if (!confirmsName(options.confirmName, preview)) return fail("השם שהוקלד לא תואם את שם האדם.");
  const { data, error } = await context.supabase.rpc("privacy_erase_person", {
    p_org: orgId,
    p_type: table,
    p_id: id,
    p_extra: options.extra,
    p_reason: options.reason,
    p_deal_names: options.dealNames,
    p_person_request: options.personRequest,
  });
  if (error) return fail(eraseError(error));
  const result = resultSchema.safeParse(data);
  revalidatePath(paths.leads(orgId));
  revalidatePath(paths.contacts(orgId));
  // the records are gone either way; a paused erasure completes by itself once the server can
  return ok({ paused: result.success ? result.data.paused : false });
}
