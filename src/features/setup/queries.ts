import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { buildChecklist, type ChecklistFacts, type ChecklistItem } from "./checklist";
import { isSetupStep, type SetupStep } from "./steps";

/** The next step of the organization's setup wizard, or null when it is finished (or the row is not visible). */
export async function getSetupStep(orgId: string): Promise<SetupStep | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("organizations").select("setup_step").eq("id", orgId).maybeSingle(),
    "organizations.setup_step",
  );
  const step = row?.setup_step ?? null;
  return isSetupStep(step) ? step : null;
}

export type SampleRecord = { record_type: string; record_id: string; removable: boolean };

/** The records that are sample data (USR-04), owners and admins only (the function refuses anyone else). */
export async function getSampleRecords(orgId: string): Promise<SampleRecord[]> {
  const supabase = await createClient();
  return must(await supabase.rpc("sample_data_records", { p_org: orgId }), "sample_data_records") ?? [];
}

/** A PostgREST "not in" list of ids; ids are uuids from the database. */
function notIn(ids: string[]): string {
  return `(${ids.join(",")})`;
}

export type SetupChecklist = { items: ChecklistItem[]; hidden: boolean; sample: SampleRecord[] };

/**
 * The setup checklist of an owner or admin (USR-04), worked out from the
 * business's data with the user's session; null when the business row is not visible.
 */
export async function getSetupChecklist(orgId: string, userId: string): Promise<SetupChecklist | null> {
  const supabase = await createClient();
  const [org, sample] = await Promise.all([
    supabase.from("organizations").select("phone, industry, setup_checklist_hidden_at").eq("id", orgId).maybeSingle(),
    getSampleRecords(orgId),
  ]);
  const row = must(org, "organizations.checklist");
  if (!row) {
    return null;
  }
  // a sample record that someone changed is in use, so it counts like a real one
  const sampleIds = (type: string) => sample.filter((r) => r.removable && r.record_type === type).map((r) => r.record_id);

  let leads = supabase.from("leads").select("id").eq("organization_id", orgId).is("deleted_at", null);
  if (sampleIds("lead").length > 0) {
    leads = leads.not("id", "in", notIn(sampleIds("lead")));
  }
  let deals = supabase.from("deals").select("id").eq("organization_id", orgId).is("deleted_at", null);
  if (sampleIds("deal").length > 0) {
    deals = deals.not("id", "in", notIn(sampleIds("deal")));
  }
  const [lead, deal, form, members, invitation, importJob, push] = await Promise.all([
    leads.limit(1),
    deals.limit(1),
    supabase.from("forms").select("id").eq("organization_id", orgId).neq("kind", "card").eq("is_active", true).limit(1),
    supabase.from("memberships").select("user_id").eq("organization_id", orgId).neq("user_id", userId).limit(1),
    supabase.from("invitations").select("id").eq("organization_id", orgId).is("revoked_at", null).limit(1),
    supabase.from("import_jobs").select("id").eq("organization_id", orgId).eq("status", "done").limit(1),
    supabase.from("push_subscriptions").select("id").eq("user_id", userId).limit(1),
  ]);

  const facts: ChecklistFacts = {
    detailsFilled: Boolean(row.phone && row.industry),
    realLead: must(lead, "leads.checklist").length > 0,
    activeForm: must(form, "forms.checklist").length > 0,
    realDeal: must(deal, "deals.checklist").length > 0,
    teamInvited: must(members, "memberships.checklist").length > 0 || must(invitation, "invitations.checklist").length > 0,
    importDone: must(importJob, "import_jobs.checklist").length > 0,
    pushOn: must(push, "push_subscriptions.checklist").length > 0,
  };
  return { items: buildChecklist(orgId, facts), hidden: row.setup_checklist_hidden_at !== null, sample };
}
