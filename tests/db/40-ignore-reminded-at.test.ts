import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, count, createOrg, createUser } from "./helpers";

afterAll(closePool);

describe("a task reminder is not a change to the task (FXD-03)", () => {
  let owner: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("remind-owner");
    org = await createOrg(owner.id);
  });

  it("sending a reminder writes no audit entry and queues no event", async () => {
    const task = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, due_at, remind_at) values ($1, 'להתקשר', now() + interval '10 minutes', now() - interval '1 minute') returning id", [org])).rows[0].id,
    );
    await asAdmin((q) => q("select app.send_task_reminders()"));
    const reminded = await asAdmin(async (q) => (await q<{ at: string | null }>("select reminded_at as at from public.tasks where id = $1", [task])).rows[0].at);
    expect(reminded).not.toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and action = 'update'", [task]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = $1 and event_type = 'task.updated'", [task]))).toBe(0);
    // a real change is still logged
    await asUser(owner.id, (q) => q("update public.tasks set title = 'להתקשר שוב' where id = $1", [task]));
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and action = 'update'", [task]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = $1 and event_type = 'task.updated'", [task]))).toBe(1);
  });
});
