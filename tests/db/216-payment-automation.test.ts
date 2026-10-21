import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Ev = { entity_type: string; entity_id: string; payload: Record<string, unknown>; processed_at: string | null; last_error: string | null };

/**
 * PAY-07 part two: the automation trigger "payment received". Recording a payment (insert as recorded or confirmed) writes one
 * outbox event per linked record (the deal, and the contact); a later change writes none; a server insert in another status
 * writes none; a payment an automation records starts no automation; a rule may ask for a minimum amount.
 */
describe("payment received automations (PAY-07)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const newContact = (name: string) =>
    run(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const newDeal = (contact: string | null) =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, $2, $3, $4, $5, $6) returning id",
            [org, `עסקה ${++n}`, pipelineId, stageId, owner.id, contact],
          )
        ).id,
    );
  const pay = (deal: string | null, contact: string | null, amount = 5000, status = "recorded") =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method, status) values ($1, $2, $3, $4, 'transfer', $5) returning id",
            [org, deal, contact, amount, status],
          )
        ).id,
    );
  const events = (payment: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Ev>(
            "select entity_type, entity_id, payload, processed_at, last_error from public.outbox_events where event_type = 'payment_received' and payload ->> 'payment_id' = $1 order by id",
            [payment],
          )
        ).rows,
    );
  const rule = (entity: "deal" | "contact", config: Record<string, unknown> = {}) =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
             values ($1, $2, $3, 'payment_received', $4, $5) returning id`,
            [org, `תשלום ${++n}`, entity, JSON.stringify(config), JSON.stringify([{ type: "notify", to: "owner", title: "התקבל תשלום" }])],
          )
        ).id,
    );
  const runsOf = (automation: string, entity: string) =>
    asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [automation, entity]));
  // process_outbox is shared by every test file and claims events with SKIP LOCKED: run it until this payment's events are done
  const processFor = async (payment: string) => {
    for (let i = 0; i < 50; i += 1) {
      await asAdmin((q) => q("select app.process_outbox(5000)"));
      if ((await events(payment)).every((e) => e.processed_at !== null)) return;
      await asAdmin((q) => q("select pg_sleep(0.1)"));
    }
    throw new Error("events were not processed");
  };

  beforeAll(async () => {
    owner = await createUser("pa-owner");
    org = await createOrg(owner.id, "עסק התשלומים");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ payments: true })]));
    const pipeline = await defaultPipeline(org);
    pipelineId = pipeline.pipelineId;
    stageId = pipeline.stages.find((s) => s.kind === "open")!.id;
  });

  it("recording a payment writes one event for its deal and one for its contact", async () => {
    const contact = await newContact("נועה");
    const deal = await newDeal(contact);
    const both = await pay(deal, contact, 12345, "confirmed");
    const evs = await events(both);
    expect(evs.map((e) => [e.entity_type, e.entity_id])).toEqual([
      ["deal", deal],
      ["contact", contact],
    ]);
    for (const e of evs) expect(e.payload).toEqual({ payment_id: both, amount_agorot: 12345, method: "transfer", status: "confirmed" });

    const contactOnly = await pay(null, contact);
    expect((await events(contactOnly)).map((e) => [e.entity_type, e.entity_id])).toEqual([["contact", contact]]);
    const dealOnly = await pay(await newDeal(null), null);
    expect((await events(dealOnly)).map((e) => e.entity_type)).toEqual(["deal"]);
  });

  it("a later change of the payment writes no event", async () => {
    const contact = await newContact("עמית");
    const payment = await pay(await newDeal(contact), contact);
    expect(await events(payment)).toHaveLength(2);
    await run((q) => q("update public.payments set status = 'failed' where id = $1", [payment]));
    await run((q) => q("update public.payments set status = 'recorded' where id = $1", [payment]));
    await run((q) => q("update public.payments set status = 'confirmed', amount_agorot = 7000, note = 'תוקן' where id = $1", [payment]));
    await run((q) => q("update public.payments set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [payment]));
    expect(await events(payment)).toHaveLength(2);
  });

  it("a server insert writes an event only for a recorded or confirmed payment", async () => {
    const contact = await newContact("שרון");
    const insert = (status: string) =>
      asAdmin(
        async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.payments (organization_id, contact_id, amount_agorot, method, status) values ($1, $2, 900, 'cash', $3) returning id",
              [org, contact, status],
            )
          ).id,
      );
    expect(await events(await insert("failed"))).toEqual([]);
    expect(await events(await insert("refunded"))).toEqual([]);
    expect((await events(await insert("recorded"))).map((e) => e.entity_type)).toEqual(["contact"]);
  });

  it("deal and contact rules run once per payment, at or above their minimum", async () => {
    const dealRule = await rule("deal", { min_agorot: 10000 });
    const contactRule = await rule("contact");
    const contact = await newContact("רוני");
    const deal = await newDeal(contact);

    const small = await pay(deal, contact, 9999);
    await processFor(small);
    expect(await runsOf(dealRule, deal)).toBe(0);
    expect(await runsOf(contactRule, contact)).toBe(1);

    const big = await pay(deal, contact, 10000);
    await processFor(big);
    expect(await runsOf(dealRule, deal)).toBe(1);
    expect(await runsOf(contactRule, contact)).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and entity_id = $2 and title = 'התקבל תשלום'", [owner.id, deal]))).toBe(1);

    // processing again runs nothing twice
    await asAdmin((q) => q("select app.process_outbox(5000)"));
    expect(await runsOf(dealRule, deal)).toBe(1);
    expect(await runsOf(contactRule, contact)).toBe(2);
    for (const id of [dealRule, contactRule]) await run((q) => q("update public.automations set is_active = false where id = $1", [id]));
  });

  it("a minimum that is not a number is ignored, and never fails the event", async () => {
    const broken = await rule("contact", { min_agorot: "הרבה" });
    const contact = await newContact("גל");
    const payment = await pay(null, contact, 100);
    await processFor(payment);
    const [ev] = await events(payment);
    expect(ev.last_error).toBeNull();
    expect(await runsOf(broken, contact)).toBe(1);
    await run((q) => q("update public.automations set is_active = false where id = $1", [broken]));
  });

  it("a payment recorded while an automation runs is marked and starts no automation", async () => {
    const contactRule = await rule("contact");
    const contact = await newContact("דור");
    const payment = await asUser(owner.id, async (q) => {
      await q("select set_config('app.automation_running', 'on', true)");
      return (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 5000, 'cash') returning id",
          [org, contact],
        )
      ).id;
    });
    const [ev] = await events(payment);
    expect(ev.payload.origin).toBe("automation");
    await processFor(payment);
    expect(await runsOf(contactRule, contact)).toBe(0);
    await run((q) => q("update public.automations set is_active = false where id = $1", [contactRule]));
  });

  it("the event function is a trigger only: no role may run it", async () => {
    await asAdmin(async (q) => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const row = await one<{ ok: boolean }>(q, "select has_function_privilege($1, 'app.emit_payment_received()', 'execute') as ok", [role]);
        expect(row.ok, role).toBe(false);
      }
    });
  });
});
