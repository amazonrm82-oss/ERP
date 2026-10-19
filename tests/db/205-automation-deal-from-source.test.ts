import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { action: string; status: string; error?: string; warning?: string };
type Deal = {
  id: string;
  pipeline_id: string;
  stage_id: string;
  amount_agorot: string;
  amount_source: string | null;
  billing_kind: string | null;
  recurring_amount_agorot: string | null;
  recurring_amount_auto: boolean | null;
  recurring_start_date: string | null;
  renewal_date: string | null;
};
type Line = {
  description: string;
  quantity: string;
  unit_price_agorot: string;
  discount_bp: number | null;
  billing: string | null;
  product_id: string | null;
  total_agorot: string;
};

// DEAL-08 follow-up (migration automation_deal_from_source): a create_deal step may make the deal in the triggering deal's
// sales process ("pipeline": "source") and copy its recurring revenue and lines ("copy_from_source": true).
describe("automations: a new deal that follows its source deal (DEAL-08 follow-up)", () => {
  let owner: U, stranger: U;
  let org: string, otherOrg: string;
  let pipeline: string, firstOpen: string, secondOpen: string;
  let other: string, otherFirst: string, foreignPipeline: string;

  const insertRow = (sql: string, params: unknown[]) => asUser(owner.id, async (q) => (await q<{ id: string }>(sql, params)).rows[0].id);
  const run = async (entity: string, actions: Array<Record<string, unknown>>, recordId: string, by?: U) => {
    const runner = by ?? owner;
    const id = await asUser(runner.id, async (q) => (await q<{ id: string }>(
      `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
       values ($1, 'המשך', $2, 'created', '{}', '[]', $3, false) returning id`,
      [org, entity, JSON.stringify(actions)],
    )).rows[0].id);
    await asUser(runner.id, (q) => q("select public.run_automation_now($1, $2)", [id, recordId]));
    return asAdmin(async (q) => (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1", [id])).rows[0].steps);
  };
  const deal = (name: string, pipelineId = pipeline, stageId = firstOpen, contactId: string | null = null) =>
    insertRow("insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, $2, $3, $4, $5) returning id", [
      org,
      name,
      pipelineId,
      stageId,
      contactId,
    ]);
  const followUp = (source: string) =>
    asAdmin(async (q) =>
      (
        await q<Deal>(
          `select id, pipeline_id, stage_id, amount_agorot::text, amount_source, billing_kind, recurring_amount_agorot::text, recurring_amount_auto,
                  recurring_start_date::text, renewal_date::text
             from public.deals where previous_deal_id = $1 order by created_at desc, id limit 1`,
          [source],
        )
      ).rows[0],
    );
  const lines = (dealId: string) =>
    asAdmin(async (q) =>
      (
        await q<Line>(
          "select description, quantity::text, unit_price_agorot::text, discount_bp, billing, product_id, total_agorot::text from public.deal_lines where deal_id = $1 order by position, created_at",
          [dealId],
        )
      ).rows,
    );
  const addLine = (dealId: string, values: Record<string, unknown>) =>
    asUser(owner.id, async (q) => {
      const all: Record<string, unknown> = { deal_id: dealId, quantity: 1, ...values };
      const keys = Object.keys(all);
      await q(`insert into public.deal_lines (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")})`, [
        org,
        ...keys.map((k) => all[k]),
      ]);
    });
  const step = (extra: Record<string, unknown> = {}) => ({ type: "create_deal", pipeline_id: pipeline, ...extra });

  beforeAll(async () => {
    owner = await createUser("ads-owner");
    org = await createOrg(owner.id, "עסק המשך");
    stranger = await createUser("ads-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ products: true, discounts: true, granular_permissions: true })]));
    const main = await defaultPipeline(org);
    pipeline = main.pipelineId;
    const open = main.stages.filter((s) => s.kind === "open");
    firstOpen = open[0].id;
    secondOpen = open[1].id;
    other = await insertRow("insert into public.pipelines (organization_id, name, position) values ($1, 'חידושים', 5) returning id", [org]);
    // the second process's open stages, its first one by position
    await insertRow("insert into public.stages (organization_id, pipeline_id, name, position, kind) values ($1, $2, 'שני', 1, 'open') returning id", [org, other]);
    otherFirst = await insertRow("insert into public.stages (organization_id, pipeline_id, name, position, kind) values ($1, $2, 'ראשון', 0, 'open') returning id", [org, other]);
    foreignPipeline = (await defaultPipeline(otherOrg)).pipelineId;
  });

  it("pipeline source: the new deal is in the source deal's process, in its first open stage", async () => {
    const source = await deal("חוזה שנתי", other, otherFirst);
    // the step's own pipeline and stage are only the fallback
    const steps = await run("deal", [step({ stage_id: secondOpen, pipeline: "source" })], source);
    expect(steps).toEqual([{ action: "create_deal", status: "ok" }]);
    expect(await followUp(source)).toMatchObject({ pipeline_id: other, stage_id: otherFirst });
  });

  it("pipeline source falls back to the step's pipeline and stage when the process is gone or the trigger is not a deal", async () => {
    const gone = await insertRow("insert into public.pipelines (organization_id, name, position) values ($1, 'ישן', 9) returning id", [org]);
    const goneStage = await insertRow("insert into public.stages (organization_id, pipeline_id, name, position, kind) values ($1, $2, 'פתוח', 0, 'open') returning id", [
      org,
      gone,
    ]);
    const source = await deal("ישנה", gone, goneStage);
    await asAdmin((q) => q("update public.pipelines set deleted_at = now() where id = $1", [gone]));
    expect(await run("deal", [step({ stage_id: secondOpen, pipeline: "source" })], source)).toEqual([{ action: "create_deal", status: "ok" }]);
    expect(await followUp(source)).toMatchObject({ pipeline_id: pipeline, stage_id: secondOpen });

    // a contact rule (stored by hand: the builder offers neither setting there)
    const contact = await insertRow("insert into public.contacts (organization_id, first_name) values ($1, 'רות') returning id", [org]);
    expect(await run("contact", [step({ name: "מאיש קשר", pipeline: "source", copy_from_source: true })], contact)).toEqual([{ action: "create_deal", status: "ok" }]);
    const made = await asAdmin(async (q) => (await q<Deal>("select pipeline_id, stage_id, billing_kind from public.deals where organization_id = $1 and name = 'מאיש קשר'", [org])).rows);
    expect(made).toEqual([{ pipeline_id: pipeline, stage_id: firstOpen, billing_kind: null }]);
  });

  it("copy from source: the recurring revenue as typed for the next period and every line as it is; the value follows the lines", async () => {
    const source = await deal("ריטיינר");
    await asUser(owner.id, (q) =>
      q(
        "update public.deals set billing_kind = 'monthly', recurring_amount_agorot = 50000, recurring_start_date = '2026-11-01', renewal_date = '2027-11-01' where id = $1",
        [source],
      ),
    );
    await addLine(source, { description: "שעות ייעוץ", quantity: 3, unit_price_agorot: 20000, discount_bp: 1000, billing: "one_time" });
    await addLine(source, { description: "אחזקה", unit_price_agorot: 5000, billing: "monthly" });

    expect(await run("deal", [step({ copy_from_source: true })], source)).toEqual([{ action: "create_deal", status: "ok" }]);
    const made = await followUp(source);
    expect(made).toMatchObject({
      billing_kind: "monthly",
      recurring_amount_agorot: "50000",
      recurring_amount_auto: null,
      // the next period: from the source's renewal date, for the same term
      recurring_start_date: "2027-11-01",
      renewal_date: "2028-11-01",
    });
    expect(await lines(made.id)).toEqual(await lines(source));
    // the value follows: the first year of the typed recurring amount plus the one-time lines (DLI-03), like the source's
    const sourceRow = await asAdmin(async (q) => (await q<{ a: string }>("select amount_agorot::text as a from public.deals where id = $1", [source])).rows[0].a);
    expect(made.amount_agorot).toBe(sourceRow);
    expect(made.amount_source).not.toBeNull();

    // an amount the step names is kept
    const named = await deal("ריטיינר ב");
    await addLine(named, { description: "שורה", unit_price_agorot: 7000, billing: "one_time" });
    await run("deal", [step({ copy_from_source: true, amount_agorot: 12300 })], named);
    expect(await followUp(named)).toMatchObject({ amount_agorot: "12300", amount_source: null });
  });

  it("copy from source: a recurring amount that followed the lines follows the copied lines", async () => {
    const source = await deal("מנוי");
    await asUser(owner.id, (q) => q("update public.deals set billing_kind = 'monthly', recurring_start_date = '2026-11-01' where id = $1", [source]));
    await addLine(source, { description: "מנוי", unit_price_agorot: 9900, billing: "monthly" });
    const before = await asAdmin(async (q) =>
      (await q<{ r: string; auto: boolean | null }>("select recurring_amount_agorot::text as r, recurring_amount_auto as auto from public.deals where id = $1", [source])).rows[0],
    );
    expect(before).toEqual({ r: "9900", auto: true });
    await run("deal", [step({ copy_from_source: true })], source);
    // no renewal date on the source: the copy starts with it and has none either
    expect(await followUp(source)).toMatchObject({
      billing_kind: "monthly",
      recurring_amount_agorot: "9900",
      recurring_amount_auto: true,
      recurring_start_date: "2026-11-01",
      renewal_date: null,
    });
    // a term of zero (renewal on the start day) gives the copy no renewal date, so a date rule cannot fire on it again
    const same = await deal("אותו יום");
    await asUser(owner.id, (q) =>
      q("update public.deals set billing_kind = 'yearly', recurring_amount_agorot = 100, recurring_start_date = '2026-12-01', renewal_date = '2026-12-01' where id = $1", [same]),
    );
    await run("deal", [step({ copy_from_source: true })], same);
    expect(await followUp(same)).toMatchObject({ recurring_start_date: "2026-12-01", renewal_date: null });
  });

  it("a line the rules no longer let in is left out, the step says so, and the deal is still made", async () => {
    const product = await insertRow("insert into public.products (organization_id, name, price_agorot) values ($1, 'ישן', 4000) returning id", [org]);
    const source = await deal("עם מוצר");
    await addLine(source, { product_id: product, description: "ישן", unit_price_agorot: 4000, price_source: "product" });
    await addLine(source, { description: "בהנחה", unit_price_agorot: 2000, discount_bp: 500, billing: "one_time" });
    await addLine(source, { description: "חופשי", unit_price_agorot: 1000, billing: "one_time" });
    await asAdmin((q) => q("update public.products set archived_at = now() where id = $1", [product]));
    // the copy is the server's: a product archived since is kept, as it was sold; a discount the plan no longer has is not
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ products: true, discounts: false, granular_permissions: true })]),
    );
    try {
      expect(await run("deal", [step({ copy_from_source: true })], source)).toEqual([{ action: "create_deal", status: "ok", warning: "some lines were not copied" }]);
      expect((await lines((await followUp(source)).id)).map((l) => l.description)).toEqual(["ישן", "חופשי"]);
    } finally {
      await asAdmin((q) =>
        q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ products: true, discounts: true, granular_permissions: true })]),
      );
    }
  });

  it("the next period is the term in whole months, so a month end stays a month end", async () => {
    const cases: Array<[string, string, string]> = [
      ["2024-02-29", "2025-02-28", "2026-02-28"],
      ["2025-01-31", "2025-02-28", "2025-03-28"],
      ["2022-03-15", "2026-03-15", "2030-03-15"],
      ["2026-01-10", "2026-01-25", "2026-02-25"],
      // the term is rounded to the nearest month: 11 months and 30 days is a year, a day is still a month
      ["2026-01-01", "2026-12-31", "2027-12-31"],
      ["2023-03-01", "2024-02-29", "2025-02-28"],
      ["2026-01-31", "2026-03-01", "2026-04-01"],
      ["2026-01-01", "2026-01-02", "2026-02-02"],
    ];
    for (const [start, renewal, next] of cases) {
      const source = await deal(`תקופה ${start}`);
      await asUser(owner.id, (q) =>
        q("update public.deals set billing_kind = 'yearly', recurring_amount_agorot = 100, recurring_start_date = $2, renewal_date = $3 where id = $1", [source, start, renewal]),
      );
      await run("deal", [step({ copy_from_source: true })], source);
      expect(await followUp(source)).toMatchObject({ recurring_start_date: renewal, renewal_date: next });
    }
  });

  it("every id is read with the rule's business: another business's pipeline is refused, its deals are never read", async () => {
    // a contact rule whose fallback pipeline belongs to another business
    const contact = await insertRow("insert into public.contacts (organization_id, first_name) values ($1, 'זר') returning id", [org]);
    const steps = await run("contact", [{ type: "create_deal", pipeline_id: foreignPipeline, pipeline: "source", copy_from_source: true }], contact);
    expect(steps).toEqual([{ action: "create_deal", status: "error", error: "the pipeline no longer exists" }]);
    // a deal rule copies only its own deal's lines, never a deal of the other business with lines
    const stage = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [foreignPipeline])).rows[0].id);
    const theirs = await asUser(stranger.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'שלהם', $2, $3) returning id", [otherOrg, foreignPipeline, stage])).rows[0].id,
    );
    await asUser(stranger.id, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot) values ($1, $2, 'סוד', 1, 100)", [otherOrg, theirs]));
    const ours = await deal("שלנו");
    await run("deal", [step({ copy_from_source: true, pipeline: "source" })], ours);
    const made = await followUp(ours);
    expect(made.pipeline_id).toBe(pipeline);
    expect(await lines(made.id)).toEqual([]);
    // their deal got no follow-up
    expect(await followUp(theirs)).toBeUndefined();
  });

  it("a person who runs the rule now copies the lines as the server would, even into a deal they may not edit", async () => {
    // a member with the automations permission, in a business where everyone sees only their own records
    const member = await addMember(org, owner.id, "member", "ads-member");
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, member.id, ["manage_automations"]]));
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const source = await asUser(member.id, async (q) =>
        (
          await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'של החבר', $2, $3) returning id", [
            org,
            pipeline,
            firstOpen,
          ])
        ).rows[0].id,
      );
      await asUser(member.id, (q) =>
        q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot, discount_bp, billing) values ($1, $2, 'ייעוץ', 3, 20000, 1000, 'one_time')", [
          org,
          source,
        ]),
      );
      // the new deal belongs to the owner, so the member may not edit it; then a task, written with the member's session again
      const steps = await run(
        "deal",
        [step({ copy_from_source: true, assign: "user", user_id: owner.id }), { type: "create_task", title: "לטפל {{name}}", due_amount: 0, due_unit: "none", assign: "owner" }],
        source,
        member,
      );
      expect(steps).toEqual([
        { action: "create_deal", status: "ok" },
        { action: "create_task", status: "ok" },
      ]);
      const made = await followUp(source);
      const copied = await lines(made.id);
      expect(copied).toEqual(await lines(source));
      expect(copied[0].total_agorot).toBe("54000");
      expect(made.amount_agorot).toBe("54000");
      // the session came back after the copy: the task the next step made is the member's doing in the audit log
      const actor = await asAdmin(async (q) =>
        (
          await q<{ actor_id: string | null }>(
            "select a.actor_id from public.audit_log a join public.tasks t on t.id = a.entity_id where a.organization_id = $1 and a.entity_type = 'tasks' and a.action = 'insert' and t.deal_id = $2",
            [org, source],
          )
        ).rows,
      );
      expect(actor).toEqual([{ actor_id: member.id }]);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });
});
