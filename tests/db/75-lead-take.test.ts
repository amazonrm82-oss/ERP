import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Take = { ok: boolean; result?: string; reason?: string; owner_name?: string | null };
type Claimed = { id: string; user_id: string; type: string; entity_id: string | null; lead_actions: boolean; title: string };

const take = (user: U, org: string, lead: string) =>
  asUser(user.id, async (q) => (await q<{ r: Take }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r);

const leadRow = (lead: string) =>
  asAdmin(async (q) =>
    (await q<{ owner_id: string | null; taken_at: Date | null }>("select owner_id, taken_at from public.leads where id = $1", [lead])).rows[0],
  );

const submit = (token: string, payload: Record<string, unknown>) =>
  asService(async (q) => (await q<{ r: { status: string; lead_id?: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify(payload)])).rows[0].r);

/**
 * SPD-01: "לקחתי" (I took it) on a new lead, and the push batch that says which
 * notifications carry the call / WhatsApp / take buttons.
 */
describe("take a lead (SPD-01)", () => {
  let owner: U, rep: U, rep2: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("take-owner");
    org = await createOrg(owner.id, "עסק הלידים");
    rep = await addMember(org, owner.id, "member", "take-rep");
    rep2 = await addMember(org, owner.id, "member", "take-rep2");
    viewer = await addMember(org, owner.id, "viewer", "take-viewer");
    outsider = await createUser("take-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  const unownedLead = async (fields: Record<string, unknown> = {}) => {
    const id = await insertLead(owner.id, org, { full_name: "ליד בלי אחראי", ...fields });
    await asAdmin((q) => q("update public.leads set owner_id = null where id = $1", [id]));
    return id;
  };

  it("an unowned lead goes to the first one who takes it", async () => {
    const lead = await unownedLead();
    expect(await take(rep, org, lead)).toEqual({ ok: true, result: "taken" });
    const row = await leadRow(lead);
    expect(row.owner_id).toBe(rep.id);
    expect(row.taken_at).not.toBeNull();

    // the second one is told who has it, and nothing changes
    const second = await take(rep2, org, lead);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("taken");
    expect(second.owner_name).toBe("take-rep");
    expect((await leadRow(lead)).owner_id).toBe(rep.id);
  });

  it("two people pressing at the same moment: exactly one gets it", async () => {
    const lead = await unownedLead();
    const [a, b] = await Promise.all([
      asUser(rep.id, async (q) => {
        const r = (await q<{ r: Take }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r;
        // hold the row lock a moment, so the other call has to wait for it
        await q("select pg_sleep(0.3)");
        return r;
      }),
      asUser(rep2.id, async (q) => {
        await q("select pg_sleep(0.1)");
        return (await q<{ r: Take }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r;
      }),
    ]);
    expect(a).toEqual({ ok: true, result: "taken" });
    expect(b.ok).toBe(false);
    expect(b.reason).toBe("taken");
    expect((await leadRow(lead)).owner_id).toBe(rep.id);
  });

  it("the owner's own lead is marked as seen once, and the owner stays", async () => {
    const lead = await insertLead(owner.id, org, { owner_id: rep.id });
    expect((await leadRow(lead)).taken_at).toBeNull();
    expect(await take(rep, org, lead)).toEqual({ ok: true, result: "acknowledged" });
    const first = (await leadRow(lead)).taken_at;
    expect(first).not.toBeNull();
    expect(await take(rep, org, lead)).toEqual({ ok: true, result: "acknowledged" });
    expect((await leadRow(lead)).taken_at).toEqual(first);
    expect((await leadRow(lead)).owner_id).toBe(rep.id);
  });

  it("someone else's lead cannot be taken, not even by an admin", async () => {
    const lead = await insertLead(owner.id, org, { owner_id: rep.id });
    const r = await take(owner, org, lead);
    expect(r).toMatchObject({ ok: false, reason: "taken" });
    expect(await leadRow(lead)).toEqual({ owner_id: rep.id, taken_at: null });
  });

  it("a new owner starts unmarked; taken_at is server only", async () => {
    const lead = await insertLead(owner.id, org, { owner_id: rep.id });
    await take(rep, org, lead);
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $1 where id = $2", [rep2.id, lead]));
    expect(await leadRow(lead)).toEqual({ owner_id: rep2.id, taken_at: null });
    // no client may write the mark
    const write = await pgError(asUser(owner.id, (q) => q("update public.leads set taken_at = now() where id = $1", [lead])));
    expect(write.code).toBe("42501");
    const insert = await pgError(insertLead(owner.id, org, { taken_at: new Date().toISOString() }));
    expect(insert.code).toBe("42501");
  });

  it("a converted lead is closed; a lead in the bin is not found", async () => {
    const converted = await unownedLead();
    await asAdmin((q) => q("update public.leads set converted_at = now() where id = $1", [converted]));
    expect(await take(rep, org, converted)).toEqual({ ok: false, reason: "closed" });
    expect((await leadRow(converted)).owner_id).toBeNull();

    const binned = await unownedLead();
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(take(rep, org, binned))).code).toBe("42501");
  });

  it("a lead whose status is not open (disqualified) is closed", async () => {
    const lead = await unownedLead();
    await asAdmin((q) =>
      q(
        `update public.leads set status_id = (select id from public.lead_statuses where organization_id = $1 and kind = 'disqualified' limit 1)
          where id = $2`,
        [org, lead],
      ),
    );
    expect(await take(rep, org, lead)).toEqual({ ok: false, reason: "closed" });
    expect(await leadRow(lead)).toEqual({ owner_id: null, taken_at: null });

    const own = await insertLead(owner.id, org, { owner_id: rep.id });
    await asAdmin((q) =>
      q(
        `update public.leads set status_id = (select id from public.lead_statuses where organization_id = $1 and kind = 'disqualified' limit 1)
          where id = $2`,
        [org, own],
      ),
    );
    expect(await take(rep, org, own)).toEqual({ ok: false, reason: "closed" });
    expect((await leadRow(own)).taken_at).toBeNull();
  });

  it("a lead converted while the take waited for it is not taken", async () => {
    const lead = await unownedLead();
    const [, b] = await Promise.all([
      asAdmin(async (q) => {
        await q("update public.leads set converted_at = now() where id = $1", [lead]);
        // hold the row lock, so the take reads the lead as open and then waits
        await q("select pg_sleep(0.3)");
      }),
      asUser(rep.id, async (q) => {
        await q("select pg_sleep(0.1)");
        return (await q<{ r: Take }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r;
      }),
    ]);
    expect(b).toEqual({ ok: false, reason: "closed" });
    expect((await leadRow(lead)).owner_id).toBeNull();
  });

  it("refuses a viewer, a stranger, another organization, a visitor and a read-only business", async () => {
    const lead = await unownedLead();
    expect((await pgError(take(viewer, org, lead))).code).toBe("42501");
    expect((await pgError(take(outsider, org, lead))).code).toBe("42501");
    // the lead does not exist in the outsider's own business
    expect((await pgError(take(outsider, otherOrg, lead))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.take_lead($1, $2)", [org, lead]))))).toMatchObject({ code: "42501" });
    expect((await leadRow(lead)).owner_id).toBeNull();

    const boss = await createUser("take-boss");
    const frozen = await createOrg(boss.id, "עסק לקריאה בלבד");
    const frozenLead = await insertLead(boss.id, frozen, {});
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [frozen]));
    expect((await pgError(take(boss, frozen, frozenLead))).code).toBe("42501");
  });

  it("a member who may not see the lead cannot take it ('own' visibility)", async () => {
    const boss = await createUser("take-own-boss");
    const closed = await createOrg(boss.id, "עסק פרטי");
    const member = await addMember(closed, boss.id, "member", "take-own-member");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [closed]));
    const lead = await insertLead(boss.id, closed, {});
    await asAdmin((q) => q("update public.leads set owner_id = null where id = $1", [lead]));
    expect((await pgError(take(member, closed, lead))).code).toBe("42501");
    // the owner sees everything and may take it
    expect(await take(boss, closed, lead)).toEqual({ ok: true, result: "taken" });
  });

  it("taking marks the taker's notifications about the lead as read", async () => {
    const lead = await insertLead(owner.id, org, { owner_id: rep.id });
    const unread = () =>
      asAdmin(async (q) => (await q("select 1 from public.notifications where user_id = $1 and entity_id = $2 and read_at is null", [rep.id, lead])).rowCount);
    expect(await unread()).toBe(1);
    await take(rep, org, lead);
    expect(await unread()).toBe(0);
  });
});

// The waiting screen keeps a taken lead for the managers of its team (SPD-01): the app
// reads, with the manager's own session, the teams they manage and the team tree.
describe("a team manager can read what the waiting screen needs (SPD-01)", () => {
  it("their manager rows and the parent of every team", async () => {
    const boss = await createUser("wt-boss");
    const org = await createOrg(boss.id, "עסק הצוותים");
    const manager = await addMember(org, boss.id, "manager", "wt-manager");
    const [top, sub] = await asUser(boss.id, async (q) => {
      const a = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צפון') returning id", [org])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'חיפה', $2) returning id", [org, a])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, a, manager.id]);
      return [a, b];
    });
    const seen = await asUser(manager.id, async (q) => ({
      managed: (await q<{ team_id: string }>("select team_id from public.team_members where organization_id = $1 and user_id = $2 and is_manager", [org, manager.id])).rows,
      teams: (await q<{ id: string; parent_team_id: string | null }>("select id, parent_team_id from public.teams where organization_id = $1 order by name", [org])).rows,
    }));
    expect(seen.managed).toEqual([{ team_id: top }]);
    expect(seen.teams).toEqual(expect.arrayContaining([{ id: top, parent_team_id: null }, { id: sub, parent_team_id: top }]));
  });
});

describe("push batch with lead buttons (SPD-01)", () => {
  let owner: U, rep: U;
  let org: string;
  let token: string;

  beforeAll(async () => {
    owner = await createUser("lpush-owner");
    org = await createOrg(owner.id, "עסק הדחיפות");
    rep = await addMember(org, owner.id, "member", "lpush-rep");
    await asAdmin((q) =>
      q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'k', 'a')", [rep.id, `https://push.example.test/${rep.id}`]),
    );
    token = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, name, title, owner_id) values ($1, 'דחיפה', 'פנייה', $2) returning token", [org, rep.id])).rows[0].token,
    );
  });

  const claim = () => asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_push_notifications(500) as r")).rows[0].r);

  it("a new form lead carries the buttons; a hand-made lead and other kinds do not", async () => {
    const fromForm = await submit(token, { full_name: "ליד מטופס", phone: "050-7100001" });
    expect(fromForm.status).toBe("accepted");
    const byHand = await insertLead(owner.id, org, { owner_id: rep.id, full_name: "ליד ידני" });
    await asAdmin((q) => q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'system', 'בדיקה')", [org, rep.id]));

    const batch = (await claim()).filter((n) => n.user_id === rep.id);
    const formNote = batch.find((n) => n.entity_id === fromForm.lead_id);
    const handNote = batch.find((n) => n.entity_id === byHand);
    const system = batch.find((n) => n.type === "system");
    expect(formNote).toMatchObject({ type: "assigned", lead_actions: true });
    expect(handNote).toMatchObject({ type: "assigned", lead_actions: false });
    expect(system).toMatchObject({ lead_actions: false });
  });

  it("kind lead_new always carries them while the lead is open; a converted lead does not", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ליד חדש" });
    const closed = await insertLead(owner.id, org, { full_name: "ליד שהומר" });
    await asAdmin(async (q) => {
      await q("update public.leads set converted_at = now() where id = $1", [closed]);
      await q(
        `insert into public.notifications (organization_id, user_id, type, title, entity_type, entity_id)
         values ($1, $2, 'lead_new', 'ליד חדש', 'lead', $3), ($1, $2, 'lead_new', 'ליד חדש', 'lead', $4)`,
        [org, rep.id, lead, closed],
      );
    });
    const batch = await claim();
    expect(batch.find((n) => n.entity_id === lead && n.type === "lead_new")?.lead_actions).toBe(true);
    expect(batch.find((n) => n.entity_id === closed && n.type === "lead_new")?.lead_actions).toBe(false);
  });

  it("is still closed to signed-in users", async () => {
    expect((await pgError(asUser(rep.id, (q) => q("select public.claim_push_notifications(10)")))).code).toBe("42501");
  });
});
