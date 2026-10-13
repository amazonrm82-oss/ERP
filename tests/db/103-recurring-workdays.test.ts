import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "@/features/calendar-days/holidays";
import { nextTask, type Recurrence } from "@/features/tasks/recurrence";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// HEB-02: a recurring task whose rule says "workdays" moves its next task from a
// day the business does not work to the next working day; app.spawn_recurring_task()
// and nextTask() agree day by day.
describe("recurring tasks on working days only (HEB-02)", () => {
  let owner: U, member: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("rw-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "rw-member");
  });

  // thousands of task events: mark this organization's outbox done, so a later file's
  // app.process_outbox(5000) reaches its own events
  const clearOutbox = () =>
    asAdmin((q) => q("update public.outbox_events set processed_at = now() where organization_id = $1 and processed_at is null", [org]));
  afterEach(clearOutbox);

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
  const newTask = (due: string, recurrence: unknown) =>
    asUser(member.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.tasks (organization_id, title, due_at, recurrence) values ($1, 'חוזרת', $2, $3) returning id", [
          org,
          due,
          JSON.stringify(recurrence),
        ])
      ).rows[0].id,
    );
  const completeAndNext = async (task: string) => {
    expect(await asUser(member.id, async (q) => (await q("update public.tasks set status = 'done' where id = $1", [task])).rowCount)).toBe(1);
    return asAdmin(async (q) =>
      (
        await q<{ id: string; due_local: string; recurrence: Recurrence | null }>(
          `select id, to_char(due_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as due_local, recurrence
             from public.tasks where recurrence_source_id = $1`,
          [task],
        )
      ).rows,
    );
  };

  it("the rule accepts workdays: true only", async () => {
    expect(await newTask("2030-03-28 09:00+02", { kind: "daily", workdays: true })).toBeTruthy();
    for (const bad of [false, "true", 1]) {
      const err = await pgError(newTask("2030-03-28 09:00+02", { kind: "daily", workdays: bad }));
      expect(err.code).toBe("23514");
    }
  });

  it("Fri+Sat rest: a daily task done on Thursday comes back on Sunday; without the key on Friday", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    // Thursday 28.3.2030; Israel's summer time starts on Friday 29.3.2030
    const [moved] = await completeAndNext(await newTask("2030-03-28 09:00+02", { kind: "daily", workdays: true }));
    expect(moved.due_local).toBe("2030-03-31 09:00");
    expect(moved.recurrence).toEqual({ kind: "daily", workdays: true });
    // and the series goes on from the moved day
    const [monday] = await completeAndNext(moved.id);
    expect(monday.due_local).toBe("2030-04-01 09:00");

    const [plain] = await completeAndNext(await newTask("2030-03-28 09:00+02", { kind: "daily" }));
    expect(plain.due_local).toBe("2030-03-29 09:00");
  });

  it("a holiday the business closes on is skipped; 'left' still counts down", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    // Yom Kippur 5791: Monday 7.10.2030 (2030-10-06 is a Sunday)
    const [next] = await completeAndNext(await newTask("2030-10-06 10:00+03", { kind: "daily", workdays: true, left: 3 }));
    expect(next.due_local).toBe("2030-10-08 10:00");
    expect(next.recurrence).toEqual({ kind: "daily", workdays: true, left: 2 });
  });

  it("no task after the end date, also when the move passes it", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    // Thursday 28.3.2030, until Friday 29.3: the next one would move to Sunday 31.3
    expect(await completeAndNext(await newTask("2030-03-28 09:00+02", { kind: "daily", workdays: true, until: "2030-03-29" }))).toEqual([]);
  });

  it("matches nextTask() day by day, for several settings and rules", async () => {
    const cases: CalendarSettings[] = [
      DEFAULT_CALENDAR_SETTINGS,
      { restWeekdays: [6], holidaysRest: true, holidayEvesRest: true, restOccasions: ["chol_hamoed_pesach", "yom_hazikaron"] },
      { restWeekdays: [0, 5, 6], holidaysRest: false, holidayEvesRest: false, restOccasions: ["purim"] },
    ];
    const rules: Recurrence[] = [
      { kind: "daily", workdays: true },
      { kind: "weekly", weekdays: [3, 5], workdays: true },
      { kind: "monthly", day: 31, workdays: true },
      { kind: "daily", workdays: true, until: "2031-04-20" },
    ];
    // February to June 2031: Purim, Pesach, Yom HaZikaron, Independence Day, Shavuot
    const from = "2031-02-01";
    const days = 150;
    for (const settings of cases) {
      await setCalendar(settings);
      for (const rule of rules) {
        // one task per day, all completed in one statement (the trigger runs per row)
        const rows = await asUser(member.id, async (q) => {
          await q(
            `insert into public.tasks (organization_id, title, due_at, recurrence)
             select $1, 'השוואה ' || to_char(f, 'YYYY-MM-DD'), (f::date + time '11:15') at time zone 'Asia/Jerusalem', $2::jsonb
               from generate_series($3::date, $3::date + ($4::int - 1), interval '1 day') f`,
            [org, JSON.stringify(rule), from, days],
          );
          await q("update public.tasks set status = 'done' where organization_id = $1 and title like 'השוואה %' and status = 'open' and recurrence = $2::jsonb and recurrence_source_id is null", [
            org,
            JSON.stringify(rule),
          ]);
          return (
            await q<{ day: string; due: string; next: string | null }>(
              `select to_char(t.due_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as day,
                      to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due,
                      to_char(s.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as next
                 from public.tasks t
                 left join public.tasks s on s.organization_id = t.organization_id and s.recurrence_source_id = t.id
                where t.organization_id = $1 and t.title like 'השוואה %' and t.recurrence = $2::jsonb and t.recurrence_source_id is null`,
              [org, JSON.stringify(rule)],
            )
          ).rows;
        });
        expect(rows).toHaveLength(days);
        const wrong = rows
          .filter((r) => {
            const expected = nextTask(rule, { dueAt: r.due, remindAt: null }, new Date(), "Asia/Jerusalem", settings);
            const want = expected ? new Date(expected.dueAt).toISOString() : null;
            return want !== r.next;
          })
          .map((r) => `${r.day} -> ${r.next}`);
        expect(wrong, `${JSON.stringify(settings)} ${JSON.stringify(rule)}`).toEqual([]);
        // clean the round's tasks out of the next round's way
        await asAdmin((q) => q("update public.tasks set title = 'נבדקה' where organization_id = $1 and title like 'השוואה %'", [org]));
        await clearOutbox();
      }
    }
  }, 240_000);
});
