import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

describe("notification preferences per user", () => {
  let owner: { id: string }, rep: { id: string }, other: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("prefs-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "prefs-rep");
    other = await addMember(org, owner.id, "member", "prefs-other");
  });

  const set = (userId: string, muted: string[], noPush: string[]) =>
    asUser(userId, (q) => q("select public.set_notification_settings($1, $2)", [muted, noPush]));
  const notifications = (userId: string, type: string) =>
    asAdmin(async (q) => (await q<{ pushed: boolean }>("select pushed_at is not null as pushed from public.notifications where user_id = $1 and type = $2", [userId, type])).rows);

  it("a muted kind is not created; a bell-only kind is never pushed; others are as before", async () => {
    await set(rep.id, ["automation"], ["assigned"]);
    // assigned: a lead given to the rep by the owner
    await insertLead(owner.id, org, { owner_id: rep.id });
    expect(await notifications(rep.id, "assigned")).toEqual([{ pushed: true }]);
    await asAdmin(async (q) => {
      await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'automation', 'x'), ($1, $2, 'system', 'y'), ($1, $2, 'task_reminder', 'z')", [org, rep.id]);
    });
    expect(await notifications(rep.id, "automation")).toEqual([]);
    expect(await notifications(rep.id, "system")).toEqual([{ pushed: false }]);
    expect(await notifications(rep.id, "task_reminder")).toEqual([{ pushed: false }]);
    // someone else's choice does not touch the others
    await insertLead(owner.id, org, { owner_id: other.id });
    expect(await notifications(other.id, "assigned")).toEqual([{ pushed: false }]);
  });

  it("each user reads only their own row and saves it only through the function", async () => {
    await set(other.id, ["inquiry"], []);
    await set(other.id, [], ["task_reminder"]);
    const own = await asUser(other.id, async (q) => (await q<{ muted: string[]; no_push: string[] }>("select muted, no_push from public.notification_settings")).rows);
    expect(own).toEqual([{ muted: [], no_push: ["task_reminder"] }]);
    await asUser(owner.id, async (q) => expect(await count(q, "select 1 from public.notification_settings")).toBe(0));
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.notification_settings (user_id) values ($1)", [owner.id])))).code).toBe("42501");
    expect((await pgError(asUser(other.id, (q) => q("update public.notification_settings set muted = '{}'")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.set_notification_settings('{}', '{}')")))).code).toBe("42501");
  });

  it("security notices cannot be muted, and unknown kinds are refused", async () => {
    expect((await pgError(set(rep.id, ["system"], []))).code).toBe("23514");
    expect((await pgError(set(rep.id, [], ["whatever"]))).code).toBe("23514");
  });
});
