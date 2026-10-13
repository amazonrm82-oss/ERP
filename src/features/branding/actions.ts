"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS } from "@/lib/action-args";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { normalizeHex } from "./color";
import { isOrgLogoPath, LOGOS_BUCKET } from "./logo";

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

// the logo shows in the header of every page, and on the public pages
function refresh(orgId: string) {
  revalidatePath(paths.org(orgId), "layout");
  revalidatePath("/f/[token]", "page");
}

/** The logo the browser just uploaded becomes the business logo; the old one is removed. */
export async function setLogoAction(orgId: string, path: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  if (!isOrgLogoPath(path, orgId)) return fail(INVALID_ARGS);
  return replaceLogo(orgId, context, path);
}

/** Removes the business logo. */
export async function removeLogoAction(orgId: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  return replaceLogo(orgId, context, null);
}

async function replaceLogo(orgId: string, { supabase }: Context, path: string | null): Promise<ActionResult> {
  const { data: before, error: readError } = await supabase.from("organizations").select("logo_path").eq("id", orgId).maybeSingle();
  if (readError) return fail(dbErrorMessage(readError));
  // RLS: only owners and admins update the organization; anyone else gets 0 rows
  const { data, error } = await supabase.from("organizations").update({ logo_path: path }).eq("id", orgId).select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הלוגו. נסו שוב."));
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  const old = before?.logo_path;
  if (old && old !== path && isOrgLogoPath(old, orgId)) {
    // best effort, with the admin's own rights: a logo left behind stays in the organization's folder
    await supabase.storage.from(LOGOS_BUCKET).remove([old]);
  }
  refresh(orgId);
  return ok();
}

const colorSchema = z.object({
  // "" = back to the product's colour
  brand_color: z
    .preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string())
    .refine((value) => value === "" || normalizeHex(value) !== null, { error: "יש להזין צבע בתבנית #1e56d6, או לבחור צבע." })
    .transform((value) => (value === "" ? null : normalizeHex(value))),
});

/** Saves the business's main colour (FLD-04). The stored value is the one picked; pages correct it for contrast. */
export async function saveBrandColorAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  // the "back to the product's colour" button sends reset=1
  const parsed = colorSchema.safeParse({ brand_color: formData.get("reset") === "1" ? "" : formData.get("brand_color") });
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase
    .from("organizations")
    .update({ brand_color: parsed.data.brand_color })
    .eq("id", orgId)
    .select("id");
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את הצבע. נסו שוב."), { values: formValues(formData) });
  if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN, { values: formValues(formData) });
  refresh(orgId);
  return { ok: true, message: parsed.data.brand_color ? "הצבע נשמר." : "חזרנו לצבע ברירת המחדל." };
}
