"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getUserNames } from "@/features/shell/queries";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";

import { BLOCKLIST_ADD_MAX, BLOCKLIST_CHANNELS, BLOCKLIST_REASONS, BLOCKLIST_REMOVED_REASONS, splitAddresses, type BlocklistChannel } from "./model";
import { consentBlocklistPath } from "./paths";
import { blocklistAddResultSchema, blocklistFindSchema } from "./schema";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת של עסק פעיל יכולים לשנות את רשימת החסימה.";

const addSchema = z.object({
  channel: z.enum(BLOCKLIST_CHANNELS, { error: "יש לבחור ערוץ." }),
  reason: z.enum(BLOCKLIST_REASONS, { error: "יש לבחור סיבה." }),
  addresses: z
    .string()
    .max(40_000, { error: "הטקסט ארוך מדי." })
    .transform(splitAddresses)
    .pipe(
      z
        .array(z.string().max(320))
        .min(1, { error: "יש להקליד טלפון או אימייל אחד לפחות." })
        .max(BLOCKLIST_ADD_MAX, { error: `אפשר להוסיף עד ${BLOCKLIST_ADD_MAX} כתובות בבת אחת.` }),
    ),
});

/** CNS-06: adds typed or pasted addresses to the list (owners and admins; the function decides). */
export async function addToBlocklistAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = addSchema.safeParse({
    channel: formData.get("channel"),
    reason: formData.get("reason"),
    addresses: formData.get("addresses") ?? "",
  });
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase.rpc("consent_blocklist_add", {
    p_org: orgId,
    p_channel: parsed.data.channel,
    p_addresses: parsed.data.addresses,
    p_reason: parsed.data.reason,
  });
  if (error) {
    return fail(error.code === "42501" ? NOT_ADMIN : dbErrorMessage(error), { values: formValues(formData) });
  }
  const result = blocklistAddResultSchema.parse(data);
  revalidatePath(consentBlocklistPath(orgId));
  return { ok: true, message: addMessage(result, parsed.data.addresses) };
}

function addMessage(result: { added: number; existing: number; invalid: number[] }, addresses: string[]): string {
  const parts = [result.added === 1 ? "נוספה כתובת אחת לרשימה." : `נוספו ${result.added} כתובות לרשימה.`];
  if (result.existing > 0) parts.push(result.existing === 1 ? "כתובת אחת כבר הייתה ברשימה." : `${result.existing} כתובות כבר היו ברשימה.`);
  if (result.invalid.length > 0) {
    const shown = result.invalid
      .slice(0, 5)
      .map((position) => addresses[position - 1])
      .filter(Boolean)
      .join(", ");
    const more = result.invalid.length > 5 ? ` ועוד ${result.invalid.length - 5}` : "";
    parts.push(`לא נוספו (לא טלפון או אימייל תקינים לערוץ הזה): ${shown}${more}.`);
  }
  return parts.join(" ");
}

export type BlocklistFindEntry = {
  id: string;
  channel: BlocklistChannel;
  reason: (typeof BLOCKLIST_REASONS)[number];
  addedBy: string | null;
  createdAt: string;
  removedAt: string | null;
  removedBy: string | null;
  removedReason: (typeof BLOCKLIST_REMOVED_REASONS)[number] | null;
};

export type BlocklistFindResult =
  | { valid: false }
  | { valid: true; kind: "phone" | "email"; checked: boolean; erasure: boolean; entries: BlocklistFindEntry[] };

const findSchema = z.object({ address: z.string().trim().min(1, { error: "יש להקליד טלפון או אימייל." }).max(320) });

/** CNS-06: looks one exact address up (its hash is compared in the database; no list of addresses ever comes back). */
export async function findInBlocklistAction(orgId: string, _prev: FormState<BlocklistFindResult>, formData: FormData): Promise<FormState<BlocklistFindResult>> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = findSchema.safeParse({ address: formData.get("address") ?? "" });
  if (!parsed.success) return invalid(parsed.error, formData);
  const { data, error } = await context.supabase.rpc("consent_blocklist_find", { p_org: orgId, p_address: parsed.data.address });
  if (error) {
    return fail(error.code === "42501" ? "רק בעלים ומנהלי מערכת יכולים לחפש ברשימת החסימה." : dbErrorMessage(error), { values: formValues(formData) });
  }
  const found = blocklistFindSchema.parse(data);
  if (!found.valid) return { ok: true, data: { valid: false } };
  const names = await getUserNames(found.entries.flatMap((e) => [e.added_by, e.removed_by]));
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    ok: true,
    data: {
      valid: true,
      kind: found.kind,
      checked: found.checked,
      erasure: found.erasure,
      entries: found.entries.map((e) => ({
        id: e.id,
        channel: e.channel,
        reason: e.reason,
        addedBy: name(e.added_by),
        createdAt: e.created_at,
        removedAt: e.removed_at,
        removedBy: name(e.removed_by),
        removedReason: e.removed_reason,
      })),
    },
  };
}

const removeSchema = z.object({ reason: z.enum(BLOCKLIST_REMOVED_REASONS, { error: "יש לבחור למה מסירים." }) });

/** CNS-06: removes one entry (never deleted: marked removed with the reason, audited). */
export async function removeFromBlocklistAction(orgId: string, entryId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, entryId);
  if (!context.ok) return context;
  const parsed = removeSchema.safeParse({ reason: formData.get("reason") });
  if (!parsed.success) return invalid(parsed.error, formData);
  const { error } = await context.supabase.rpc("consent_blocklist_remove", { p_org: orgId, p_id: entryId, p_reason: parsed.data.reason });
  if (error) return fail(error.code === "42501" ? NOT_ADMIN : dbErrorMessage(error));
  revalidatePath(consentBlocklistPath(orgId));
  return { ok: true, message: "הכתובת הוסרה מהרשימה. מעכשיו חלים עליה רק כללי ההסכמה הרגילים." };
}
