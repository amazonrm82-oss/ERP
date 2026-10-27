import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * PAY-02 fix (migration money_same_customer_null): app.money_same_customer answers false, never NULL, when one side has no
 * deal or no contact, so neither a payment nor a proforma link reaches another customer's document through a missing link.
 */
describe("same customer never answers NULL (PAY-02)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const id = (sql: string, params: unknown[]) => run(async (q) => (await one<{ id: string }>(q, sql, params)).id);
  const contact = () => id("insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, `לקוח ${++n}`]);
  const deal = () =>
    id("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, $2, $3, $4) returning id", [org, `עסקה ${++n}`, pipelineId, stageId]);
  const doc = (type: string, on: { deal?: string; contact?: string }, proforma: string | null = null) =>
    id(
      "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot, proforma_id) values ($1, $2, $3, $4, $5, 1000, $6) returning id",
      [org, on.deal ?? null, on.contact ?? null, type, `NUL-${++n}`, proforma],
    );

  beforeAll(async () => {
    owner = await createUser("nul-owner");
    org = await createOrg(owner.id, "עסק הבדיקה");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true })]));
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("a payment on a deal with no contact is not allocated to another contact's invoice", async () => {
    const payment = await id("insert into public.payments (organization_id, deal_id, amount_agorot, method) values ($1, $2, 1000, 'cash') returning id", [org, await deal()]);
    const invoice = await doc("tax_invoice", { contact: await contact() });
    expect(
      (await pgError(run((q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 100)", [org, payment, invoice])))).hint,
    ).toBe("allocation:customer");
    expect(await asAdmin(async (q) => (await one<{ s: boolean | null }>(q, "select app.money_same_customer($1, $2, null, null, $3) as s", [org, await deal(), await contact()])).s)).toBe(false);
  });

  it("an invoice on a deal with no contact does not bill another customer's contact-only proforma", async () => {
    const proforma = await doc("proforma", { contact: await contact() });
    expect((await pgError(doc("tax_invoice", { deal: await deal() }, proforma))).hint).toBe("document:proforma");
  });
});
