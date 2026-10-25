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
  const events = (payment: string, type = "payment_received") =>
    asAdmin(
      async (q) =>
        (
          await q<Ev>(
            "select entity_type, entity_id, payload, processed_at, last_error from public.outbox_events where event_type = $2 and payload ->> 'payment_id' = $1 order by id",
            [payment, type],
          )
        ).rows,
    );
  const rule = (entity: "deal" | "contact", config: Record<string, unknown> = {}, trigger = "payment_received") =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
             values ($1, $2, $3, $6, $4, $5) returning id`,
            [org, `תשלום ${++n}`, entity, JSON.stringify(config), JSON.stringify([{ type: "notify", to: "owner", title: "התקבל תשלום" }]), trigger],
          )
        ).id,
    );
  const runsOf = (automation: string, entity: string) =>
    asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1 and entity_id = $2", [automation, entity]));
  // process_outbox is shared by every test file and claims events with SKIP LOCKED: run it until this payment's events are done
  const processFor = async (payment: string) => {
    for (let i = 0; i < 50; i += 1) {
      await asAdmin((q) => q("select app.process_outbox(5000)"));
      const all = [...(await events(payment)), ...(await events(payment, "payment_confirmed"))];
      if (all.every((e) => e.processed_at !== null)) return;
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

  it("a payment confirmed (inserted as confirmed, or moved from recorded) writes one confirmed event per record (answer 3)", async () => {
    const contact = await newContact("אור");
    const deal = await newDeal(contact);
    // inserted as confirmed: both kinds of events
    const direct = await pay(deal, contact, 4000, "confirmed");
    expect((await events(direct)).map((e) => e.entity_type)).toEqual(["deal", "contact"]);
    const confirmed = await events(direct, "payment_confirmed");
    expect(confirmed.map((e) => [e.entity_type, e.entity_id])).toEqual([
      ["deal", deal],
      ["contact", contact],
    ]);
    for (const e of confirmed) expect(e.payload).toEqual({ payment_id: direct, amount_agorot: 4000, method: "transfer", status: "confirmed" });

    // recorded, then confirmed: the confirmed events come with the move
    const later = await pay(null, contact, 2500);
    expect(await events(later, "payment_confirmed")).toEqual([]);
    await run((q) => q("update public.payments set note = 'בדיקה' where id = $1", [later]));
    expect(await events(later, "payment_confirmed")).toEqual([]);
    await run((q) => q("update public.payments set status = 'confirmed' where id = $1", [later]));
    expect((await events(later, "payment_confirmed")).map((e) => e.entity_type)).toEqual(["contact"]);
    // a later change of a confirmed payment, or a cancel, writes none
    await run((q) => q("update public.payments set note = 'עוד' where id = $1", [later]));
    await run((q) => q("update public.payments set status = 'cancelled', cancel_reason = 'בוטל' where id = $1", [later]));
    expect(await events(later, "payment_confirmed")).toHaveLength(1);

    // failed, then confirmed: not a confirmation of a recorded payment, so no event
    const failed = await pay(null, contact, 2500);
    await run((q) => q("update public.payments set status = 'failed' where id = $1", [failed]));
    await run((q) => q("update public.payments set status = 'confirmed' where id = $1", [failed]));
    expect(await events(failed, "payment_confirmed")).toEqual([]);
  });

  it("confirmed rules run on the confirmation only, at or above their minimum; received rules are not run again", async () => {
    const confirmedRule = await rule("deal", { min_agorot: 3000 }, "payment_confirmed");
    const receivedRule = await rule("deal");
    const deal = await newDeal(null);
    const small = await pay(deal, null, 2999);
    await run((q) => q("update public.payments set status = 'confirmed' where id = $1", [small]));
    await processFor(small);
    expect(await runsOf(confirmedRule, deal)).toBe(0);
    expect(await runsOf(receivedRule, deal)).toBe(1);

    const big = await pay(deal, null, 3000);
    await processFor(big);
    expect(await runsOf(confirmedRule, deal)).toBe(0);
    expect(await runsOf(receivedRule, deal)).toBe(2);
    await run((q) => q("update public.payments set status = 'confirmed' where id = $1", [big]));
    await processFor(big);
    expect(await runsOf(confirmedRule, deal)).toBe(1);
    expect(await runsOf(receivedRule, deal)).toBe(2);
    for (const id of [confirmedRule, receivedRule]) await run((q) => q("update public.automations set is_active = false where id = $1", [id]));
  });

  it("a payment confirmed while an automation runs is marked and starts no automation", async () => {
    const confirmedRule = await rule("contact", {}, "payment_confirmed");
    const contact = await newContact("שקד");
    const payment = await pay(null, contact, 5000);
    await asUser(owner.id, async (q) => {
      await q("select set_config('app.automation_running', 'on', true)");
      await q("update public.payments set status = 'confirmed' where id = $1", [payment]);
    });
    const [ev] = await events(payment, "payment_confirmed");
    expect(ev.payload.origin).toBe("automation");
    await processFor(payment);
    expect(await runsOf(confirmedRule, contact)).toBe(0);
    await run((q) => q("update public.automations set is_active = false where id = $1", [confirmedRule]));
  });

  it("the event function is a trigger only: no role may run it", async () => {
    await asAdmin(async (q) => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const fn of ["app.emit_payment_received()", "app.emit_payment_confirmed()"]) {
          const row = await one<{ ok: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as ok", [role, fn]);
          expect(row.ok, `${role} ${fn}`).toBe(false);
        }
      }
    });
  });
});
