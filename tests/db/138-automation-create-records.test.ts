import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; error?: string };
type Deal = {
  id: string;
  name: string;
  pipeline_id: string;
  stage_id: string;
  amount_agorot: string;
  owner_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  previous_deal_id: string | null;
};

// AUT-02: automation steps that create a deal ("create_deal") or a note ("create_note").
describe("automations create a deal or a note (AUT-02)", () => {
  let owner: U, member: U, stranger: U;
  let org: string, otherOrg: string;
  let pipeline: string, firstOpen: string, secondOpen: string, won: string;
  let otherPipeline: string, otherPipelineStage: string, foreignPipeline: string;

  const rule = async (entity: string, actions: Array<Record<string, unknown>>, name = "יצירה") =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, $2, $3, 'created', '{}', '[]', $4, false) returning id`,
          [org, name, entity, JSON.stringify(actions)],
        )
      ).rows[0].id,
    );
  const run = async (entity: string, actions: Array<Record<string, unknown>>, recordId: string, name?: string) => {
    const id = await rule(entity, actions, name);
    const result = await asUser(owner.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [id, recordId])).rows[0].r);
    const steps = await asAdmin(async (q) => (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1", [id])).rows[0].steps);
    return { rule: id, status: result.status, steps };
  };
  const dealsMadeBy = (ruleId: string) =>
    asAdmin(async (q) =>
      (
        await q<Deal>(
          `select d.id, d.name, d.pipeline_id, d.stage_id, d.amount_agorot, d.owner_id, d.contact_id, d.company_id, d.previous_deal_id
             from public.deals d
            where d.organization_id = $1
              and exists (select 1 from public.audit_log a where a.entity_type = 'deals' and a.entity_id = d.id
                             and a.changes -> 'automation' ->> 'id' = $2)
            order by d.created_at, d.id`,
          [org, ruleId],
        )
      ).rows,
    );
  const insertRow = (sql: string, params: unknown[]) => asUser(owner.id, async (q) => (await q<{ id: string }>(sql, params)).rows[0].id);
  const contact = (name: string, company: string | null = null, ownerId: string | null = null) =>
    insertRow("insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, company, ownerId]);
  const company = (name: string) => insertRow("insert into public.companies (organization_id, name) values ($1, $2) returning id", [org, name]);
  const deal = (name: string, contactId: string | null, companyId: string | null) =>
    insertRow(
      "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id) values ($1, $2, $3, $4, $5, $6) returning id",
      [org, name, pipeline, firstOpen, contactId, companyId],
    );
  const task = (title: string, links: { lead?: string; contact?: string; company?: string; deal?: string }) =>
    insertRow(
      "insert into public.tasks (organization_id, title, lead_id, contact_id, company_id, deal_id) values ($1, $2, $3, $4, $5, $6) returning id",
      [org, title, links.lead ?? null, links.contact ?? null, links.company ?? null, links.deal ?? null],
    );
  const createDeal = (extra: Record<string, unknown> = {}) => ({ type: "create_deal", pipeline_id: pipeline, ...extra });

  beforeAll(async () => {
    owner = await createUser("acr-owner");
    org = await createOrg(owner.id, "עסק יצירה");
    member = await createUser("acr-member");
    await asAdmin((q) => q("insert into public.memberships (organization_id, user_id, role, status) values ($1, $2, 'member', 'active')", [org, member.id]));
    stranger = await createUser("acr-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    const main = await defaultPipeline(org);
    pipeline = main.pipelineId;
    const open = main.stages.filter((s) => s.kind === "open");
    firstOpen = open[0].id;
    secondOpen = open[1].id;
    won = main.stages.find((s) => s.kind === "won")!.id;
    otherPipeline = await insertRow("insert into public.pipelines (organization_id, name, position) values ($1, 'שני', 5) returning id", [org]);
    otherPipelineStage = await insertRow(
      "insert into public.stages (organization_id, pipeline_id, name, position, kind) values ($1, $2, 'פתוח', 0, 'open') returning id",
      [org, otherPipeline],
    );
    foreignPipeline = (await defaultPipeline(otherOrg)).pipelineId;
  });

  it("makes a deal for a contact: the contact and its company, the first open stage, the contact's owner", async () => {
    const co = await company("חברת אלון");
    const c = await contact("דנה כהן", co, member.id);
    const r = await run("contact", [createDeal({ name: "הצעה ל{{name}}", amount_agorot: 250000 })], c);
    expect(r.steps).toEqual([{ action: "create_deal", status: "ok" }]);
    const made = await dealsMadeBy(r.rule);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({
      name: "הצעה לדנה כהן",
      pipeline_id: pipeline,
      stage_id: firstOpen,
      amount_agorot: "250000",
      owner_id: member.id,
      contact_id: c,
      company_id: co,
      previous_deal_id: null,
    });
    // the new deal is marked as made by an automation, so it starts no other automation
    expect(
      await asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = $1 and payload ->> 'origin' = 'automation'", [made[0].id])),
    ).toBeGreaterThan(0);
  });

  it("a company gives itself; a deal gives its contact and company and becomes the previous deal; a chosen open stage is kept", async () => {
    const co = await company("חברת ברוש");
    const r1 = await run("company", [createDeal()], co);
    expect(r1.steps[0].status).toBe("ok");
    expect((await dealsMadeBy(r1.rule))[0]).toMatchObject({ name: "עסקה: חברת ברוש", contact_id: null, company_id: co, owner_id: owner.id });

    const c = await contact("יוסי לוי", co);
    const source = await deal("שנה ראשונה", c, co);
    const r2 = await run("deal", [createDeal({ name: "חידוש: {{name}}", stage_id: secondOpen, assign: "user", user_id: member.id })], source);
    expect(r2.steps[0].status).toBe("ok");
    expect((await dealsMadeBy(r2.rule))[0]).toMatchObject({
      name: "חידוש: שנה ראשונה",
      stage_id: secondOpen,
      owner_id: member.id,
      contact_id: c,
      company_id: co,
      previous_deal_id: source,
    });
  });

  it("a task gives its contact and company, leaving out one in the recycle bin", async () => {
    const co = await company("חברת ארז");
    const c = await contact("מיכל", co);
    const t = await task("להתקשר", { contact: c, company: co });
    await asUser(owner.id, (q) => q("update public.companies set deleted_at = now() where id = $1", [co]));
    const r = await run("task", [createDeal()], t);
    expect(r.steps[0].status).toBe("ok");
    expect((await dealsMadeBy(r.rule))[0]).toMatchObject({ contact_id: c, company_id: null, name: "עסקה: להתקשר" });

    // a contact in the recycle bin is left out too (here: a deal's contact)
    const co2 = await company("חברת שקד");
    const c2 = await contact("גיל", co2);
    const source = await deal("עם איש קשר שנמחק", c2, co2);
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [c2]));
    const r2 = await run("deal", [createDeal()], source);
    expect(r2.steps[0].status).toBe("ok");
    expect((await dealsMadeBy(r2.rule))[0]).toMatchObject({ contact_id: null, company_id: co2, previous_deal_id: source });
  });

  it("refuses what does not fit, step by step, and the other steps still run", async () => {
    const lead = await insertLead(owner.id, org);
    const onLead = await run("lead", [createDeal()], lead);
    expect(onLead.steps).toEqual([{ action: "create_deal", status: "error", error: "a lead becomes a deal by conversion" }]);

    const c = await contact("נועה");
    await asUser(owner.id, (q) => q("update public.pipelines set deleted_at = now() where id = $1", [otherPipeline]));
    const r = await run(
      "contact",
      [
        createDeal({ pipeline_id: foreignPipeline }),
        createDeal({ pipeline_id: otherPipeline }),
        createDeal({ stage_id: otherPipelineStage }),
        createDeal({ stage_id: won }),
        createDeal({ amount_agorot: -1 }),
        createDeal({ amount_agorot: 10.5 }),
        createDeal({ amount_agorot: "100" }),
        createDeal({ amount_agorot: 100000000001 }),
        createDeal({ assign: "user", user_id: stranger.id }),
        createDeal({ amount_agorot: null }),
      ],
      c,
    );
    expect(r.status).toBe("partial");
    expect(r.steps.map((s) => s.error ?? s.status)).toEqual([
      "the pipeline no longer exists",
      "the pipeline no longer exists",
      "the stage is not an open stage of the pipeline",
      "the stage is not an open stage of the pipeline",
      "the amount is invalid",
      "the amount is invalid",
      "the amount is invalid",
      "the amount is invalid",
      "the user is not an active member",
      "ok",
    ]);
    // nothing was made in the other business, and one deal here
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where organization_id = $1", [otherOrg]))).toBe(0);
    expect(await dealsMadeBy(r.rule)).toHaveLength(1);
  });

  it("the plan's record limit fails the step, not the run", async () => {
    const c = await contact("גבול");
    const used = await asAdmin(async (q) => Number((await q<{ n: string }>("select records_count as n from public.org_usage where organization_id = $1", [org])).rows[0].n));
    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = jsonb_build_object('max_records', $2::int) where organization_id = $1`, [org, used]));
    try {
      const r = await run("contact", [createDeal(), { type: "create_note", body: "עדיין רץ" }], c);
      expect(r.steps).toEqual([
        { action: "create_deal", status: "error", error: "the plan record limit is reached" },
        { action: "create_note", status: "ok" },
      ]);
      expect(await dealsMadeBy(r.rule)).toHaveLength(0);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [org]));
    }
  });

  it("writes a note on the record, marked as the rule's, that is not contact with the customer", async () => {
    const lead = await insertLead(owner.id, org);
    const name = await asAdmin(async (q) => (await q<{ n: string }>("select full_name as n from public.leads where id = $1", [lead])).rows[0].n);
    const r = await run("lead", [{ type: "create_note", body: "  נכנס ליד: {{name}}  " }], lead, "כלל הערות");
    expect(r.steps).toEqual([{ action: "create_note", status: "ok" }]);
    const notes = await asAdmin(async (q) =>
      (
        await q<{ type: string; body: string; metadata: Record<string, string>; is_private: boolean; created_by: string | null }>(
          "select type, body, metadata, is_private, created_by from public.activities where lead_id = $1",
          [lead],
        )
      ).rows,
    );
    // no author, although a person ran the rule by hand (as on a scheduled run)
    expect(notes).toEqual([
      { type: "automation_note", body: `נכנס ליד: ${name}`, metadata: { automation_id: r.rule, automation_name: "כלל הערות" }, is_private: false, created_by: null },
    ]);
    // a person ran the rule, and still the lead was not contacted
    const lead_after = await asAdmin(async (q) =>
      (await q<{ last: string | null; first: string | null }>("select last_contacted_at as last, first_contacted_at as first from public.leads where id = $1", [lead])).rows[0],
    );
    expect(lead_after).toEqual({ last: null, first: null });
    // members of the business read it on the timeline
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.activities where lead_id = $1 and type = 'automation_note'", [lead]))).toBe(1);
  });

  it("a note on a deal, run by a person, is not a person's activity for the stuck-deals report", async () => {
    const d = await deal("עסקה שקטה", null, null);
    const lastActivity = async () =>
      (
        await asUser(owner.id, async (q) => (await q<{ r: Array<{ id: string; last_activity_at: string | null }> }>("select public.report_stuck_deals($1) as r", [org])).rows[0].r)
      ).find((row) => row.id === d)?.last_activity_at ?? null;
    await run("deal", [{ type: "create_note", body: "תזכורת" }], d);
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where deal_id = $1 and type = 'automation_note' and created_by is null", [d]))).toBe(1);
    expect(await lastActivity()).toBeNull();
    // a client cannot clear the author of its own entries: the trigger acts on the automation type only
    await asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, body, deal_id) values ($1, 'note', 'אני', $2)", [org, d]));
    expect(await lastActivity()).not.toBeNull();
  });

  it("a task's note goes on every record the task is linked to; an empty note or an unlinked task fails the step", async () => {
    const co = await company("חברת תמר");
    const c = await contact("רון", co);
    const linked = await task("משימה מקושרת", { contact: c, company: co });
    const r = await run("task", [{ type: "create_note", body: "מ{{name}}" }, { type: "create_note", body: "   " }], linked);
    expect(r.steps).toEqual([
      { action: "create_note", status: "ok" },
      { action: "create_note", status: "error", error: "the note is empty" },
    ]);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and company_id = $2 and body = 'ממשימה מקושרת'", [c, co])),
    ).toBe(1);

    // links in the recycle bin are left out; a task whose links are all there has nowhere to write
    const co3 = await company("חברת אגוז");
    const c3 = await contact("שי", co3);
    const half = await task("חצי במחזור", { contact: c3, company: co3 });
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [c3]));
    expect((await run("task", [{ type: "create_note", body: "רק לחברה" }], half)).steps[0].status).toBe("ok");
    expect(
      await asAdmin(async (q) => (await q<{ contact_id: string | null; company_id: string }>("select contact_id, company_id from public.activities where body = 'רק לחברה'")).rows),
    ).toEqual([{ contact_id: null, company_id: co3 }]);
    const lead = await insertLead(owner.id, org);
    const d = await deal("במחזור", null, null);
    const binned = await task("הכול במחזור", { lead, deal: d });
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [d]));
    expect((await run("task", [{ type: "create_note", body: "לאן?" }], binned)).steps).toEqual([
      { action: "create_note", status: "error", error: "the task is not linked to a record" },
    ]);

    const alone = await task("משימה בלי קישור", {});
    const r2 = await run("task", [{ type: "create_note", body: "הערה" }], alone);
    expect(r2.steps).toEqual([{ action: "create_note", status: "error", error: "the task is not linked to a record" }]);
  });

  it("a note a rule wrote is not activity for a 'no activity' rule; a person's note is", async () => {
    const quiet = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'שקט', 'contact', 'no_activity', '{"days": 3}', '[]', '[{"type": "create_note", "body": "עדיין אין פעילות"}]', false)
           returning id`,
          [org],
        )
      ).rows[0].id,
    );
    // quiet for ten days (inserted by the server, so the creation time can be in the past)
    const c = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, owner_id, created_at) values ($1, 'שקטה', $2, now() - interval '10 days') returning id",
          [org, owner.id],
        )
      ).rows[0].id,
    );
    const scan = () =>
      asAdmin(async (q) => {
        await q("delete from app.automation_scan_cursors where automation_id = $1", [quiet]);
        await q("select app.scheduled_no_activity(a) from public.automations a where a.id = $1", [quiet]);
      });
    const runsOn = () => asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [quiet, c]));
    await scan();
    expect(await runsOn()).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and type = 'automation_note'", [c]))).toBe(1);
    // a rule's note five days ago is not activity: the contact is quiet since its creation, the same occasion, no new run
    const entry = (type: string) =>
      asAdmin((q) =>
        q("insert into public.activities (organization_id, type, body, contact_id, occurred_at) values ($1, $2, 'ישן', $3, now() - interval '5 days')", [org, type, c]),
      );
    await entry("automation_note");
    await scan();
    expect(await runsOn()).toBe(1);
    // a note five days ago is activity: a new quiet spell starts from it, and the rule runs again
    await entry("note");
    await scan();
    expect(await runsOn()).toBe(2);
  });
});
