import { afterAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type Event = { user_id: string; ip: string | null; ip_hidden: boolean; created_at: string };

// FXS-10: a business's login log shows its members' sign-ins only from the day they joined it, and the IP address only
// of someone whose only business it is.
describe("login log privacy (FXS-10)", () => {
  const login = (userId: string, ip: string, at: string) =>
    asAdmin((q) =>
      q("insert into auth.audit_log_entries (payload, ip_address, created_at) values ($1, $2, $3)", [JSON.stringify({ action: "login", actor_id: userId }), ip, at]),
    );
  const events = (adminId: string, org: string) =>
    asUser(adminId, async (q) => (await q<{ r: Event[] }>("select public.org_login_events($1) as r", [org])).rows[0].r);

  it("hides the address of a member who belongs to another business too, and keeps what came before joining out", async () => {
    const owner = await createUser("fxs10-owner");
    const org = await createOrg(owner.id, "עסק יומן כניסות");
    const solo = await addMember(org, owner.id, "member", "fxs10-solo");
    const shared = await addMember(org, owner.id, "member", "fxs10-shared");
    // "shared" also works in another business
    const otherOwner = await createUser("fxs10-other-owner");
    const other = await createOrg(otherOwner.id, "עסק אחר");
    await asAdmin((q) => q("insert into public.memberships (organization_id, user_id, role, seat_type) values ($1, $2, 'member', 'full')", [other, shared.id]));

    const joined = await asAdmin(async (q) => (await q<{ t: string }>("select created_at::text as t from public.memberships where organization_id = $1 and user_id = $2", [org, shared.id])).rows[0].t);
    await login(solo.id, "10.1.1.1", new Date().toISOString());
    await login(shared.id, "10.2.2.2", new Date().toISOString());
    // a sign-in from before "shared" joined this business (in the other one's days)
    await login(shared.id, "10.3.3.3", new Date(new Date(joined).getTime() - 86_400_000).toISOString());

    const rows = await events(owner.id, org);
    const of = (id: string) => rows.filter((e) => e.user_id === id);
    expect(of(solo.id)).toEqual([expect.objectContaining({ ip: "10.1.1.1", ip_hidden: false })]);
    expect(of(shared.id)).toEqual([expect.objectContaining({ ip: null, ip_hidden: true })]);
    expect(JSON.stringify(rows)).not.toContain("10.2.2.2");
    expect(JSON.stringify(rows)).not.toContain("10.3.3.3");

    // the other business's log shows "shared" too (from their own joining), also without the address
    const theirs = await events(otherOwner.id, other);
    expect(theirs.filter((e) => e.user_id === shared.id)).toEqual([expect.objectContaining({ ip: null, ip_hidden: true })]);
  });
});
