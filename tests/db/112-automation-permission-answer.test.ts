import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DB_URL, addMember, asAdmin, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// PRM-01, owner's answer of 15 October 2026 (option א): the automations permission stays organization-wide,
// with its grant and revoke audited, rules that keep their creator and last editor, and changes an
// automation makes naming the rule. Also: a key whose module is not built yet cannot be granted.
describe("automations permission conditions (PRM-01)", () => {
  let owner: U, admin: U, member: U;
  let org: string;
  let tag: string;

  const grant = (user: string, keys: string[]) =>
    asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, user, keys]));
  const ruleRow = (id: string) =>
    asAdmin(async (q) => (await q<{ created_by: string | null; updated_by: string | null }>("select created_by, updated_by from public.automations where id = $1", [id])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("ans-owner");
    org = await createOrg(owner.id, "עסק אוטומציות");
    admin = await addMember(org, owner.id, "admin", "ans-admin");
    member = await addMember(org, owner.id, "member", "ans-member");
    tag = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'חם') returning id", [org])).rows[0].id);
  });

  it("a key whose module is not built yet cannot be granted", async () => {
    // view_costs became grantable with PRD-06 (migration product_costs)
    for (const key of ["issue_documents", "issue_credits", "record_payments", "mass_send"]) {
      expect((await pgError(grant(member.id, [key]))).hint, key).toBe("permissions:not_built");
    }
    const built = await asAdmin(async (q) => (await q<{ k: string[] }>("select app.member_permission_built_keys() as k")).rows[0].k);
    // DOC-01 (migration accounting_documents) made `documents` grantable
    expect([...built].sort()).toEqual(["documents", "edit_catalog", "export", "import", "manage_automations", "view_costs"]);
  });

  it("granting and revoking the automations permission are both in the audit log", async () => {
    await grant(member.id, ["manage_automations"]);
    await grant(member.id, []);
    const entries = await asAdmin(async (q) =>
      (await q<{ actor_id: string; changes: { user_id: string; permissions: { old: string[]; new: string[] } } }>(
        "select actor_id, changes from public.audit_log where organization_id = $1 and entity_type = 'member_permissions' and entity_id = $2 order by created_at, id",
        [org, member.id],
      )).rows,
    );
    expect(entries.map((e) => e.changes.permissions)).toEqual([
      { old: [], new: ["manage_automations"] },
      { old: ["manage_automations"], new: [] },
    ]);
    expect(entries.every((e) => e.actor_id === owner.id && e.changes.user_id === member.id)).toBe(true);
  });

  it("a rule keeps its creator and last editor, set by the server and not writable by a client", async () => {
    await grant(member.id, ["manage_automations"]);
    const rule = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'של העובד', 'lead', 'created', '[{\"type\":\"notify\"}]', false) returning id", [org])).rows[0].id,
    );
    expect(await ruleRow(rule)).toEqual({ created_by: member.id, updated_by: member.id });
    await asUser(admin.id, (q) => q("update public.automations set name = 'שונה' where id = $1", [rule]));
    expect(await ruleRow(rule)).toEqual({ created_by: member.id, updated_by: admin.id });
    // neither column can be sent by a client
    expect((await pgError(asUser(admin.id, (q) => q("update public.automations set updated_by = $2 where id = $1", [rule, member.id])))).code).toBe("42501");
    expect((await pgError(asUser(admin.id, (q) => q("update public.automations set created_by = $2 where id = $1", [rule, admin.id])))).code).toBe("42501");
    expect(
      (await pgError(asUser(admin.id, (q) => q("insert into public.automations (organization_id, name, entity_type, trigger_type, actions, updated_by) values ($1, 'x', 'lead', 'created', '[{\"type\":\"notify\"}]', $2)", [org, member.id])))).code,
    ).toBe("42501");
  });

  it("a change an automation makes names the rule in the audit log; a person's change does not", async () => {
    const rule = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>(
        "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'תיוג חמים', 'lead', 'created', $2, false) returning id",
        [org, JSON.stringify([{ type: "add_tag", tag_id: tag }])],
      )).rows[0].id,
    );
    const lead = await insertLead(owner.id, org, { full_name: "ליד לתיוג" });
    await asUser(owner.id, (q) => q("update public.leads set full_name = 'שם חדש' where id = $1", [lead]));
    expect((await asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, lead])).rows[0].r)).status).toBe("success");
    const entries = await asAdmin(async (q) =>
      (await q<{ changes: Record<string, unknown> }>("select changes from public.audit_log where organization_id = $1 and entity_type = 'leads' and entity_id = $2 and action = 'update' order by created_at, id", [org, lead])).rows,
    );
    const byPerson = entries.find((e) => "full_name" in e.changes);
    const byRule = entries.find((e) => "tag_ids" in e.changes);
    expect(byPerson?.changes.automation).toBeUndefined();
    expect(byRule?.changes.automation).toEqual({ id: rule, name: "תיוג חמים" });
    // the entry keeps the name as it was: renaming, then deleting the rule changes nothing in it
    await asUser(owner.id, (q) => q("update public.automations set name = 'שם אחר' where id = $1", [rule]));
    await asUser(owner.id, (q) => q("delete from public.automations where id = $1", [rule]));
    const kept = await asAdmin(async (q) =>
      (await q<{ a: unknown }>("select changes -> 'automation' as a from public.audit_log where organization_id = $1 and entity_type = 'leads' and entity_id = $2 and changes ? 'automation'", [org, lead])).rows,
    );
    expect(kept).toEqual([{ a: { id: rule, name: "תיוג חמים" } }]);
    // the running rule does not outlive the rule's actions
    expect(await asAdmin((q) => count(q, "select 1 from app.automation_rule_runs where rule_id is not null"))).toBe(0);
  });

  it("app.audit_row keeps ignoring the computed score (LEAD-05) next to the rule name", async () => {
    const def = await asAdmin(async (q) => (await q<{ d: string }>("select pg_get_functiondef('app.audit_row()'::regprocedure) as d")).rows[0].d);
    expect(def).toContain("'score'");
    expect(def).toContain("app.automation_rule");
    // a score-only recompute writes no audit entry
    const lead = await insertLead(owner.id, org, { full_name: "ליד לציון", email: "score@example.test" });
    const score = () => asAdmin(async (q) => (await q<{ s: number }>("select score as s from public.leads where id = $1", [lead])).rows[0].s);
    const audits = () => asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.audit_log where entity_id = $1", [lead])).rows[0].n));
    const [before, auditBefore] = [await score(), await audits()];
    await asUser(owner.id, (q) => q("insert into public.lead_score_rules (organization_id, field, op, points) values ($1, 'email', 'filled', 9)", [org]));
    expect(await asUser(owner.id, async (q) => (await q<{ done: boolean }>("select public.lead_scores_refresh($1) as done", [org])).rows[0].done)).toBe(true);
    expect(await score()).toBe(before + 9);
    expect(await audits()).toBe(auditBefore);
  });

  it("a client session cannot forge the rule label, with a setting or by writing the run table", async () => {
    // a rule of another business
    const owner2 = await createUser("ans-owner2");
    const org2 = await createOrg(owner2.id, "עסק אחר");
    const foreign = await asUser(owner2.id, async (q) =>
      (await q<{ id: string }>("insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'כלל זר', 'lead', 'created', '[{\"type\":\"notify\"}]', false) returning id", [org2])).rows[0].id,
    );
    const lead = await insertLead(owner.id, org, { full_name: "ליד לזיוף" });
    for (const value of [foreign, "not-a-uuid"]) {
      await asUser(owner.id, async (q) => {
        await q("select set_config('app.automation_rule', $1, true)", [value]);
        expect((await q("update public.leads set full_name = $2 where id = $1", [lead, `שם ${value}`])).rowCount).toBe(1);
      });
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and changes ? 'automation'", [lead]))).toBe(0);
    // the table that does carry the running rule is closed to clients
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.automation_rule_runs")))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into app.automation_rule_runs (slot, txid, organization_id, rule_id) values ((txid_current() % 65536)::integer, txid_current(), $1, $2)", [org, foreign])))).code,
    ).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("update app.automation_rule_runs set txid = txid_current(), organization_id = $1, rule_id = $2 where slot = (txid_current() % 65536)::integer", [org, foreign])))).code,
    ).toBe("42501");
  });

  it("the run table is 65,536 fixed slots and does not grow", async () => {
    expect(await asAdmin((q) => count(q, "select 1 from app.automation_rule_runs"))).toBe(65536);
  });

  it("a run never waits for its slot: while another transaction holds it, the change is logged without the rule's name", async () => {
    const rule = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>(
        "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'תיוג בחריץ תפוס', 'lead', 'created', $2, false) returning id",
        [org, JSON.stringify([{ type: "add_tag", tag_id: tag }])],
      )).rows[0].id,
    );
    const lead = await insertLead(owner.id, org, { full_name: "ליד לחריץ תפוס" });
    const holder = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    try {
      const status = await asUser(owner.id, async (q) => {
        const slot = (await q<{ s: number }>("select (txid_current() % 65536)::integer as s")).rows[0].s;
        // another open transaction holds this transaction's slot
        await holder.query("begin");
        await holder.query("select 1 from app.automation_rule_runs where slot = $1 for update", [slot]);
        // a wait would end in 55P03 here instead of finishing
        await q("set local lock_timeout = '2s'");
        return (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, lead])).rows[0].r.status;
      });
      expect(status).toBe("success");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    const entries = await asAdmin(async (q) =>
      (await q<{ changes: Record<string, unknown> }>("select changes from public.audit_log where organization_id = $1 and entity_type = 'leads' and entity_id = $2 and action = 'update'", [org, lead])).rows,
    );
    const byRule = entries.find((e) => "tag_ids" in e.changes);
    expect(byRule).toBeDefined();
    expect(byRule?.changes.automation).toBeUndefined();
  });
});
