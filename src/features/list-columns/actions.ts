"use server";

import { revalidatePath } from "next/cache";

import { requestedProductEnabled } from "@/features/requested-product/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { isRecordType, RECORD_TYPES } from "@/lib/record-types";

import { BOARD_PREFERENCE, boardCatalog, MAX_BOARD_FIELDS } from "@/features/deals/board-fields";
import { productsPath } from "@/features/products/paths";
import { paths } from "@/lib/paths";

import { catalogFor, columnChoicesSchema, type ColumnChoice, type PreferenceKey } from "./columns";


const isPreferenceKey = (object: unknown): object is PreferenceKey => object === BOARD_PREFERENCE || object === "product" || isRecordType(object);

// the page that shows a list's columns (or the board's card fields); the product catalog is not a record type (LST-09)
const pageOf = (orgId: string, object: PreferenceKey) =>
  object === BOARD_PREFERENCE ? paths.deals(orgId) : object === "product" ? productsPath(orgId) : RECORD_TYPES[object].list(orgId);

/** What can be picked for a list: its columns, or the fields of a board card (DEAL-09). */
async function knownKeys(orgId: string, object: PreferenceKey): Promise<Set<string>> {
  if (object === BOARD_PREFERENCE) {
    return new Set(boardCatalog(await listFieldDefinitions(orgId, "deal")).map((column) => column.key));
  }
  const [fields, products] = await Promise.all([
    object === "task" || object === "product" ? Promise.resolve([]) : listFieldDefinitions(orgId, object),
    // LEAD-04: the leads' product column only with the product catalog
    object === "lead" ? requestedProductEnabled(orgId) : Promise.resolve(false),
  ]);
  return new Set(catalogFor(object, fields, { products }).map((column) => column.key));
}

/** Saves the user's columns for a list, or the fields of a deal card on the board (only ones that really exist). */
export async function saveListColumnsAction(orgId: string, object: PreferenceKey, columns: ColumnChoice[]): Promise<ActionResult> {
  if (!isPreferenceKey(object)) {
    return fail("הרשימה לא נמצאה.");
  }
  const parsed = columnChoicesSchema.safeParse(columns);
  if (!parsed.success) {
    return fail("לא הצלחנו לקרוא את העמודות. רעננו את הדף ונסו שוב.");
  }
  if (object === BOARD_PREFERENCE && parsed.data.length > MAX_BOARD_FIELDS) {
    return fail(`אפשר להציג על הכרטיס עד ${MAX_BOARD_FIELDS} שדות.`);
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const known = await knownKeys(orgId, object);
  if (parsed.data.some((choice) => !known.has(choice.key))) {
    return fail(object === BOARD_PREFERENCE ? "אחד השדות כבר לא קיים. רעננו את הדף ונסו שוב." : "אחת העמודות כבר לא קיימת. רעננו את הדף ונסו שוב.");
  }

  // update the user's row, or create it the first time (RLS: own rows only)
  const { data, error } = await context.supabase
    .from("list_preferences")
    .update({ columns: parsed.data })
    .eq("organization_id", orgId)
    .eq("object_type", object)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את העמודות. נסו שוב."));
  }
  if (data.length === 0) {
    const { error: insertError } = await context.supabase.from("list_preferences").insert({ organization_id: orgId, object_type: object, columns: parsed.data });
    if (insertError) {
      return fail(dbErrorMessage(insertError, "לא הצלחנו לשמור את העמודות. נסו שוב."));
    }
  }
  revalidatePath(pageOf(orgId, object));
  return ok();
}

/** Back to the list's default columns (or the board's default card fields). */
export async function resetListColumnsAction(orgId: string, object: PreferenceKey): Promise<ActionResult> {
  if (!isPreferenceKey(object)) {
    return fail("הרשימה לא נמצאה.");
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const { error } = await context.supabase.from("list_preferences").delete().eq("organization_id", orgId).eq("object_type", object);
  if (error) {
    return fail(dbErrorMessage(error));
  }
  revalidatePath(pageOf(orgId, object));
  return ok();
}
