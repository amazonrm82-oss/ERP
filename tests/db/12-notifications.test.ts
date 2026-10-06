import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const sendReminders = () => asAdmin((q) => q("select app.send_task_reminders()"));

describe("notifications, reminders and push subscriptions", () => {
  let owner: U, member: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "member");
  });

  it("a due reminder notifies the task's owner once, and changing remind_at arms it again", async () => {
    const task = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, remind_at) values ($1, 'לחזור לדני', now() - interval '1 minute') returning id", [org])).rows[0].id,
    );
    await sendReminders();
    await sendReminders();
    const reminders = () =>
      asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'task_reminder' and entity_id = $2", [member.id, task]));
    expect(await reminders()).toBe(1);
    expect(
      await asAdmin(async (q) => (await q<{ title: string }>("select title from public.notifications where entity_id = $1", [task])).rows[0].title),
    ).toBe("תזכורת: לחזור לדני");

    await asUser(member.id, (q) => q("update public.tasks set remind_at = now() - interval '10 seconds' where id = $1", [task]));
    await sendReminders();
    expect(await reminders()).toBe(2);
  });

  it("old, done or ownerless tasks are not reminded", async () => {
    await asUser(member.id, async (q) => {
      await q("insert into public.tasks (organization_id, title, remind_at) values ($1, 'ישנה', now() - interval '3 days')", [org]);
      await q("insert into public.tasks (organization_id, title, remind_at, status) values ($1, 'בוצעה', now() - interval '1 minute', 'done')", [org]);
      await q("insert into public.tasks (organization_id, title, remind_at) values ($1, 'עתידית', now() + interval '1 hour')", [org]);
    });
    await sendReminders();
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.notifications n join public.tasks t on t.id = n.entity_id where t.title in ('ישנה', 'בוצעה', 'עתידית')"),
      ),
    ).toBe(0);
  });

  it("users read and mark only their own notifications; pushed_at is the server's", async () => {
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.notifications where user_id = $1", [member.id])).toBe(0);
      expect((await q("update public.notifications set read_at = now() where user_id = $1", [member.id])).rowCount).toBe(0);
    });
    await asUser(member.id, async (q) => {
      expect((await q("update public.notifications set read_at = now() where user_id = $1", [member.id])).rowCount).toBeGreaterThan(0);
    });
    const pushed = await pgError(asUser(member.id, (q) => q("update public.notifications set pushed_at = now()")));
    expect(pushed.code).toBe("42501");
  });

  it("a push subscription belongs to the signed-in user, whatever the client sends", async () => {
    const forged = await pgError(
      asUser(member.id, (q) =>
        q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example/x', 'k', 'a')", [owner.id]),
      ),
    );
    expect(forged.code).toBe("42501");
    await asUser(member.id, (q) => q("insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/member', 'k', 'a')"));
    expect(
      await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.push_subscriptions where endpoint = 'https://push.example/member'")).rows[0].user_id),
    ).toBe(member.id);
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.push_subscriptions")).toBe(0);
      expect((await q("delete from public.push_subscriptions where endpoint = 'https://push.example/member'")).rowCount).toBe(0);
      // without WHERE only the delete policy itself filters
      expect((await q("delete from public.push_subscriptions")).rowCount).toBe(0);
    });
    const plainHttp = await pgError(
      asUser(member.id, (q) => q("insert into public.push_subscriptions (endpoint, p256dh, auth) values ('http://push.example/y', 'k', 'a')")),
    );
    expect(plainHttp.code).toBe("23514");
  });

  it("the push dispatcher claims each unread notification of a subscribed user exactly once", async () => {
    const other = await addMember(org, owner.id, "member", "nosub");
    await asAdmin(async (q) => {
      await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'system', 'לדחיפה')", [org, member.id]);
      await q("insert into public.notifications (organization_id, user_id, type, title, read_at) values ($1, $2, 'system', 'כבר נקראה', now())", [org, member.id]);
      await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'system', 'בלי מינוי')", [org, other.id]);
    });
    const claim = () =>
      asService(
        async (q) =>
          (await q<{ batch: Array<{ title: string; organization_name: string }> }>("select public.claim_push_notifications(50) as batch")).rows[0].batch,
      );
    const first = await claim();
    expect(first.map((row) => row.title)).toContain("לדחיפה");
    expect(first.map((row) => row.title)).not.toContain("כבר נקראה");
    expect(first.map((row) => row.title)).not.toContain("בלי מינוי");
    expect(first[0].organization_name).toBeTruthy();
    expect((await claim()).map((row) => row.title)).not.toContain("לדחיפה");
  });

  it("the jobs and their settings are out of the clients' reach", async () => {
    for (const sql of [
      "select app.send_task_reminders()",
      "select app.dispatch_push()",
      "select * from app.settings",
      "select public.claim_push_notifications(10)",
    ]) {
      const err = await pgError(asUser(owner.id, (q) => q(sql)));
      expect(err.code, sql).toBe("42501");
    }
    // without the dispatch settings it does nothing
    expect(await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.dispatch_push() as ok")).rows[0].ok)).toBe(false);
  });
});
