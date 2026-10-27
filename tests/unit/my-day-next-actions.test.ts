import { describe, expect, it } from "vitest";

import { nextActions, NEXT_ACTIONS_SHOWN, startsInText, waitedText, type NextActionInput } from "@/features/home/next-actions";
import { resolveTerms } from "@/features/terminology/terms";

const ZONE = "Asia/Jerusalem";
const ORG = "00000000-0000-0000-0000-00000000000a";
// 12:00 in Israel on 19 October 2026 (UTC+3)
const NOW = new Date("2026-10-19T09:00:00Z");
const TODAY = "2026-10-19";

function base(over: Partial<NextActionInput> = {}): NextActionInput {
  return {
    orgId: ORG,
    now: NOW,
    today: TODAY,
    timeZone: ZONE,
    tasks: [],
    waitingLeads: [],
    meetings: [],
    quotes: [],
    dealsWithoutNextStep: [],
    ...over,
  };
}

const task = (id: string, dueAt: string, taskType = "todo", extra: Partial<NextActionInput["tasks"][number]> = {}) => ({
  id,
  title: `משימה ${id}`,
  dueAt,
  taskType,
  leadId: null,
  related: null,
  ...extra,
});

const meeting = (id: string, startsAt: string, endsAt: string, phase: "upcoming" | "now" | "over", status = "planned") => ({
  id,
  title: `פגישה ${id}`,
  startsAt,
  endsAt,
  status,
  type: "meeting",
  location: null,
  related: null,
  phase,
});

const quote = (id: string, status: "sent" | "viewed", extra: Partial<NextActionInput["quotes"][number]> = {}) => ({
  id,
  title: `הצעה ${id}`,
  numberDisplay: null,
  status,
  sentAt: "2026-10-15T08:00:00Z",
  validUntil: "2026-11-30",
  customerName: null,
  lastViewedAt: null,
  ...extra,
});

describe("AIX-03: what next, in My day", () => {
  it("orders every kind by the fixed rank, and each kind by its own tie-break", () => {
    const result = nextActions(
      base({
        dealsWithoutNextStep: [{ id: "d1", name: "עסקה א", stageName: "הצעה", idleDays: 12 }],
        quotes: [
          quote("q-end", "sent", { validUntil: TODAY }),
          quote("q-old-view", "viewed", { lastViewedAt: "2026-10-17T08:00:00Z" }),
          quote("q-new-view", "viewed", { lastViewedAt: "2026-10-19T07:00:00Z" }),
          quote("q-far", "sent"),
        ],
        tasks: [
          task("t-later", "2026-10-19T13:00:00Z"),
          task("c-later", "2026-10-19T12:00:00Z", "call"),
          task("t-old", "2026-10-15T08:00:00Z"),
          task("t-older", "2026-10-14T08:00:00Z"),
          task("c-due", "2026-10-19T08:00:00Z", "call"),
          task("t-tomorrow", "2026-10-20T08:00:00Z"),
        ],
        waitingLeads: [
          { id: "l2", name: "ליד ב", createdAt: "2026-10-19T08:00:00Z" },
          { id: "l1", name: "ליד א", createdAt: "2026-10-18T08:00:00Z" },
        ],
        meetings: [
          meeting("m-far", "2026-10-19T12:00:00Z", "2026-10-19T13:00:00Z", "upcoming"),
          meeting("m-soon", "2026-10-19T09:30:00Z", "2026-10-19T10:00:00Z", "upcoming"),
          meeting("m-over", "2026-10-19T06:00:00Z", "2026-10-19T07:00:00Z", "over"),
        ],
      }),
    );
    expect(result.actions.map((a) => a.key)).toEqual([
      "meeting_soon:m-soon",
      "call_due:c-due",
      "lead_waiting:l1",
      "lead_waiting:l2",
      "quote_viewed:q-new-view",
      "quote_viewed:q-old-view",
      "task_due:t-older",
      "task_due:t-old",
      "call_today:c-later",
      "quote_ending:q-end",
    ]);
    // the eleventh and twelfth are counted, not shown
    expect(result.total).toBe(12);
    expect(result.actions).toHaveLength(NEXT_ACTIONS_SHOWN);
  });

  it("is deterministic whatever order the rows arrive in", () => {
    const tasks = [task("b", "2026-10-15T08:00:00Z"), task("a", "2026-10-15T08:00:00Z"), task("c", "2026-10-14T08:00:00Z")];
    const one = nextActions(base({ tasks })).actions.map((a) => a.key);
    const two = nextActions(base({ tasks: [...tasks].reverse() })).actions.map((a) => a.key);
    expect(one).toEqual(["task_due:c", "task_due:a", "task_due:b"]);
    expect(two).toEqual(one);
  });

  it("gives each action a short reason and a link to its record", () => {
    const result = nextActions(
      base({
        tasks: [
          task("c1", "2026-10-17T08:00:00Z", "call", { related: { kind: "lead", id: "l9", name: "דנה" }, leadId: "l9" }),
          task("c2", "2026-10-19T08:30:00Z", "call"),
          task("c3", "2026-10-19T14:00:00Z", "call"),
          task("t1", "2026-10-19T14:00:00Z", "todo", { related: { kind: "deal", id: "d9", name: "חידוש" } }),
        ],
        waitingLeads: [{ id: "l1", name: "יוסי", createdAt: "2026-10-19T06:00:00Z" }],
        meetings: [meeting("m1", "2026-10-19T08:30:00Z", "2026-10-19T09:30:00Z", "now")],
        quotes: [quote("q1", "viewed", { lastViewedAt: "2026-10-18T08:00:00Z", numberDisplay: "Q-12", customerName: "חברת אור" })],
        dealsWithoutNextStep: [{ id: "d1", name: "עסקה א", stageName: "משא ומתן", idleDays: 12 }],
      }),
    );
    const by = Object.fromEntries(result.actions.map((a) => [a.key, a]));
    expect(by["meeting_soon:m1"]).toMatchObject({ reason: "פגישה שמתקיימת עכשיו", urgent: true, href: `/o/${ORG}/calendar?view=day` });
    expect(by["call_due:c1"]).toMatchObject({ reason: "שיחה שהובטחה, באיחור מ-17.10", context: "ליד: דנה", href: `/o/${ORG}/leads/l9` });
    expect(by["call_due:c2"]).toMatchObject({ reason: "שיחה שהובטחה ל-11:30, השעה עברה", href: `/o/${ORG}/tasks` });
    expect(by["call_today:c3"]).toMatchObject({ reason: "שיחה שהובטחה להיום ב-17:00", urgent: false });
    expect(by["task_today:t1"]).toMatchObject({ reason: "משימה להיום ב-17:00", context: "עסקה: חידוש", href: `/o/${ORG}/deals/d9` });
    expect(by["lead_waiting:l1"]).toMatchObject({ title: "יוסי", reason: "ליד שמחכה למענה כבר 3 שעות", href: `/o/${ORG}/leads/l1` });
    expect(by["quote_viewed:q1"]).toMatchObject({
      title: "Q-12 הצעה q1",
      reason: "הצעה שנצפתה אתמול ועוד לא נענתה",
      context: "חברת אור",
      href: `/o/${ORG}/quotes/q1`,
    });
    expect(by["deal_idle:d1"]).toMatchObject({ reason: "אין לעסקה צעד הבא · בלי פעילות 12 ימים", context: "משא ומתן", href: `/o/${ORG}/deals/d1` });
  });

  it("uses the business's own words", () => {
    const terms = resolveTerms({ contact: "patient", lead: "inquiry", deal: "case" });
    const result = nextActions(
      base({
        terms,
        tasks: [task("t1", "2026-10-15T08:00:00Z", "todo", { related: { kind: "contact", id: "c1", name: "רות" } })],
        waitingLeads: [{ id: "l1", name: "יוסי", createdAt: "2026-10-19T08:58:00Z" }],
        dealsWithoutNextStep: [{ id: "d1", name: "תיק א", stageName: null, idleDays: 1 }],
      }),
    );
    expect(result.actions.map((a) => a.reason)).toEqual(["פנייה שמחכה למענה כבר 2 דקות", "משימה, באיחור מ-15.10", "אין לתיק צעד הבא · בלי פעילות יום אחד"]);
    expect(result.actions[1].context).toBe("מטופל: רות");
  });

  it("does not list a lead as waiting while a call to it is due today", () => {
    const result = nextActions(
      base({
        tasks: [task("c1", "2026-10-19T15:00:00Z", "call", { leadId: "l1", related: { kind: "lead", id: "l1", name: "א" } })],
        waitingLeads: [
          { id: "l1", name: "א", createdAt: "2026-10-18T08:00:00Z" },
          { id: "l2", name: "ב", createdAt: "2026-10-18T09:00:00Z" },
        ],
      }),
    );
    expect(result.actions.map((a) => a.key)).toEqual(["lead_waiting:l2", "call_today:c1"]);
  });

  it("leaves out what is not due yet: far meetings, cancelled ones, quotes with time left, tasks of tomorrow", () => {
    const result = nextActions(
      base({
        meetings: [
          meeting("m-far", "2026-10-19T10:30:00Z", "2026-10-19T11:00:00Z", "upcoming"),
          meeting("m-cancel", "2026-10-19T09:10:00Z", "2026-10-19T10:00:00Z", "upcoming", "cancelled"),
        ],
        quotes: [quote("q1", "sent", { validUntil: "2026-10-22" }), quote("q2", "sent", { validUntil: "2026-10-18" }), quote("q3", "sent", { validUntil: null })],
        tasks: [task("t1", "2026-10-19T21:30:00Z"), task("t2", "")],
      }),
    );
    expect(result).toEqual({ actions: [], total: 0 });
  });

  it("says how long things waited and how soon they start", () => {
    expect(waitedText("2026-10-19T09:00:00Z", NOW)).toBe("כבר דקה");
    expect(waitedText("2026-10-19T08:15:00Z", NOW)).toBe("כבר 45 דקות");
    expect(waitedText("2026-10-19T08:00:00Z", NOW)).toBe("כבר שעה");
    expect(waitedText("2026-10-19T07:00:00Z", NOW)).toBe("כבר שעתיים");
    expect(waitedText("2026-10-18T08:00:00Z", NOW)).toBe("כבר יום");
    expect(waitedText("2026-10-17T08:00:00Z", NOW)).toBe("כבר יומיים");
    expect(waitedText("2026-10-14T08:00:00Z", NOW)).toBe("כבר 5 ימים");
    expect(startsInText("2026-10-19T09:00:30Z", NOW)).toBe("בעוד דקה");
    expect(startsInText("2026-10-19T09:25:00Z", NOW)).toBe("בעוד 25 דקות");
    expect(startsInText("2026-10-19T10:00:00Z", NOW)).toBe("בעוד שעה");
  });
});
