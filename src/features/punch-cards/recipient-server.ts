import "server-only";

import { listRelationTypes } from "@/features/contact-relations/queries";
import { relationChoices } from "@/features/contact-relations/types";
import { orgHasFeature } from "@/features/settings/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isRecipientHow, type LineRecipient, type RecipientDocKind, type RecipientOption } from "./recipients";

/** What a quote's or order's page needs for PKG-06: each line's recipient, and the choices while the draft is editable. */
export type RecipientSetup = {
  lines: Record<string, LineRecipient>;
  // null while the document cannot change (sent, numbered, or the person may not edit it)
  edit: {
    options: RecipientOption[];
    // the payer is a contact: a new recipient is linked to it by a relation of one of these kinds
    payerContactId: string | null;
    // the payer is a company: a new recipient is one of its employees
    payerCompanyId: string | null;
    relationChoices: Array<{ value: string; label: string }>;
  } | null;
};

type LineIn = { id: string; productId: string | null; recipientId?: string | null };

/**
 * The punch card lines of a document (products of kind punch_card), the names of their recipients and, for an editable
 * draft, the contacts that may receive (public.punch_card_recipient_options). Read with the user's session; a name the
 * person may not read is shown as "איש קשר" (the line keeps its recipient).
 */
export async function getRecipientSetup(
  orgId: string,
  kind: RecipientDocKind,
  docId: string,
  payer: { contactId: string | null; companyId: string | null },
  lines: LineIn[],
  editable: boolean,
): Promise<RecipientSetup> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((id): id is string => Boolean(id)))];
  if (productIds.length === 0 || !(await orgHasFeature(orgId, "punch_cards"))) {
    return { lines: {}, edit: null };
  }
  const supabase = await createClient();
  const products = must(
    await supabase.from("products").select("id").eq("organization_id", orgId).eq("kind", "punch_card").in("id", productIds),
    "punch card products",
  );
  const punchIds = new Set(products.map((p) => p.id));
  const punchLines = lines.filter((l) => l.productId && punchIds.has(l.productId));
  if (punchLines.length === 0) {
    return { lines: {}, edit: null };
  }
  const recipientIds = [...new Set(punchLines.map((l) => l.recipientId).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (recipientIds.length > 0) {
    const rows = must(await supabase.from("contacts").select("id, full_name").eq("organization_id", orgId).in("id", recipientIds), "recipient names");
    for (const row of rows) names.set(row.id, row.full_name || "ללא שם");
  }
  const result: Record<string, LineRecipient> = {};
  for (const line of punchLines) {
    const id = line.recipientId ?? null;
    result[line.id] = { punch: true, recipientId: id, recipientName: id ? (names.get(id) ?? "איש קשר") : null };
  }
  if (!editable) {
    return { lines: result, edit: null };
  }
  const options = must(await supabase.rpc("punch_card_recipient_options", { p_org: orgId, p_kind: kind, p_doc: docId }), "recipient options");
  const types = payer.contactId ? await listRelationTypes(orgId) : [];
  return {
    lines: result,
    edit: {
      options: options.map((o) => ({ id: o.contact_id, name: o.name, how: isRecipientHow(o.how) ? o.how : "relation" })),
      payerContactId: payer.contactId,
      payerCompanyId: payer.contactId ? null : payer.companyId,
      relationChoices: relationChoices(types),
    },
  };
}
