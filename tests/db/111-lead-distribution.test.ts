import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// CAP-08: distribution by weight, by open load and by rules (source, product), behind the
// plan key 'lead_distribution' (from basic up). One function decides the owner
// (app.lead_distribution_pick); intake, the automation round robin, the CAP-09 waiting job and
// the SPD-03 pass-on all use it, and CAP-09 hours / leave and HEB-08 deputies still apply.
describe("lead distribution by weight, load and rules (CAP-08)", () => {
  let owner: U, admin: U, manager: U, repA: U, repB: U, repC: U, outsider: U;
  let org: string, otherOrg: string;
  let team: string, team2: string, otherTeam: string;
  let source: string, source2: string, otherSource: string;
  let product: string;
  let formToken: string;
  let otherRep: U;

  const setFeature = (o: string, on: boolean) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object('lead_distribution', $2::boolean) where organization_id = $1", [o, on]),
    );
  const setMethod = (method: string, weights: Record<string, number> = {}) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.lead_distribution_settings (organization_id, method, weights) values ($1, $2, $3)
         on conflict (organization_id) do update set method = excluded.method, weights = excluded.weights`,
        [org, method, JSON.stringify(weights)],
      ),
    );
  const submit = (phone: string, tok = formToken) =>
    asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [tok, JSON.stringify({ full_name: "פונה", phone })])).rows[0].r.lead_id);
  const lead = (id: string) =>
    asAdmin(async (q) => (await q<{ owner_id: string | null; team_id: string | null }>("select owner_id, team_id from public.leads where id = $1", [id])).rows[0]);
  // clean slate: no open leads, no weighted memory, everyone's turn equal and in this order
  const reset = (users: U[]) =>
    asAdmin(async (q) => {
      await q("update public.leads set deleted_at = now() where organization_id = $1 and deleted_at is null", [org]);
      await q("update app.lead_rotation_clock set vtime = 0 where organization_id = $1", [org]);
      await q("update app.lead_rotation_passes set pass = 0 where organization_id = $1", [org]);
      for (const [i, user] of users.entries()) {
        await q("update public.memberships set last_lead_assigned_at = now() - make_interval(hours => $3) where organization_id = $1 and user_id = $2", [org, user.id, 10 - i]);
      }
    });
  const pick = (teamId: string | null, leadCtx: Record<string, string | null> | null = null, excluded: string[] = []) =>
    asAdmin(async (q) =>
      (
        await q<{ turn_user: string | null; owner_id: string | null; team_id: string | null; method: string }>(
          "select turn_user, owner_id, team_id, method from app.lead_distribution_pick($1, $2, now(), $3, $4::uuid[])",
          [org, teamId, leadCtx === null ? null : JSON.stringify(leadCtx), excluded],
        )
      ).rows[0],
    );
  const tally = (owners: (string | null)[]) => owners.reduce<Record<string, number>>((acc, o) => ({ ...acc, [String(o)]: (acc[String(o)] ?? 0) + 1 }), {});
  const clearLeaves = () => asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1", [org]));

  beforeAll(async () => {
    owner = await createUser("ld-owner");
    org = await createOrg(owner.id, "עסק החלוקה");
    admin = await addMember(org, owner.id, "admin", "ld-admin");
    manager = await addMember(org, owner.id, "manager", "ld-manager");
    repA = await addMember(org, owner.id, "member", "ld-a");
    repB = await addMember(org, owner.id, "member", "ld-b");
    repC = await addMember(org, owner.id, "member", "ld-c");
    outsider = await createUser("ld-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    otherRep = await addMember(otherOrg, outsider.id, "member", "ld-other");
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      team2 = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צפון') returning id", [org])).rows[0].id;
      for (const user of [repA, repB]) {
        await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, user.id]);
      }
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team2, repC.id]);
      source = (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'פייסבוק') returning id", [org])).rows[0].id;
      source2 = (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'גוגל') returning id", [org])).rows[0].id;
      product = (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, 'מנוי שנתי') returning id", [org])).rows[0].id;
      formToken = (
        await q<{ token: string }>(
          "insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id, source_id) values ($1, 'webhook', 'טופס', $2, 'round_robin', $3, $4) returning token",
          [org, owner.id, team, source],
        )
      ).rows[0].token;
    });
    await asUser(outsider.id, async (q) => {
      otherTeam = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id;
      otherSource = (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id;
    });
  });

  beforeEach(async () => {
    await setFeature(org, true);
    await clearLeaves();
    await asAdmin((q) => q("update public.lead_routing_rules set is_active = false where organization_id = $1", [org]));
  });

  it("settings: the method and the weights are checked; another method needs the plan key", async () => {
    const insert = (method: string, weights: unknown) =>
      pgError(asUser(owner.id, (q) => q("insert into public.lead_distribution_settings (organization_id, method, weights) values ($1, $2, $3)", [org, method, JSON.stringify(weights)])));
    expect((await insert("random", {})).code).toBe("23514");
    for (const bad of [{ [repA.id]: 0 }, { [repA.id]: 11 }, { [repA.id]: 1.5 }, { [repA.id]: "2" }, { "not-a-uuid": 2 }, []]) {
      expect((await insert("weighted", bad)).code, JSON.stringify(bad)).toBe("23514");
    }
    // without the key: round robin may be saved (weights too), another method may not
    await setFeature(org, false);
    expect((await insert("weighted", {})).hint).toBe("feature:lead_distribution");
    await asUser(owner.id, (q) => q("insert into public.lead_distribution_settings (organization_id, weights) values ($1, $2)", [org, JSON.stringify({ [repA.id]: 3 })]));
    expect((await pgError(asUser(owner.id, (q) => q("update public.lead_distribution_settings set method = 'load' where organization_id = $1", [org])))).hint).toBe("feature:lead_distribution");
    await setFeature(org, true);
    await asUser(admin.id, (q) => q("update public.lead_distribution_settings set method = 'load' where organization_id = $1", [org]));
    // a business that lost the key keeps its method and may still change the weights
    await setFeature(org, false);
    await asUser(owner.id, (q) => q("update public.lead_distribution_settings set weights = '{}' where organization_id = $1", [org]));
    // one row per business
    await setFeature(org, true);
    expect((await insert("round_robin", {})).code).toBe("23505");
    // a manager or a member changes nothing; a member reads it; an outsider sees nothing and learns nothing about the plan
    for (const user of [manager, repA]) {
      expect(await asUser(user.id, async (q) => (await q("update public.lead_distribution_settings set method = 'weighted' where organization_id = $1", [org])).rowCount), user.email).toBe(0);
      expect(await asUser(user.id, (q) => count(q, "select 1 from public.lead_distribution_settings where organization_id = $1", [org]))).toBe(1);
    }
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.lead_distribution_settings where organization_id = $1", [org]))).toBe(0);
    await setFeature(org, false);
    const foreign = await pgError(asUser(outsider.id, (q) => q("insert into public.lead_distribution_settings (organization_id, method) values ($1, 'weighted')", [org])));
    expect(foreign.code).toBe("42501");
    expect(foreign.hint).toBeUndefined();
    // audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'lead_distribution_settings'", [org]))).toBeGreaterThanOrEqual(3);
    await setFeature(org, true);
    await setMethod("round_robin");
  });

  it("rules: a source or a product, a team of the same business, 50 at most, the plan key", async () => {
    const insert = (cols: Record<string, unknown>, user: U = owner) =>
      pgError(
        asUser(user.id, (q) => {
          const row: Record<string, unknown> = { organization_id: org, ...cols };
          const names = Object.keys(row);
          return q(`insert into public.lead_routing_rules (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
        }),
      );
    expect((await insert({ team_id: team })).code).toBe("23514");
    // another business's team or source: the composite keys refuse it
    expect((await insert({ source_id: source, team_id: otherTeam })).code).toBe("23503");
    expect((await insert({ source_id: otherSource, team_id: team })).code).toBe("23503");
    await setFeature(org, false);
    expect((await insert({ source_id: source, team_id: team2 })).hint).toBe("feature:lead_distribution");
    // an inactive rule may be written without the key
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, source_id, team_id, is_active) values ($1, $2, $3, false)", [org, source2, team2]));
    expect((await pgError(asUser(owner.id, (q) => q("update public.lead_routing_rules set is_active = true where organization_id = $1 and source_id = $2", [org, source2])))).hint).toBe("feature:lead_distribution");
    await setFeature(org, true);
    // managers and members do not write rules; an outsider gets the plain refusal
    expect((await insert({ source_id: source, team_id: team2 }, manager)).code).toBe("42501");
    const foreign = await insert({ source_id: source, team_id: team2 }, outsider);
    expect(foreign.code).toBe("42501");
    expect(foreign.hint).toBeUndefined();
    expect(await asUser(repA.id, async (q) => (await q("update public.lead_routing_rules set position = 9 where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.lead_routing_rules where organization_id = $1", [org]))).toBe(0);
    // the cap
    const existing = await asAdmin((q) => count(q, "select 1 from public.lead_routing_rules where organization_id = $1", [org]));
    await asAdmin((q) =>
      q("insert into public.lead_routing_rules (organization_id, position, is_active, source_id, team_id) select $1, 100 + g, false, $2, $3 from generate_series(1, $4::int) g", [org, source2, team2, 50 - existing]),
    );
    expect((await insert({ source_id: source, team_id: team2, is_active: false })).hint).toBe("lead_routing_rules:max");
    await asAdmin((q) => q("update public.lead_routing_rules set team_id = $2 where organization_id = $1 and position > 100", [org, team2]));
    // removing a team takes its rules with it
    const spare = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'זמני') returning id", [org])).rows[0].id);
    await asAdmin((q) => q("update public.lead_routing_rules set team_id = $2 where organization_id = $1 and position > 100", [org, spare]));
    await asUser(owner.id, (q) => q("delete from public.teams where id = $1", [spare]));
    expect(await asAdmin((q) => count(q, "select 1 from public.lead_routing_rules where organization_id = $1 and position > 100", [org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'lead_routing_rules'", [org]))).toBeGreaterThanOrEqual(1);
  });

  it("round robin is unchanged without the key, even with saved settings and rules", async () => {
    await setMethod("weighted", { [repA.id]: 10 });
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, source_id, team_id) values ($1, $2, $3)", [org, source, team2]));
    await setFeature(org, false);
    await reset([repA, repB]);
    const owners = [];
    for (let i = 0; i < 4; i++) {
      const l = await lead(await submit(`050-71000${i}0`));
      expect(l.team_id).toBe(team);
      owners.push(l.owner_id);
    }
    expect(owners).toEqual([repA.id, repB.id, repA.id, repB.id]);
    await setFeature(org, true);
    await setMethod("round_robin");
  });

  it("by weight: a member of weight 2 gets twice the leads of weight 1; someone new is not flooded", async () => {
    await setMethod("weighted", { [repA.id]: 2 });
    await reset([repA, repB]);
    const owners = [];
    for (let i = 0; i < 9; i++) {
      owners.push((await lead(await submit(`050-72000${i}0`))).owner_id);
    }
    expect(tally(owners)).toEqual({ [repA.id]: 6, [repB.id]: 3 });
    // repC joins the team now: from the clock, so they get about their share, not every lead
    await asUser(owner.id, (q) => q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, repC.id]));
    const later = [];
    for (let i = 0; i < 8; i++) {
      later.push((await lead(await submit(`050-72100${i}0`))).owner_id);
    }
    const t = tally(later);
    expect(t[repC.id]).toBeGreaterThanOrEqual(2);
    expect(t[repC.id]).toBeLessThanOrEqual(3);
    expect(t[repA.id]).toBeGreaterThanOrEqual(3);
    await asUser(owner.id, (q) => q("delete from public.team_members where team_id = $1 and user_id = $2", [team, repC.id]));
    // a weight saved for someone of another business is ignored and harms nothing
    await setMethod("weighted", { [otherRep.id]: 10 });
    expect([repA.id, repB.id]).toContain((await pick(team)).owner_id);
    await setMethod("round_robin");
  });

  it("by open load: the fewest open leads (per unit of weight) first; closed, converted and binned leads do not count", async () => {
    await setMethod("load");
    await reset([repA, repB, repC]);
    // n open leads of a person; "deleted_at" / "converted_at" mark them binned or converted
    const give = (user: U, n: number, mark: "" | "deleted_at" | "converted_at" = "") =>
      asAdmin(async (q) => {
        for (let i = 0; i < n; i++) {
          await q(
            `insert into public.leads (organization_id, status_id, full_name, owner_id, deleted_at, converted_at)
             select $1, s.id, 'ליד פתוח', $2, case when $3 = 'deleted_at' then now() end, case when $3 = 'converted_at' then now() end
               from public.lead_statuses s where s.organization_id = $1 and s.kind = 'open' order by s.position limit 1`,
            [org, user.id, mark],
          );
        }
      });
    await give(repA, 3);
    await give(repB, 1);
    // repB's other leads are binned or converted: they do not count
    await give(repB, 2, "deleted_at");
    await give(repB, 2, "converted_at");
    expect((await lead(await submit("050-7300010"))).owner_id).toBe(repB.id);
    // now A 3, B 2: B again
    expect((await lead(await submit("050-7300020"))).owner_id).toBe(repB.id);
    // B 3 = A 3: the round robin order breaks the tie (A waited longer)
    expect((await lead(await submit("050-7300030"))).owner_id).toBe(repA.id);
    // with weights the load is per unit of weight: A (4 leads, weight 4) before B (3 leads, weight 1)
    await setMethod("load", { [repA.id]: 4 });
    expect((await lead(await submit("050-7300040"))).owner_id).toBe(repA.id);
    // a lead in a closed status does not count
    await asAdmin((q) =>
      q(
        `update public.leads set status_id = (select id from public.lead_statuses where organization_id = $1 and kind <> 'open' order by position limit 1)
          where organization_id = $1 and owner_id = $2 and deleted_at is null and converted_at is null`,
        [org, repB.id],
      ),
    );
    await setMethod("load");
    expect((await lead(await submit("050-7300050"))).owner_id).toBe(repB.id);
    await setMethod("round_robin");
  });

  it("rules: the first active matching rule's team is the pool and the lead's team; no match = the form's team", async () => {
    await reset([repA, repB, repC]);
    const ruleId = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.lead_routing_rules (organization_id, position, source_id, team_id) values ($1, 2, $2, $3) returning id", [org, source, team2])).rows[0].id,
    );
    const l = await lead(await submit("050-7400010"));
    expect(l).toEqual({ owner_id: repC.id, team_id: team2 });
    // the form of another source is not matched
    const other = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id, source_id) values ($1, 'webhook', 'טופס גוגל', $2, 'round_robin', $3, $4) returning token", [org, owner.id, team, source2])).rows[0].token,
    );
    const g = await lead(await submit("050-7400020", other));
    expect(g.team_id).toBe(team);
    expect([repA.id, repB.id]).toContain(g.owner_id);
    // a rule before it (position 1) that sends the same source back to the first team wins
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, position, source_id, team_id) values ($1, 1, $2, $3)", [org, source, team]));
    expect((await lead(await submit("050-7400030"))).team_id).toBe(team);
    await asAdmin((q) => q("update public.lead_routing_rules set is_active = false where organization_id = $1 and id <> $2", [org, ruleId]));
    // source and product together: both must match
    await asUser(owner.id, (q) => q("update public.lead_routing_rules set product_id = $2 where id = $1", [ruleId, product]));
    expect((await pick(team, { source_id: source, product_id: null })).team_id).toBe(team);
    expect((await pick(team, { source_id: source, product_id: product })).team_id).toBe(team2);
    // a product rule alone
    await asUser(owner.id, (q) => q("update public.lead_routing_rules set source_id = null where id = $1", [ruleId]));
    expect((await pick(null, { source_id: source2, product_id: product })).team_id).toBe(team2);
    // no lead given (the pass-on and the waiting job): no rules
    expect((await pick(team)).team_id).toBe(team);
    // a rule's team where nobody can take leads: nobody in hours, the lead waits for "לקחתי" (CAP-09 lines)
    await asUser(owner.id, (q) => q("update public.lead_routing_rules set source_id = $2, product_id = null where id = $1", [ruleId, source]));
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date - 1, current_date + 1)", [org, repC.id]));
    const waiting = await submit("050-7400040");
    expect(await lead(waiting)).toEqual({ owner_id: null, team_id: team2 });
    expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where lead_id = $1 and team_id = $2", [waiting, team2]))).toBe(1);
    // the would-be takers are the rule team's people (plus whoever reads all)
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and type = 'lead_new' and user_id = $2", [waiting, repC.id]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and type = 'lead_new' and user_id = $2", [waiting, repA.id]))).toBe(0);
    await clearLeaves();
    // the waiting job gives it to the rule team's member back in hours
    await asAdmin((q) => q("update app.rotation_waiting_leads set next_check_at = now() + interval '1 hour' where resolved_at is null and lead_id <> $1", [waiting]));
    await asAdmin((q) => q("select app.assign_waiting_rotation_leads()"));
    expect((await lead(waiting)).owner_id).toBe(repC.id);
  });

  it("an automation's round robin on a lead applies the rules by the lead's source and requested product", async () => {
    await reset([repA, repB, repC]);
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, position, product_id, team_id) values ($1, 0, $2, $3)", [org, product, team2]));
    const leadId = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.leads (organization_id, status_id, full_name, requested_product_id)
           select $1, s.id, 'רוצה מנוי', $2 from public.lead_statuses s where s.organization_id = $1 and s.kind = 'open' order by s.position limit 1 returning id`,
          [org, product],
        )
      ).rows[0].id,
    );
    const steps = await asAdmin(async (q) => {
      const auto = (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active)
           values ($1, 'חלוקה', 'lead', 'created', $2, false) returning id`,
          [org, JSON.stringify([{ type: "assign_owner", mode: "round_robin", team_id: team }])],
        )
      ).rows[0].id;
      return (await q<{ r: unknown }>("select app.run_automation_actions(a, 'lead', $2) as r from public.automations a where a.id = $1", [auto, leadId])).rows[0].r;
    });
    expect(JSON.stringify(steps)).toContain("ok");
    expect((await lead(leadId)).owner_id).toBe(repC.id);
  });

  it("CAP-09 and HEB-08 still decide who may get a lead, under every method", async () => {
    for (const method of ["weighted", "load"]) {
      await setMethod(method);
      await reset([repA, repB]);
      await clearLeaves();
      // repA on leave with no deputy: skipped
      await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date - 1, current_date + 1)", [org, repA.id]));
      expect((await lead(await submit(`050-75${method.length}0010`))).owner_id, method).toBe(repB.id);
      expect((await lead(await submit(`050-75${method.length}0020`))).owner_id, method).toBe(repB.id);
      await clearLeaves();
      // repA away with repC as deputy: repA's turn, repC gets it
      await asUser(owner.id, (q) =>
        q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, current_date - 1, current_date + 1, 'vacation', $3)", [org, repA.id, repC.id]),
      );
      await reset([repA, repB]);
      expect((await lead(await submit(`050-75${method.length}0030`))).owner_id, method).toBe(repC.id);
      await clearLeaves();
      // not available: never
      await asAdmin((q) => q("update public.memberships set is_available = false where organization_id = $1 and user_id = $2", [org, repB.id]));
      await reset([repB, repA]);
      expect((await lead(await submit(`050-75${method.length}0040`))).owner_id, method).toBe(repA.id);
      await asAdmin((q) => q("update public.memberships set is_available = true where organization_id = $1 and user_id = $2", [org, repB.id]));
    }
    await setMethod("round_robin");
  });

  it("the pass-on's excluded people are skipped and keep their turn and their weighted place", async () => {
    await setMethod("weighted");
    await reset([repA, repB]);
    const before = await asAdmin(async (q) =>
      (await q<{ t: Date | null }>("select last_lead_assigned_at as t from public.memberships where organization_id = $1 and user_id = $2", [org, repA.id])).rows[0].t?.toISOString(),
    );
    const p = await pick(team, null, [repA.id]);
    expect(p.owner_id).toBe(repB.id);
    const after = await asAdmin(async (q) =>
      (await q<{ t: Date | null }>("select last_lead_assigned_at as t from public.memberships where organization_id = $1 and user_id = $2", [org, repA.id])).rows[0].t?.toISOString(),
    );
    expect(after).toBe(before);
    expect((await pick(team)).owner_id).toBe(repA.id);
    // everyone excluded: nobody
    expect((await pick(team, null, [repA.id, repB.id])).owner_id).toBeNull();
    await setMethod("round_robin");
  });

  it("never crosses businesses: another business's team gives nobody, and its key does not open ours", async () => {
    await setMethod("round_robin");
    expect((await pick(otherTeam)).owner_id).toBeNull();
    // the other business has the key and a weighted method; ours does not have the key
    await setFeature(otherOrg, true);
    await asUser(outsider.id, (q) => q("insert into public.lead_distribution_settings (organization_id, method) values ($1, 'weighted')", [otherOrg]));
    await setFeature(org, false);
    expect((await pick(team)).method).toBe("round_robin");
    // a person of another business never comes out of our pick
    await setFeature(org, true);
    for (let i = 0; i < 4; i++) {
      expect([repA.id, repB.id, repC.id, owner.id, admin.id, manager.id]).toContain((await pick(null)).owner_id);
    }
    // nobody but the server calls the pick
    for (const user of [owner, outsider]) {
      expect((await pgError(asUser(user.id, (q) => q("select app.lead_distribution_pick($1, null, now())", [org])))).code).toBe("42501");
    }
  });
});

describe("the plan key lead_distribution (CAP-08, owner 14 October 2026)", () => {
  it("is on from basic up, off in personal and in a plan without the key; running the migration again changes nothing", async () => {
    await asAdmin(async (q) => {
      const flags = (await q<{ key: string; f: boolean | null }>("select key, (features ->> 'lead_distribution')::boolean as f from public.plans order by position, key")).rows;
      expect(Object.fromEntries(flags.map((r) => [r.key, r.f]))).toMatchObject({ personal: false, basic: true, pro: true, business: true, free: false });
      expect((await q<{ d: boolean }>("select (app.plan_key_defaults() -> 'features' ->> 'lead_distribution')::boolean as d")).rows[0].d).toBe(false);
      const sql = readFileSync(join(process.cwd(), "supabase/migrations", readdirSync(join(process.cwd(), "supabase/migrations")).find((f) => f.endsWith("_lead_distribution_plan.sql")) as string), "utf8");
      const before = (await q("select xmin::text as x, * from public.plans order by key")).rows;
      await q("savepoint s");
      await q(sql);
      expect((await q("select xmin::text as x, * from public.plans order by key")).rows).toEqual(before);
      // a value set on a plan by hand is kept by the "missing key" statement, and a plan missing it gets false
      await q("update public.plans set features = features - 'lead_distribution' where key = 'free'");
      await q(sql);
      expect((await q<{ f: boolean }>("select (features ->> 'lead_distribution')::boolean as f from public.plans where key = 'free'")).rows[0].f).toBe(false);
      await q("rollback to savepoint s");
    });
    // a new business (trial on pro) has the capability without any override
    const u = await createUser("ld-plan");
    const o = await createOrg(u.id, "עסק בניסיון");
    expect(await asAdmin(async (q) => (await q<{ f: boolean }>("select app.org_has_feature($1, 'lead_distribution') as f", [o])).rows[0].f)).toBe(true);
  });
});


// CAP-08 follow-ups (owner, 14 October 2026): language on leads and forms, rules by language and
// by a list field, a rule that names one person (HEB-08 rules), and load = unanswered leads.
describe("lead distribution follow-ups (CAP-08)", () => {
  let owner: U, repA: U, repB: U, repC: U, viewer: U, outsider: U;
  let org: string, team: string, team2: string, field: string;
  let formToken: string, webhookToken: string;

  const today = "(now() at time zone 'Asia/Jerusalem')::date";
  const submitForm = (payload: Record<string, unknown>, tok = formToken, kind = "form") =>
    asService(async (q) => (await q<{ r: { lead_id: string; status: string } }>("select public.intake_submit($1, $2, $3) as r", [tok, kind, JSON.stringify(payload)])).rows[0].r);
  const leadRow = (id: string) =>
    asAdmin(async (q) => (await q<{ owner_id: string | null; team_id: string | null; preferred_locale: string | null }>("select owner_id, team_id, preferred_locale from public.leads where id = $1", [id])).rows[0]);
  const rule = (cols: Record<string, unknown>, user: U = owner) =>
    asUser(user.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: org, ...cols };
      const names = Object.keys(row);
      return (await q<{ id: string }>(`insert into public.lead_routing_rules (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row))).rows[0].id;
    });
  const clearRules = () => asAdmin((q) => q("update public.lead_routing_rules set is_active = false where organization_id = $1", [org]));
  const clearLeaves = () => asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1", [org]));

  beforeAll(async () => {
    owner = await createUser("ldf-owner");
    org = await createOrg(owner.id, "עסק חלוקה 2");
    repA = await addMember(org, owner.id, "member", "ldf-a");
    repB = await addMember(org, owner.id, "member", "ldf-b");
    repC = await addMember(org, owner.id, "member", "ldf-c");
    viewer = await addMember(org, owner.id, "viewer", "ldf-viewer");
    outsider = await createUser("ldf-outsider");
    await createOrg(outsider.id, "עסק זר 2");
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'כללי') returning id", [org])).rows[0].id;
      team2 = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'ערבית') returning id", [org])).rows[0].id;
      for (const user of [repA, repB]) await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, user.id]);
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team2, repC.id]);
      field = (
        await q<{ id: string }>(
          `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options) values ($1, 'lead', 'area', 'אזור', 'select', '["צפון", "מרכז", "דרום"]') returning id`,
          [org],
        )
      ).rows[0].id;
      await q(`insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'notes2', 'הערות', 'text')`, [org]);
      formToken = (
        await q<{ token: string }>(
          `insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id, locale_choice, fields)
           values ($1, 'form', 'טופס שפה', $2, 'round_robin', $3, true, '[{"key": "full_name"}, {"key": "phone"}, {"key": "cf:area"}]') returning token`,
          [org, owner.id, team],
        )
      ).rows[0].token;
      webhookToken = (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id) values ($1, 'webhook', 'חיבור', $2, 'round_robin', $3) returning token", [org, owner.id, team])).rows[0].token;
    });
  });

  beforeEach(async () => {
    await clearRules();
    await clearLeaves();
  });

  it("language on a lead: the contacts' codes, written by a person, copied to the contact at conversion only when empty", async () => {
    const lead = await insertLead(repA.id, org, { full_name: "ליד שפה" });
    expect((await pgError(asUser(repA.id, (q) => q("update public.leads set preferred_locale = 'xx' where id = $1", [lead])))).code).toBe("23514");
    await asUser(repA.id, (q) => q("update public.leads set preferred_locale = 'ar' where id = $1", [lead]));
    const converted = await asUser(owner.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [lead])).rows[0].r.contact_id);
    expect(await asAdmin(async (q) => (await q<{ l: string | null }>("select preferred_locale as l from public.contacts where id = $1", [converted])).rows[0].l)).toBe("ar");
    // a contact that already has a language keeps it (the conversion trigger never overwrites)
    const lead2 = await insertLead(repA.id, org, { full_name: "ליד שפה 2" });
    await asUser(repA.id, (q) => q("update public.leads set preferred_locale = 'ru' where id = $1", [lead2]));
    await asAdmin(async (q) => {
      await q("savepoint s");
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, preferred_locale) values ($1, 'קיים', 'he') returning id", [org])).rows[0].id;
      await q("update public.leads set converted_contact_id = $2, converted_at = now() where id = $1", [lead2, contact]);
      expect((await q<{ l: string }>("select preferred_locale as l from public.contacts where id = $1", [contact])).rows[0].l).toBe("he");
      await q("rollback to savepoint s");
    });
  });

  it("the public form asks the language only when it is turned on; a repeat inquiry fills an empty one", async () => {
    expect(await asService(async (q) => (await q<{ f: { locale_choice: boolean } }>("select public.intake_form($1) as f", [formToken])).rows[0].f.locale_choice)).toBe(true);
    const r = await submitForm({ full_name: "פונה", phone: "050-8800001", preferred_locale: "en" });
    expect((await leadRow(r.lead_id)).preferred_locale).toBe("en");
    // a value outside the list is ignored
    expect((await leadRow((await submitForm({ full_name: "פונה", phone: "050-8800002", preferred_locale: "xx" })).lead_id)).preferred_locale).toBeNull();
    // a webhook (or a form that does not ask) ignores it
    expect((await leadRow((await submitForm({ full_name: "פונה", phone: "050-8800003", preferred_locale: "en" }, webhookToken, "webhook")).lead_id)).preferred_locale).toBeNull();
    // repeat inquiry: fills the empty one, keeps a set one
    const empty = await submitForm({ full_name: "פונה", phone: "050-8800002", preferred_locale: "ru" });
    expect(empty.status).toBe("duplicate");
    expect((await leadRow(empty.lead_id)).preferred_locale).toBe("ru");
    const kept = await submitForm({ full_name: "פונה", phone: "050-8800001", preferred_locale: "fr" });
    expect((await leadRow(kept.lead_id)).preferred_locale).toBe("en");
  });

  it("rules by language and by a list field; a field rule needs a list field of leads and one of its options", async () => {
    // a list field: only one of its options; a text field or an unknown field is refused
    expect((await pgError(rule({ field_key: "area", field_value: "מזרח", team_id: team2 }))).hint).toBe("lead_routing_rules:field");
    expect((await pgError(rule({ field_key: "notes2", field_value: "x", team_id: team2 }))).hint).toBe("lead_routing_rules:field");
    // a field with no value: refused by the trigger before the shape check
    expect((await pgError(rule({ field_key: "area", team_id: team2 }))).hint).toBe("lead_routing_rules:field");
    expect((await pgError(rule({ locale: "xx", team_id: team2 }))).code).toBe("23514");
    await rule({ position: 1, locale: "ar", team_id: team2 });
    const ar = await submitForm({ full_name: "פונה", phone: "050-8800011", preferred_locale: "ar" });
    expect(await leadRow(ar.lead_id)).toMatchObject({ owner_id: repC.id, team_id: team2, preferred_locale: "ar" });
    const he = await submitForm({ full_name: "פונה", phone: "050-8800012", preferred_locale: "he" });
    expect((await leadRow(he.lead_id)).team_id).toBe(team);
    await clearRules();
    await rule({ position: 1, field_key: "area", field_value: "צפון", team_id: team2 });
    const north = await submitForm({ full_name: "פונה", phone: "050-8800013", custom: { area: "צפון" } });
    expect((await leadRow(north.lead_id)).team_id).toBe(team2);
    const south = await submitForm({ full_name: "פונה", phone: "050-8800014", custom: { area: "דרום" } });
    expect((await leadRow(south.lead_id)).team_id).toBe(team);
    // a field that is switched off: its rule can no longer be added
    await asAdmin((q) => q("update public.field_definitions set is_active = false where id = $1", [field]));
    expect((await pgError(rule({ field_key: "area", field_value: "צפון", team_id: team }))).hint).toBe("lead_routing_rules:field");
    await asAdmin((q) => q("update public.field_definitions set is_active = true where id = $1", [field]));
  });

  it("a rule names a team or one person, never both or neither; the person is an active member who is not a viewer", async () => {
    expect((await pgError(rule({ locale: "en", team_id: team, user_id: repA.id }))).code).toBe("23514");
    expect((await pgError(rule({ locale: "en" }))).code).toBe("23514");
    expect((await pgError(rule({ locale: "en", user_id: viewer.id }))).hint).toBe("lead_routing_rules:user_inactive");
    // someone of another business is not a member here (the composite key would refuse it too)
    expect((await pgError(rule({ locale: "en", user_id: outsider.id }))).hint).toBe("lead_routing_rules:user_inactive");
    await rule({ locale: "en", user_id: repB.id });
  });

  it("a person rule goes through HEB-08: the person, else their deputy, else no owner (SPD-01) and the absence list", async () => {
    await rule({ position: 1, locale: "fr", user_id: repC.id });
    // present (working hours are not asked, as for a fixed owner)
    // the team: the person's only team (app.default_team()'s rule), not the form's
    expect(await leadRow((await submitForm({ full_name: "פונה", phone: "050-8800021", preferred_locale: "fr" })).lead_id)).toMatchObject({ owner_id: repC.id, team_id: team2 });
    // away with a deputy
    await asUser(owner.id, (q) =>
      q(`insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, ${today} - 1, ${today} + 1, 'vacation', $3)`, [org, repC.id, repA.id]),
    );
    expect((await leadRow((await submitForm({ full_name: "פונה", phone: "050-8800022", preferred_locale: "fr" })).lead_id)).owner_id).toBe(repA.id);
    // away with no deputy: no owner, the would-be takers are told, and it waits for the return; never the form's owner
    await clearLeaves();
    await asAdmin((q) => q(`insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, ${today} - 1, ${today} + 1)`, [org, repC.id]));
    const orphan = (await submitForm({ full_name: "פונה", phone: "050-8800023", preferred_locale: "fr" })).lead_id;
    expect((await leadRow(orphan)).owner_id).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.absence_waiting_leads where lead_id = $1 and absent_user_id = $2", [orphan, repC.id]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and type = 'lead_new'", [orphan]))).toBeGreaterThan(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where lead_id = $1", [orphan]))).toBe(0);
    await clearLeaves();
    // a person who was suspended later: the rule is skipped, the lead goes to the team's rotation
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, repC.id]));
    expect([repA.id, repB.id]).toContain((await leadRow((await submitForm({ full_name: "פונה", phone: "050-8800024", preferred_locale: "fr" })).lead_id)).owner_id);
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, repC.id]));
    // without the plan key the rule does nothing
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"lead_distribution\": false}' where organization_id = $1", [org]));
    expect([repA.id, repB.id]).toContain((await leadRow((await submitForm({ full_name: "פונה", phone: "050-8800025", preferred_locale: "fr" })).lead_id)).owner_id);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'lead_distribution' where organization_id = $1", [org]));
  });

  it("an automation's round robin on a lead follows a person rule, with the HEB-08 warning when the person is away", async () => {
    await rule({ position: 1, locale: "am", user_id: repB.id });
    const lead = await insertLead(owner.id, org, { full_name: "ליד אמהרית" });
    await asAdmin((q) => q("update public.leads set preferred_locale = 'am', owner_id = null where id = $1", [lead]));
    const run = () =>
      asAdmin(async (q) => {
        const auto = (
          await q<{ id: string }>(
            "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'סבב', 'lead', 'created', $2, false) returning id",
            [org, JSON.stringify([{ type: "assign_owner", mode: "round_robin", team_id: team }])],
          )
        ).rows[0].id;
        return JSON.stringify((await q<{ r: unknown }>("select app.run_automation_actions(a, 'lead', $2) as r from public.automations a where a.id = $1", [auto, lead])).rows[0].r);
      });
    await run();
    expect((await leadRow(lead)).owner_id).toBe(repB.id);
    await asAdmin((q) => q("update public.leads set owner_id = null where id = $1", [lead]));
    await asAdmin((q) => q(`insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, ${today} - 1, ${today} + 1)`, [org, repB.id]));
    expect(await run()).toContain("the owner is away, the lead has no owner");
    expect((await leadRow(lead)).owner_id).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.absence_waiting_leads where lead_id = $1", [lead]))).toBe(1);
  });

  it("open load counts only unanswered leads: a person's contact entry answers a lead, a private note does not; imported leads do not count", async () => {
    const load = (user: U) => asAdmin(async (q) => (await q<{ n: number }>("select app.member_open_load($1, $2) as n", [org, user.id])).rows[0].n);
    await asAdmin((q) => q("update public.leads set deleted_at = now() where organization_id = $1 and owner_id = $2 and deleted_at is null", [org, repA.id]));
    const a1 = await insertLead(repA.id, org, { full_name: "לא נענה" });
    const a2 = await insertLead(repA.id, org, { full_name: "נענה" });
    const a3 = await insertLead(repA.id, org, { full_name: "הערה פרטית" });
    await asAdmin((q) => q("update public.leads set owner_id = $2 where id = any($1)", [[a1, a2, a3], repA.id]));
    expect(await load(repA)).toBe(3);
    await asUser(repA.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'דיברנו', $2)", [org, a2]));
    await asUser(repA.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'לעצמי', $2, true)", [org, a3]));
    expect(await load(repA)).toBe(2);
    // a system entry (no person) does not answer either
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'system', 'מערכת', $2)", [org, a1]));
    expect(await load(repA)).toBe(2);
  });
});

// Owner, 14 October 2026: a rule that names one person sets the lead's team by app.default_team()'s
// rule (the person's only team, else their primary team; else the form's or step's team stays).
describe("the team of a lead a rule sends to one person (CAP-08)", () => {
  let owner: U, solo: U, multi: U, noPrimary: U, loner: U, away: U, deputy: U;
  let org: string, formTeam: string, t1: string, t2: string, t3: string;
  let token: string;
  const today = "(now() at time zone 'Asia/Jerusalem')::date";
  const submit = (phone: string, locale: string) =>
    asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify({ full_name: "פונה", phone, preferred_locale: locale })])).rows[0].r.lead_id);
  const leadRow = (id: string) => asAdmin(async (q) => (await q<{ owner_id: string | null; team_id: string | null }>("select owner_id, team_id from public.leads where id = $1", [id])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("ldt-owner");
    org = await createOrg(owner.id, "עסק צוות לאדם");
    solo = await addMember(org, owner.id, "member", "ldt-solo");
    multi = await addMember(org, owner.id, "member", "ldt-multi");
    noPrimary = await addMember(org, owner.id, "member", "ldt-noprimary");
    loner = await addMember(org, owner.id, "member", "ldt-loner");
    away = await addMember(org, owner.id, "member", "ldt-away");
    deputy = await addMember(org, owner.id, "member", "ldt-deputy");
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      const team = async (name: string) => (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, $2) returning id", [org, name])).rows[0].id;
      formTeam = await team("טופס");
      t1 = await team("א");
      t2 = await team("ב");
      t3 = await team("ג");
      const join = (t: string, u: U, primary = false) =>
        q("insert into public.team_members (organization_id, team_id, user_id, is_primary) values ($1, $2, $3, $4)", [org, t, u.id, primary]);
      await join(t1, solo);
      await join(t1, multi);
      await join(t2, multi, true);
      await join(t1, noPrimary);
      await join(t3, noPrimary);
      await join(t3, away);
      await join(t1, deputy);
      token = (
        await q<{ token: string }>(
          `insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id, locale_choice, fields)
           values ($1, 'form', 'טופס', $2, 'round_robin', $3, true, '[{"key": "full_name"}, {"key": "phone"}]') returning token`,
          [org, owner.id, formTeam],
        )
      ).rows[0].token;
      const rule = (locale: string, u: U) => q("insert into public.lead_routing_rules (organization_id, locale, user_id) values ($1, $2, $3)", [org, locale, u.id]);
      await rule("he", solo);
      await rule("ar", multi);
      await rule("en", noPrimary);
      await rule("ru", loner);
      await rule("fr", away);
    });
  });

  it("app.member_default_team is app.default_team()'s choice", async () => {
    const team = (u: U) => asAdmin(async (q) => (await q<{ t: string | null }>("select app.member_default_team($1, $2) as t", [org, u.id])).rows[0].t);
    expect(await team(solo)).toBe(t1);
    expect(await team(multi)).toBe(t2);
    expect(await team(noPrimary)).toBeNull();
    expect(await team(loner)).toBeNull();
    // the trigger itself is unchanged: a deal of a person with one team joins it
    const pipe = await asAdmin(async (q) => (await q<{ p: string; s: string }>("select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 order by s.position limit 1", [org])).rows[0]);
    const deal = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [org, pipe.p, pipe.s, solo.id])).rows[0].id);
    expect(await asAdmin(async (q) => (await q<{ t: string }>("select team_id as t from public.deals where id = $1", [deal])).rows[0].t)).toBe(t1);
  });

  it("intake: the person's only team; else their primary team; else the form's team", async () => {
    expect(await leadRow(await submit("050-8900001", "he"))).toEqual({ owner_id: solo.id, team_id: t1 });
    expect(await leadRow(await submit("050-8900002", "ar"))).toEqual({ owner_id: multi.id, team_id: t2 });
    expect(await leadRow(await submit("050-8900003", "en"))).toEqual({ owner_id: noPrimary.id, team_id: formTeam });
    expect(await leadRow(await submit("050-8900004", "ru"))).toEqual({ owner_id: loner.id, team_id: formTeam });
  });

  it("the person is away and the deputy takes the lead: the team is still the person's (the lead was meant for them)", async () => {
    await asUser(owner.id, (q) =>
      q(`insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id) values ($1, $2, ${today} - 1, ${today} + 1, 'vacation', $3)`, [org, away.id, deputy.id]),
    );
    expect(await leadRow(await submit("050-8900005", "fr"))).toEqual({ owner_id: deputy.id, team_id: t3 });
    // the automation round robin does the same
    const lead = await insertLead(owner.id, org, { full_name: "ליד צרפתית" });
    await asAdmin((q) => q("update public.leads set preferred_locale = 'fr', owner_id = null, team_id = $2 where id = $1", [lead, formTeam]));
    await asAdmin(async (q) => {
      const auto = (
        await q<{ id: string }>(
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'סבב', 'lead', 'created', $2, false) returning id",
          [org, JSON.stringify([{ type: "assign_owner", mode: "round_robin", team_id: formTeam }])],
        )
      ).rows[0].id;
      await q("select app.run_automation_actions(a, 'lead', $2) from public.automations a where a.id = $1", [auto, lead]);
    });
    expect(await leadRow(lead)).toEqual({ owner_id: deputy.id, team_id: t3 });
  });
});

// Review of 79273c2 (15 October 2026).
describe("lead distribution review fixes (CAP-08)", () => {
  let owner: U, repA: U, repB: U, repC: U, keeper: U;
  let org: string, team: string, team2: string, team3: string;
  let token: string;
  const leadRow = (id: string) => asAdmin(async (q) => (await q<{ owner_id: string | null; team_id: string | null }>("select owner_id, team_id from public.leads where id = $1", [id])).rows[0]);
  const runRoundRobin = (lead: string, stepTeam: string | null) =>
    asAdmin(async (q) => {
      const auto = (
        await q<{ id: string }>(
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'סבב', 'lead', 'created', $2, false) returning id",
          [org, JSON.stringify([{ type: "assign_owner", mode: "round_robin", team_id: stepTeam }])],
        )
      ).rows[0].id;
      return JSON.stringify((await q<{ r: unknown }>("select app.run_automation_actions(a, 'lead', $2) as r from public.automations a where a.id = $1", [auto, lead])).rows[0].r);
    });
  const newLead = async (fields: Record<string, unknown>) => {
    const id = await insertLead(owner.id, org, { full_name: "ליד" });
    const cols = Object.keys(fields);
    if (cols.length > 0) {
      await asAdmin((q) => q(`update public.leads set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1`, [id, ...Object.values(fields)]));
    }
    return id;
  };

  beforeAll(async () => {
    owner = await createUser("ldr-owner");
    org = await createOrg(owner.id, "עסק תיקוני סקירה");
    repA = await addMember(org, owner.id, "member", "ldr-a");
    repB = await addMember(org, owner.id, "member", "ldr-b");
    repC = await addMember(org, owner.id, "member", "ldr-c");
    keeper = await addMember(org, owner.id, "member", "ldr-keeper");
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      const mk = async (name: string) => (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, $2) returning id", [org, name])).rows[0].id;
      team = await mk("ראשי");
      team2 = await mk("צפון");
      team3 = await mk("אחר");
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, repA.id]);
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team2, repB.id]);
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team2, repC.id]);
      await q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, default_value)
         values ($1, 'lead', 'region', 'אזור', 'select', '["צפון", "דרום"]', '"צפון"')`,
        [org],
      );
      token = (
        await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id) values ($1, 'webhook', 'חיבור', $2, 'round_robin', $3) returning token", [org, owner.id, team])
      ).rows[0].token;
    });
  });

  beforeEach(() => asAdmin((q) => q("update public.lead_routing_rules set is_active = false where organization_id = $1", [org])));

  it("a weight must be a whole number: 2.0 is refused, and a stored 2.0 could not break the pick", async () => {
    const bad = await pgError(asUser(owner.id, (q) => q(`insert into public.lead_distribution_settings (organization_id, method, weights) values ($1, 'weighted', '{"${repA.id}": 2.0}')`, [org])));
    expect(bad.code).toBe("23514");
    const w = (weights: string) => asAdmin(async (q) => (await q<{ w: number }>(`select app.distribution_weight('${weights}'::jsonb, $1) as w`, [repA.id])).rows[0].w);
    expect(await w(`{"${repA.id}": 2.0}`)).toBe(2);
    expect(await w(`{"${repA.id}": 2.5}`)).toBe(1);
    expect(await w(`{"${repA.id}": 3}`)).toBe(3);
  });

  it("intake matches the rules against the custom values with the fields' defaults", async () => {
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, field_key, field_value, team_id) values ($1, 'region', 'צפון', $2)", [org, team2]));
    const lead = await asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [token, JSON.stringify({ full_name: "פונה", phone: "050-8990001" })])).rows[0].r.lead_id);
    expect((await leadRow(lead)).team_id).toBe(team2);
    expect([repB.id, repC.id]).toContain((await leadRow(lead)).owner_id);
  });

  it("the automation round robin puts the route's team on the lead, as intake does", async () => {
    // no rule: the step's team
    const plain = await newLead({ owner_id: null, team_id: team3 });
    await runRoundRobin(plain, team);
    expect(await leadRow(plain)).toEqual({ owner_id: repA.id, team_id: team });
    // a rule's team wins over the step's
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, locale, team_id) values ($1, 'ru', $2)", [org, team2]));
    const ruled = await newLead({ owner_id: null, team_id: team3, preferred_locale: "ru" });
    await runRoundRobin(ruled, team);
    const row = await leadRow(ruled);
    expect(row.team_id).toBe(team2);
    expect([repB.id, repC.id]).toContain(row.owner_id);
  });

  it("a person rule moves the team only when the owner changes or the lead had none", async () => {
    await asUser(owner.id, (q) => q("insert into public.lead_routing_rules (organization_id, locale, user_id) values ($1, 'es', $2)", [org, repB.id]));
    // already the person's lead, in another team: the team stays
    const same = await newLead({ owner_id: repB.id, team_id: team3, preferred_locale: "es" });
    await runRoundRobin(same, team);
    expect(await leadRow(same)).toEqual({ owner_id: repB.id, team_id: team3 });
    // someone else's lead: it moves to the person and the person's team
    const moved = await newLead({ owner_id: keeper.id, team_id: team3, preferred_locale: "es" });
    await runRoundRobin(moved, team);
    expect(await leadRow(moved)).toEqual({ owner_id: repB.id, team_id: team2 });
    // the person is away with no deputy: a lead that keeps its owner keeps its team too
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date - 1, (now() at time zone 'Asia/Jerusalem')::date + 1)", [org, repB.id]));
    const kept = await newLead({ owner_id: keeper.id, team_id: team3, preferred_locale: "es" });
    expect(await runRoundRobin(kept, team)).toContain("the requested owner is away, the lead stays with its owner");
    expect(await leadRow(kept)).toEqual({ owner_id: keeper.id, team_id: team3 });
    // an unowned lead takes the person's team even while nobody owns it
    const orphan = await newLead({ owner_id: null, team_id: team3, preferred_locale: "es" });
    await runRoundRobin(orphan, team);
    expect(await leadRow(orphan)).toEqual({ owner_id: null, team_id: team2 });
  });
});
