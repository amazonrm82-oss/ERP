import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; warning?: string; error?: string };

// RVW-9 (owner, 12 October 2026): an automation that moves a lead to "not relevant" gives a reason from the list.
describe("automations give a not-relevant reason (RVW-9)", () => {
  let owner: U, stranger: U;
  let org: string, otherOrg: string, disqualified: string, open: string, reason: string, hidden: string, foreignReason: string;

  beforeAll(async () => {
    owner = await createUser("adr-owner");
    org = await createOrg(owner.id);
    stranger = await createUser("adr-stranger");
    otherOrg = await createOrg(stranger.id);
    const statuses = await asAdmin(async (q) =>
      (await q<{ id: string; kind: string; is_default: boolean }>("select id, kind, is_default from public.lead_statuses where organization_id = $1", [org])).rows,
    );
    disqualified = statuses.find((s) => s.kind === "disqualified")!.id;
    open = statuses.find((s) => s.kind === "open" && !s.is_default)!.id;
    const addReason = (as: U, o: string, name: string, active = true) =>
      asUser(as.id, async (q) =>
        (await q<{ id: string }>("insert into public.disqualify_reasons (organization_id, name, is_active) values ($1, $2, $3) returning id", [o, name, active])).rows[0].id,
      );
    reason = await addReason(owner, org, "בחר ספק אחר");
    hidden = await addReason(owner, org, "סיבה מוסתרת", false);
    foreignReason = await addReason(stranger, otherOrg, "סיבה של עסק אחר");
  });

  const lead = (id: string) =>
    asAdmin(async (q) => (await q<{ status_id: string; disqualify_reason: string | null }>("select status_id, disqualify_reason from public.leads where id = $1", [id])).rows[0]);

  const runRule = async (action: Record<string, unknown>, leadId: string) => {
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'סטטוס', 'lead', 'created', '{}', '[]', $2, false) returning id`,
          [org, JSON.stringify([{ type: "set_lead_status", ...action }])],
        )
      ).rows[0].id,
    );
    const result = await asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, leadId])).rows[0].r);
    const steps = await asAdmin(async (q) => (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1", [rule])).rows[0].steps);
    return { status: result.status, step: steps[0] };
  };

  it("moves the lead into not relevant with the configured reason, by its current name", async () => {
    const id = await insertLead(owner.id, org);
    const run = await runRule({ status_id: disqualified, reason_id: reason }, id);
    expect(run).toEqual({ status: "success", step: { action: "set_lead_status", status: "ok" } });
    expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: "בחר ספק אחר" });

    // the rule keeps the id: a renamed reason is written with its new name
    await asUser(owner.id, (q) => q("update public.disqualify_reasons set name = 'ספק אחר' where id = $1", [reason]));
    const id2 = await insertLead(owner.id, org);
    await runRule({ status_id: disqualified, reason_id: reason }, id2);
    expect((await lead(id2)).disqualify_reason).toBe("ספק אחר");
  });

  it("an old rule without a reason still runs: empty reason and a note in the run log", async () => {
    const id = await insertLead(owner.id, org);
    const run = await runRule({ status_id: disqualified }, id);
    expect(run).toEqual({ status: "success", step: { action: "set_lead_status", status: "ok", warning: "no reason is set" } });
    expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
  });

  it("an empty or blank reason id counts as no reason set", async () => {
    for (const reasonId of ["", "   ", null]) {
      const id = await insertLead(owner.id, org);
      const run = await runRule({ status_id: disqualified, reason_id: reasonId }, id);
      expect(run).toEqual({ status: "success", step: { action: "set_lead_status", status: "ok", warning: "no reason is set" } });
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
    }
  });

  it("a hidden, deleted, malformed or other organization's reason: empty reason and a note, the run does not fail", async () => {
    const gone = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.disqualify_reasons (organization_id, name) values ($1, 'תימחק') returning id", [org])).rows[0].id,
    );
    await asAdmin((q) => q("delete from public.disqualify_reasons where id = $1", [gone]));
    for (const reasonId of [hidden, gone, foreignReason, "not-an-id"]) {
      const id = await insertLead(owner.id, org);
      const run = await runRule({ status_id: disqualified, reason_id: reasonId }, id);
      expect(run).toEqual({ status: "success", step: { action: "set_lead_status", status: "ok", warning: "the reason no longer exists" } });
      expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: null });
    }
  });

  it("a lead already not relevant: the configured reason replaces its reason; without one its reason stays", async () => {
    const id = await insertLead(owner.id, org);
    await asUser(owner.id, (q) => q("update public.leads set status_id = $1, disqualify_reason = 'ספק אחר' where id = $2", [disqualified, id]));
    await runRule({ status_id: disqualified }, id);
    expect((await lead(id)).disqualify_reason).toBe("ספק אחר");
    const second = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.disqualify_reasons (organization_id, name) values ($1, 'לא בתקציב') returning id", [org])).rows[0].id,
    );
    await runRule({ status_id: disqualified, reason_id: second }, id);
    expect(await lead(id)).toEqual({ status_id: disqualified, disqualify_reason: "לא בתקציב" });
  });

  it("other statuses are unaffected: no reason is written and no note is logged", async () => {
    const id = await insertLead(owner.id, org);
    const run = await runRule({ status_id: open, reason_id: reason }, id);
    expect(run).toEqual({ status: "success", step: { action: "set_lead_status", status: "ok" } });
    expect(await lead(id)).toEqual({ status_id: open, disqualify_reason: null });
  });

  it("the engine stays closed to clients", async () => {
    const granted = await asAdmin(async (q) =>
      (
        await q<{ ok: boolean }>(
          "select has_function_privilege('authenticated', 'app.run_automation_actions(public.automations, text, uuid)', 'execute') as ok",
        )
      ).rows[0].ok,
    );
    expect(granted).toBe(false);
  });
});
