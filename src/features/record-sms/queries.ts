import "server-only";

import { isGender } from "@/features/gender/gender";
import { businessAddressLine } from "@/features/message-templates/envelope";
import type { MergeValues } from "@/features/message-templates/fields";
import { listMessageTemplates, type MessageTemplate } from "@/features/message-templates/queries";
import { canRecordPayments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { getDocumentDetails } from "@/features/tax/queries";
import { firstNameOf } from "@/features/whatsapp/templates";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { cardSmsTemplates, queuedSms, type QueuedSms, type RecordSmsKind } from "./logic";

export type RecordSmsSetup = {
  // the number the SMS goes to (the record's own; a deal's contact's), as typed, shown in the dialog
  phone: string;
  templates: MessageTemplate[];
  queued: (QueuedSms & { senderName: string | null })[];
  // the record's values for the preview (the user's and the business's are added by the page)
  values: MergeValues;
};

type Person = { phone: string | null; phoneE164: string | null; firstName: string | null; fullName: string | null; gender: string | null };

/** The person the SMS goes to, read with the user's session (null = not found, or a deal without a readable contact). */
async function recipient(orgId: string, kind: RecordSmsKind, recordId: string): Promise<Person | null> {
  const supabase = await createClient();
  if (kind === "lead") {
    const row = must(
      await supabase
        .from("leads")
        .select("phone, phone_e164, full_name, gender")
        .eq("organization_id", orgId)
        .eq("id", recordId)
        .is("deleted_at", null)
        .maybeSingle(),
      "record sms lead",
    );
    return row ? { phone: row.phone, phoneE164: row.phone_e164, firstName: null, fullName: row.full_name, gender: row.gender } : null;
  }
  let contactId: string | null = recordId;
  if (kind === "deal") {
    const deal = must(await supabase.from("deals").select("contact_id").eq("organization_id", orgId).eq("id", recordId).is("deleted_at", null).maybeSingle(),
      "record sms deal",
    );
    contactId = deal?.contact_id ?? null;
  }
  if (!contactId) return null;
  const row = must(
    await supabase
      .from("contacts")
      .select("phone, phone_e164, first_name, full_name, gender")
      .eq("organization_id", orgId)
      .eq("id", contactId)
      .is("deleted_at", null)
      .maybeSingle(),
    "record sms contact",
  );
  return row ? { phone: row.phone, phoneE164: row.phone_e164, firstName: row.first_name, fullName: row.full_name, gender: row.gender } : null;
}

/**
 * SMS-02: what the card's "שליחת SMS" needs, with the user's session: the number, the SMS templates a card may send
 * (collection only for a payment recorder with the plan keys) and the SMS sent from this card in the last 30 days. null when
 * the record has no phone to send to (the database sends to phone_e164 only), or the plan has no sms flag.
 */
export async function getRecordSmsSetup(orgId: string, kind: RecordSmsKind, recordId: string): Promise<RecordSmsSetup | null> {
  // review F1: no button without the plan's sms flag (the database refuses too, hint feature:sms)
  if (!(await orgHasFeature(orgId, "sms"))) return null;
  const person = await recipient(orgId, kind, recordId);
  if (!person || !person.phoneE164?.trim()) return null;
  const supabase = await createClient();
  const [templates, queue, details, org, context, granted, collectionKeys] = await Promise.all([
    listMessageTemplates(orgId),
    supabase.rpc("record_sms_queue", { p_org: orgId, p_kind: kind, p_record: recordId }),
    getDocumentDetails(orgId),
    supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle(),
    getOrgContext(orgId),
    getMyPermissions(orgId),
    Promise.all(["collection", "documents", "payments"].map((key) => orgHasFeature(orgId, key))).then((keys) => keys.every(Boolean)),
  ]);
  // the list is a nicety: a failed read shows the dialog without it
  const queued = queue.error ? [] : queuedSms(queue.data);
  const names = await getUserNames(queued.map((q) => q.senderId));
  const orgPhone = org.error ? null : (org.data?.phone ?? null);
  return {
    phone: person.phone?.trim() || person.phoneE164,
    templates: cardSmsTemplates(templates, collectionKeys && canRecordPayments(context.role, granted)),
    queued: queued.map((q) => ({ ...q, senderName: q.senderId ? (names.get(q.senderId) ?? null) : null })),
    values: {
      firstName: person.firstName?.trim() || firstNameOf(person.fullName),
      fullName: person.fullName,
      ...(isGender(person.gender) ? { gender: person.gender } : {}),
      businessPhone: details.phone?.trim() || orgPhone?.trim() || null,
      businessAddress: businessAddressLine(details),
    },
  };
}
