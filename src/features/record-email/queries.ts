import "server-only";

import { isGender } from "@/features/gender/gender";
import { businessAddressLine } from "@/features/message-templates/envelope";
import type { MergeValues } from "@/features/message-templates/fields";
import { getLibrary } from "@/features/library/queries";
import { isLibraryItemOfferable } from "@/features/library/validity";
import { listMessageTemplates, type MessageTemplate } from "@/features/message-templates/queries";
import { canRecordPayments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { getOrgContext, getUserNames } from "@/features/shell/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getDocumentDetails } from "@/features/tax/queries";
import { firstNameOf } from "@/features/whatsapp/templates";
import { must } from "@/lib/db-read";
import { zoneDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import { cardEmailTemplates, queuedEmails, type PickableFile, type QueuedEmail, type RecordEmailKind } from "./logic";

export type RecordEmailSetup = {
  // the address the email goes to (the record's own; a deal's contact's), shown in the dialog
  address: string;
  templates: MessageTemplate[];
  files: PickableFile[];
  // LIB-01 (owner (197) ב): active file items valid today with a current file; the id is the item's
  library: PickableFile[];
  queued: (QueuedEmail & { senderName: string | null })[];
  // the record's values for the preview (the user's and the business's are added by the page)
  values: MergeValues;
};

const FILE_COLUMN = { lead: "lead_id", contact: "contact_id", deal: "deal_id" } as const;

type Person = { email: string | null; firstName: string | null; fullName: string | null; gender: string | null };

/** The person the email goes to, read with the user's session (null = not found, or a deal without a readable contact). */
async function recipient(orgId: string, kind: RecordEmailKind, recordId: string): Promise<Person | null> {
  const supabase = await createClient();
  if (kind === "lead") {
    const row = must(
      await supabase
        .from("leads")
        .select("email, full_name, gender")
        .eq("organization_id", orgId)
        .eq("id", recordId)
        .is("deleted_at", null)
        .maybeSingle(),
      "record email lead",
    );
    return row ? { email: row.email, firstName: null, fullName: row.full_name, gender: row.gender } : null;
  }
  let contactId: string | null = recordId;
  if (kind === "deal") {
    const deal = must(await supabase.from("deals").select("contact_id").eq("organization_id", orgId).eq("id", recordId).is("deleted_at", null).maybeSingle(),
      "record email deal",
    );
    contactId = deal?.contact_id ?? null;
  }
  if (!contactId) return null;
  const row = must(
    await supabase
      .from("contacts")
      .select("email, first_name, full_name, gender")
      .eq("organization_id", orgId)
      .eq("id", contactId)
      .is("deleted_at", null)
      .maybeSingle(),
    "record email contact",
  );
  return row ? { email: row.email, firstName: row.first_name, fullName: row.full_name, gender: row.gender } : null;
}

/**
 * EML-02: what the card's "שליחת אימייל" needs, with the user's session: the address, the email templates a card may
 * send (collection only for a payment recorder), the record's confirmed files (RLS: a private note's file stays its
 * author's and the admins'), the content library's sendable files and the emails sent from this card in the last 30 days.
 * null when the record has no address to send to.
 */
export async function getRecordEmailSetup(orgId: string, kind: RecordEmailKind, recordId: string): Promise<RecordEmailSetup | null> {
  const person = await recipient(orgId, kind, recordId);
  const address = person?.email?.trim();
  if (!person || !address) return null;
  const supabase = await createClient();
  const [templates, files, queue, details, org, library, context, granted, collectionKeys] = await Promise.all([
    listMessageTemplates(orgId),
    supabase
      .from("files")
      .select("id, name, size_bytes")
      .eq("organization_id", orgId)
      .eq(FILE_COLUMN[kind], recordId)
      .is("unconfirmed_since", null)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.rpc("record_email_queue", { p_org: orgId, p_kind: kind, p_record: recordId }),
    getDocumentDetails(orgId),
    supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle(),
    getLibrary(orgId),
    getOrgContext(orgId),
    getMyPermissions(orgId),
    // a collection email needs the plan keys of every collection feature (the database asks them again)
    Promise.all(["collection", "documents", "payments"].map((key) => orgHasFeature(orgId, key))).then((keys) => keys.every(Boolean)),
  ]);
  const today = zoneDate(new Date(), context.org.timeZone);
  const fileRows = must(files, "record email files") ?? [];
  // the list is a nicety: a failed read shows the dialog without it
  const queued = queue.error ? [] : queuedEmails(queue.data);
  const names = await getUserNames(queued.map((q) => q.senderId));
  const orgPhone = org.error ? null : (org.data?.phone ?? null);
  return {
    address,
    templates: cardEmailTemplates(templates, collectionKeys && canRecordPayments(context.role, granted)),
    files: fileRows.map((f) => ({ id: f.id, name: f.name, sizeBytes: f.size_bytes })),
    library: library.items.flatMap((item) =>
      item.kind === "file" && item.file && isLibraryItemOfferable(item, today) ? [{ id: item.id, name: item.title, sizeBytes: item.file.sizeBytes }] : [],
    ),
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
