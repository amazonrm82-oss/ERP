import "server-only";

import { endOfToday, zoneDate, zonedIso } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

export type MyTask = { id: string; title: string; dueAt: string | null; isOverdue: boolean };
export type MyNewLead = { id: string; fullName: string | null; email: string | null; phone: string | null; companyName: string | null; createdAt: string };

export type MyDay = {
  // YYYY-MM-DD in the organization's time zone
  today: string;
  tasks: MyTask[];
  newLeads: MyNewLead[];
  newLeadsCount: number;
  openDealsCount: number;
  openDealsTotalAgorot: number;
};

const TASK_LIMIT = 50;
const NEW_LEADS_SHOWN = 8;
const DEALS_SUM_LIMIT = 1000;

/** "My day": the signed-in user's due tasks, new leads and open deals in one organization. */
export async function getMyDay(orgId: string, userId: string): Promise<MyDay> {
  const supabase = await createClient();
  const now = new Date();
  const today = zoneDate(now);
  const startOfToday = zonedIso(today, "00:00:00");

  const defaultStatus = must(await supabase
    .from("lead_statuses")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle(), "lead_statuses");

  const [tasks, leads, deals] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, due_at")
      .eq("organization_id", orgId)
      .eq("owner_id", userId)
      .eq("status", "open")
      .is("deleted_at", null)
      .lte("due_at", endOfToday(now))
      .order("due_at", { ascending: true })
      .limit(TASK_LIMIT),
    defaultStatus
      ? supabase
          .from("leads")
          .select("id, full_name, email, phone, company_name, created_at", { count: "exact" })
          .eq("organization_id", orgId)
          .eq("owner_id", userId)
          .eq("status_id", defaultStatus.id)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(NEW_LEADS_SHOWN)
      : Promise.resolve({ data: [], count: 0, error: null }),
    supabase
      .from("deals")
      .select("amount_agorot", { count: "exact" })
      .eq("organization_id", orgId)
      .eq("owner_id", userId)
      .eq("status", "open")
      .is("deleted_at", null)
      .limit(DEALS_SUM_LIMIT),
  ]);

  if (tasks.error) {
    throw new Error(`my tasks query failed: ${tasks.error.message}`);
  }
  if (leads.error) {
    throw new Error(`my new leads query failed: ${leads.error.message}`);
  }
  if (deals.error) {
    throw new Error(`my deals query failed: ${deals.error.message}`);
  }

  return {
    today,
    tasks: tasks.data.map((task) => ({
      id: task.id,
      title: task.title,
      dueAt: task.due_at,
      // compared as numbers: PostgREST writes "+00:00", toISOString() writes "Z"
      isOverdue: task.due_at !== null && Date.parse(task.due_at) < Date.parse(startOfToday),
    })),
    newLeads: (leads.data ?? []).map((lead) => ({
      id: lead.id,
      fullName: lead.full_name,
      email: lead.email,
      phone: lead.phone,
      companyName: lead.company_name,
      createdAt: lead.created_at,
    })),
    newLeadsCount: leads.count ?? leads.data?.length ?? 0,
    openDealsCount: deals.count ?? deals.data.length,
    // summed over at most DEALS_SUM_LIMIT deals, far above one person's open pipeline
    openDealsTotalAgorot: deals.data.reduce((sum, deal) => sum + deal.amount_agorot, 0),
  };
}
