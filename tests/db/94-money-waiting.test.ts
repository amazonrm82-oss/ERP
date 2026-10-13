import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Line = { deals: number; amount: number };
type Money = {
  today: string;
  to_close: Line;
  stuck: Line;
  overdue: Line;
  deals: Array<{ id: string; name: string; stuck: boolean; overdue: boolean; owner_id: string | null }>;
  estimate: { leads: number; won_deals: number; average: number | null; amount: number | null; days: number; min_deals: number };
  leads: Array<{ id: string; owner_id: string | null }>;
};

// MNY-01: money waiting. The main number is deals to close (the cleanup's stuck and overdue deals, each
// once); unhandled leads are an estimate apart, by the average won deal of 90 days when there are five.
describe("money waiting (MNY-01)", () => {
  let owner: U, m1: U, m2: U, outsider: U;
  let org: string;
  let pipeline: string;
  let firstOpen: string;
  let won: string;
  const leads: Record<string, string> = {};

  const money = (userId: string, args: unknown[] = []) =>
    asUser(userId, async (q) => {
      const params = [org, ...args];
      return (await q<{ r: Money }>(`select public.report_money_waiting(${params.map((_, i) => `$${i + 1}`).join(", ")}) as r`, params)).rows[0].r;
    });

  const addWon = (count: number, amount: number, daysAgo: number) =>
    asAdmin(async (q) => {
      for (let i = 0; i < count; i += 1) {
        const id = (
          await q<{ id: string }>(
            "insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id) values ($1, 'זכייה', $2, $3, $4, $5) returning id",
            [org, m1.id, amount, pipeline, won],
          )
        ).rows[0].id;
        await q("update public.deals set closed_at = now() - make_interval(days => $2::int) where id = $1", [id, daysAgo]);
      }
    });

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    await createOrg(outsider.id, "עסק אחר");
    m1 = await addMember(org, owner.id, "member", "m1");
    m2 = await addMember(org, owner.id, "member", "m2");

    await asAdmin(async (q) => {
      pipeline = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      firstOpen = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [pipeline])).rows[0].id;
      won = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [pipeline])).rows[0].id;
      await q("update public.stages set rot_days = null where id = $1", [firstOpen]);
      const add = async (name: string, ownerId: string, amount: number, daysInStage: number, closeOffset: number | null) => {
        const id = (
          await q<{ id: string }>(
            `insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id, expected_close_date)
             values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else (now() at time zone 'Asia/Jerusalem')::date + $7::int end) returning id`,
            [org, name, ownerId, amount, pipeline, firstOpen, closeOffset],
          )
        ).rows[0].id;
        await q("update public.deals set stage_entered_at = now() - make_interval(days => $2::int) - interval '1 hour' where id = $1", [id, daysInStage]);
      };
      await add("stuck", m1.id, 100000, 20, null);
      await add("stuck and overdue", m1.id, 50000, 20, -5);
      await add("overdue", m2.id, 30000, 1, -2);
      await add("fine", m2.id, 70000, 1, 10);
    });

    leads.waiting = await insertLead(m1.id, org, { owner_id: m1.id, full_name: "מחכה" });
    leads.waiting2 = await insertLead(m2.id, org, { owner_id: m2.id, full_name: "מחכה 2" });
    leads.answered = await insertLead(m1.id, org, { owner_id: m1.id, full_name: "קיבל מענה" });
    await asUser(m1.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [org, leads.answered]));
    leads.binned = await insertLead(m1.id, org, { owner_id: m1.id, full_name: "בסל" });
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [leads.binned]));
    leads.closed = await insertLead(m1.id, org, { owner_id: m1.id, full_name: "לא רלוונטי" });
    await asAdmin((q) =>
      q(
        "update public.leads l set status_id = s.id from public.lead_statuses s where l.id = $1 and s.organization_id = l.organization_id and s.kind <> 'open' and s.kind <> 'disqualified'",
        [leads.closed],
      ),
    );
  });

  it("the main number is deals to close, each deal once", async () => {
    const m = await money(owner.id);
    expect(m.stuck).toEqual({ deals: 2, amount: 150000 });
    expect(m.overdue).toEqual({ deals: 1, amount: 30000 });
    expect(m.to_close).toEqual({ deals: 3, amount: 180000 });
    expect(m.deals.map((d) => d.name).sort()).toEqual(["overdue", "stuck", "stuck and overdue"]);
  });

  it("unhandled leads are an estimate apart; no average below five won deals in 90 days", async () => {
    let m = await money(owner.id);
    expect(m.estimate).toMatchObject({ leads: 2, won_deals: 0, average: null, amount: null, days: 90, min_deals: 5 });
    expect(m.leads.map((l) => l.id).sort()).toEqual([leads.waiting, leads.waiting2].sort());

    // four recent wins and one old one: still no average
    await addWon(4, 20000, 10);
    await addWon(1, 90000, 120);
    m = await money(owner.id);
    expect(m.estimate).toMatchObject({ won_deals: 4, average: null, amount: null });

    // a fifth recent win: average 20,000 + (50,000 - 20,000) / 5 = 26,000 agorot a deal
    await addWon(1, 50000, 3);
    m = await money(owner.id);
    expect(m.estimate).toMatchObject({ leads: 2, won_deals: 5, average: 26000, amount: 52000 });
    // won deals are not money waiting
    expect(m.to_close.deals).toBe(3);
  });

  it("with an owner, that person's deals and leads; the average stays the business's", async () => {
    const m = await money(owner.id, [m2.id]);
    expect(m.to_close).toEqual({ deals: 1, amount: 30000 });
    expect(m.leads.map((l) => l.id)).toEqual([leads.waiting2]);
    expect(m.estimate).toMatchObject({ leads: 1, average: 26000, amount: 26000 });
  });

  it("RLS decides: under 'own' visibility a member counts only their own records", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const m = await money(m2.id);
      expect(m.to_close).toEqual({ deals: 1, amount: 30000 });
      expect(m.leads.every((l) => l.owner_id === m2.id)).toBe(true);
      // m2 won nothing: no average from what m2 sees
      expect(m.estimate).toMatchObject({ leads: 1, won_deals: 0, average: null, amount: null });
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("another business gets nothing, and anon may not call it", async () => {
    expect(await asUser(outsider.id, async (q) => (await q<{ r: unknown }>("select public.report_money_waiting($1) as r", [org])).rows[0].r)).toBeNull();
    expect((await pgError(asAnon((q) => q("select public.report_money_waiting($1)", [org])))).code).toBe("42501");
  });
});

// Review findings M1 and L3: a private note is not an answer, so the result does not depend on who
// looks; and a lead someone else took is left out as on the waiting screen (SPD-01 takenLeadsFilter).
describe("money waiting: private notes and taken leads (MNY-01)", () => {
  let owner: U, admin: U, manager: U, rep: U, other: U;
  let org: string;
  let top: string, sub: string, elsewhere: string;
  const leadIds = async (userId: string) =>
    asUser(userId, async (q) => (await q<{ r: Money }>("select public.report_money_waiting($1) as r", [org])).rows[0].r.leads.map((l) => l.id));

  beforeAll(async () => {
    owner = await createUser("mw-owner");
    org = await createOrg(owner.id, "עסק הנלקחים");
    admin = await addMember(org, owner.id, "admin", "mw-admin");
    manager = await addMember(org, owner.id, "manager", "mw-manager");
    rep = await addMember(org, owner.id, "member", "mw-rep");
    other = await addMember(org, owner.id, "member", "mw-other");
    [top, sub, elsewhere] = await asUser(owner.id, async (q) => {
      const a = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צפון') returning id", [org])).rows[0].id;
      const b = (await q<{ id: string }>("insert into public.teams (organization_id, name, parent_team_id) values ($1, 'חיפה', $2) returning id", [org, a])).rows[0].id;
      const c = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'דרום') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [org, a, manager.id]);
      return [a, b, c];
    });
    expect(top).toBeTruthy();
  });

  it("a lead with only a private note is unhandled for its author, an admin and a manager", async () => {
    const lead = await insertLead(rep.id, org, { owner_id: rep.id, full_name: "הערה פרטית" });
    await asAdmin((q) => q("update public.leads set team_id = $2 where id = $1", [lead, sub]));
    await asUser(rep.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'רק לי', $2, true)", [org, lead]));
    for (const user of [rep, admin, manager, owner]) {
      expect(await leadIds(user.id)).toContain(lead);
    }
  });

  it("a lead someone took stays for its owner, owners and admins, and managers of its team or a parent team", async () => {
    const taken = await insertLead(rep.id, org, { owner_id: rep.id, full_name: "נלקח" });
    const takenElsewhere = await insertLead(rep.id, org, { owner_id: rep.id, full_name: "נלקח בצוות אחר" });
    const free = await insertLead(rep.id, org, { owner_id: rep.id, full_name: "לא נלקח" });
    await asAdmin(async (q) => {
      await q("update public.leads set team_id = $2 where id = $1", [taken, sub]);
      await q("update public.leads set team_id = $2 where id = $1", [takenElsewhere, elsewhere]);
      await q("update public.leads set taken_at = now() where id = any($1)", [[taken, takenElsewhere]]);
    });
    for (const user of [rep, owner, admin]) {
      expect(await leadIds(user.id)).toEqual(expect.arrayContaining([taken, takenElsewhere, free]));
    }
    // the manager of the parent team keeps the lead of the sub-team, not the other team's
    const managerSees = await leadIds(manager.id);
    expect(managerSees).toContain(taken);
    expect(managerSees).not.toContain(takenElsewhere);
    expect(managerSees).toContain(free);
    // another rep (who reads the leads under 'org' visibility) does not see taken leads
    const otherSees = await leadIds(other.id);
    expect(otherSees).not.toContain(taken);
    expect(otherSees).not.toContain(takenElsewhere);
    expect(otherSees).toContain(free);
  });
});
