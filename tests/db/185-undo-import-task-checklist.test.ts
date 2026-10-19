import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// RVW-36: undoing one's own import keeps an imported task someone worked on through its checklist
// (TASK-06): a step added after the import, or any step that is done. Steps do not touch the task row.
describe("undo of one's own task import keeps tasks worked on through their checklist (RVW-36)", () => {
  let owner: U, holder: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("rvw36-owner");
    org = await createOrg(owner.id, "עסק משימות");
    // undo_own_import is for a member who holds the import permission (PRM-01), as in test 111
    holder = await addMember(org, owner.id, "member", "rvw36-holder");
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, holder.id, ["import"]]));
  });

  it("a task with a step added later, or a done step, stays; an untouched task goes", async () => {
    const job = await asUser(holder.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'task', 't.csv', 'skip') returning id", [org])).rows[0].id,
    );
    const [added, ticked, untouched] = await asUser(holder.id, async (q) => {
      const ids: string[] = [];
      for (const title of ["שלב נוסף", "שלב סומן", "לא נגעו"]) {
        ids.push((await q<{ id: string }>("insert into public.tasks (organization_id, title, import_job_id) values ($1, $2, $3) returning id", [org, title, job])).rows[0].id);
      }
      await q("update public.import_jobs set status = 'done', created_count = 3 where id = $1", [job]);
      return ids;
    });
    // later: a step added to one task, a step ticked on another
    await asUser(owner.id, async (q) => {
      await q("insert into public.task_checklist_items (organization_id, task_id, title) values ($1, $2, 'לבדוק')", [org, added]);
      await q("insert into public.task_checklist_items (organization_id, task_id, title) values ($1, $2, 'נעשה')", [org, ticked]);
      await q("update public.task_checklist_items set done = true where task_id = $1", [ticked]);
    });
    // the ticked step counts by itself, even if it was there from the start
    await asAdmin((q) =>
      q("update public.task_checklist_items i set created_at = t.created_at from public.tasks t where t.id = i.task_id and i.task_id = $1", [ticked]),
    );
    // the steps did not touch the task rows
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = any($1) and updated_at = created_at", [[added, ticked, untouched]]))).toBe(3);

    const result = await asUser(holder.id, async (q) =>
      (await q<{ r: { done: number; kept: number } }>("select public.undo_own_import($1, $2) as r", [org, job])).rows[0].r,
    );
    expect(result).toEqual({ done: 1, kept: 2 });
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = any($1) and deleted_at is null", [[added, ticked]]))).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = $1 and deleted_at is not null", [untouched]))).toBe(1);
    // the kept tasks' steps are still there
    expect(await asAdmin((q) => count(q, "select 1 from public.task_checklist_items where task_id = any($1)", [[added, ticked]]))).toBe(2);
  });
});
