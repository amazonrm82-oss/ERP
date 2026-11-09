"use server";

import { revalidatePath } from "next/cache";

import { encryptSecret } from "@/features/integrations/crypto";
import { currentSecretKey } from "@/features/integrations/keys-server";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { pick } from "@/lib/validation";

import { metaGraphProvider } from "./graph/select";
import { withTimeout } from "./timeout";
import type { GraphErrorCode } from "./graph/types";
import { metaLeadsSettingsPath } from "./paths";
import { connectSchema, formMappingSchema, tokenSchema } from "./schema";

/**
 * CAP-11: the settings screen's actions, all with the user's own session (owners and admins; RLS and the database's
 * triggers decide). The page token is encrypted here (INT-02) and handed to public.integration_secret_set as an envelope;
 * it is never written to a log, never put back into a form's values and never read again by this screen.
 */

// the token field never travels back to the browser, not even after a failed save
const SECRET_FIELDS = ["token", "password"];
const values = (formData: FormData) => formValues(formData, SECRET_FIELDS);

const NO_KEY = "מפתח ההצפנה של המערכת עוד לא הוגדר, ולכן אי אפשר לשמור את הטוקן. פנו לתמיכה.";
const NO_PROVIDER = "החיבור לפייסבוק ולאינסטגרם עוד לא הופעל במערכת. נעדכן כשיהיה אפשר לחבר דף.";
const PAGE_TAKEN = "הדף הזה כבר מחובר לעסק.";

function graphMessage(code: GraphErrorCode): string {
  if (code === "token_invalid") return "פייסבוק לא קיבלה את הטוקן. העתיקו טוקן חדש של הדף ונסו שוב.";
  if (code === "not_found") return "לא מצאנו את הדף בפייסבוק. בדקו את מזהה הדף.";
  return "פייסבוק לא ענתה כרגע. נסו שוב בעוד כמה דקות.";
}

type Supabase = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>["supabase"];

/**
 * Review finding 3: owners and admins only, asked before a token is sent to the provider (the database refuses others
 * anyway; this keeps their tokens from reaching Meta at all). Read with the user's own session: their own membership row.
 */
async function isOwnerOrAdmin(supabase: Supabase, orgId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role, status")
    .eq("organization_id", orgId)
    .eq("user_id", userId);
  if (error) return false;
  const row = data[0];
  return row !== undefined && row.status === "active" && (row.role === "owner" || row.role === "admin");
}

/** The provider's answer, or "graph_unavailable" when it fails or takes longer than PROVIDER_TIMEOUT_MS (finding 4). */
function checkPageWithin(provider: NonNullable<ReturnType<typeof metaGraphProvider>>, pageId: string, token: string) {
  return withTimeout(provider.checkPage(pageId, token), { ok: false as const, code: "graph_unavailable" as const });
}

async function storeToken(supabase: Supabase, orgId: string, integrationId: string, pageId: string, token: string): Promise<string | null> {
  const key = currentSecretKey();
  if (!key) return NO_KEY;
  // the additional data binds business, connection and page (review finding 1)
  const envelope = encryptSecret(token, key, { organizationId: orgId, integrationId, externalId: pageId });
  const { error } = await supabase.rpc("integration_secret_set", {
    p_org: orgId,
    p_integration: integrationId,
    p_ciphertext: envelope,
    p_key_version: key.version,
  });
  return error ? dbErrorMessage(error) : null;
}

/** Connects a page: checks the token with Meta, makes the connection and stores the token encrypted. */
export async function connectPageAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = connectSchema.safeParse(pick(formData, ["page_id", "name", "token"]));
  if (!parsed.success) {
    const result = invalid(parsed.error, formData);
    return { ...result, values: values(formData) };
  }
  const { supabase } = context;
  if (!(await isOwnerOrAdmin(supabase, orgId, context.user.id))) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (!currentSecretKey()) return fail(NO_KEY, { values: values(formData) });
  const provider = metaGraphProvider();
  if (!provider) return fail(NO_PROVIDER, { values: values(formData) });
  const { page_id: pageId, name, token } = parsed.data;
  const check = await checkPageWithin(provider, pageId, token);
  if (!check.ok) return fail(graphMessage(check.code), { values: values(formData) });

  const { data, error } = await supabase
    .from("integrations")
    .insert({ organization_id: orgId, provider: "meta_lead_ads", external_id: pageId, name })
    .select("id");
  if (error) return fail(error.code === "23505" ? PAGE_TAKEN : dbErrorMessage(error, "לא הצלחנו לחבר את הדף. נסו שוב."), { values: values(formData) });
  const integrationId = data[0]?.id;
  if (!integrationId) return fail(NOT_FOUND_OR_FORBIDDEN);
  const problem = await storeToken(supabase, orgId, integrationId, pageId, token);
  if (problem) {
    // a connection without its token would only wait: removed again
    await supabase.from("integrations").delete().eq("organization_id", orgId).eq("id", integrationId);
    return fail(problem, { values: values(formData) });
  }
  revalidatePath(metaLeadsSettingsPath(orgId));
  return { ok: true, message: "הדף חובר. כשהליד הראשון ממנו ייקלט, החיבור יאומת והלידים יוצגו כאן." };
}

/** Replaces a page's token (an expired or revoked one); the connection becomes connected again. */
export async function replaceTokenAction(orgId: string, integrationId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, integrationId);
  if (!context.ok) return context;
  const parsed = tokenSchema.safeParse(pick(formData, ["token"]));
  if (!parsed.success) return { ...invalid(parsed.error), values: {} };
  const { supabase } = context;
  if (!(await isOwnerOrAdmin(supabase, orgId, context.user.id))) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (!currentSecretKey()) return fail(NO_KEY);
  const provider = metaGraphProvider();
  if (!provider) return fail(NO_PROVIDER);
  const { data, error } = await supabase
    .from("integrations")
    .select("id, external_id")
    .eq("organization_id", orgId)
    .eq("id", integrationId)
    .eq("provider", "meta_lead_ads");
  if (error) return fail(dbErrorMessage(error));
  const row = data[0];
  if (!row?.external_id) return fail(NOT_FOUND_OR_FORBIDDEN);
  const check = await checkPageWithin(provider, row.external_id, parsed.data.token);
  if (!check.ok) return fail(graphMessage(check.code));
  const problem = await storeToken(supabase, orgId, row.id, row.external_id, parsed.data.token);
  if (problem) return fail(problem);
  revalidatePath(metaLeadsSettingsPath(orgId));
  return { ok: true, message: "הטוקן החדש נשמר. הלידים שחיכו יימשכו בדקות הקרובות." };
}

/** Switches a page off (no new leads are taken) or on again (only while a token is stored). */
export async function setConnectionStatusAction(orgId: string, integrationId: string, connected: boolean): Promise<ActionResult> {
  const context = await actionContext(orgId, integrationId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase
    .from("integrations")
    .update({ status: connected ? "connected" : "disconnected" })
    .eq("organization_id", orgId)
    .eq("id", integrationId)
    .select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(metaLeadsSettingsPath(orgId));
  return ok();
}

/** Removes a page's connection, its token and its form settings. Leads that came in stay. */
export async function deleteConnectionAction(orgId: string, integrationId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, integrationId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("integrations").delete().eq("organization_id", orgId).eq("id", integrationId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(metaLeadsSettingsPath(orgId));
  return ok();
}

function parseMapping(formData: FormData) {
  return formMappingSchema.safeParse({
    ...pick(formData, ["meta_form_id", "name", "assign_mode", "owner_id", "team_id"]),
    is_active: formData.get("is_active") === "on",
  });
}

/** Saves which Meta form goes to whom: a new mapping (rowId null) or an existing one (its Meta form id stays). */
export async function saveFormMappingAction(
  orgId: string,
  integrationId: string,
  rowId: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await actionContext(orgId, integrationId, ...(rowId ? [rowId] : []));
  if (!context.ok) return context;
  const parsed = parseMapping(formData);
  if (!parsed.success) return invalid(parsed.error, formData);
  const { supabase } = context;
  const { meta_form_id: metaFormId, ...rest } = parsed.data;
  if (rowId) {
    const { data, error } = await supabase.from("meta_lead_forms").update(rest).eq("organization_id", orgId).eq("id", rowId).select("id");
    if (error) return fail(dbErrorMessage(error), { values: formValues(formData) });
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  } else {
    if (!metaFormId) return fail("יש למלא את מזהה הטופס.", { fieldErrors: { meta_form_id: "יש למלא את מזהה הטופס." }, values: formValues(formData) });
    const { error } = await supabase
      .from("meta_lead_forms")
      .insert({ organization_id: orgId, integration_id: integrationId, meta_form_id: metaFormId, ...rest });
    if (error) {
      const message = error.code === "23505" ? "הטופס הזה כבר מוגדר לדף." : dbErrorMessage(error, "לא הצלחנו להוסיף את הטופס. נסו שוב.");
      return fail(message, { values: formValues(formData) });
    }
  }
  revalidatePath(metaLeadsSettingsPath(orgId));
  return { ok: true, message: "ההגדרות נשמרו." };
}

/** Removes a form mapping; its leads go to the page's default row from now on. */
export async function deleteFormMappingAction(orgId: string, rowId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, rowId);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.from("meta_lead_forms").delete().eq("organization_id", orgId).eq("id", rowId).select("id");
  if (error) return fail(dbErrorMessage(error));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  revalidatePath(metaLeadsSettingsPath(orgId));
  return ok();
}
