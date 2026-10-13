import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addBusinessDays } from "@/features/calendar-days/business-days";
import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "@/features/calendar-days/holidays";
import { addDays } from "@/lib/calendar-grid";

import { asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; warning?: string; error?: string };

// HEB-03: business days. app.add_business_days() and its TS mirror, and the
// automation's "due in N business days".
describe("business days (HEB-03)", () => {
  let owner: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("bd-owner");
    org = await createOrg(owner.id);
  });

  const setCalendar = (s: CalendarSettings) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions)
         values ($1, $2, $3, $4, $5)
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays, holidays_rest = excluded.holidays_rest,
           holiday_eves_rest = excluded.holiday_eves_rest, rest_occasions = excluded.rest_occasions`,
        [org, s.restWeekdays, s.holidaysRest, s.holidayEvesRest, s.restOccasions],
      ),
    );
  const add = (from: string, n: number | null) =>
    asAdmin(async (q) => (await q<{ d: string | null }>("select to_char(app.add_business_days($1, $2::date, $3), 'YYYY-MM-DD') as d", [org, from, n])).rows[0].d);

  it("Fri+Sat rest: Thursday + 1 business day is Sunday; n = 0 keeps a working day", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    expect(await add("2026-10-15", 1)).toBe("2026-10-18");
    expect(await add("2026-10-15", 0)).toBe("2026-10-15");
    expect(await add("2026-10-16", 0)).toBe("2026-10-18");
    expect(await add("2026-10-15", 5)).toBe("2026-10-22");
  });

  it("a holiday marked as rest is skipped (Yom Kippur, Monday 21 September 2026)", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    expect(await add("2026-09-20", 1)).toBe("2026-09-22");
    await setCalendar({ ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false });
    expect(await add("2026-09-20", 1)).toBe("2026-09-21");
  });

  it("a business with no rest days counts calendar days", async () => {
    await setCalendar({ restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] });
    for (const n of [0, 1, 7, 60]) {
      expect(await add("2026-10-15", n)).toBe(addDays("2026-10-15", n));
    }
  });

  it("refuses a negative or too large number; a null argument gives null", async () => {
    expect(await pgError(add("2026-10-15", -1))).toMatchObject({ code: "22023", hint: "business_days:range" });
    expect(await pgError(add("2026-10-15", 1001))).toMatchObject({ code: "22023", hint: "business_days:range" });
    expect(await add("2026-10-15", null)).toBeNull();
  });

  it("is not reachable from the API", async () => {
    const err = await pgError(asUser(owner.id, (q) => q("select app.add_business_days($1, current_date, 1)", [org])));
    expect(err?.code).toBe("42501");
  });

  it("matches addBusinessDays() day by day, for several settings and numbers", async () => {
    const cases: CalendarSettings[] = [
      DEFAULT_CALENDAR_SETTINGS,
      { restWeekdays: [6], holidaysRest: true, holidayEvesRest: true, restOccasions: ["chol_hamoed_sukkot", "chol_hamoed_pesach"] },
      { restWeekdays: [0, 5, 6], holidaysRest: false, holidayEvesRest: false, restOccasions: ["yom_hazikaron", "purim"] },
      { restWeekdays: [], holidaysRest: true, holidayEvesRest: false, restOccasions: [] },
    ];
    // September 2026 to May 2027: the autumn holidays, Chanukah, Purim, Pesach, Yom HaZikaron
    const from = "2026-09-01";
    for (const settings of cases) {
      await setCalendar(settings);
      for (const [n, days, step] of [[0, 270, 1], [1, 270, 1], [2, 270, 1], [3, 270, 1], [10, 270, 2], [60, 270, 9]] as const) {
        const rows = await asAdmin(async (q) =>
          (
            await q<{ day: string; d: string }>(
              `select to_char(f, 'YYYY-MM-DD') as day, to_char(app.add_business_days($1, f::date, $3), 'YYYY-MM-DD') as d
                 from generate_series($2::date, $2::date + ($4::int - 1), make_interval(days => $5::int)) f`,
              [org, from, n, days, step],
            )
          ).rows,
        );
        expect(rows).toHaveLength(Math.ceil(days / step));
        const wrong = rows.filter((r) => r.d !== addBusinessDays(settings, r.day, n)).map((r) => `${r.day}+${n}`);
        expect(wrong, JSON.stringify(settings)).toEqual([]);
      }
    }
  }, 180_000);

  describe("automation: create a task due in N business days", () => {
    // extra: action keys, or raw JSON text of keys (to store a literal such as 3.0)
    const runTaskRule = async (extra: Record<string, unknown> | string) => {
      const base = JSON.stringify({ type: "create_task", title: "להתקשר ל{{name}}", task_type: "call", assign: "owner" });
      const action = typeof extra === "string" ? `${base.slice(0, -1)}, ${extra}}` : JSON.stringify({ ...JSON.parse(base), ...extra });
      const rule = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'משימה', 'lead', 'created', '{}', '[]', $2, false) returning id`,
            [org, `[${action}]`],
          )
        ).rows[0].id,
      );
      const leadId = await insertLead(owner.id, org);
      const result = await asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, leadId])).rows[0].r);
      const steps = await asAdmin(async (q) => (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1", [rule])).rows[0].steps);
      // compare with the run's own time (the transaction's now(), as the engine saw it),
      // so a minute or midnight passing between the run and this check does not matter
      const task = await asAdmin(async (q) =>
        (
          await q<{ due_day: string | null; due_time: string | null; now_time: string; today: string }>(
            `select to_char(t.due_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as due_day,
                    to_char(t.due_at at time zone 'Asia/Jerusalem', 'HH24:MI:SS.US') as due_time,
                    to_char(r.created_at at time zone 'Asia/Jerusalem', 'HH24:MI:SS.US') as now_time,
                    to_char(r.created_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as today
               from public.tasks t, public.automation_runs r
              where t.organization_id = $1 and t.lead_id = $2 and r.automation_id = $3`,
            [org, leadId, rule],
          )
        ).rows[0],
      );
      return { status: result.status, step: steps[0], task };
    };

    it("puts the task on the right business day, at the current local time", async () => {
      await setCalendar(DEFAULT_CALENDAR_SETTINGS);
      for (const n of [0, 1, 3]) {
        const run = await runTaskRule({ due_in_business_days: n });
        expect(run.status).toBe("success");
        expect(run.step).toEqual({ action: "create_task", status: "ok" });
        expect(run.task.due_day).toBe(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, run.task.today, n));
        expect(run.task.due_time).toBe(run.task.now_time);
      }
    });

    it("accepts a whole number written as 3.0", async () => {
      await setCalendar(DEFAULT_CALENDAR_SETTINGS);
      const run = await runTaskRule('"due_in_business_days": 3.0');
      expect(run.status).toBe("success");
      expect(run.step).toEqual({ action: "create_task", status: "ok" });
      expect(run.task.due_day).toBe(addBusinessDays(DEFAULT_CALENDAR_SETTINGS, run.task.today, 3));
    });

    it("follows the business's own rest days", async () => {
      const settings: CalendarSettings = { restWeekdays: [0, 1, 2, 3, 4, 5], holidaysRest: true, holidayEvesRest: false, restOccasions: [] };
      await setCalendar(settings);
      const run = await runTaskRule({ due_in_business_days: 1 });
      // only Saturdays are working days here
      expect(new Date(`${run.task.due_day}T12:00:00Z`).getUTCDay()).toBe(6);
      expect(run.task.due_day).toBe(addBusinessDays(settings, run.task.today, 1));
      await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    });

    it("ignores an invalid number with a warning, and the task has no due time", async () => {
      for (const bad of [61, -1, 2.5, "3", null]) {
        const run = await runTaskRule({ due_in_business_days: bad });
        expect(run.status).toBe("success");
        expect(run.step).toEqual({ action: "create_task", status: "ok", warning: "the business-day offset is invalid" });
        expect(run.task.due_day).toBeNull();
      }
    });

    it("leaves rules in calendar days as they were", async () => {
      const run = await runTaskRule({ due_in_days: 3 });
      expect(run.step).toEqual({ action: "create_task", status: "ok" });
      expect(run.task.due_day).toBe(addDays(run.task.today, 3));
      const none = await runTaskRule({});
      expect(none.task.due_day).toBeNull();
    });
  });
});
