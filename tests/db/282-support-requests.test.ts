import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// USR-12: the support request form. A member sends a request for themselves (the requester comes from the session);
// at most 5 per person per hour across businesses; outsiders and anon cannot; a closed business's owner still can.

const send = (userId: string, org: string, extra: { page?: string | null; category?: string } = {}) =>
  asUser(userId, (q) =>
    q("insert into public.support_requests (organization_id, category, subject, message, page_path) values ($1, $2, 'נושא', 'הודעה', $3)", [
      org,
      extra.category ?? "question",
      extra.page ?? null,
    ]),
  );

describe("USR-12: support requests", () => {
  let alice: { id: string };
  let bob: { id: string };
  let orgA: string;
  let orgA2: string;
  let orgB: string;

  beforeAll(async () => {
    alice = await createUser("usr12-alice");
    bob = await createUser("usr12-bob");
    orgA = await createOrg(alice.id, "עסק א");
    orgA2 = await createOrg(alice.id, "עסק א 2");
    orgB = await createOrg(bob.id, "עסק ב");
  });

  it("five an hour per person, across businesses", async () => {
    for (let i = 0; i < 3; i++) await send(alice.id, orgA);
    await send(alice.id, orgA2);
    await send(alice.id, orgA2);
    expect((await pgError(send(alice.id, orgA))).hint).toBe("support:rate");
    expect((await pgError(send(alice.id, orgA2))).hint).toBe("support:rate");
    // an hour later the window has moved
    // (touch_row keeps created_at on an update: the triggers are off for this one statement's transaction)
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.support_requests set created_at = created_at - interval '61 minutes' where user_id = $1", [alice.id]);
    });
    await send(alice.id, orgA);
  });

  it("outsiders, anon and bad values are refused; nobody learns of another business", async () => {
    const err = await pgError(send(bob.id, orgA));
    expect(err.code).toBe("42501");
    expect(err.hint ?? null).toBeNull();
    const anon = await pgError(asAnon((q) => q("insert into public.support_requests (organization_id, category, subject, message) values ($1, 'bug', 'x', 'x')", [orgA])));
    expect(anon.code).toBe("42501");
    expect(await asUser(bob.id, (q) => count(q, "select 1 from public.support_requests"))).toBe(0);
    expect((await pgError(send(bob.id, orgB, { category: "other-thing" }))).code).toBe("23514");
    expect((await pgError(send(bob.id, orgB, { page: "/o/x?token=secret" }))).code).toBe("23514");
    expect((await pgError(send(bob.id, orgB, { page: "https://evil.example/" }))).code).toBe("23514");
    await send(bob.id, orgB, { page: "/o/x/leads" });
    expect((await pgError(asUser(bob.id, (q) => q("insert into public.support_requests (organization_id, category, subject, message) values ($1, 'bug', '   ', 'x')", [orgB])))).code).toBe("23514");
    expect((await pgError(asUser(bob.id, (q) => q("insert into public.support_requests (organization_id, category, subject, message) values ($1, 'bug', 'x', $2)", [orgB, "א".repeat(2001)])))).code).toBe("23514");
  });

  it("a suspended member cannot send; the owner of a closed business can", async () => {
    const member = await addMember(orgB, bob.id, "member", "usr12-member");
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [orgB, member.id]));
    expect((await pgError(send(member.id, orgB))).code).toBe("42501");
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [orgB]));
    await send(bob.id, orgB);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [orgB]));
  });

  it("the person's what's-new date is theirs to write, nobody else's", async () => {
    await asUser(alice.id, (q) => q("update public.profiles set whats_new_seen_on = '2026-11-01' where id = $1", [alice.id]));
    expect((await asUser(bob.id, (q) => q("update public.profiles set whats_new_seen_on = '2026-11-01' where id = $1", [alice.id]))).rowCount).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.profiles where id = $1 and whats_new_seen_on = '2026-11-01'", [alice.id]))).toBe(1);
  });
});
