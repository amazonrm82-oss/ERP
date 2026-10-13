import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Result = { ok: boolean; reason?: string; retry_seconds?: number };

/**
 * GAP-01: public.send_test_notification(org) writes a 'system' notification to
 * the caller only, so the bell and the phone push deliver it the normal way.
 * At most 3 per user in a 10-minute window (app.push_tests, no client access);
 * the fourth answers {ok: false, reason: 'rate'} and writes nothing.
 */
describe("test notification (GAP-01)", () => {
  let owner: U, rep: U, other: U, stranger: U;
  let org: string, otherOrg: string;

  const send = (user: U, orgId: string) =>
    asUser(user.id, async (q) => (await q<{ r: Result }>("select public.send_test_notification($1) as r", [orgId])).rows[0].r);

  const testsOf = (user: U) =>
    asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and type = 'system' and title = 'התראת בדיקה'", [user.id]));

  beforeAll(async () => {
    owner = await createUser("push-owner");
    org = await createOrg(owner.id, "עסק ההתראות");
    rep = await addMember(org, owner.id, "member", "push-rep");
    other = await addMember(org, owner.id, "viewer", "push-other");
    stranger = await createUser("push-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
  });

  it("writes one unread, unpushed 'system' notification to the caller only", async () => {
    expect(await send(rep, org)).toEqual({ ok: true });
    const rows = await asAdmin(async (q) =>
      (
        await q<{ organization_id: string; type: string; read_at: string | null; pushed_at: string | null; entity_id: string | null }>(
          "select organization_id, type, read_at, pushed_at, entity_id from public.notifications where user_id = $1 and title = 'התראת בדיקה'",
          [rep.id],
        )
      ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: org, type: "system", read_at: null, pushed_at: null, entity_id: null });
    expect(await testsOf(owner)).toBe(0);
    expect(await testsOf(other)).toBe(0);
    // the caller sees it in the bell with their own session
    const seen = await asUser(rep.id, (q) => count(q, "select 1 from public.notifications where title = 'התראת בדיקה'"));
    expect(seen).toBe(1);
  });

  it("a viewer may test too (it only reaches themselves)", async () => {
    expect(await send(other, org)).toEqual({ ok: true });
    expect(await testsOf(other)).toBe(1);
  });

  it("allows 3 in 10 minutes per user, then answers 'rate' and writes nothing", async () => {
    const user = await addMember(org, owner.id, "member", "push-limit");
    for (let i = 0; i < 3; i += 1) {
      expect((await send(user, org)).ok).toBe(true);
    }
    const blocked = await send(user, org);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("rate");
    expect(blocked.retry_seconds).toBeGreaterThan(0);
    expect(blocked.retry_seconds).toBeLessThanOrEqual(600);
    expect(await testsOf(user)).toBe(3);
    // the limit is per user, in every organization
    const otherBusiness = await createOrg(user.id, "עסק שני");
    expect((await send(user, otherBusiness)).reason).toBe("rate");
    // another user is not affected
    expect((await send(owner, org)).ok).toBe(true);

    // once the window has passed, it works again
    await asAdmin((q) => q("update app.push_tests set window_started_at = now() - interval '11 minutes' where user_id = $1", [user.id]));
    expect(await send(user, org)).toEqual({ ok: true });
    expect(await testsOf(user)).toBe(4);
  });

  it("refuses someone who is not an active member", async () => {
    expect((await pgError(send(stranger, org))).code).toBe("42501");
    expect((await pgError(send(rep, otherOrg))).code).toBe("42501");
    const left = await addMember(org, owner.id, "member", "push-suspended");
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, left.id]));
    expect((await pgError(send(left, org))).code).toBe("42501");
    expect(await testsOf(left)).toBe(0);
  });

  it("refuses a suspended organization", async () => {
    const boss = await createUser("push-boss");
    const closed = await createOrg(boss.id, "עסק מושעה");
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [closed]));
    const err = await pgError(send(boss, closed));
    expect(err.hint).toBe("org:suspended");
    expect(await testsOf(boss)).toBe(0);
  });

  it("is closed to visitors, and the counter is closed to everyone", async () => {
    const anon = await pgError(asAnon((q) => q("select public.send_test_notification($1)", [org])));
    expect(anon.code).toBe("42501");
    const read = await pgError(asUser(rep.id, (q) => q("select * from app.push_tests")));
    expect(read.code).toBe("42501");
  });
});
