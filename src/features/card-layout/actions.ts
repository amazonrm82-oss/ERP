"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

import { CARD_LAYOUT_TYPES, cleanLayout, defaultLayout, layoutCatalog, layoutProblem, layoutSchema, type CardLayoutGroup, type CardLayoutType } from "./layout";

const typeArg = z.enum(CARD_LAYOUT_TYPES);
// the browser's value before cleaning: generous bounds, the real rules follow
const rawLayoutArg = z
  .array(z.object({ title: z.string().max(400), columns: z.union([z.literal(1), z.literal(2)]), fields: z.array(z.string().max(60)).max(200) }).strict())
  .max(40);

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

/** Writes the layout of one type with the user's session (owners and admins of a writable business; RLS decides). */
async function writeLayout(context: Context, orgId: string, type: CardLayoutType, groups: CardLayoutGroup[]): Promise<ActionResult> {
  const update = () =>
    context.supabase.from("card_layouts").update({ groups }).eq("organization_id", orgId).eq("object_type", type).select("id");
  const first = await update();
  if (first.error) {
    return fail(dbErrorMessage(first.error));
  }
  if (first.data.length === 0) {
    // no row yet (the business never changed this card), or not permitted: RLS refuses the insert then
    const inserted = await context.supabase.from("card_layouts").insert({ organization_id: orgId, object_type: type, groups }).select("id");
    if (inserted.error?.code === "23505") {
      // another admin saved the first row at the same moment: write over it once
      const again = await update();
      if (again.error) {
        return fail(dbErrorMessage(again.error));
      }
      if (again.data.length === 0) {
        return fail(NOT_FOUND_OR_FORBIDDEN);
      }
    } else if (inserted.error) {
      return fail(inserted.error.code === "42501" ? NOT_FOUND_OR_FORBIDDEN : dbErrorMessage(inserted.error));
    }
  }
  revalidatePath(`/o/${orgId}/settings/card-layout`);
  return { ok: true, message: "התצוגה נשמרה." };
}

/** FLD-08: saves the groups of one record type's card. */
export async function saveCardLayoutAction(orgId: string, type: string, groups: unknown): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  if (!validArg(typeArg, type) || !validArg(rawLayoutArg, groups)) {
    return fail(INVALID_ARGS);
  }
  const catalog = layoutCatalog(type, await listFieldDefinitions(orgId, type));
  const cleaned = cleanLayout(groups as CardLayoutGroup[], catalog.map((f) => f.key));
  const problem = layoutProblem(cleaned);
  if (problem) {
    return fail(problem);
  }
  if (!layoutSchema(type).safeParse(cleaned).success) {
    return fail(INVALID_ARGS);
  }
  return writeLayout(context, orgId, type, cleaned);
}

/** FLD-08: "שחזור ברירת מחדל" writes the default layout (there is no delete). */
export async function resetCardLayoutAction(orgId: string, type: string): Promise<ActionResult> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  if (!validArg(typeArg, type)) {
    return fail(INVALID_ARGS);
  }
  return writeLayout(context, orgId, type, defaultLayout(type, await listFieldDefinitions(orgId, type)));
}
