// AIX-03 "מה הלאה" (wave 2: fixed rules, no AI): a layer of order and reasons over what "My day" (TASK-09) already reads.
// Not another list: at most NEXT_ACTIONS_SHOWN actions, each with a short reason and a link to its record.
//
// Pure: no database and no clock of its own, so the order is unit tested (tests/unit/my-day-next-actions.test.ts).
//
// The order is fixed (RANK below), and inside one rank a fixed tie-break, then the id, so the same data always gives
// the same list:
//   1. meeting_soon   a planned meeting under way, or starting within MEETING_SOON_MINUTES   start, earliest first
//   2. call_due       an open call task (task_type 'call', e.g. SPD-05's call-back) due by now due, oldest first
//   3. lead_waiting   the person's own lead nobody answered yet (SPD-02's rule)              arrival, oldest first
//   4. quote_viewed   a quote the customer opened and did not decide                        last view, latest first
//   5. task_due       another open task, overdue or due earlier today                        due, oldest first
//   6. call_today     a call task due later today                                           due, earliest first
//   7. quote_ending   a sent quote not opened yet whose validity ends today or tomorrow      end day, then sent
//   8. task_today     another task due later today                                          due, earliest first
//   9. deal_idle      the person's open deal with no next step (report_stuck_deals)         the report's order
// A lead that has a call task due today is not listed as waiting: the call is its next step.

import { DEFAULT_TERMS, withPrefixThe, type OrgTerms } from "@/features/terminology/terms";
import { calendarPath } from "@/features/calendar/range";
import { quotePath } from "@/features/quotes/paths";
import { formatNumber, zoneDate, zoneTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { recordPage, recordTypeNames, type RecordType } from "@/lib/record-types";

import { idleText, type DealWithoutNextStep, type MyMeeting, type WaitingQuoteRow } from "./my-day";

export const NEXT_ACTIONS_SHOWN = 10;
export const MEETING_SOON_MINUTES = 60;

export type NextActionKind =
  | "meeting_soon"
  | "call_due"
  | "lead_waiting"
  | "quote_viewed"
  | "task_due"
  | "call_today"
  | "quote_ending"
  | "task_today"
  | "deal_idle";

const RANK: Record<NextActionKind, number> = {
  meeting_soon: 1,
  call_due: 2,
  lead_waiting: 3,
  quote_viewed: 4,
  task_due: 5,
  call_today: 6,
  quote_ending: 7,
  task_today: 8,
  deal_idle: 9,
};

export type NextAction = {
  /** unique in the list: "<kind>:<id>" */
  key: string;
  kind: NextActionKind;
  /** what to act on: the task's title, the lead's name, the quote's number and title */
  title: string;
  /** why it is here, in a few words */
  reason: string;
  /** the record it belongs to, as "ליד: דנה כהן" (null when the title says it) */
  context: string | null;
  href: string;
  /** late or under way: shown in the danger tone */
  urgent: boolean;
};

export type NextActionTask = {
  id: string;
  title: string;
  dueAt: string | null;
  taskType: string;
  /** the lead the task is linked to, whatever record it shows (a call task covers its waiting lead) */
  leadId: string | null;
  related: { kind: RecordType; id: string; name: string | null } | null;
};

export type NextActionLead = { id: string; name: string; createdAt: string };

export type NextActionQuote = Pick<WaitingQuoteRow, "id" | "title" | "numberDisplay" | "status" | "sentAt" | "validUntil" | "customerName"> & {
  /** quote_views.last_viewed_at; null when unknown */
  lastViewedAt: string | null;
};

export type NextActionInput = {
  orgId: string;
  now: Date;
  /** YYYY-MM-DD in the business's zone */
  today: string;
  timeZone: string;
  terms?: OrgTerms;
  tasks: NextActionTask[];
  waitingLeads: NextActionLead[];
  meetings: MyMeeting[];
  quotes: NextActionQuote[];
  dealsWithoutNextStep: DealWithoutNextStep[];
};

export type NextActions = { actions: NextAction[]; total: number };

type Ranked = { action: NextAction; sort: number };

function ms(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Whole days between two calendar dates (YYYY-MM-DD), later minus earlier; never below 0. */
function daysBetween(earlier: string, later: string): number {
  const diff = Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`);
  return Number.isFinite(diff) ? Math.max(0, Math.round(diff / 86_400_000)) : 0;
}

/** "12.10": a day in the business's zone. */
function shortDay(at: Date, timeZone: string): string {
  const day = zoneDate(at, timeZone);
  return `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}`;
}

/** "כבר 5 דקות" / "כבר שעתיים" / "כבר 3 ימים": how long something has waited. */
export function waitedText(fromIso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - ms(fromIso)) / 60_000)) || 0;
  if (minutes < 60) return minutes <= 1 ? "כבר דקה" : `כבר ${formatNumber(minutes)} דקות`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "כבר שעה" : hours === 2 ? "כבר שעתיים" : `כבר ${formatNumber(hours)} שעות`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "כבר יום" : days === 2 ? "כבר יומיים" : `כבר ${formatNumber(days)} ימים`;
}

/** "בעוד 25 דקות" / "בעוד דקה" / "בעוד שעה", rounded up. */
export function startsInText(startsAt: string, now: Date): string {
  const minutes = Math.max(1, Math.ceil((ms(startsAt) - now.getTime()) / 60_000));
  if (minutes >= 60) return "בעוד שעה";
  return minutes === 1 ? "בעוד דקה" : `בעוד ${formatNumber(minutes)} דקות`;
}

/** "היום" / "אתמול" / "לפני 4 ימים", in the business's days. */
function dayAgoText(iso: string, today: string, timeZone: string): string {
  const days = daysBetween(zoneDate(new Date(iso), timeZone), today);
  return days === 0 ? "היום" : days === 1 ? "אתמול" : `לפני ${formatNumber(days)} ימים`;
}

function relatedContext(related: NextActionTask["related"], terms: OrgTerms): string | null {
  if (!related) return null;
  return `${recordTypeNames(related.kind, terms).singular}: ${related.name ?? "ללא שם"}`;
}

/**
 * The next actions of one person, in the fixed order above, at most NEXT_ACTIONS_SHOWN; `total` counts them all.
 * Every input is what My day read with the person's session, so RLS already decided what may show.
 */
export function nextActions(input: NextActionInput): NextActions {
  const { orgId, now, today, timeZone } = input;
  const terms = input.terms ?? DEFAULT_TERMS;
  const at = now.getTime();
  const ranked: Ranked[] = [];
  const push = (action: NextAction, sort: number) => {
    ranked.push({ action, sort: Number.isFinite(sort) ? sort : 0 });
  };

  // 1. meetings under way or about to start (the meetings card lists the whole day)
  for (const meeting of input.meetings) {
    if (meeting.status !== "planned" || meeting.phase === "over") continue;
    const startsAt = ms(meeting.startsAt);
    const underWay = meeting.phase === "now";
    if (!underWay && !(startsAt - at <= MEETING_SOON_MINUTES * 60_000)) continue;
    push(
      {
        key: `meeting_soon:${meeting.id}`,
        kind: "meeting_soon",
        title: meeting.title,
        reason: underWay ? "פגישה שמתקיימת עכשיו" : `פגישה שמתחילה ${startsInText(meeting.startsAt, now)}`,
        context: null,
        href: meeting.related ? recordPage(meeting.related.type, orgId, meeting.related.id) : calendarPath(orgId, { view: "day" }),
        urgent: underWay,
      },
      startsAt,
    );
  }

  // 2, 5, 6, 8: tasks due by the end of today
  const leadsWithCall = new Set<string>();
  for (const task of input.tasks) {
    const due = ms(task.dueAt);
    if (!Number.isFinite(due) || !task.dueAt) continue;
    const dueDay = zoneDate(new Date(due), timeZone);
    if (dueDay > today) continue;
    const isCall = task.taskType === "call";
    if (isCall && task.leadId) leadsWithCall.add(task.leadId);
    const passed = due <= at;
    const time = zoneTime(new Date(due), timeZone);
    const noun = isCall ? "שיחה שהובטחה" : "משימה";
    const reason =
      dueDay < today
        ? `${noun}, באיחור מ-${shortDay(new Date(due), timeZone)}`
        : passed
          ? `${noun} ל-${time}, השעה עברה`
          : `${noun} להיום ב-${time}`;
    const kind: NextActionKind = passed ? (isCall ? "call_due" : "task_due") : isCall ? "call_today" : "task_today";
    push(
      {
        key: `${kind}:${task.id}`,
        kind,
        title: task.title,
        reason,
        context: relatedContext(task.related, terms),
        href: task.related ? recordPage(task.related.kind, orgId, task.related.id) : paths.tasks(orgId),
        urgent: passed,
      },
      due,
    );
  }

  // 3. the person's leads nobody answered yet, oldest first; a call due today is that lead's next step
  for (const lead of input.waitingLeads) {
    if (leadsWithCall.has(lead.id)) continue;
    push(
      {
        key: `lead_waiting:${lead.id}`,
        kind: "lead_waiting",
        title: lead.name,
        reason: `${terms.lead.singular} שמחכה למענה ${waitedText(lead.createdAt, now)}`,
        context: null,
        href: paths.lead(orgId, lead.id),
        urgent: true,
      },
      ms(lead.createdAt),
    );
  }

  // 4 and 7: quotes waiting for the customer's answer
  for (const quote of input.quotes) {
    const title = quote.numberDisplay ? `${quote.numberDisplay} ${quote.title}` : quote.title;
    const context = quote.customerName ? quote.customerName : null;
    if (quote.status === "viewed") {
      push(
        {
          key: `quote_viewed:${quote.id}`,
          kind: "quote_viewed",
          title,
          reason: quote.lastViewedAt
            ? `הצעה שנצפתה ${dayAgoText(quote.lastViewedAt, today, timeZone)} ועוד לא נענתה`
            : "הצעה שנצפתה ועוד לא נענתה",
          context,
          href: quotePath(orgId, quote.id),
          urgent: false,
        },
        // latest view first
        -(ms(quote.lastViewedAt) || 0),
      );
      continue;
    }
    if (!quote.validUntil || quote.validUntil < today) continue;
    const left = daysBetween(today, quote.validUntil);
    if (left > 1) continue;
    push(
      {
        key: `quote_ending:${quote.id}`,
        kind: "quote_ending",
        title,
        reason: left === 0 ? "הצעה שבתוקף עד היום ועוד לא נענתה" : "הצעה שבתוקף עד מחר ועוד לא נענתה",
        context,
        href: quotePath(orgId, quote.id),
        urgent: false,
      },
      left * 1e15 + (ms(quote.sentAt) || 0),
    );
  }

  // 9. open deals with no next step, in the report's order
  input.dealsWithoutNextStep.forEach((deal, index) => {
    push(
      {
        key: `deal_idle:${deal.id}`,
        kind: "deal_idle",
        title: deal.name,
        reason: `אין ${withPrefixThe("ל", terms.deal)} צעד הבא · ${idleText(deal.idleDays)}`,
        context: deal.stageName,
        href: paths.deal(orgId, deal.id),
        urgent: false,
      },
      index,
    );
  });

  // one action per key (a task listed twice by mistake stays once)
  const seen = new Set<string>();
  const unique: Ranked[] = [];
  for (const item of ranked) {
    if (seen.has(item.action.key)) continue;
    seen.add(item.action.key);
    unique.push(item);
  }
  unique.sort(
    (a, b) =>
      RANK[a.action.kind] - RANK[b.action.kind] ||
      a.sort - b.sort ||
      (a.action.key < b.action.key ? -1 : a.action.key > b.action.key ? 1 : 0),
  );
  return { actions: unique.slice(0, NEXT_ACTIONS_SHOWN).map((item) => item.action), total: unique.length };
}
