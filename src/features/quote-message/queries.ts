import "server-only";

import { isGender } from "@/features/gender/gender";
import { businessAddressLine } from "@/features/message-templates/envelope";
import type { MergeValues } from "@/features/message-templates/fields";
import { listMessageTemplates } from "@/features/message-templates/queries";
import type { Quote } from "@/features/quotes/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getUserNames } from "@/features/shell/queries";
import { getDocumentDetails } from "@/features/tax/queries";
import { firstNameOf } from "@/features/whatsapp/templates";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { quoteDocumentName, quoteMessageTemplates, queuedQuoteMessages, type QueuedQuoteMessage, type QuoteMessageChannel } from "./logic";

export type QuoteMessageOption = {
  channel: QuoteMessageChannel;
  // where it goes, as typed on the contact
  address: string;
  templates: { id: string; name: string; subject: string | null; body: string; messageType: string }[];
};

export type QuoteMessageSetup = {
  options: QuoteMessageOption[];
  queued: (QueuedQuoteMessage & { senderName: string | null })[];
  values: MergeValues;
};

/**
 * QUO-18: what the quote screen's "שליחה ללקוח" needs, with the user's session: the quote's customer (the contact it names), the channels that have an address (SMS only with the plan's sms key), the requested_document templates of
 * each, and the quote's messages of the last 30 days. null when there is no customer to send to.
 */
export async function getQuoteMessageSetup(orgId: string, quote: Quote, hasValidity: boolean): Promise<QuoteMessageSetup | null> {
  const supabase = await createClient();
  // review F3: the contact the quote names (= app.quote_message_customer), never a deal's current contact
  const contactId = quote.contactId;
  if (!contactId) return null;
  const contact = must(
    await supabase
      .from("contacts")
      .select("first_name, full_name, gender, email, phone, phone_e164")
      .eq("organization_id", orgId)
      .eq("id", contactId)
      .is("deleted_at", null)
      .maybeSingle(),
    "quote message contact",
  );
  if (!contact) return null;
  const [templates, sms, queue, details, org] = await Promise.all([
    listMessageTemplates(orgId),
    orgHasFeature(orgId, "sms"),
    supabase.rpc("quote_message_queue", { p_org: orgId, p_quote: quote.id }),
    getDocumentDetails(orgId),
    supabase.from("organizations").select("phone").eq("id", orgId).maybeSingle(),
  ]);
  const pick = (channel: QuoteMessageChannel) =>
    quoteMessageTemplates(templates, channel, hasValidity).map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body, messageType: t.messageType }));
  const options: QuoteMessageOption[] = [];
  const email = contact.email?.trim();
  if (email && /^[^@\s]+@[^@\s]+$/.test(email)) options.push({ channel: "email", address: email, templates: pick("email") });
  if (sms && contact.phone_e164?.trim()) options.push({ channel: "sms", address: contact.phone?.trim() || contact.phone_e164, templates: pick("sms") });
  // the list is a nicety: a failed read shows the dialog without it
  const queued = queue.error ? [] : queuedQuoteMessages(queue.data);
  const names = await getUserNames(queued.map((q) => q.senderId));
  const orgPhone = org.error ? null : (org.data?.phone ?? null);
  return {
    options,
    queued: queued.map((q) => ({ ...q, senderName: q.senderId ? (names.get(q.senderId) ?? null) : null })),
    values: {
      firstName: contact.first_name?.trim() || firstNameOf(contact.full_name),
      fullName: contact.full_name,
      ...(isGender(contact.gender) ? { gender: contact.gender } : {}),
      businessPhone: details.phone?.trim() || orgPhone?.trim() || null,
      businessAddress: businessAddressLine(details),
      document: quoteDocumentName(quote.numberDisplay),
    },
  };
}
