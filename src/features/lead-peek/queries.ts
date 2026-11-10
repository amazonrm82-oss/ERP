import "server-only";

import { listActivityTypes } from "@/features/activity-types/queries";
import { getTimeline, type TimelineItem, type TimelineRow } from "@/features/activities/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { asCustomValues } from "@/features/custom-fields/types";
import { displayCustomFields } from "@/features/custom-fields/values";
import { leadDisplayName } from "@/features/leads/display";
import { getLead, getLeadLookups, getUnownedLead, getUnownedLeadTimeline, type LeadStatusOption } from "@/features/leads/queries";
import { CONTACT_TYPES } from "@/features/leads/waiting";
import { getRequestedProduct, requestedProductEnabled } from "@/features/requested-product/queries";
import { getUserNames } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { defaultAskedFields, PEEK_TIMELINE_MAX, type PeekAskedField } from "./model";

export type PeekLead = {
  id: string;
  name: string;
  fullName: string | null;
  gender: string | null;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  statusId: string;
  status: LeadStatusOption | null;
  statuses: LeadStatusOption[];
  ownerId: string | null;
  ownerName: string | null;
  sourceName: string | null;
  createdAt: string;
  converted: boolean;
  // SPD-01 (owner 187 ב, 213 ב): read only because it is offered to take (public.unowned_lead / unowned_lead_timeline)
  offeredOnly: boolean;
  // SPD-02: the waiting screen's rule holds (open, not converted, not imported, no answer by a person)
  waiting: boolean;
  asked: PeekAskedField[];
  timeline: TimelineItem[];
};

// the waiting screen's answer rule (src/features/leads/waiting.ts): a person's contact entry that is not private
const isAnswer = (row: Pick<TimelineRow, "type" | "created_by" | "is_private">) =>
  (CONTACT_TYPES as readonly string[]).includes(row.type) && row.created_by !== null && !row.is_private;

// the panel is "what happened lately": newest first, pinned or not
const latest = (items: TimelineItem[]) => [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, PEEK_TIMELINE_MAX);

/**
 * Everything the side panel shows (UX-01), read with the user's session through the lead page's own queries. A lead the
 * person does not read under the business's visibility but is offered to take (SPD-01) is read through the same narrow
 * functions as the take-only page (owner's answer 213 ב). Null when the lead is gone or not offered.
 */
export async function getPeekLead(orgId: string, leadId: string): Promise<PeekLead | null> {
  const [lead, lookups, terms, types] = await Promise.all([getLead(orgId, leadId), getLeadLookups(orgId), getOrgTerms(orgId), listActivityTypes(orgId)]);
  const sourceName = (id: string | null) => (id ? (lookups.sources.find((source) => source.id === id)?.name ?? null) : null);
  const statusOf = (id: string) => lookups.statuses.find((option) => option.id === id) ?? null;

  if (!lead) {
    const offered = await getUnownedLead(orgId, leadId);
    if (!offered) return null;
    const read = await getUnownedLeadTimeline(orgId, leadId);
    const rows = read?.activities ?? [];
    const items = rows.length > 0 ? await getTimeline(orgId, { kind: "lead", id: leadId }, undefined, types, terms, rows) : [];
    const status = statusOf(offered.status_id);
    return {
      id: offered.id,
      name: leadDisplayName({ fullName: offered.full_name, email: offered.email, phone: offered.phone }),
      fullName: offered.full_name,
      gender: offered.gender,
      phone: offered.phone,
      phoneE164: offered.phone_e164,
      email: offered.email,
      statusId: offered.status_id,
      status,
      statuses: lookups.statuses,
      ownerId: null,
      ownerName: null,
      sourceName: sourceName(offered.source_id),
      createdAt: offered.created_at,
      converted: false,
      offeredOnly: true,
      // public.unowned_lead_timeline leaves out private notes and imported leads are never offered, as in the rule
      waiting: status?.kind === "open" && !rows.some(isAnswer),
      // the narrow function answers the message only (no product or custom fields before taking)
      asked: defaultAskedFields({ requestedProduct: null, custom: [], message: offered.message }),
      timeline: latest(items),
    };
  }

  const supabase = await createClient();
  const [owners, productsOn, fields, extra, answered, timeline] = await Promise.all([
    getUserNames([lead.owner_id]),
    requestedProductEnabled(orgId),
    listFieldDefinitions(orgId, "lead"),
    supabase.from("leads").select("import_job_id").eq("organization_id", orgId).eq("id", leadId).maybeSingle(),
    supabase
      .from("activities")
      .select("id")
      .eq("organization_id", orgId)
      .eq("lead_id", leadId)
      .in("type", [...CONTACT_TYPES])
      .not("created_by", "is", null)
      .eq("is_private", false)
      .limit(1),
    getTimeline(orgId, { kind: "lead", id: leadId }, undefined, types, terms),
  ]);
  const importJobId = must(extra, "lead import tag")?.import_job_id ?? null;
  const hasAnswer = must(answered, "lead answers").length > 0;
  const product = productsOn ? await getRequestedProduct(orgId, lead.requested_product_id) : null;
  const status = statusOf(lead.status_id);
  const custom = displayCustomFields(
    // a checkbox always has a value ("לא"), and files, links and rich text belong on the full page
    fields.filter((field) => field.isActive && !["checkbox", "file", "record_link", "rich_text"].includes(field.type)),
    asCustomValues(lead.custom_fields),
  );

  return {
    id: lead.id,
    name: leadDisplayName({ fullName: lead.full_name, email: lead.email, phone: lead.phone }),
    fullName: lead.full_name,
    gender: lead.gender,
    phone: lead.phone,
    phoneE164: lead.phone_e164,
    email: lead.email,
    statusId: lead.status_id,
    status,
    statuses: lookups.statuses,
    ownerId: lead.owner_id,
    ownerName: lead.owner_id ? (owners.get(lead.owner_id) ?? null) : null,
    sourceName: sourceName(lead.source_id),
    createdAt: lead.created_at,
    converted: lead.converted_at !== null,
    offeredOnly: false,
    waiting: status?.kind === "open" && lead.converted_at === null && importJobId === null && !hasAnswer,
    asked: defaultAskedFields({ requestedProduct: product?.name ?? null, custom, message: lead.message }),
    timeline: latest(timeline),
  };
}
