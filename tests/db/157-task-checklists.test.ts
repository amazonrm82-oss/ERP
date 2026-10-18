import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * TASK-06: steps inside a task (rights follow the task), and checklist templates (a managed list, owners and admins
 * write). A recurring task hands its steps on, unticked.
 */
describe("task checklists (TASK-06)", () => {
  let owner: U, admin: U, manager: U, member: U, member2: U, viewer: U, outsider: U;
  let org: string;
  let taskOwn: string, taskOther: string;

  const newTask = (who: U, fields: Record<string, unknown> = {}) =>
    asUser(who.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: org, title: "משימה", ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.tasks (${cols.join(", ")}) values (${cols.map((c, i) => (c === "recurrence" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ")}) returning id`,
          Object.values(row).map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)),
        )
      ).rows[0].id;
    });
  const addStep = (who: U, task: string, title = "שלב") =>
    asUser(who.id, async (q) => (await q<{ id: string }>("insert into public.task_checklist_items (organization_id, task_id, title) values ($1, $2, $3) returning id", [org, task, title])).rows[0].id);
  const steps = (who: U, task: string) => asUser(who.id, (q) => count(q, "select 1 from public.task_checklist_items where task_id = $1", [task]));

  beforeAll(async () => {
    owner = await createUser("chk-owner");
    org = await createOrg(owner.id, "עסק המשימות");
    admin = await addMember(org, owner.id, "admin", "chk-admin");
    manager = await addMember(org, owner.id, "manager", "chk-manager");
    member = await addMember(org, owner.id, "member", "chk-member");
    member2 = await addMember(org, owner.id, "member", "chk-member2");
    viewer = await addMember(org, owner.id, "viewer", "chk-viewer");
    outsider = await createUser("chk-outsider");
    await createOrg(outsider.id, "עסק אחר");
    // each person sees only their own records
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    taskOwn = await newTask(member, { title: "שלי" });
    taskOther = await newTask(member2, { title: "של אחר" });
  });

  it("a step follows its task: seen with it, written by whoever may update the task", async () => {
    const step = await addStep(member, taskOwn, "שיחת היכרות");
    expect(await steps(member, taskOwn)).toBe(1);
    // another member neither sees nor writes it
    expect(await steps(member2, taskOwn)).toBe(0);
    expect((await pgError(addStep(member2, taskOwn))).code).toBe("42501");
    expect(await asUser(member2.id, async (q) => (await q("update public.task_checklist_items set done = true where id = $1", [step])).rowCount)).toBe(0);
    expect(await asUser(member2.id, async (q) => (await q("delete from public.task_checklist_items where id = $1", [step])).rowCount)).toBe(0);
    // writes without WHERE reach only what the writer may write
    expect(await asUser(member2.id, async (q) => (await q("update public.task_checklist_items set title = 'נחטף'")).rowCount)).toBe(0);
    expect(await asUser(member2.id, async (q) => (await q("delete from public.task_checklist_items")).rowCount)).toBe(0);
    // admins and owners write every task's steps
    expect(await steps(admin, taskOwn)).toBe(1);
    await addStep(admin, taskOther, "של המנהלת");
    expect(await steps(owner, taskOther)).toBe(1);
    // a viewer reads with org visibility, writes nothing
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    try {
      expect(await steps(viewer, taskOwn)).toBe(1);
      expect((await pgError(addStep(viewer, taskOwn))).code).toBe("42501");
      expect(await asUser(viewer.id, async (q) => (await q("update public.task_checklist_items set done = true where id = $1", [step])).rowCount)).toBe(0);
      expect(await asUser(viewer.id, async (q) => (await q("delete from public.task_checklist_items where id = $1", [step])).rowCount)).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    }
    // whoever created a task for someone else edits its steps
    const handed = await newTask(manager, { title: "בשבילך", owner_id: member2.id });
    expect(await addStep(manager, handed, "של היוצר")).toMatch(/^[0-9a-f-]{36}$/);
    // another business sees nothing and writes nothing
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.task_checklist_items where organization_id = $1", [org]))).toBe(0);
    expect((await pgError(addStep(outsider, taskOwn))).code).toBe("42501");
  });

  it("ticking stamps when and who; clients write neither", async () => {
    const step = await addStep(member, taskOwn, "לתייק");
    const read = () =>
      asAdmin(async (q) => (await q<{ done: boolean; done_at: string | null; done_by: string | null }>("select done, done_at, done_by from public.task_checklist_items where id = $1", [step])).rows[0]);
    await asUser(member.id, (q) => q("update public.task_checklist_items set done = true where id = $1", [step]));
    const ticked = await read();
    expect(ticked.done).toBe(true);
    expect(ticked.done_at).not.toBeNull();
    expect(ticked.done_by).toBe(member.id);
    // renaming keeps the stamp
    await asUser(admin.id, (q) => q("update public.task_checklist_items set title = 'לתייק במגירה' where id = $1", [step]));
    expect((await read()).done_by).toBe(member.id);
    await asUser(member.id, (q) => q("update public.task_checklist_items set done = false where id = $1", [step]));
    expect(await read()).toEqual({ done: false, done_at: null, done_by: null });
    expect((await pgError(asUser(member.id, (q) => q("update public.task_checklist_items set done_by = $2 where id = $1", [step, member2.id])))).code).toBe("42501");
    expect((await pgError(asUser(member.id, (q) => q("update public.task_checklist_items set task_id = $2 where id = $1", [step, taskOther])))).code).toBe("42501");
    // a step holds a title
    expect((await pgError(addStep(member, taskOwn, " "))).code).toBe("23514");
  });

  it("at most 100 steps in a task", async () => {
    const task = await newTask(member, { title: "ארוכה" });
    await asUser(member.id, (q) =>
      q("insert into public.task_checklist_items (organization_id, task_id, title, position) select $1, $2, 'שלב ' || g, g from generate_series(1, 100) g", [org, task]),
    );
    const over = await pgError(addStep(member, task, "אחד יותר מדי"));
    expect(over.hint).toBe("task_checklist:max");
    // someone who may not write the task gets the plain refusal, not the count
    expect((await pgError(addStep(member2, task, "x"))).code).toBe("42501");
  });

  it("a removed task and a read-only business take no step changes", async () => {
    const task = await newTask(member, { title: "תוסר" });
    const step = await addStep(member, task, "שלב");
    await asAdmin((q) => q("update public.tasks set deleted_at = now() where id = $1", [task]));
    expect((await pgError(addStep(admin, task))).code).toBe("42501");
    expect(await asUser(admin.id, async (q) => (await q("update public.task_checklist_items set done = true where id = $1", [step])).rowCount)).toBe(0);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(addStep(member, taskOwn))).code).toBe("42501");
      expect(await asUser(owner.id, async (q) => (await q("update public.task_checklist_items set done = true where task_id = $1", [taskOwn])).rowCount)).toBe(0);
      expect(await asUser(owner.id, async (q) => (await q("delete from public.task_checklist_items where task_id = $1", [taskOwn])).rowCount)).toBe(0);
      expect(await steps(member, taskOwn)).toBeGreaterThan(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a recurring task hands its steps to the next one, unticked; deleting a task removes its steps", async () => {
    const task = await newTask(member, { title: "שבועית", due_at: "2026-11-01T09:00:00Z", recurrence: { kind: "weekly", weekdays: [0] } });
    const first = await addStep(member, task, "ראשון");
    await addStep(member, task, "שני");
    await asUser(member.id, (q) => q("update public.task_checklist_items set done = true where id = $1", [first]));
    expect(await asUser(member.id, async (q) => (await q("update public.tasks set status = 'done' where id = $1", [task])).rowCount)).toBe(1);
    const next = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.tasks where recurrence_source_id = $1", [task])).rows[0].id);
    const carried = await asUser(member.id, async (q) =>
      (await q<{ title: string; done: boolean }>("select title, done from public.task_checklist_items where task_id = $1 order by position, title", [next])).rows,
    );
    expect(carried.map((r) => r.title).sort()).toEqual(["ראשון", "שני"]);
    expect(carried.every((r) => !r.done)).toBe(true);
    // the steps go with their task
    await asAdmin((q) => q("delete from public.tasks where id = $1", [next]));
    expect(await asAdmin((q) => count(q, "select 1 from public.task_checklist_items where task_id = $1", [next]))).toBe(0);
  });

  it("templates: seeded, read by every member, written by owners and admins, checked and capped", async () => {
    const names = await asUser(viewer.id, async (q) => (await q<{ name: string }>("select name from public.checklist_templates where organization_id = $1 order by position", [org])).rows.map((r) => r.name));
    expect(names).toEqual(["קליטת לקוח", "הכנה לפגישה"]);
    const add = (who: U, name: string, list: string[]) =>
      asUser(who.id, (q) => q("insert into public.checklist_templates (organization_id, name, steps) values ($1, $2, $3)", [org, name, list]));
    for (const who of [manager, member, viewer]) {
      expect((await pgError(add(who, "של " + who.email.slice(0, 8), ["א"]))).code).toBe("42501");
      expect(await asUser(who.id, async (q) => (await q("update public.checklist_templates set name = name")).rowCount)).toBe(0);
      expect(await asUser(who.id, async (q) => (await q("delete from public.checklist_templates")).rowCount)).toBe(0);
    }
    await add(admin, "החזרת ציוד", ["איסוף", "בדיקה"]);
    expect(await asUser(owner.id, async (q) => (await q("update public.checklist_templates set steps = '{א,ב,ג}' where organization_id = $1 and name = 'החזרת ציוד'", [org])).rowCount)).toBe(1);
    // the same name once, ignoring case
    expect((await pgError(add(admin, "החזרת ציוד", ["x"]))).code).toBe("23505");
    // 1..50 steps, each 1..200 characters with no outer spaces
    expect((await pgError(add(admin, "ריקה", []))).code).toBe("23514");
    expect((await pgError(add(admin, "שלב ריק", ["א", " "]))).code).toBe("23514");
    expect((await pgError(add(admin, "ארוכה", Array.from({ length: 51 }, (_, i) => `שלב ${i}`)))).code).toBe("23514");
    expect((await pgError(add(admin, "שלב ארוך", ["x".repeat(201)]))).code).toBe("23514");
    // at most 50
    await asAdmin((q) =>
      q("insert into public.checklist_templates (organization_id, name, steps) select $1, 'תבנית ' || g, '{א}' from generate_series(1, 47) g", [org]),
    );
    expect((await pgError(add(admin, "החמישים ואחת", ["א"]))).hint).toBe("checklist_templates:max");
    // an outsider gets the plain refusal
    expect((await pgError(add(outsider, "זרה", ["א"]))).code).toBe("42501");
    // a read-only business keeps them but changes none
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await asUser(owner.id, async (q) => (await q("update public.checklist_templates set name = name where organization_id = $1", [org])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("two writers at once cannot pass 100 steps (the lock per task)", async () => {
    const task = await newTask(member, { title: "בו זמנית" });
    await asUser(member.id, (q) =>
      q("insert into public.task_checklist_items (organization_id, task_id, title, position) select $1, $2, 'שלב ' || g, g from generate_series(1, 99) g", [org, task]),
    );
    // the first writer adds the 100th and holds its transaction open; the second starts meanwhile
    const first = asUser(member.id, async (q) => {
      await q("insert into public.task_checklist_items (organization_id, task_id, title) values ($1, $2, 'המאה')", [org, task]);
      await q("select pg_sleep(0.8)");
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = pgError(addStep(admin, task, "המאה ואחד"));
    await first;
    expect((await second).hint).toBe("task_checklist:max");
    expect(await asAdmin((q) => count(q, "select 1 from public.task_checklist_items where task_id = $1", [task]))).toBe(100);
  });

  it("a creator deletes steps only while they may write: not in a read-only business, not as a viewer", async () => {
    // the manager creates a task for a colleague: the creator clause
    const task = await newTask(manager, { title: "של היוצר", owner_id: member2.id });
    const step = await addStep(manager, task, "שלב");
    const remove = () => asUser(manager.id, async (q) => (await q("delete from public.task_checklist_items where id = $1", [step])).rowCount);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await remove()).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    // made a viewer (written without the seat triggers): still the creator, but no longer a writer
    const setRole = (role: string, seat: string) =>
      asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.memberships set role = $3, seat_type = $4 where organization_id = $1 and user_id = $2", [org, manager.id, role, seat]);
      });
    await setRole("viewer", "view");
    try {
      expect(await remove()).toBe(0);
    } finally {
      await setRole("manager", "full");
    }
    expect(await remove()).toBe(1);
  });

  it("a deputy works the steps of the absent person's open tasks, during the absence only", async () => {
    const open = await newTask(member, { title: "פתוחה של הנעדר" });
    const closed = await newTask(member, { title: "סגורה של הנעדר" });
    const closedStep = await addStep(member, closed, "שלב בסגורה");
    await asUser(member.id, (q) => q("update public.tasks set status = 'done' where id = $1", [closed]));
    // before the absence: refused
    expect((await pgError(addStep(member2, open, "לפני"))).code).toBe("42501");
    await asAdmin((q) =>
      q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date - 1, current_date + 1, 'reserve', $3)", [org, member.id, member2.id]),
    );
    try {
      const step = await addStep(member2, open, "של הממלא מקום");
      expect(await asUser(member2.id, async (q) => (await q("update public.task_checklist_items set done = true where id = $1", [step])).rowCount)).toBe(1);
      expect(await asUser(member2.id, async (q) => (await q("delete from public.task_checklist_items where id = $1", [step])).rowCount)).toBe(1);
      // not on a closed task
      expect((await pgError(addStep(member2, closed, "בסגורה"))).code).toBe("42501");
      expect(await asUser(member2.id, async (q) => (await q("update public.task_checklist_items set done = true where id = $1", [closedStep])).rowCount)).toBe(0);
      expect(await asUser(member2.id, async (q) => (await q("delete from public.task_checklist_items where id = $1", [closedStep])).rowCount)).toBe(0);
      // and nobody else gains anything
      expect((await pgError(addStep(manager, open, "מנהל בלי צוות"))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1", [org]));
    }
    expect((await pgError(addStep(member2, open, "אחרי"))).code).toBe("42501");
  });

  it("sample data with steps a person added is kept when the samples are removed", async () => {
    const sampleOwner = await createUser("chk-sample");
    const sampleOrg = await createOrg(sampleOwner.id);
    await asUser(sampleOwner.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
    const tasks = await asAdmin(async (q) =>
      (await q<{ id: string; linked: boolean }>(
        `select t.id, (t.lead_id is not null or t.contact_id is not null or t.company_id is not null or t.deal_id is not null) as linked
           from app.sample_records r join public.tasks t on t.organization_id = r.organization_id and t.id = r.task_id
          where r.organization_id = $1 order by linked`,
        [sampleOrg],
      )).rows,
    );
    expect(tasks.length).toBeGreaterThan(0);
    const kept = tasks[0].id;
    await asUser(sampleOwner.id, (q) => q("insert into public.task_checklist_items (organization_id, task_id, title) values ($1, $2, 'שלב אמיתי')", [sampleOrg, kept]));
    await asUser(sampleOwner.id, (q) => q("select public.sample_data_remove($1)", [sampleOrg]));
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = $1", [kept]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.task_checklist_items where task_id = $1", [kept]))).toBe(1);
    // the samples nobody worked on are gone
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where organization_id = $1 and id <> $2", [sampleOrg, kept]))).toBe(0);
  });
});
