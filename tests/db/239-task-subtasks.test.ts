import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * TASK-06 part B (owner, 25 October 2026): a sub-task is an ordinary task with parent_task_id, one level only. It takes
 * the parent's record link; only someone who may update the parent adds one; it does not repeat, and a recurring parent's
 * next occurrence starts without sub-tasks. Removing the parent takes its sub-tasks to the bin, restoring brings them back.
 */
describe("sub-tasks (TASK-06 part B)", () => {
  let owner: U, admin: U, manager: U, m1: U, m2: U, viewer: U, stranger: U;
  let org: string, otherOrg: string;
  let leadM1: string, leadOwner: string;

  const newTask = (user: U, fields: Record<string, unknown> = {}, orgId = org) =>
    asUser(user.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: orgId, title: "משימה", ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.tasks (${cols.join(", ")}) values (${cols.map((c, i) => (c === "recurrence" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ")}) returning id`,
          Object.values(row).map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)),
        )
      ).rows[0].id;
    });
  const row = (id: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ parent_task_id: string | null; lead_id: string | null; contact_id: string | null; deleted_at: string | null; status: string }>(
            "select parent_task_id, lead_id, contact_id, deleted_at, status from public.tasks where id = $1",
            [id],
          )
        ).rows[0],
    );

  beforeAll(async () => {
    owner = await createUser("sub-owner");
    org = await createOrg(owner.id, "עסק תתי-משימות");
    admin = await addMember(org, owner.id, "admin", "sub-admin");
    manager = await addMember(org, owner.id, "manager", "sub-manager");
    m1 = await addMember(org, owner.id, "member", "sub-m1");
    m2 = await addMember(org, owner.id, "member", "sub-m2");
    viewer = await addMember(org, owner.id, "viewer", "sub-viewer");
    stranger = await createUser("sub-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    leadM1 = await insertLead(m1.id, org, { full_name: "ליד של m1" });
    leadOwner = await insertLead(owner.id, org, { full_name: "ליד של הבעלים" });
  });

  it("a sub-task takes its parent's record link, whatever was sent", async () => {
    const parent = await newTask(m1, { title: "הורה", lead_id: leadM1 });
    const child = await newTask(m1, { title: "בת", parent_task_id: parent });
    expect(await row(child)).toMatchObject({ parent_task_id: parent, lead_id: leadM1, contact_id: null });
    // a link sent with it is replaced by the parent's
    const contact = await asUser(m1.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id);
    const child2 = await newTask(m1, { title: "בת 2", parent_task_id: parent, contact_id: contact });
    expect(await row(child2)).toMatchObject({ lead_id: leadM1, contact_id: null });
    // a person may not move a sub-task to another record on its own
    const moved = await pgError(asUser(m1.id, (q) => q("update public.tasks set contact_id = $2 where id = $1", [child, contact])));
    expect(moved.hint).toBe("task:subtask_links");
    // the parent's change reaches its sub-tasks
    await asUser(m1.id, (q) => q("update public.tasks set lead_id = null, contact_id = $2 where id = $1", [parent, contact]));
    expect(await row(child)).toMatchObject({ lead_id: null, contact_id: contact });
    expect(await row(child2)).toMatchObject({ lead_id: null, contact_id: contact });
  });

  it("one level only, both ways", async () => {
    const parent = await newTask(m1, { title: "הורה" });
    const child = await newTask(m1, { title: "בת", parent_task_id: parent });
    // a sub-task has no sub-tasks
    expect((await pgError(newTask(m1, { title: "נכדה", parent_task_id: child }))).hint).toBe("task:subtask_depth");
    // a task with sub-tasks does not become one (a server write; clients cannot change parent_task_id at all)
    const other = await newTask(m1, { title: "אחרת" });
    expect((await pgError(asAdmin((q) => q("update public.tasks set parent_task_id = $2 where id = $1", [parent, other]))))).toMatchObject({ hint: "task:subtask_depth" });
    // nor from the edit form (owner, answer (3) ב: picking a parent is allowed, but not one level deeper)
    expect((await pgError(asUser(m1.id, (q) => q("update public.tasks set parent_task_id = $2 where id = $1", [parent, other]))))).toMatchObject({ hint: "task:subtask_depth" });
    expect((await pgError(asUser(m1.id, (q) => q("update public.tasks set parent_task_id = $2 where id = $1", [other, child]))))).toMatchObject({ hint: "task:subtask_depth" });
    // not its own parent
    expect((await pgError(asAdmin((q) => q("update public.tasks set parent_task_id = id where id = $1", [other]))))).toMatchObject({ code: "23514" });
  });

  it("only within the business, under a parent the person may update and see", async () => {
    const parent = await newTask(m1, { title: "של m1" });
    // another business: not found (RLS), and the composite key holds for any writer
    expect((await pgError(newTask(stranger, { title: "זר", parent_task_id: parent }, otherOrg))).code).toBe("42501");
    const strangerTask = await newTask(stranger, { title: "זרה" }, otherOrg);
    expect((await pgError(asAdmin((q) => q("insert into public.tasks (organization_id, title, parent_task_id) values ($1, 'x', $2)", [org, strangerTask]))))).toMatchObject({
      hint: "task:parent",
    });
    // another member cannot see or update it
    expect((await pgError(newTask(m2, { title: "של m2", parent_task_id: parent }))).hint).toBe("task:parent");
    // a viewer writes nothing
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    try {
      expect((await pgError(newTask(viewer, { title: "צופה", parent_task_id: parent }))).code).toBe("42501");
      // seeing it is not enough: m2 sees every task now but may not update m1's
      expect((await pgError(newTask(m2, { title: "של m2", parent_task_id: parent }))).hint).toBe("task:parent");
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    }
    // owners and admins may, and so may whoever created the task for someone else
    expect(await newTask(admin, { title: "של מנהלת", parent_task_id: parent })).toMatch(/^[0-9a-f-]{36}$/);
    const handed = await newTask(manager, { title: "בשבילך", owner_id: m2.id });
    expect(await newTask(manager, { title: "בת של היוצר", parent_task_id: handed })).toMatch(/^[0-9a-f-]{36}$/);
    // a removed parent takes no sub-tasks
    const removed = await newTask(m1, { title: "תוסר" });
    await asAdmin((q) => q("update public.tasks set deleted_at = now() where id = $1", [removed]));
    expect((await pgError(newTask(m1, { title: "בת", parent_task_id: removed }))).hint).toBe("task:parent");
  });

  it("a member handed a task on a record they cannot read may still split it", async () => {
    // the owner's own lead; m1 cannot read it ('own')
    const parent = await newTask(owner, { title: "על ליד של הבעלים", lead_id: leadOwner, owner_id: m1.id });
    expect((await pgError(newTask(m1, { title: "קישור ישיר", lead_id: leadOwner }))).code).toBe("42501");
    const child = await newTask(m1, { title: "בת", parent_task_id: parent });
    expect(await row(child)).toMatchObject({ lead_id: leadOwner });
  });

  it("a sub-task does not repeat; a recurring parent's next occurrence starts without sub-tasks", async () => {
    const parent = await newTask(m1, { title: "חוזרת", due_at: new Date(Date.now() + 86_400_000).toISOString(), recurrence: { kind: "daily" } });
    const child = await newTask(m1, { title: "בת", parent_task_id: parent });
    expect((await pgError(newTask(m1, { title: "בת חוזרת", parent_task_id: parent, recurrence: { kind: "daily" } }))).hint).toBe("task:subtask_recurrence");
    expect((await pgError(asUser(m1.id, (q) => q(`update public.tasks set recurrence = '{"kind":"daily"}'::jsonb where id = $1`, [child]))))).toMatchObject({
      hint: "task:subtask_recurrence",
    });
    await asUser(m1.id, (q) => q("update public.tasks set status = 'done' where id = $1", [parent]));
    const next = await asAdmin(async (q) => (await q<{ id: string; parent_task_id: string | null }>("select id, parent_task_id from public.tasks where recurrence_source_id = $1", [parent])).rows);
    expect(next).toHaveLength(1);
    expect(next[0].parent_task_id).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where parent_task_id = $1", [next[0].id]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where parent_task_id = $1", [parent]))).toBe(1);
  });

  it("completing a parent with open sub-tasks is not refused; counts read from the rows", async () => {
    const parent = await newTask(m1, { title: "הורה" });
    const a = await newTask(m1, { title: "א", parent_task_id: parent });
    await newTask(m1, { title: "ב", parent_task_id: parent });
    await newTask(m1, { title: "ג", parent_task_id: parent });
    await asUser(m1.id, (q) => q("update public.tasks set status = 'done' where id = $1", [a]));
    const counts = await asUser(m1.id, async (q) =>
      (await q<{ done: string; total: string }>("select count(*) filter (where status = 'done') as done, count(*) as total from public.tasks where parent_task_id = $1 and deleted_at is null", [parent])).rows[0],
    );
    expect(counts).toEqual({ done: "1", total: "3" });
    expect(await asUser(m1.id, async (q) => (await q("update public.tasks set status = 'done' where id = $1", [parent])).rowCount)).toBe(1);
  });

  it("removing the parent takes its sub-tasks to the bin; restoring brings back those that went with it", async () => {
    const parent = await newTask(m1, { title: "הורה" });
    const a = await newTask(m1, { title: "א", parent_task_id: parent });
    const b = await newTask(admin, { title: "ב", parent_task_id: parent, owner_id: m2.id });
    const early = await newTask(m1, { title: "הוסרה קודם", parent_task_id: parent });
    await asAdmin((q) => q("update public.tasks set deleted_at = now() - interval '1 hour' where id = $1", [early]));
    // an admin removes the parent (tasks have no bin screen; the rule holds for every writer)
    await asUser(admin.id, (q) => q("update public.tasks set deleted_at = now() where id = $1", [parent]));
    const removedAt = (await row(parent)).deleted_at;
    expect(removedAt).not.toBeNull();
    expect((await row(a)).deleted_at).toEqual(removedAt);
    expect((await row(b)).deleted_at).toEqual(removedAt);
    // a member cannot restore it alone
    expect((await pgError(asUser(m1.id, (q) => q("update public.tasks set deleted_at = null where id = $1", [parent])))).code).toBe("42501");
    await asUser(admin.id, (q) => q("update public.tasks set deleted_at = null where id = $1", [parent]));
    expect((await row(a)).deleted_at).toBeNull();
    expect((await row(b)).deleted_at).toBeNull();
    expect((await row(early)).deleted_at).not.toBeNull();
    // a purge removes them together; a sub-task restored alone survives the parent's purge as a plain task
    await asUser(admin.id, (q) => q("update public.tasks set deleted_at = now() where id = $1", [parent]));
    await asAdmin((q) => q("update public.tasks set deleted_at = null where id = $1", [b]));
    await asUser(admin.id, (q) => q("delete from public.tasks where id = $1", [parent]));
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = $1", [parent]))).toBe(0);
    expect(await row(b)).toMatchObject({ parent_task_id: null, deleted_at: null });
  });

  it("a sub-task keeps a sample task and marks an imported task as worked on", async () => {
    const parent = await newTask(owner, { title: "לבדיקה" });
    const before = await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.import_record_worked($1, 'task', $2, now() - interval '1 day', null) as ok", [org, parent])).rows[0].ok);
    expect(before).toBe(false);
    await newTask(owner, { title: "בת", parent_task_id: parent });
    const after = await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.import_record_worked($1, 'task', $2, now() - interval '1 day', null) as ok", [org, parent])).rows[0].ok);
    expect(after).toBe(true);
    const snapshot = await asAdmin(async (q) => (await q<{ s: unknown }>("select app.sample_row($1, 'task', $2) as s", [org, parent])).rows[0].s);
    const untouched = await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.sample_untouched($1, 'task', $2, $3::jsonb) as ok", [org, parent, JSON.stringify(snapshot)])).rows[0].ok);
    expect(untouched).toBe(false);
  });

  describe("linking an existing task from its edit form, and detaching it (owner, answer (3) ב)", () => {
    const link = (user: U, task: string, parent: string | null) =>
      asUser(user.id, async (q) => (await q("update public.tasks set parent_task_id = $2 where id = $1", [task, parent])).rowCount);

    it("the update grant lets a person link: the task takes the parent's record", async () => {
      const contact = await asUser(m1.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'רות') returning id", [org])).rows[0].id);
      const parent = await newTask(m1, { title: "הורה", lead_id: leadM1 });
      const task = await newTask(m1, { title: "קיימת", contact_id: contact });
      expect(await link(m1, task, parent)).toBe(1);
      expect(await row(task)).toMatchObject({ parent_task_id: parent, lead_id: leadM1, contact_id: null });
      // the column is granted for update (not only through a definer path)
      const granted = await asAdmin(async (q) => (await q<{ ok: boolean }>("select has_column_privilege('authenticated', 'public.tasks', 'parent_task_id', 'UPDATE') as ok")).rows[0].ok);
      expect(granted).toBe(true);
      // and only that column: the insert grant stays column-level (a bare "grant insert, update (col)" grants the whole table)
      const table = await asAdmin(async (q) => (await q<{ ins: boolean; upd: boolean }>("select has_table_privilege('authenticated', 'public.tasks', 'INSERT') as ins, has_table_privilege('authenticated', 'public.tasks', 'UPDATE') as upd")).rows[0]);
      expect(table).toEqual({ ins: false, upd: false });
    });

    it("detaching keeps the links and the task's own bin state; then its links may be edited", async () => {
      const contact = await asUser(m1.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'גיל') returning id", [org])).rows[0].id);
      const parent = await newTask(m1, { title: "הורה", lead_id: leadM1 });
      const child = await newTask(m1, { title: "בת", parent_task_id: parent });
      expect(await link(m1, child, null)).toBe(1);
      expect(await row(child)).toMatchObject({ parent_task_id: null, lead_id: leadM1, deleted_at: null });
      expect(await asUser(m1.id, async (q) => (await q("update public.tasks set lead_id = null, contact_id = $2 where id = $1", [child, contact])).rowCount)).toBe(1);
      expect(await row(child)).toMatchObject({ lead_id: null, contact_id: contact });
      // a sub-task removed on its own keeps its removal when detached (a server write: tasks have no bin screen)
      const binned = await newTask(m1, { title: "בסל", parent_task_id: parent });
      await asAdmin((q) => q("update public.tasks set deleted_at = now() where id = $1", [binned]));
      await asAdmin((q) => q("update public.tasks set parent_task_id = null where id = $1", [binned]));
      expect((await row(binned)).deleted_at).not.toBeNull();
      // a detached task no longer goes to the bin with its old parent
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = now() where id = $1", [parent]));
      expect((await row(child)).deleted_at).toBeNull();
    });

    it("refusals: a sub-task as parent, a task with sub-tasks, another business, an unreadable or removed parent, no right, a repeat", async () => {
      const top = await newTask(m1, { title: "עליונה" });
      const sub = await newTask(m1, { title: "בת", parent_task_id: top });
      const plain = await newTask(m1, { title: "רגילה" });
      // a sub-task as parent
      expect((await pgError(link(m1, plain, sub))).hint).toBe("task:subtask_depth");
      // a task with sub-tasks cannot become one
      const other = await newTask(m1, { title: "אחרת" });
      expect((await pgError(link(m1, top, other))).hint).toBe("task:subtask_depth");
      // another business: not found in this one, for a person and for the server alike
      const foreign = await newTask(stranger, { title: "זרה" }, otherOrg);
      expect((await pgError(link(m1, plain, foreign))).hint).toBe("task:parent");
      expect((await pgError(asAdmin((q) => q("update public.tasks set parent_task_id = $2 where id = $1", [plain, foreign]))))).toMatchObject({ hint: "task:parent" });
      // a parent the person cannot read ('own': m2's task)
      const ofM2 = await newTask(m2, { title: "של m2" });
      expect((await pgError(link(m1, plain, ofM2))).hint).toBe("task:parent");
      // readable but not updatable: visibility 'org' lets m1 see m2's task, not edit it
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      try {
        expect((await pgError(link(m1, plain, ofM2))).hint).toBe("task:parent");
        // and m2 cannot link m1's task under its own: no right on the task itself (RLS, nothing changes)
        expect(await link(m2, plain, ofM2)).toBe(0);
      } finally {
        await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      }
      // a removed parent
      const removed = await newTask(m1, { title: "בסל" });
      await asAdmin((q) => q("update public.tasks set deleted_at = now() where id = $1", [removed]));
      expect((await pgError(link(m1, plain, removed))).hint).toBe("task:parent");
      // a repeating task is not linked until its repeat is cleared, in the same save or before
      const repeating = await newTask(m1, { title: "חוזרת", due_at: new Date(Date.now() + 86_400_000).toISOString(), recurrence: { kind: "daily" } });
      expect((await pgError(link(m1, repeating, top))).hint).toBe("task:subtask_recurrence");
      expect(await asUser(m1.id, async (q) => (await q("update public.tasks set parent_task_id = $2, recurrence = null where id = $1", [repeating, top])).rowCount)).toBe(1);
      expect(await row(plain)).toMatchObject({ parent_task_id: null });
    });
  });
  describe("review fixes (TASK-06 part B)", () => {
    type Links = { lead_id: string | null; contact_id: string | null; company_id: string | null; deal_id: string | null; parent_task_id: string | null };
    const links = (id: string) =>
      asAdmin(async (q) => (await q<Links>("select lead_id, contact_id, company_id, deal_id, parent_task_id from public.tasks where id = $1", [id])).rows[0]);
    const link = (user: U, task: string, parent: string | null) =>
      asUser(user.id, async (q) => (await q("update public.tasks set parent_task_id = $2 where id = $1", [task, parent])).rowCount);
    const deletedAt = async (id: string) => (await row(id)).deleted_at;
    const newContact = (user: U, name: string) =>
      asUser(user.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).rows[0].id);

    it("conversion: an open sub-task of a done parent carries its whole family to the contact and deal", async () => {
      const lead = await insertLead(m1.id, org, { full_name: "ליד להמרה עם משפחה" });
      const parent = await newTask(m1, { title: "הורה", lead_id: lead });
      const open = await newTask(m1, { title: "פתוחה", parent_task_id: parent });
      const done = await newTask(m1, { title: "גמורה", parent_task_id: parent });
      await asUser(m1.id, (q) => q("update public.tasks set status = 'done' where id = any($1)", [[parent, done]]));
      const r = await asUser(m1.id, async (q) =>
        (await q<{ r: { contact_id: string; deal_id: string } }>("select public.convert_lead($1, true, null, 1000) as r", [lead])).rows[0].r,
      );
      const expected = { lead_id: lead, contact_id: r.contact_id, deal_id: r.deal_id };
      expect(await links(open)).toMatchObject(expected);
      expect(await links(parent)).toMatchObject(expected);
      expect(await links(done)).toMatchObject(expected);
    });

    it("a server write that moves one sub-task carries the family; a merge moves it together", async () => {
      const a = await newContact(owner, "מקור");
      const b = await newContact(owner, "יעד");
      const parent = await newTask(owner, { title: "הורה", contact_id: a });
      const c1 = await newTask(owner, { title: "בת 1", parent_task_id: parent });
      const c2 = await newTask(owner, { title: "בת 2", parent_task_id: parent });
      await asAdmin((q) => q("update public.tasks set contact_id = $2 where id = $1", [c1, b]));
      for (const id of [parent, c1, c2]) expect(await links(id)).toMatchObject({ contact_id: b });
      // a merge moves every task of the duplicate in one statement: the family stays together on the kept contact
      const keep = await newContact(owner, "נשמר");
      await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, b]));
      for (const id of [parent, c1, c2]) expect(await links(id)).toMatchObject({ contact_id: keep });
    });

    it("a lead's call-back task is kept out of families, both ways", async () => {
      const call = await newTask(m1, { title: "להתקשר", lead_id: leadM1 });
      await asAdmin((q) => q("insert into app.intake_callback_tasks (task_id, organization_id, lead_id) values ($1, $2, $3)", [call, org, leadM1]));
      const parent = await newTask(m1, { title: "הורה" });
      expect((await pgError(link(m1, call, parent))).hint).toBe("task:subtask_callback");
      expect((await pgError(newTask(m1, { title: "בת", parent_task_id: call }))).hint).toBe("task:subtask_callback");
      const plain = await newTask(m1, { title: "רגילה" });
      expect((await pgError(link(m1, plain, call))).hint).toBe("task:subtask_callback");
      // a person learns whether a task is a call-back task, or has sub-tasks, only in their own business
      const asked = await asUser(stranger.id, async (q) =>
        (await q<{ cb: boolean; subs: boolean }>("select app.task_is_callback($1, $2) as cb, app.task_has_subtasks($1, $3) as subs", [org, call, parent])).rows[0],
      );
      await newTask(m1, { title: "בת", parent_task_id: parent });
      const again = await asUser(stranger.id, async (q) => (await q<{ subs: boolean }>("select app.task_has_subtasks($1, $2) as subs", [org, parent])).rows[0]);
      expect(asked).toEqual({ cb: false, subs: false });
      expect(again.subs).toBe(false);
      expect(await asUser(m1.id, async (q) => (await q<{ subs: boolean }>("select app.task_has_subtasks($1, $2) as subs", [org, parent])).rows[0].subs)).toBe(true);
    });

    it("linking keeps the insert rule: a team manager links a member's task, a deputy links the absent person's", async () => {
      const team = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות תתי-משימות') returning id", [org])).rows[0].id);
      await asAdmin((q) =>
        q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false)", [org, team, manager.id, m1.id]),
      );
      const ofMember = await newTask(m1, { title: "של חבר הצוות", team_id: team });
      const leadManager = await insertLead(manager.id, org, { full_name: "ליד של המנהל" });
      const ofManager = await newTask(manager, { title: "של המנהל", lead_id: leadManager });
      expect(await link(manager, ofMember, ofManager)).toBe(1);
      expect(await links(ofMember)).toMatchObject({ parent_task_id: ofManager, lead_id: leadManager });

      // m2 is away today and m1 deputises: m1 may update m2's open tasks (app.task_parent_writable's deputy branch)
      const leave = await asAdmin(async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date - 1, current_date + 1, 'vacation', $3) returning id",
            [org, m2.id, m1.id],
          )
        ).rows[0].id,
      );
      try {
        const task = await newTask(m2, { title: "של m2 שנעדר" });
        const parent = await newTask(m2, { title: "אב של m2" });
        expect(await link(m1, task, parent)).toBe(1);
        expect((await links(task)).parent_task_id).toBe(parent);
      } finally {
        await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where id = $1", [leave]));
      }
    });

    it("the bin goes by the mark, not by the time", async () => {
      const parent = await newTask(m1, { title: "הורה" });
      const a = await newTask(m1, { title: "א", parent_task_id: parent });
      const early = await newTask(m1, { title: "הוסרה קודם", parent_task_id: parent });
      const t0 = await asAdmin(async (q) => (await q<{ t: string }>("update public.tasks set deleted_at = now() - interval '1 hour' where id = $1 returning deleted_at::text as t", [early])).rows[0].t);
      // the parent removed at exactly the earlier sub-task's time: restoring it still leaves that one in the bin
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = $2 where id = $1", [parent, t0]));
      expect(await deletedAt(a)).toEqual(await deletedAt(parent));
      // the removed parent's time changed: the one that went with it follows (they are purged together)
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = now() - interval '2 days' where id = $1", [parent]));
      expect(await deletedAt(a)).toEqual(await deletedAt(parent));
      expect(await deletedAt(early)).toEqual(await asAdmin(async (q) => (await q<{ t: Date }>("select $1::timestamptz as t", [t0])).rows[0].t));
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = null where id = $1", [parent]));
      expect(await deletedAt(a)).toBeNull();
      expect(await deletedAt(early)).not.toBeNull();

      // one restored alone and removed alone again at the parent's time no longer comes back with it
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = now() where id = $1", [parent]));
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = null where id = $1", [a]));
      const parentAt = await asAdmin(async (q) => (await q<{ t: string }>("select deleted_at::text as t from public.tasks where id = $1", [parent])).rows[0].t);
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = $2 where id = $1", [a, parentAt]));
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = null where id = $1", [parent]));
      expect(await deletedAt(a)).not.toBeNull();
      // the mark is the server's
      expect((await pgError(asUser(admin.id, (q) => q("update public.tasks set binned_with_parent = true where id = $1", [a])))).code).toBe("42501");
    });

    it("the nightly purge removes a family binned together", async () => {
      const parent = await newTask(m1, { title: "הורה ישן" });
      const child = await newTask(m1, { title: "בת ישנה", parent_task_id: parent });
      await asUser(admin.id, (q) => q("update public.tasks set deleted_at = now() - interval '31 days' where id = $1", [parent]));
      expect(await deletedAt(child)).toEqual(await deletedAt(parent));
      await asAdmin((q) => q("select app.purge_trash()"));
      expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = any($1)", [[parent, child]]))).toBe(0);
    });

    it("imports: an imported task may be linked; undo refuses a task a person gave sub-tasks", async () => {
      const importTasks = (titles: string[]) =>
        asUser(owner.id, async (q) => {
          const job = (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'task', 't.csv', 'skip') returning id", [org])).rows[0].id;
          const ids: string[] = [];
          for (const title of titles) {
            ids.push((await q<{ id: string }>("insert into public.tasks (organization_id, title, import_job_id) values ($1, $2, $3) returning id", [org, title, job])).rows[0].id);
          }
          await q("update public.import_jobs set status = 'done' where id = $1", [job]);
          return { job, ids };
        });
      const undo = (job: string) => asUser(owner.id, (q) => q("select public.undo_import($1, $2)", [org, job]));

      // linking an imported task under a person's task: allowed; it keeps its import and can still be undone alone
      const parent = await newTask(owner, { title: "של אדם", lead_id: leadOwner });
      const one = await importTasks(["מיובאת"]);
      expect(await link(owner, one.ids[0], parent)).toBe(1);
      expect(await links(one.ids[0])).toMatchObject({ parent_task_id: parent, lead_id: leadOwner });
      await undo(one.job);
      expect(await deletedAt(one.ids[0])).not.toBeNull();
      expect(await deletedAt(parent)).toBeNull();

      // an imported task a person split is worked on: the undo refuses with its own hint, counts it, and moves nothing
      const two = await importTasks(["מיובאת 1", "מיובאת 2"]);
      const sub = await newTask(owner, { title: "בת של מיובאת", parent_task_id: two.ids[0] });
      const refused = await pgError(undo(two.job));
      expect(refused.hint).toBe("import_undo:subtasks");
      expect((refused as { detail?: string }).detail).toBe("1");
      for (const id of [...two.ids, sub]) expect(await deletedAt(id)).toBeNull();
      // a sub-task only in the bin does not block it: the undo goes through and the removed sub-task stays removed
      await asAdmin((q) => q("update public.tasks set deleted_at = now() where id = $1", [sub]));
      await undo(two.job);
      for (const id of two.ids) expect(await deletedAt(id)).not.toBeNull();
    });
  });
});
