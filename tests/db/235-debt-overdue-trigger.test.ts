import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * AUT-04 follow-up: "חוב עבר את מועדו" (debt_overdue). An active tax invoice or proforma whose due date plus the rule's
 * days is before the business's today, with a balance above zero (the rule of money_allocation_state), runs the deal or
 * contact rule once per document and due date, from 08:00 in the business's zone, only with both plan flags (documents and
 * payments), at most 200 runs per business a pass. An AUT-06 retry runs only while the document is still active, its due
 * date unchanged and its balance above zero.
 */
describe("debt overdue trigger (AUT-04 follow-up)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const own = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const insert = (sql: string, params: unknown[]) => own(async (q) => (await one<{ id: string }>(q, sql, params)).id);
  const today = () =>
    asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone o.timezone)::date, 'YYYY-MM-DD') as d from public.organizations o where o.id = $1", [org])).d);
  const shift = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const customer = async () => {
    const contact = await insert("insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, `לקוח ${++n}`, owner.id]);
    const deal = await insert("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, $2, $3, $4, $5, $6) returning id", [
      org,
      `עסקה ${n}`,
      pipelineId,
      stageId,
      owner.id,
      contact,
    ]);
    return { contact, deal };
  };
  // a tax invoice of 100 ₪ dated 10 days ago, due `dueIn` days from today
  const invoice = async (c: { contact: string; deal: string }, dueIn: number, type = "tax_invoice") => {
    const t = await today();
    return insert(
      "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, $3, $4, $5, $6, 10000, $7) returning id",
      [org, c.deal, c.contact, type, `INV-${++n}`, shift(t, -10), shift(t, dueIn)],
    );
  };
  const rule = (entity: "deal" | "contact", config: Record<string, unknown> = {}, actions: unknown[] = [{ type: "notify", to: "owner", title: "חוב" }]) =>
    insert(
      `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
       values ($1, $2, $3, 'debt_overdue', $4, $5) returning id`,
      [org, `חוב ${++n}`, entity, JSON.stringify(config), JSON.stringify(actions)],
    );
  const off = (id: string) => asAdmin((q) => q("update public.automations set is_active = false where id = $1", [id]));
  const pass = (hour = "0") =>
    asAdmin(async (q) => {
      await q("select set_config('app.date_trigger_hour', $1, true)", [hour]);
      return (await one<{ n: number }>(q, "select app.run_debt_automations() as n")).n;
    });
  const runsOf = (auto: string, record?: string) =>
    asAdmin((q) => count(q, `select 1 from public.automation_runs where automation_id = $1 ${record ? "and entity_id = $2" : ""}`, record ? [auto, record] : [auto]));
  const pay = async (c: { contact: string; deal: string }, document: string, amount: number) => {
    const payment = await insert("insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method) values ($1, $2, $3, $4, 'cash') returning id", [
      org,
      c.deal,
      c.contact,
      amount,
    ]);
    await own((q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, payment, document, amount]));
  };
  const setFlags = (flags: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(flags)]));

  beforeAll(async () => {
    owner = await createUser("do-owner");
    org = await createOrg(owner.id, "עסק החובות");
    await setFlags({ documents: true, payments: true });
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("runs once per overdue document with a balance, on its deal or its contact; not before 08:00, not before it is due", async () => {
    const dealRule = await rule("deal");
    const contactRule = await rule("contact");
    const late = await customer();
    const lateDoc = await invoice(late, -1);
    const dueToday = await customer();
    await invoice(dueToday, 0);
    const paid = await customer();
    const paidDoc = await invoice(paid, -3);
    await pay(paid, paidDoc, 10000);
    const partly = await customer();
    const partlyDoc = await invoice(partly, -3);
    await pay(partly, partlyDoc, 4000);
    const cancelled = await customer();
    const cancelledDoc = await invoice(cancelled, -3);
    await own((q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelledDoc]));

    // (the 08:00 gate is app.date_trigger_hour(), the date triggers' rule, tested with them; here it is lowered to 0)
    await pass();
    expect([await runsOf(dealRule, late.deal), await runsOf(contactRule, late.contact)]).toEqual([1, 1]);
    expect(await runsOf(dealRule, partly.deal)).toBe(1);
    for (const c of [dueToday, paid, cancelled]) expect(await runsOf(dealRule, c.deal)).toBe(0);
    const key = await asAdmin(async (q) => (await one<{ k: string }>(q, "select run_key as k from public.automation_runs where automation_id = $1 and entity_id = $2", [dealRule, late.deal])).k);
    expect(key).toBe(`debt:${lateDoc}:${shift(await today(), -1)}:0`);

    // once: another pass runs nothing new
    await pass();
    expect(await runsOf(dealRule)).toBe(2);
    // a moved due date is a new occasion
    await own((q) => q("update public.accounting_documents set due_date = due_date - 1 where id = $1", [lateDoc]));
    await pass();
    expect(await runsOf(dealRule, late.deal)).toBe(2);
    await off(dealRule);
    await off(contactRule);
  });

  it("waits the rule's days after the due date; another days value counts as 0", async () => {
    const wait3 = await rule("deal", { days_overdue: 3 });
    const bad = await rule("deal", { days_overdue: "שלושה" });
    const two = await customer();
    await invoice(two, -2);
    const four = await customer();
    await invoice(four, -4);
    await pass();
    expect([await runsOf(wait3, two.deal), await runsOf(wait3, four.deal)]).toEqual([0, 1]);
    expect([await runsOf(bad, two.deal), await runsOf(bad, four.deal)]).toEqual([1, 1]);
    await off(wait3);
    await off(bad);
  });

  it("needs both plan flags; at most 200 runs per business a pass, and the next pass goes on", async () => {
    const auto = await rule("deal");
    const c = await customer();
    const docs = [await invoice(c, -1), await invoice(c, -1), await invoice(c, -1)];
    await setFlags({ documents: true, payments: false });
    try {
      await pass();
      expect(await runsOf(auto)).toBe(0);
      // the budget test below needs the flags back first
    } finally {
      await setFlags({ documents: true, payments: true });
    }
    // a budget of 2 for this rule: two runs, then the cursor carries the third to the next pass
    const first = await asAdmin(async (q) => {
      await q("select set_config('app.date_trigger_hour', '0', true)");
      return (await one<{ n: number }>(q, "select app.scheduled_debt_overdue(a, 2) as n from public.automations a where a.id = $1", [auto])).n;
    });
    expect(first).toBe(2);
    await pass();
    // every overdue document runs once, this customer's three included (earlier tests' documents run too)
    expect(await runsOf(auto, c.deal)).toBe(docs.length);
    expect(await runsOf(auto)).toBeGreaterThanOrEqual(docs.length);
    await off(auto);
  });

  it("an AUT-06 retry runs only while the document is active, due on the same day and still owed", async () => {
    const failing = () => rule("deal", {}, [{ type: "add_tag", tag_id: "00000000-0000-4000-8000-0000000000cc" }]);
    const runOf = async (auto: string, deal: string) =>
      asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.automation_runs where automation_id = $1 and entity_id = $2", [auto, deal])).id);
    const retry = async (run: string) => {
      await asAdmin((q) => q("update public.automation_runs set next_retry_at = now() - interval '1 second' where id = $1", [run]));
      await asAdmin((q) => q("select app.retry_automation_runs(500)"));
      return asAdmin((q) => one<{ retry_count: number; retry_note: string | null; event_facts: unknown }>(q, "select retry_count, retry_note, event_facts from public.automation_runs where id = $1", [run]));
    };
    const auto = await failing();
    const holds = await customer();
    const holdsDoc = await invoice(holds, -1);
    const paidLater = await customer();
    const paidDoc = await invoice(paidLater, -1);
    const moved = await customer();
    const movedDoc = await invoice(moved, -1);
    await pass();
    const r1 = await runOf(auto, holds.deal);
    expect(await retry(r1)).toMatchObject({ retry_count: 1, retry_note: null, event_facts: { document_id: holdsDoc, due_date: shift(await today(), -1) } });
    const r2 = await runOf(auto, paidLater.deal);
    await pay(paidLater, paidDoc, 10000);
    expect(await retry(r2)).toMatchObject({ retry_count: 0, retry_note: "event_changed" });
    const r3 = await runOf(auto, moved.deal);
    await own((q) => q("update public.accounting_documents set due_date = due_date + 5 where id = $1", [movedDoc]));
    expect(await retry(r3)).toMatchObject({ retry_count: 0, retry_note: "event_changed" });
    // losing the payments flag ends the retries with feature_off
    const lost = await customer();
    await invoice(lost, -1);
    await pass();
    const r4 = await runOf(auto, lost.deal);
    await setFlags({ documents: true, payments: false });
    try {
      expect(await retry(r4)).toMatchObject({ retry_count: 0, retry_note: "feature_off" });
    } finally {
      await setFlags({ documents: true, payments: true });
    }
    await off(auto);
  });

  it("the scan functions are internal: only the job runs for service_role", async () => {
    for (const [fn, roles] of [
      ["app.run_debt_automations()", ["anon", "authenticated"]],
      ["app.scheduled_debt_overdue(public.automations, integer)", ["anon", "authenticated", "service_role"]],
      ["app.document_balance(uuid, uuid)", ["anon", "authenticated", "service_role"]],
      ["app.automation_trigger_flags_ok(uuid, text)", ["anon", "authenticated", "service_role"]],
    ] as const) {
      for (const role of roles) {
        const ok = await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok);
        expect(ok, `${role} ${fn}`).toBe(false);
      }
    }
  });
});
