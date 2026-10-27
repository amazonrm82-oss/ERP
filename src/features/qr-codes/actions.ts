"use server";

import { revalidatePath } from "next/cache";

import { booleanArg, INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, FORM_INVALID, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { parseTarget, qrCodeSchema, targetColumns } from "./model";
import { qrCodesSettingsPath } from "./paths";
import { normalizeQrTargetUrl, QR_URL_MESSAGES } from "./target-url";

/**
 * BIZ-03: a new code that opens a form, a booking page, a business card or an https link. Owners and admins (the database
 * decides, with the plan and the link rule).
 */
export async function createQrCodeAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = qrCodeSchema.safeParse(pick(formData, ["name", "kind", "target", "url"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  let columns: ReturnType<typeof targetColumns>;
  if (parsed.data.kind === "url") {
    const link = normalizeQrTargetUrl(parsed.data.url ?? "");
    if (!link.ok) return fail(FORM_INVALID, { fieldErrors: { url: QR_URL_MESSAGES[link.problem] }, values: formValues(formData) });
    columns = targetColumns("url", null, link.url);
  } else {
    const target = parseTarget(parsed.data.target ?? "");
    if (!target) return fail("יש לבחור מה הקוד פותח.", { values: formValues(formData) });
    columns = targetColumns(target.kind, target.id, null);
  }
  const { error } = await context.supabase.from("qr_codes").insert({ organization_id: orgId, name: parsed.data.name, ...columns });
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו ליצור את הקוד. נסו שוב."), { values: formValues(formData) });
  revalidatePath(qrCodesSettingsPath(orgId));
  return { ok: true, message: "הקוד נוצר. אפשר להוריד אותו ולהדפיס." };
}

/** Switches a code on or off; an off code answers "not found" and is not counted. */
export async function setQrCodeActiveAction(orgId: string, codeId: string, active: boolean): Promise<ActionResult> {
  if (!validArg(booleanArg, active)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, codeId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("qr_codes")
    .update({ is_active: active })
    .eq("organization_id", orgId)
    .eq("id", codeId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(qrCodesSettingsPath(orgId));
  return ok();
}

/** Removes a code and its counts; printed copies stop working. Leads that came through it stay. */
export async function deleteQrCodeAction(orgId: string, codeId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, codeId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("qr_codes").delete().eq("organization_id", orgId).eq("id", codeId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(qrCodesSettingsPath(orgId));
  return ok();
}
