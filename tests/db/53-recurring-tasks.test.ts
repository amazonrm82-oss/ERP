import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Successor = { id: string; due_local: string; due_utc: string; remind_local: string | null; recurrence: Record<string, unknown> | null; owner_id: string; created_by: string; title: string; lead_id: string | null };

// TASK-04: completing a recurring task creates the next one, once.
describe("recurring tasks (TASK-04)", () => {
  let owner: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("rec-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "rec-member");
    other = await addMember(org, owner.id, "member", "rec-other");
    viewer = await addMember(org, owner.id, "viewer", "rec-viewer");
    outsider = await createUser("rec-outsider");
    otherOrg = await createOrg(outsider.id);
  });

  const newTask = (user: U, fields: { title?: string; due?: string | null; remind?: string | null; recurrence?: unknown; owner?: string; organization?: string }) =>
    asUser(user.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.tasks (organization_id, title, due_at, remind_at, recurrence, owner_id) values ($1, $2, $3, $4, $5, $6) returning id",
          [fields.organization ?? org, fields.title ?? "משימה חוזרת", fields.due ?? null, fields.remind ?? null, fields.recurrence === undefined ? null : JSON.stringify(fields.recurrence), fields.owner ?? null],
        )
      ).rows[0].id,
    );
  const setStatus = (user: U, task: string, status: "done" | "open") =>
    asUser(user.id, async (q) => (await q("update public.tasks set status = $1 where id = $2", [status, task])).rowCount);
  const successors = (task: string) =>
    asAdmin(async (q) =>
      (
        await q<Successor>(
          `select t.id, to_char(t.due_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as due_local,
                  to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as due_utc,
                  to_char(t.remind_at at time zone 'Asia/Jerusalem', 'YYYY-MM-DD HH24:MI') as remind_local,
                  t.recurrence, t.owner_id, t.created_by, t.title, t.lead_id
             from public.tasks t where t.recurrence_source_id = $1`,
          [task],
        )
      ).rows,
    );
  const completeAndNext = async (user: U, task: string) => {
    expect(await setStatus(user, task, "done")).toBe(1);
    const rows = await successors(task);
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  const localToday = () => asAdmin(async (q) => (await q<{ d: string }>("select to_char(now() at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') as d")).rows[0].d);

  it("daily keeps 09:00 local across both clock changes, and the reminder keeps its offset", async () => {
    // Israel: summer time ends on Sunday 27.10.2030 and starts on Friday 29.3.2030
    const autumn = await newTask(member, { due: "2030-10-26 09:00+03", remind: "2030-10-26 08:45+03", recurrence: { kind: "daily" } });
    const next = await completeAndNext(member, autumn);
    expect(next.due_local).toBe("2030-10-27 09:00");
    expect(next.due_utc).toBe("2030-10-27 07:00");
    expect(next.remind_local).toBe("2030-10-27 08:45");
    expect(next.recurrence).toEqual({ kind: "daily" });

    const spring = await newTask(member, { due: "2030-03-28 09:00+02", recurrence: { kind: "daily" } });
    const after = await completeAndNext(member, spring);
    expect(after.due_local).toBe("2030-03-29 09:00");
    expect(after.due_utc).toBe("2030-03-29 06:00");
    expect(after.remind_local).toBeNull();
  });

  it("weekly goes to the next chosen weekday; monthly clamps to the month's last day", async () => {
    // 1.1.2030 is a Tuesday; Sunday = 0, Wednesday = 3
    const weekly = await newTask(member, { due: "2030-01-01 10:30+02", recurrence: { kind: "weekly", weekdays: [0, 3] } });
    const wed = await completeAndNext(member, weekly);
    expect(wed.due_local).toBe("2030-01-02 10:30");
    const sun = await completeAndNext(member, wed.id);
    expect(sun.due_local).toBe("2030-01-06 10:30");

    const monthly = await newTask(member, { due: "2031-01-31 09:00+02", recurrence: { kind: "monthly", day: 31 } });
    const feb = await completeAndNext(member, monthly);
    expect(feb.due_local).toBe("2031-02-28 09:00");
    const mar = await completeAndNext(member, feb.id);
    expect(mar.due_local).toBe("2031-03-31 09:00");
    const leap = await newTask(member, { due: "2032-01-30 09:00+02", recurrence: { kind: "monthly", day: 30 } });
    expect((await completeAndNext(member, leap)).due_local).toBe("2032-02-29 09:00");
  });

  it("a late completion continues from today; 'after completion' counts from today", async () => {
    const today = await localToday();
    const late = await newTask(member, { due: new Date(Date.now() - 5 * 86_400_000).toISOString(), recurrence: { kind: "daily" } });
    expect((await completeAndNext(member, late)).due_local.slice(0, 10)).toBe(today);

    const after = await newTask(member, { due: "2040-01-01 14:00+02", recurrence: { kind: "after_done", days: 3 } });
    const next = await completeAndNext(member, after);
    const expected = await asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone 'Asia/Jerusalem')::date + 3, 'YYYY-MM-DD') as d")).rows[0].d);
    expect(next.due_local).toBe(`${expected} 14:00`);

    // no due date: from today, at 09:00
    const undated = await newTask(member, { recurrence: { kind: "after_done", days: 1 } });
    const d1 = await asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone 'Asia/Jerusalem')::date + 1, 'YYYY-MM-DD') as d")).rows[0].d);
    expect((await completeAndNext(member, undated)).due_local).toBe(`${d1} 09:00`);
  });

  it("uses the organization's own time zone", async () => {
    await asAdmin((q) => q("update public.organizations set timezone = 'America/New_York' where id = $1", [org]));
    try {
      // New York: summer time ends on Sunday 3.11.2030
      const task = await newTask(member, { due: "2030-11-02 09:00-04", recurrence: { kind: "daily" } });
      const next = await completeAndNext(member, task);
      expect(next.due_utc).toBe("2030-11-03 14:00");
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    }
  });

  it("exactly one successor per task, even when reopened and completed again", async () => {
    const task = await newTask(member, { due: "2030-05-01 09:00+03", recurrence: { kind: "daily" } });
    await completeAndNext(member, task);
    expect(await setStatus(member, task, "open")).toBe(1);
    expect(await setStatus(member, task, "done")).toBe(1);
    expect(await successors(task)).toHaveLength(1);
    // the successor itself is open and has no outcome or completion
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where recurrence_source_id = $1 and status = 'open' and completed_at is null", [task]))).toBe(1);
  });

  it("turning recurrence off stops the series; an end date or a count ends it", async () => {
    const off = await newTask(member, { due: "2030-05-01 09:00+03", recurrence: { kind: "daily" } });
    expect(await asUser(member.id, async (q) => (await q("update public.tasks set recurrence = null where id = $1", [off])).rowCount)).toBe(1);
    expect(await setStatus(member, off, "done")).toBe(1);
    expect(await successors(off)).toHaveLength(0);

    const until = await newTask(member, { due: "2030-05-01 09:00+03", recurrence: { kind: "daily", until: "2030-05-01" } });
    expect(await setStatus(member, until, "done")).toBe(1);
    expect(await successors(until)).toHaveLength(0);
    const lastDay = await newTask(member, { due: "2030-05-01 09:00+03", recurrence: { kind: "daily", until: "2030-05-02" } });
    expect((await completeAndNext(member, lastDay)).recurrence).toEqual({ kind: "daily", until: "2030-05-02" });

    // left = how many more tasks may follow; the form saves "3 tasks in total" as
    // left 2 (src/features/tasks/recurrence.ts), so this series has exactly 3
    const counted = await newTask(member, { due: "2030-05-01 09:00+03", recurrence: { kind: "daily", left: 2 } });
    const second = await completeAndNext(member, counted);
    expect(second.recurrence).toEqual({ kind: "daily", left: 1 });
    const third = await completeAndNext(member, second.id);
    expect(third.recurrence).toBeNull();
    expect(await setStatus(member, third.id, "done")).toBe(1);
    expect(await successors(third.id)).toHaveLength(0);

    // cancelled is not done
    const cancelled = await newTask(member, { due: "2030-05-01 09:00+03", recurrence: { kind: "daily" } });
    expect(await asUser(member.id, async (q) => (await q("update public.tasks set status = 'cancelled' where id = $1", [cancelled])).rowCount)).toBe(1);
    expect(await successors(cancelled)).toHaveLength(0);
  });

  it("the successor keeps title, links, assignee and the creator of the series", async () => {
    const lead = await asUser(owner.id, async (q) => {
      const status = (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 and is_default", [org])).rows[0].id;
      return (await q<{ id: string }>("insert into public.leads (organization_id, full_name, status_id) values ($1, 'ליד', $2) returning id", [org, status])).rows[0].id;
    });
    // the owner hands a weekly task on the lead to the member
    const task = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.tasks (organization_id, title, due_at, owner_id, lead_id, recurrence, priority) values ($1, 'דוח שבועי', '2030-06-02 09:00+03', $2, $3, '{\"kind\":\"weekly\",\"weekdays\":[0]}', 1) returning id",
          [org, member.id, lead],
        )
      ).rows[0].id,
    );
    const before = await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'assigned'", [member.id]));
    const next = await completeAndNext(member, task);
    expect(next).toMatchObject({ title: "דוח שבועי", owner_id: member.id, created_by: owner.id, lead_id: lead, due_local: "2030-06-09 09:00" });
    expect(await asAdmin(async (q) => (await q<{ priority: number }>("select priority from public.tasks where id = $1", [next.id])).rows[0].priority)).toBe(1);
    // completing one's own task does not notify oneself about the next one
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'assigned'", [member.id]))).toBe(before);
    // when the owner completes it, the member hears about the new task like any other
    const third = await completeAndNext(owner, next.id);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'assigned' and entity_id = $2", [member.id, third.id]))).toBe(1);
  });

  it("who may set recurrence is who may edit the task", async () => {
    const task = await newTask(member, { due: "2030-05-01 09:00+03" });
    const set = (user: U) =>
      asUser(user.id, async (q) => (await q(`update public.tasks set recurrence = '{"kind":"daily"}' where id = $1`, [task])).rowCount);
    expect(await set(other)).toBe(0);
    expect(await set(viewer)).toBe(0);
    expect(await set(outsider)).toBe(0);
    expect(await set(member)).toBe(1);
    expect(await set(owner)).toBe(1);
    // a viewer cannot complete it either, so nothing is created
    expect(await setStatus(viewer, task, "done")).toBe(0);
    expect(await successors(task)).toHaveLength(0);
  });

  it("only the database writes recurrence_source_id", async () => {
    const task = await newTask(member, { due: "2030-05-01 09:00+03" });
    expect((await pgError(asUser(member.id, (q) => q("update public.tasks set recurrence_source_id = $1 where id = $1", [task])))).code).toBe("42501");
    expect(
      (await pgError(asUser(member.id, (q) => q("insert into public.tasks (organization_id, title, recurrence_source_id) values ($1, 'x', $2)", [org, task])))).code,
    ).toBe("42501");
    // every other column is written as before
    expect(
      await asUser(member.id, async (q) =>
        (await q("update public.tasks set title = 'חדש', description = 'd', priority = 3, outcome = null, remind_at = null, task_type = 'call' where id = $1", [task])).rowCount,
      ),
    ).toBe(1);
  });

  it("successors stay in their organization, and another organization's rule never touches ours", async () => {
    const theirs = await newTask(outsider, { organization: otherOrg, due: "2030-05-01 09:00+03", recurrence: { kind: "daily" } });
    const next = await completeAndNext(outsider, theirs);
    expect(await asAdmin(async (q) => (await q<{ organization_id: string }>("select organization_id from public.tasks where id = $1", [next.id])).rows[0].organization_id)).toBe(otherOrg);
    // nobody in our organization sees it
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.tasks where id = $1 or recurrence_source_id = $2", [next.id, theirs]))).toBe(0);
  });

  it("a read-only organization gets no successor", async () => {
    const task = await newTask(member, { due: "2030-05-01 09:00+03", recurrence: { kind: "daily" } });
    // complete it as the server would while the organization is read-only
    await asAdmin(async (q) => {
      const status = (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status;
      await q("update public.organizations set status = 'read_only' where id = $1", [org]);
      await q("update public.tasks set status = 'done' where id = $1", [task]);
      await q("update public.organizations set status = $2 where id = $1", [org, status]);
    });
    expect(await successors(task)).toHaveLength(0);
  });

  it("rejects a malformed rule", async () => {
    const bad = [
      { kind: "yearly" },
      { kind: "daily", day: 3 },
      { kind: "weekly" },
      { kind: "monthly" },
      { kind: "after_done" },
      { kind: "daily", until: null },
      { kind: "weekly", weekdays: [] },
      { kind: "weekly", weekdays: [7] },
      { kind: "weekly", weekdays: ["1"] },
      { kind: "monthly", day: 0 },
      { kind: "monthly", day: 32 },
      { kind: "monthly", day: 1.5 },
      { kind: "after_done", days: 0 },
      { kind: "after_done", days: 400 },
      { kind: "daily", until: "31/12/2030" },
      { kind: "daily", left: 0 },
      { kind: "daily", extra: true },
      [1, 2],
      "daily",
    ];
    for (const recurrence of bad) {
      expect((await pgError(newTask(member, { due: "2030-05-01 09:00+03", recurrence }))).code, JSON.stringify(recurrence)).toBe("23514");
    }
    for (const recurrence of [{ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6] }, { kind: "monthly", day: 1, until: "2031-02-28", left: 999 }, { kind: "after_done", days: 365 }]) {
      expect(await newTask(member, { due: "2030-05-01 09:00+03", recurrence })).toBeTruthy();
    }
  });
});
