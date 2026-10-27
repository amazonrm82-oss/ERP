import "server-only";

import { TIME_ZONE } from "@/lib/app";
import { endOfToday, zoneDate, zonedIso } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";
import { relatedRecords, type RelatedRecord } from "@/features/tasks/queries";
import { listCalendarItems } from "@/features/calendar/queries";
import { rangeBounds } from "@/features/calendar/range";

import {
  dealsWithoutNextStep,
  myMeetings,
  TEAM_TASKS_SHOWN,
  withoutSupersededQuotes,
  type DealsWithoutNextStep,
  type MyMeeting,
  type WaitingQuoteRow,
} from "./my-day";
import { parseReportData } from "@/features/reports/schemas";

// related: the record the task belongs to, when it has one (FXU-01)
export type MyTask = {
  id: string;
  title: string;
  dueAt: string | null;
  isOverdue: boolean;
  related: RelatedRecord | null;
  // AIX-03: a call task is a promised call; its lead (whatever record `related` shows) is not listed as waiting
  taskType: string;
  leadId: string | null;
};
export type MyNewLead = {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  companyName: string | null;
  createdAt: string;
};

export type MyDay = {
  // YYYY-MM-DD in the organization's time zone
  today: string;
  tasks: MyTask[];
  newLeads: MyNewLead[];
  newLeadsCount: number;
  openDealsCount: number;
  openDealsTotalAgorot: number;
  // TASK-09: today's meetings the user organizes or takes part in (as the calendar's "mine")
  meetings: MyMeeting[];
  meetingsTruncated: boolean;
  // TASK-09: the user's open deals with no open task and no planned meeting ahead
  dealsWithoutNextStep: DealsWithoutNextStep;
  // TASK-09: the user's sent or viewed quotes still within their validity, oldest sent first
  waitingQuotes: WaitingQuoteRow[];
  waitingQuotesCount: number;
  // AIX-03: every waiting quote read (not only the card's few), with the customer's last view of the viewed ones
  waitingQuotesAll: Array<WaitingQuoteRow & { lastViewedAt: string | null }>;
};

const TASK_LIMIT = 50;
const NEW_LEADS_SHOWN = 8;
const DEALS_SUM_LIMIT = 1000;
const NO_NEXT_STEP_SHOWN = 8;
const WAITING_QUOTES_SHOWN = 8;
// read a few more than shown, so a quote replaced by a newer sent version can be left out
const WAITING_QUOTES_READ = 50;

/**
 * "My day": the signed-in user's due tasks, new leads, open deals, today's meetings and the
 * deals that have no next action, in one organization. Everything is read with the user's
 * session, so RLS decides what shows.
 */
export async function getMyDay(orgId: string, userId: string, timeZone?: string): Promise<MyDay> {
  const supabase = await createClient();
  const now = new Date();
  const today = zoneDate(now, timeZone);
  const startOfToday = zonedIso(today, "00:00:00", timeZone);

  const defaultStatus = must(await supabase
    .from("lead_statuses")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle(), "lead_statuses");

  const [tasks, leads, deals, calendar, stuck, quotes] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, due_at, task_type, lead_id, contact_id, company_id, deal_id")
      .eq("organization_id", orgId)
      .eq("owner_id", userId)
      .eq("status", "open")
      .is("deleted_at", null)
      .lte("due_at", endOfToday(now, timeZone))
      .order("due_at", { ascending: true })
      .limit(TASK_LIMIT),
    defaultStatus
      ? supabase
          .from("leads")
          .select("id, full_name, email, phone, phone_e164, company_name, created_at", { count: "exact" })
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
    // the calendar's own read: a meeting that overlaps today, organizer or participant, not cancelled
    listCalendarItems(orgId, rangeBounds([today], timeZone ?? TIME_ZONE), [userId]),
    // "no next action" as the board and the stuck-deals report decide it (security invoker)
    supabase.rpc("report_stuck_deals", { p_org: orgId, p_owner: userId }),
    // quotes the user owns that wait for the customer: sent or viewed, validity not passed in the business's day
    supabase
      .from("quotes")
      .select("id, title, number_display, status, sent_at, valid_until, customer_name, total_agorot", { count: "exact" })
      .eq("organization_id", orgId)
      .eq("owner_id", userId)
      .in("status", ["sent", "viewed"])
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .order("sent_at", { ascending: true })
      .order("id")
      .limit(WAITING_QUOTES_READ),
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

  // FXC-12: checked before it is read; a mismatch throws (the page's error screen)
  const stuckRows = parseReportData("report_stuck_deals", must(stuck, "stuck deals"));

  const quoteRows = must(quotes, "waiting quotes");
  // a quote whose newer version was sent waits no more (the customer's link shows the newer one)
  const newer = quoteRows.length
    ? must(
        await supabase
          .from("quotes")
          .select("previous_id")
          .eq("organization_id", orgId)
          .in("previous_id", quoteRows.map((q) => q.id))
          .neq("status", "draft"),
        "newer quote versions",
      )
    : [];
  const superseded = new Set(newer.map((row) => row.previous_id).filter((id): id is string => id !== null));
  const waiting = withoutSupersededQuotes(
    quoteRows.map((q) => ({
      id: q.id,
      title: q.title,
      numberDisplay: q.number_display,
      status: q.status === "viewed" ? ("viewed" as const) : ("sent" as const),
      sentAt: q.sent_at,
      validUntil: q.valid_until,
      customerName: q.customer_name,
      totalAgorot: Number(q.total_agorot),
    })),
    superseded,
  );
  // AIX-03: when the customer last opened each viewed quote (quote_views follows the quote's RLS)
  const viewedIds = waiting.filter((quote) => quote.status === "viewed").map((quote) => quote.id);
  const views = viewedIds.length
    ? must(
        await supabase.from("quote_views").select("quote_id, last_viewed_at").eq("organization_id", orgId).in("quote_id", viewedIds),
        "quote views",
      )
    : [];
  const lastViewed = new Map(views.map((row) => [row.quote_id, row.last_viewed_at]));

  const related = await relatedRecords(orgId, tasks.data);
  return {
    today,
    tasks: tasks.data.map((task) => ({
      id: task.id,
      title: task.title,
      dueAt: task.due_at,
      // compared as numbers: PostgREST writes "+00:00", toISOString() writes "Z"
      isOverdue: task.due_at !== null && Date.parse(task.due_at) < Date.parse(startOfToday),
      related: related(task),
      taskType: task.task_type,
      leadId: task.lead_id,
    })),
    newLeads: (leads.data ?? []).map((lead) => ({
      id: lead.id,
      fullName: lead.full_name,
      email: lead.email,
      phone: lead.phone,
      phoneE164: lead.phone_e164,
      companyName: lead.company_name,
      createdAt: lead.created_at,
    })),
    newLeadsCount: leads.count ?? leads.data?.length ?? 0,
    openDealsCount: deals.count ?? deals.data.length,
    // summed over at most DEALS_SUM_LIMIT deals, far above one person's open pipeline
    openDealsTotalAgorot: deals.data.reduce((sum, deal) => sum + deal.amount_agorot, 0),
    meetings: myMeetings(calendar.items, now),
    meetingsTruncated: calendar.truncated,
    dealsWithoutNextStep: dealsWithoutNextStep(stuckRows, NO_NEXT_STEP_SHOWN),
    waitingQuotes: waiting.slice(0, WAITING_QUOTES_SHOWN),
    waitingQuotesAll: waiting.map((quote) => ({ ...quote, lastViewedAt: lastViewed.get(quote.id) ?? null })),
    // the count is exact while the read held them all; beyond that it is the database's count less what was seen replaced
    waitingQuotesCount: Math.max(waiting.length, (quotes.count ?? quoteRows.length) - superseded.size),
  };
}

export type MyTeamTask = { id: string; title: string; dueAt: string | null; teamName: string; related: RelatedRecord | null };

/**
 * TASK-07 follow-up: open team tasks nobody took yet, of the user's own teams (the team rule, app.team_task_visible), due
 * first and undated last, at most TEAM_TASKS_SHOWN, with the count of them all. A viewer gets none; so does a person in no
 * team. Read with the user's session, so RLS decides what shows.
 */
export async function getMyTeamTasks(orgId: string, userId: string, role: string | null): Promise<{ tasks: MyTeamTask[]; count: number }> {
  if (role !== "owner" && role !== "admin" && role !== "manager" && role !== "member") return { tasks: [], count: 0 };
  const supabase = await createClient();
  const teamIds = must(
    await supabase.from("team_members").select("team_id").eq("organization_id", orgId).eq("user_id", userId),
    "team members",
  ).map((row) => row.team_id);
  if (teamIds.length === 0) return { tasks: [], count: 0 };
  const [tasks, teams] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, due_at, team_id, lead_id, contact_id, company_id, deal_id", { count: "exact" })
      .eq("organization_id", orgId)
      .eq("status", "open")
      .is("deleted_at", null)
      .is("owner_id", null)
      .in("team_id", teamIds)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .order("id")
      .limit(TEAM_TASKS_SHOWN),
    supabase.from("teams").select("id, name").eq("organization_id", orgId).in("id", teamIds),
  ]);
  const rows = must(tasks, "team tasks");
  const names = new Map(must(teams, "teams").map((team) => [team.id, team.name]));
  const related = await relatedRecords(orgId, rows);
  return {
    tasks: rows.map((row) => ({
      id: row.id,
      title: row.title,
      dueAt: row.due_at,
      teamName: (row.team_id && names.get(row.team_id)) || "הצוות",
      related: related(row),
    })),
    count: tasks.count ?? rows.length,
  };
}
