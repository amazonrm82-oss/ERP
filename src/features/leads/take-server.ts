import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getUserNames } from "@/features/shell/queries";
import type { Database } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { dbErrorMessage, GENERIC_ERROR } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

import { parseTakeOutcome, type TakeOutcome } from "./take";

export type TakeAnswer = { ok: true; outcome: TakeOutcome } | { ok: false; message: string };

/**
 * "לקחתי" with the user's own session (SPD-01). public.take_lead() decides who
 * may take the lead and makes the first one win; an expected refusal (someone
 * else has it, converted) comes back as an outcome, a permission error as a message.
 */
export async function takeLead(supabase: SupabaseClient<Database>, orgId: string, leadId: string): Promise<TakeAnswer> {
  const { data, error } = await supabase.rpc("take_lead", { p_org: orgId, p_lead: leadId });
  if (error) {
    return { ok: false, message: dbErrorMessage(error) };
  }
  const outcome = parseTakeOutcome(data);
  return outcome ? { ok: true, outcome } : { ok: false, message: GENERIC_ERROR };
}

export type RespondLead = {
  id: string;
  name: string;
  fullName: string | null;
  companyName: string | null;
  phone: string | null;
  phoneE164: string | null;
  message: string | null;
  sourceName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  takenAt: string | null;
  createdAt: string;
  converted: boolean;
};

/** The lead for the short screen a new-lead push opens, read with the user's session; null when gone or not visible. */
export async function getRespondLead(orgId: string, leadId: string): Promise<RespondLead | null> {
  const supabase = await createClient();
  const lead = must(
    await supabase
      .from("leads")
      .select("id, full_name, email, phone, phone_e164, company_name, message, source_id, owner_id, taken_at, created_at, converted_at")
      .eq("organization_id", orgId)
      .eq("id", leadId)
      .is("deleted_at", null)
      .maybeSingle(),
    "lead",
  );
  if (!lead) return null;
  const [source, owners] = await Promise.all([
    lead.source_id
      ? supabase.from("lead_sources").select("name").eq("organization_id", orgId).eq("id", lead.source_id).maybeSingle().then((r) => must(r, "lead source"))
      : Promise.resolve(null),
    getUserNames([lead.owner_id]),
  ]);
  return {
    id: lead.id,
    name: lead.full_name || lead.company_name || lead.phone || lead.email || "ליד ללא שם",
    fullName: lead.full_name,
    companyName: lead.full_name ? lead.company_name : null,
    phone: lead.phone,
    phoneE164: lead.phone_e164,
    message: lead.message,
    sourceName: source?.name ?? null,
    ownerId: lead.owner_id,
    ownerName: lead.owner_id ? (owners.get(lead.owner_id) ?? null) : null,
    takenAt: lead.taken_at,
    createdAt: lead.created_at,
    converted: lead.converted_at !== null,
  };
}
