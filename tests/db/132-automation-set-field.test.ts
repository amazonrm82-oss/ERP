import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; error?: string; warning?: string };

// AUT-01: an automation step that updates one field of the record ("set_field"): a custom field of any type, checked as
// a person's write is, or a built-in list field (source on leads, contacts and deals; type on tasks).
describe("automations update a field (AUT-01)", () => {
  let owner: U, stranger: U;
  let org: string, otherOrg: string, source: string, hiddenSource: string;

  const define = (o: string, object: string, key: string, type: string, extra: { options?: string[]; unique?: boolean; readOnly?: boolean; active?: boolean } = {}) =>
    asAdmin((q) =>
      q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, is_unique, is_read_only, is_active)
         values ($1, $2, $3, $3, $4, $5, $6, $7, $8)`,
        [o, object, key, type, JSON.stringify(extra.options ?? []), extra.unique ?? false, extra.readOnly ?? false, extra.active ?? true],
      ),
    );
  const customOf = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ c: Record<string, unknown> | null }>(`select custom_fields as c from public.${table} where id = $1`, [id])).rows[0].c ?? {});
  const run = async (entity: string, actions: Array<Record<string, unknown>>, recordId: string) => {
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'שדה', $2, 'created', '{}', '[]', $3, false) returning id`,
          [org, entity, JSON.stringify(actions)],
        )
      ).rows[0].id,
    );
    const result = await asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, recordId])).rows[0].r);
    const steps = await asAdmin(async (q) => (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1", [rule])).rows[0].steps);
    return { status: result.status, steps };
  };
  const set = (field: string, value: unknown) => ({ type: "set_field", field, value });

  beforeAll(async () => {
    owner = await createUser("asf-owner");
    org = await createOrg(owner.id, "עסק שדות");
    stranger = await createUser("asf-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await define(org, "lead", "note", "text");
    await define(org, "lead", "size", "number");
    await define(org, "lead", "budget", "currency");
    await define(org, "lead", "tier", "select", { options: ["זהב", "כסף"] });
    await define(org, "lead", "topics", "multi_select", { options: ["א", "ב", "ג"] });
    await define(org, "lead", "vip", "checkbox");
    await define(org, "lead", "visit", "date");
    await define(org, "lead", "rep", "user");
    await define(org, "lead", "old", "text", { active: false });
    await define(org, "lead", "locked", "text", { readOnly: true });
    await define(org, "lead", "code", "text", { unique: true });
    await define(org, "company", "region", "select", { options: ["צפון", "דרום"] });
    await define(otherOrg, "lead", "foreign", "text");
    const sources = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'כנס'), ($1, 'ישן') returning id", [org])).rows,
    );
    source = sources[0].id;
    hiddenSource = sources[1].id;
    await asUser(owner.id, (q) => q("update public.lead_sources set is_active = false where id = $1", [hiddenSource]));
  });

  it("writes custom fields of every kind, each checked like a person's write, and clears with null", async () => {
    const id = await insertLead(owner.id, org);
    const r = await run(
      "lead",
      [
        set("cf:note", "מאוטומציה"),
        set("cf:size", 12),
        set("cf:budget", 150000),
        set("cf:tier", "זהב"),
        set("cf:topics", ["א", "ג"]),
        set("cf:vip", true),
        set("cf:visit", "2026-11-01"),
        set("cf:rep", owner.id),
      ],
      id,
    );
    expect(r.status).toBe("success");
    expect(r.steps.every((s) => s.status === "ok" && s.action === "set_field")).toBe(true);
    expect(await customOf("leads", id)).toEqual({
      note: "מאוטומציה",
      size: 12,
      budget: 150000,
      tier: "זהב",
      topics: ["א", "ג"],
      vip: true,
      visit: "2026-11-01",
      rep: owner.id,
    });
    // null, or no value at all, clears the field; the others stay
    const cleared = await run("lead", [set("cf:note", null), { type: "set_field", field: "cf:size" }], id);
    expect(cleared.status).toBe("success");
    const after = await customOf("leads", id);
    expect(after).not.toHaveProperty("note");
    expect(after).not.toHaveProperty("size");
    expect(after.tier).toBe("זהב");
  });

  it("a value the field does not take fails the step and changes nothing; the other steps still run", async () => {
    const id = await insertLead(owner.id, org);
    const bad = [
      set("cf:tier", "ארד"),
      set("cf:topics", ["ד"]),
      set("cf:size", "שתים עשרה"),
      set("cf:vip", "כן"),
      set("cf:visit", "2026-02-30"),
      set("cf:rep", stranger.id),
    ];
    for (const action of bad) {
      const r = await run("lead", [action, set("cf:note", "עבר")], id);
      expect(r.status, JSON.stringify(action)).toBe("partial");
      expect(r.steps[0]).toEqual({ action: "set_field", status: "error", error: "the value does not fit the field" });
      expect(r.steps[1].status).toBe("ok");
    }
    expect(await customOf("leads", id)).toEqual({ note: "עבר" });
  });

  it("a hidden, unknown or other business's field, or a field of another record type, is refused", async () => {
    const id = await insertLead(owner.id, org);
    for (const field of ["cf:old", "cf:nothing", "cf:foreign", "cf:region"]) {
      const r = await run("lead", [set(field, "x")], id);
      expect(r.steps[0], field).toEqual({ action: "set_field", status: "error", error: "the field no longer exists" });
    }
    for (const field of ["owner_id", "status_id", "full_name", "task_type", "organization_id"]) {
      const r = await run("lead", [set(field, "x")], id);
      expect(r.steps[0], field).toEqual({ action: "set_field", status: "error", error: "the field does not fit this record" });
    }
    expect(await customOf("leads", id)).toEqual({});
    const { pipelineId, stages } = await defaultPipeline(org);
    const task = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'משימה', $2) returning id", [org, owner.id])).rows[0].id,
    );
    expect((await run("task", [set("cf:note", "x")], task)).steps[0].error).toBe("the field does not fit this record");
    const deal = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipelineId, stages[0].id])).rows[0].id,
    );
    expect((await run("deal", [set("task_type", "call")], deal)).steps[0].error).toBe("the field does not fit this record");
  });

  it("a filled read-only field stays; an empty one is filled once", async () => {
    const id = await insertLead(owner.id, org);
    expect((await run("lead", [set("cf:locked", "ראשון")], id)).steps[0].status).toBe("ok");
    const second = await run("lead", [set("cf:locked", "שני")], id);
    expect(second.steps[0]).toEqual({ action: "set_field", status: "error", error: "the field is read-only" });
    expect((await run("lead", [set("cf:locked", null)], id)).steps[0].error).toBe("the field is read-only");
    // writing the value it already holds is not a change
    expect((await run("lead", [set("cf:locked", "ראשון")], id)).steps[0].status).toBe("ok");
    expect((await customOf("leads", id)).locked).toBe("ראשון");
  });

  it("a unique field's taken value fails the step, not the run, and leaves the constraint deferred", async () => {
    const first = await insertLead(owner.id, org);
    const second = await insertLead(owner.id, org);
    expect((await run("lead", [set("cf:code", "A-1")], first)).steps[0].status).toBe("ok");
    const taken = await run("lead", [set("cf:code", "A-1"), set("cf:note", "עבר")], second);
    expect(taken.status).toBe("partial");
    expect(taken.steps[0]).toEqual({ action: "set_field", status: "error", error: "the value is already on another record" });
    expect(await customOf("leads", second)).toEqual({ note: "עבר" });
    // a free value is written
    expect((await run("lead", [set("cf:code", "A-2")], second)).steps[0].status).toBe("ok");
    expect((await customOf("leads", second)).code).toBe("A-2");
    // after the steps the constraint is deferred again: in one transaction, a step that failed on a taken value and one
    // that wrote a free value, then a clash that a later statement of the same transaction resolves, commits
    await asUser(owner.id, async (q) => {
      const rule = (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'שדה', 'lead', 'created', '{}', '[]', $2, false) returning id`,
          [org, JSON.stringify([set("cf:code", "A-1"), set("cf:code", "A-5")])],
        )
      ).rows[0].id;
      await q("select public.run_automation_now($1, $2)", [rule, second]);
      await q(`update public.leads set custom_fields = '{"$merge": {"code": "A-1"}}' where id = $1`, [second]);
      await q(`update public.leads set custom_fields = '{"$merge": {"code": "A-3"}}' where id = $1`, [second]);
    });
    expect((await customOf("leads", second)).code).toBe("A-3");
  });

  it("sets and clears the source of a lead, a contact and a deal; a hidden source is refused", async () => {
    const lead = await insertLead(owner.id, org);
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipelineId, stages[0].id])).rows[0].id,
    );
    for (const [entity, table, id] of [["lead", "leads", lead], ["contact", "contacts", contact], ["deal", "deals", deal]] as const) {
      expect((await run(entity, [set("source_id", source)], id)).steps[0].status, entity).toBe("ok");
      expect(await asAdmin((q) => count(q, `select 1 from public.${table} where id = $1 and source_id = $2`, [id, source]))).toBe(1);
      expect((await run(entity, [set("source_id", hiddenSource)], id)).steps[0].error, entity).toBe("the source no longer exists");
      expect((await run(entity, [set("source_id", null)], id)).steps[0].status, entity).toBe("ok");
      expect(await asAdmin((q) => count(q, `select 1 from public.${table} where id = $1 and source_id is null`, [id]))).toBe(1);
    }
    // another business's source
    const foreignSource = await asUser(stranger.id, async (q) =>
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id,
    );
    expect((await run("lead", [set("source_id", foreignSource)], lead)).steps[0].error).toBe("the source no longer exists");
    // a company has no source
    const company = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה') returning id", [org])).rows[0].id,
    );
    expect((await run("company", [set("source_id", source)], company)).steps[0].error).toBe("the field does not fit this record");
    expect((await run("company", [set("cf:region", "צפון")], company)).steps[0].status).toBe("ok");
    expect((await customOf("companies", company)).region).toBe("צפון");
  });

  it("sets a task's type, never to an unknown or empty one", async () => {
    const task = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id) values ($1, 'משימה', $2) returning id", [org, owner.id])).rows[0].id,
    );
    expect((await run("task", [set("task_type", "call")], task)).steps[0].status).toBe("ok");
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = $1 and task_type = 'call'", [task]))).toBe(1);
    for (const value of ["party", null]) {
      expect((await run("task", [set("task_type", value)], task)).steps[0].error).toBe("the value does not fit the field");
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.tasks where id = $1 and task_type = 'call'", [task]))).toBe(1);
  });

  it("the change is the automation's: its audit entry names the rule, and it triggers no other automation", async () => {
    const id = await insertLead(owner.id, org);
    const before = await asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and payload ->> 'origin' = 'automation'", [org]));
    await run("lead", [set("cf:note", "מסומן")], id);
    const entry = await asAdmin(async (q) =>
      (
        await q<{ changes: Record<string, unknown> }>(
          "select changes from public.audit_log where organization_id = $1 and entity_type = 'leads' and entity_id = $2 and action = 'update' order by id desc limit 1",
          [org, id],
        )
      ).rows[0],
    );
    expect(entry.changes).toHaveProperty("custom_fields");
    const after = await asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and payload ->> 'origin' = 'automation'", [org]));
    expect(after).toBeGreaterThan(before);
    // a person outside the business cannot run the rule at all
    const rule = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.automations where organization_id = $1 limit 1", [org])).rows[0].id);
    expect((await pgError(asUser(stranger.id, (q) => q("select public.run_automation_now($1, $2)", [rule, id])))).code).toBeDefined();
  });
});
