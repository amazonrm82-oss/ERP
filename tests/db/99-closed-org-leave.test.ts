import { afterAll, describe, expect, it } from "vitest";

import { leadsWaitingText } from "../../src/features/notifications/lead-count";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

// Owner's answers of 13 October 2026: leaving a suspended or cancelled business (0164), and the
// one rule for counting leads in a notice (0164).
afterAll(closePool);

const setStatus = (org: string, status: string) => asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
const leave = (userId: string, org: string) => asUser(userId, (q) => q("select public.leave_closed_organization($1)", [org]));

describe("the lead count in notices", () => {
  it("the database and the app write it the same way, one lead and many", async () => {
    for (const n of [1, 2, 11]) {
      const sql = await asAdmin(async (q) => (await q<{ t: string }>("select app.leads_waiting_text($1, 'עסק לדוגמה') as t", [n])).rows[0].t);
      expect(sql, String(n)).toBe(leadsWaitingText(n, "עסק לדוגמה"));
    }
    expect(leadsWaitingText(1, "עסק")).toBe("ליד אחד מחכה לכם בעסק. כדי לראות אותו, חדשו את המנוי.");
    expect(leadsWaitingText(2, "עסק")).toBe("2 לידים מחכים לכם בעסק. כדי לראות אותם, חדשו את המנוי.");
  });
});

describe("leaving a business closed until payment", () => {
  for (const state of ["suspended", "cancelled"]) {
    it(`a member who is not the owner leaves a ${state} business: membership gone, records stay, audited`, async () => {
      const owner = await createUser(`leave-${state}-owner`);
      const org = await createOrg(owner.id, `עסק ${state}`);
      const member = await addMember(org, owner.id, "member", `leave-${state}-member`);
      const lead = await insertLead(member.id, org, { full_name: "ליד של העובד" });
      await setStatus(org, state);

      await leave(member.id, org);
      await asAdmin(async (q) => {
        // the membership is out of use (status), so the records it owns keep their owner
        expect(await count(q, "select 1 from public.memberships where organization_id = $1 and user_id = $2 and status = 'active'", [org, member.id])).toBe(0);
        expect(await count(q, "select 1 from public.leads where id = $1 and owner_id = $2", [lead, member.id])).toBe(1);
        expect(await count(q, "select 1 from public.audit_log where organization_id = $1 and actor_id = $2 and changes::text like '%suspended%'", [org, member.id])).toBe(1);
      });
      // gone from their list, and no way back in while it is closed or after it reopens
      expect(await asUser(member.id, async (q) => (await q<{ r: unknown[] }>("select public.closed_orgs() as r")).rows[0].r)).toEqual([]);
      await setStatus(org, "active");
      expect(await asUser(member.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(0);
      await setStatus(org, state);
      // again: no longer a member
      expect((await pgError(leave(member.id, org))).code).toBe("42501");
    });
  }

  it("the owner cannot leave; an open business, a non-member and a stranger cannot use it", async () => {
    const owner = await createUser("leave-guard-owner");
    const org = await createOrg(owner.id, "עסק שמירה");
    const member = await addMember(org, owner.id, "admin", "leave-guard-admin");
    const stranger = await createUser("leave-guard-stranger");

    // open business: the normal path
    for (const state of ["active", "read_only"]) {
      await setStatus(org, state);
      expect((await pgError(leave(member.id, org))).hint, state).toBe("leave:open");
    }
    await setStatus(org, "suspended");
    expect((await pgError(leave(owner.id, org))).hint).toBe("leave:owner");
    expect((await pgError(leave(stranger.id, org))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.memberships where organization_id = $1", [org]))).toBe(2);
    // anon has no access to the function at all
    const anon = await asAdmin(async (q) => (await q<{ c: boolean }>("select has_function_privilege('anon', 'public.leave_closed_organization(uuid)', 'EXECUTE') as c")).rows[0].c);
    expect(anon).toBe(false);
  });

  it("coming back takes a new invitation: the same membership row comes back active with the invited role, within the seats", async () => {
    const owner = await createUser("leave-back-owner");
    const org = await createOrg(owner.id, "עסק חזרה");
    const member = await addMember(org, owner.id, "member", "leave-back-member");
    const other = await addMember(org, owner.id, "member", "leave-back-other");
    const lead = await insertLead(member.id, org, { full_name: "ליד שנשאר" });
    await setStatus(org, "suspended");
    await leave(member.id, org);
    await setStatus(org, "active");

    // an active member cannot be invited again
    expect((await pgError(asUser(owner.id, (q) => q("select public.create_invitation($1, $2, 'member')", [org, other.email])))).code).toBe("23505");

    // the seat limit still holds: no free seat, no coming back
    const invite = (role: string) =>
      asUser(owner.id, async (q) => (await q<{ t: string }>("select public.create_invitation($1, $2, $3) as t", [org, member.email, role])).rows[0].t);
    const accept = (token: string) => asUser(member.id, (q) => q("select public.accept_invitation($1)", [token]));
    const full = await asAdmin(async (q) =>
      Number((await q<{ n: string }>("select count(*) as n from public.memberships where organization_id = $1 and status = 'active' and seat_type = 'full'", [org])).rows[0].n),
    );
    await asAdmin((q) => q("update public.subscriptions set seats = $2 where organization_id = $1", [org, full]));
    const blocked = await invite("manager");
    expect((await pgError(accept(blocked))).hint).toBe("limit:seats");
    await asAdmin((q) => q("update public.subscriptions set seats = null where organization_id = $1", [org]));

    const token = await invite("manager");
    await accept(token);
    const row = await asAdmin(async (q) =>
      (await q<{ status: string; role: string; n: string }>(
        "select status::text as status, role::text as role, (select count(*) from public.memberships m2 where m2.organization_id = $1 and m2.user_id = $2)::text as n from public.memberships where organization_id = $1 and user_id = $2",
        [org, member.id],
      )).rows[0],
    );
    expect(row).toEqual({ status: "active", role: "manager", n: "1" });
    // back with their records
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.leads where id = $1", [lead]))).toBe(1);
    // and once active, "already a member" again
    expect((await pgError(invite("member"))).code).toBe("23505");
  });
});
