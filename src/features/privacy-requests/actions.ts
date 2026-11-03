"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isUuid } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

import { NOTE_MAX, PRIVACY_LINK_TOKEN, PRIVACY_REQUEST_STATUSES, PRIVACY_VERIFY_METHODS, publicPrivacyPath, refusalReasonFrom } from "./model";
import { privacyRequestPath, privacyRequestsPath } from "./paths";

// PRK-02: the staff side, with the user's session. RLS lets owners and admins read a request and change it while the business
// is not deleted, suspended or cancelled (a read-only business still handles privacy requests); trigger privacy_requests_check judges every change (identity first, a reason for a refusal, closed = frozen).

const CANNOT = "רק בעלים ומנהלי מערכת מטפלים בבקשות פרטיות, וכשהעסק סגור אי אפשר לשנות אותן.";
const GONE = "הבקשה לא נמצאה, או שאין לכם הרשאה לשנות אותה.";
const writeError = (error: { code?: string; message?: string; hint?: string }) => (error.code === "42501" ? CANNOT : dbErrorMessage(error));

/** A new link (the previous one stops working). The address is returned once: only its hash is kept. */
export async function createPrivacyLinkAction(orgId: string): Promise<ActionResult<{ url: string }>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("privacy_request_link_create", { p_org: orgId });
  if (error) return fail(writeError(error));
  if (typeof data !== "string" || !PRIVACY_LINK_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  revalidatePath(privacyRequestsPath(orgId));
  return ok({ url: `${await siteOrigin()}${publicPrivacyPath(data)}` });
}

/** Turns the link off; the page answers "not found" from now on. */
export async function revokePrivacyLinkAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const { error } = await context.supabase.rpc("privacy_request_link_revoke", { p_org: orgId });
  if (error) return fail(writeError(error));
  revalidatePath(privacyRequestsPath(orgId));
  return ok();
}

type Patch = {
  status?: (typeof PRIVACY_REQUEST_STATUSES)[number];
  verify_method?: (typeof PRIVACY_VERIFY_METHODS)[number];
  verify_note?: string | null;
  refusal_reason?: string | null;
  lead_id?: string | null;
  contact_id?: string | null;
};

async function update(orgId: string, requestId: string, patch: Patch): Promise<FormState> {
  const context = await actionContext(orgId, requestId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("privacy_requests")
    .update(patch)
    .eq("organization_id", orgId)
    .eq("id", requestId)
    .select("id");
  if (error) return fail(writeError(error));
  if (!data || data.length === 0) return fail(GONE);
  revalidatePath(privacyRequestsPath(orgId));
  revalidatePath(privacyRequestPath(orgId, requestId));
  return { ok: true, message: "נשמר." };
}

const statusSchema = z.enum(["verifying", "in_progress", "done"]);

/** Moves an open request on (to "refused" only through the refusal form). */
export async function setPrivacyRequestStatusAction(orgId: string, requestId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = statusSchema.safeParse(formData.get("status"));
  if (!parsed.success) return fail("יש לבחור מצב מהרשימה.");
  return update(orgId, requestId, { status: parsed.data });
}

const verifySchema = z.object({
  verify_method: z.enum(PRIVACY_VERIFY_METHODS, { message: "יש לבחור איך אומתה הזהות." }),
  verify_note: z.string().trim().max(NOTE_MAX, `אפשר עד ${NOTE_MAX} תווים.`),
});

/** "זהות אומתה": how, and an optional note; marked once. A new request moves to "באימות זהות" with it. */
export async function verifyPrivacyRequestAction(orgId: string, requestId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = verifySchema.safeParse({ verify_method: formData.get("verify_method"), verify_note: formData.get("verify_note") ?? "" });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "יש לתקן את השדות.");
  const status = formData.get("status") === "new" ? { status: "verifying" as const } : {};
  return update(orgId, requestId, { ...status, verify_method: parsed.data.verify_method, verify_note: parsed.data.verify_note || null });
}

/** Refuses the request (junk included: it is closed, never deleted) with a ready reason or the words typed for "other". */
export async function refusePrivacyRequestAction(orgId: string, requestId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const reason = refusalReasonFrom(String(formData.get("refusal_choice") ?? ""), String(formData.get("refusal_detail") ?? ""));
  if (!reason) return fail("יש לבחור סיבה, או לכתוב אותה.");
  if (reason.length > NOTE_MAX) return fail(`אפשר עד ${NOTE_MAX} תווים.`);
  return update(orgId, requestId, { status: "refused", refusal_reason: reason });
}

/** Links one lead or contact (picked in the search), or clears the link. */
export async function linkPrivacyRequestAction(orgId: string, requestId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const kind = formData.get("record_kind");
  const id = String(formData.get("record_id") ?? "");
  if (kind !== "lead" && kind !== "contact") return fail("יש לבחור סוג רשומה.");
  if (id !== "" && !isUuid(id)) return fail("יש לבחור רשומה מהחיפוש.");
  const value = id === "" ? null : id;
  return update(orgId, requestId, kind === "lead" ? { lead_id: value, contact_id: null } : { contact_id: value, lead_id: null });
}
