import "server-only";

import { managesTeamChain } from "@/features/activities/schema";
import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { readAllPages } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { takenLeadsFilter, type WaitingViewer } from "./take";

// "Contact with the customer", as in the reports (DECISIONS.md; app.contact_types()):
// an activity a person logged of one of these types. Keep the two in step.
export const CONTACT_TYPES = ["note", "call", "meeting", "email", "whatsapp", "sms"] as const;

export type WaitingLead = {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  phoneE164: string | null;
  sourceName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  // SPD-01: when someone pressed "לקחתי" (the clock still runs from createdAt)
  takenAt: string | null;
  createdAt: string;
};

const BATCH = 200;
const MAX_SCANNED = 2000;
const MAX_SHOWN = 200;

/**
 * Leads that no one has answered yet (SPD-02), oldest first: open status, not
 * converted, not imported, and no contact activity logged by a person that is not
 * a private note (the rule of report_money_waiting, MNY-01). Read
 * with the user's session, so each person sees the leads they may see.
 * `ownerId` narrows to one person's leads. `viewer` (SPD-01) leaves out leads
 * someone else already took ("לקחתי"), except for owners, admins and the
 * managers of the lead's team (takenLeadsFilter).
 */
export async function getWaitingLeads(
  orgId: string,
  ownerId: string | null,
  viewer?: { id: string; role: WaitingViewer["role"] },
): Promise<{ leads: WaitingLead[]; truncated: boolean }> {
  const supabase = await createClient();
  const takenFilter = viewer
    ? takenLeadsFilter({ ...viewer, overseenTeamIds: viewer.role === "manager" ? await overseenTeams(orgId, viewer.id) : [] })
    : null;
  const [statuses, sources] = await Promise.all([
    must(await supabase.from("lead_statuses").select("id").eq("organization_id", orgId).eq("kind", "open"), "lead statuses"),
    must(await supabase.from("lead_sources").select("id, name").eq("organization_id", orgId), "lead sources"),
  ]);
  const openStatusIds = (statuses ?? []).map((s) => s.id);
  if (openStatusIds.length === 0) return { leads: [], truncated: false };

  type Row = { id: string; full_name: string | null; email: string | null; phone: string | null; phone_e164: string | null; company_name: string | null; source_id: string | null; owner_id: string | null; taken_at: string | null; created_at: string };
  const waiting: Row[] = [];
  let scanned = 0;
  let exhausted = false;
  while (waiting.length < MAX_SHOWN && scanned < MAX_SCANNED) {
    let query = supabase
      .from("leads")
      .select("id, full_name, email, phone, phone_e164, company_name, source_id, owner_id, taken_at, created_at")
      .eq("organization_id", orgId)
      .in("status_id", openStatusIds)
      .is("converted_at", null)
      .is("import_job_id", null)
      .is("deleted_at", null);
    if (ownerId) query = query.eq("owner_id", ownerId);
    if (takenFilter) query = query.or(takenFilter);
    const batch = must(await query.order("created_at", { ascending: true }).order("id", { ascending: true }).range(scanned, scanned + BATCH - 1), "waiting leads") ?? [];
    scanned += batch.length;
    if (batch.length > 0) {
      // a lead can have many activities: page through them, or past 1,000 rows answered leads would show as waiting (RVW-2)
      const { rows: answered } = await readAllPages(
        async (from, to) =>
          must(
            await supabase
              .from("activities")
              .select("lead_id")
              .eq("organization_id", orgId)
              .in("lead_id", batch.map((row) => row.id))
              .in("type", [...CONTACT_TYPES])
              .not("created_by", "is", null)
              // a private note is not an answer: otherwise a lead would be waiting for some people and not others
              .eq("is_private", false)
              .order("id", { ascending: true })
              .range(from, to),
            "lead activities",
          ) ?? [],
      );
      const answeredIds = new Set(answered.map((row) => row.lead_id));
      waiting.push(...batch.filter((row) => !answeredIds.has(row.id)));
    }
    if (batch.length < BATCH) {
      exhausted = true;
      break;
    }
  }

  const shown = waiting.slice(0, MAX_SHOWN);
  const owners = await getUserNames(shown.map((row) => row.owner_id));
  const sourceName = new Map((sources ?? []).map((s) => [s.id, s.name]));
  return {
    leads: shown.map((row) => ({
      id: row.id,
      name: row.full_name || row.company_name || row.phone || row.email || "ליד ללא שם",
      companyName: row.full_name ? row.company_name : null,
      phone: row.phone,
      phoneE164: row.phone_e164,
      sourceName: row.source_id ? (sourceName.get(row.source_id) ?? null) : null,
      ownerId: row.owner_id,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      takenAt: row.taken_at,
      createdAt: row.created_at,
    })),
    truncated: !exhausted || waiting.length > MAX_SHOWN,
  };
}

/**
 * The teams a manager oversees: every team they manage and every team under it
 * (the rule of app.manages_team(): a manager of the team or of a parent team).
 */
async function overseenTeams(orgId: string, userId: string): Promise<string[]> {
  const supabase = await createClient();
  const [teams, managed] = await Promise.all([
    supabase.from("teams").select("id, parent_team_id").eq("organization_id", orgId),
    supabase.from("team_members").select("team_id").eq("organization_id", orgId).eq("user_id", userId).eq("is_manager", true),
  ]);
  const managedIds = new Set(must(managed, "managed teams").map((row) => row.team_id));
  if (managedIds.size === 0) return [];
  const chain = must(teams, "teams").map((team) => ({ id: team.id, parentTeamId: team.parent_team_id }));
  return chain.filter((team) => managesTeamChain(team.id, chain, managedIds)).map((team) => team.id);
}
