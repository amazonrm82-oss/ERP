import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * RVW-25 / HEB-08 (owner, 19 October 2026, answer (ב)): an employee still picks their own deputy; the manager of their team
 * (or the owner when there is none) gets one `system` notice, and the choice is written to the audit log.
 */
describe("an employee who picks their own deputy tells their manager (RVW-25)", () => {
  let owner: U, admin: U, manager: U, topManager: U, m1: U, m2: U, loner: U;
  let org: string;

  const noticesFor = (leave: string) =>
    asAdmin(async (q) =>
      (await q<{ user_id: string; type: string; title: string; body: string }>(
        "select user_id, type, title, body from public.notifications where entity_type = 'member_leaves' and entity_id = $1 order by user_id",
        [leave],
      )).rows,
    );
  const auditFor = (leave: string) =>
    asAdmin(async (q) =>
      (await q<{ actor_id: string; changes: Record<string, string> }>(
        "select actor_id, changes from public.audit_log where entity_type = 'member_leaves' and entity_id = $1 and action = 'deputy_chosen' order by id",
        [leave],
      )).rows,
    );
  const addLeave = (by: U, user: U, deputy: U | null, from = 10, to = 12) =>
    asUser(by.id, async (q) =>
      (await q<{ id: string }>(
        "insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, deputy_id) values ($1, $2, current_date + $3::int, current_date + $4::int, $5) returning id",
        [org, user.id, from, to, deputy?.id ?? null],
      )).rows[0].id,
    );
  const sorted = (ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    owner = await createUser("dp-owner");
    org = await createOrg(owner.id, "עסק ממלאי מקום");
    admin = await addMember(org, owner.id, "admin", "dp-admin");
    manager = await addMember(org, owner.id, "manager", "dp-manager");
    topManager = await addMember(org, owner.id, "manager", "dp-top");
    m1 = await addMember(org, owner.id, "member", "dp-m1");
    m2 = await addMember(org, owner.id, "member", "dp-m2");
    loner = await addMember(org, owner.id, "member", "dp-loner");
    await asAdmin(async (q) => {
      await q("update public.profiles set full_name = 'דנה' where id = $1", [m1.id]);
      await q("update public.profiles set full_name = 'יוסי' where id = $1", [m2.id]);
    });
    await asUser(owner.id, async (q) => {
      const top = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'אזור') returning id", [org])).rows[0].id;
      const team = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'צפון', $2) returning id", [org, top])).rows[0].id;
      await q(
        `insert into public.team_members (organization_id, team_id, user_id, is_manager) values
           ($1, $2, $3, true), ($1, $2, $4, false), ($1, $2, $5, false), ($1, $6, $7, true)`,
        [org, team, manager.id, m1.id, m2.id, top, topManager.id],
      );
    });
  });

  it("the team's managers, up the chain of teams, hear of it once; the choice is in the audit log", async () => {
    const leave = await addLeave(m1, m1, m2);
    const told = await noticesFor(leave);
    expect(told.map((n) => n.user_id)).toEqual(sorted([manager.id, topManager.id]));
    for (const n of told) {
      expect(n.type).toBe("system");
      expect(n.title).toBe("ממלא מקום בהיעדרות: דנה");
      expect(n.body).toMatch(/^נבחר ממלא מקום על ידי דנה: יוסי, מ-\d\d\.\d\d\.\d{4} עד \d\d\.\d\d\.\d{4}\./);
    }
    const [entry, ...more] = await auditFor(leave);
    expect(more).toEqual([]);
    expect(entry.actor_id).toBe(m1.id);
    expect(entry.changes).toMatchObject({ user_id: m1.id, deputy_id: m2.id });
    const dates = await asAdmin(async (q) => (await q<{ s: string; e: string }>("select (current_date + 10)::text as s, (current_date + 12)::text as e")).rows[0]);
    expect([entry.changes.starts_on, entry.changes.ends_on]).toEqual([dates.s, dates.e]);
  });

  it("a change of deputy or dates tells them again; a change of anything else does not", async () => {
    const leave = await addLeave(m1, m1, m2, 20, 21);
    expect(await noticesFor(leave)).toHaveLength(2);
    await asUser(m1.id, (q) => q("update public.member_leaves set kind = 'vacation' where id = $1", [leave]));
    expect(await noticesFor(leave)).toHaveLength(2);
    await asUser(m1.id, (q) => q("update public.member_leaves set ends_on = ends_on + 1 where id = $1", [leave]));
    expect(await noticesFor(leave)).toHaveLength(4);
    await asUser(m1.id, (q) => q("update public.member_leaves set deputy_id = $2 where id = $1", [leave, loner.id]));
    expect(await noticesFor(leave)).toHaveLength(6);
    expect(await auditFor(leave)).toHaveLength(3);
    // clearing the deputy tells nobody
    await asUser(m1.id, (q) => q("update public.member_leaves set deputy_id = null where id = $1", [leave]));
    expect(await noticesFor(leave)).toHaveLength(6);
  });

  it("without a team manager the owner hears of it; a leave without a deputy tells nobody", async () => {
    const leave = await addLeave(loner, loner, m2, 30, 31);
    expect((await noticesFor(leave)).map((n) => n.user_id)).toEqual([owner.id]);
    expect(await auditFor(leave)).toHaveLength(1);
    const plain = await addLeave(loner, loner, null, 40, 41);
    expect(await noticesFor(plain)).toEqual([]);
    expect(await auditFor(plain)).toEqual([]);
  });

  it("a deputy set by an owner or admin for someone else is not the employee's own pick: no notice, no extra entry", async () => {
    const leave = await addLeave(admin, m2, loner, 50, 51);
    expect(await noticesFor(leave)).toEqual([]);
    expect(await auditFor(leave)).toEqual([]);
    const byOwner = await addLeave(owner, m1, m2, 60, 61);
    expect(await noticesFor(byOwner)).toEqual([]);
  });

  it("a manager who picks their own deputy is not told about it; the managers above them are", async () => {
    const leave = await addLeave(manager, manager, m1, 70, 71);
    expect((await noticesFor(leave)).map((n) => n.user_id)).toEqual([topManager.id]);
  });
});
