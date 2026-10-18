import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultLeadStatus } from "./helpers";

afterAll(closePool);

// FXD-06 (owner, 18 October 2026): read notifications are removed 90 days after they were made, unread ones after 180
// days, in batches (app.purge_old_notifications, 020355, pasted by hand); the recycle bin is emptied in batches of
// 1,000 rows per table a run (app.purge_trash).
describe("nightly removal in batches (FXD-06)", () => {
  const notify = (org: string, user: string, title: string, createdAt: string, readAt: string | null) =>
    asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.notifications (organization_id, user_id, type, title, created_at, read_at, pushed_at) values ($1, $2, 'system', $3, $4::timestamptz, $5::timestamptz, now()) returning id",
            [org, user, title, createdAt, readAt],
          )
        ).rows[0].id,
    );
  const exists = (id: string) => asAdmin((q) => count(q, "select 1 from public.notifications where id = $1", [id]));
  const purge = (limit?: number) =>
    asAdmin(async (q) =>
      Number((await q<{ n: number }>(limit === undefined ? "select app.purge_old_notifications() as n" : "select app.purge_old_notifications($1) as n", limit === undefined ? [] : [limit])).rows[0].n),
    );

  it("read after 90 days, unread after 180 days; newer ones stay", async () => {
    const owner = await createUser("rp-owner");
    const org = await createOrg(owner.id, "עסק התראות");
    const ago = (days: number) => `now() - interval '${days} days'`;
    const at = (days: number) => asAdmin(async (q) => (await q<{ t: string }>(`select (${ago(days)})::text as t`)).rows[0].t);
    const ids = {
      read91: await notify(org, owner.id, "נקראה לפני 91", await at(91), await at(90)),
      read89: await notify(org, owner.id, "נקראה לפני 89", await at(89), await at(88)),
      unread179: await notify(org, owner.id, "לא נקראה 179", await at(179), null),
      unread181: await notify(org, owner.id, "לא נקראה 181", await at(181), null),
      read181: await notify(org, owner.id, "נקראה 181", await at(181), await at(1)),
    };
    expect(await purge()).toBeGreaterThanOrEqual(3);
    expect(await exists(ids.read91)).toBe(0);
    expect(await exists(ids.read181)).toBe(0);
    expect(await exists(ids.unread181)).toBe(0);
    expect(await exists(ids.read89)).toBe(1);
    expect(await exists(ids.unread179)).toBe(1);
  });

  it("removes the oldest first, at most the batch size a run", async () => {
    const owner = await createUser("rb-owner");
    const org = await createOrg(owner.id, "עסק מנות");
    const first = await notify(org, owner.id, "ראשונה", "2000-01-01T00:00:00Z", null);
    const second = await notify(org, owner.id, "שנייה", "2000-01-01T00:00:01Z", null);
    const third = await notify(org, owner.id, "שלישית", "2000-01-01T00:00:02Z", null);
    expect(await purge(2)).toBe(2);
    expect([await exists(first), await exists(second), await exists(third)]).toEqual([0, 0, 1]);
    expect(await purge(1)).toBe(1);
    expect(await exists(third)).toBe(0);
  });

  it("the recycle bin is emptied 1,000 rows of a table a run, oldest first", async () => {
    const owner = await createUser("rt-owner");
    const org = await createOrg(owner.id, "עסק סל גדול");
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"max_records\": null}'::jsonb where organization_id = $1", [org]));
    const status = await defaultLeadStatus(org);
    await asAdmin((q) =>
      q(
        `insert into public.leads (organization_id, status_id, full_name, owner_id, deleted_at)
         select $1, $2, 'בסל ' || g, $3, timestamptz '2000-01-01' + g * interval '1 second' from generate_series(1, 1002) g`,
        [org, status, owner.id],
      ),
    );
    const left = () => asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [org]));
    const run = () => asAdmin(async (q) => (await q<{ r: Record<string, number> }>("select app.purge_trash() as r")).rows[0].r);
    const firstRun = await run();
    expect(firstRun.leads).toBe(1000);
    expect(await left()).toBe(2);
    // the two newest are the ones left
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name in ('בסל 1001', 'בסל 1002')", [org]))).toBe(2);
    await run();
    expect(await left()).toBe(0);
  });

  it("nobody calls the removal from the API", async () => {
    const user = await createUser("rp-api");
    await asUser(user.id, async (q) => {
      await expect(q("select app.purge_old_notifications()")).rejects.toMatchObject({ code: "42501" });
    });
    const grants = await asAdmin(
      async (q) =>
        (await q<{ a: boolean; b: boolean }>(
          "select has_function_privilege('authenticated', 'app.purge_old_notifications(integer)', 'execute') as a, has_function_privilege('anon', 'app.purge_old_notifications(integer)', 'execute') as b",
        )).rows[0],
    );
    expect(grants).toEqual({ a: false, b: false });
  });
});
