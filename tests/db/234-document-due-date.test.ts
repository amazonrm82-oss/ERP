import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * PAY-02 answer 7: a tax invoice or a proforma takes an optional due date, filled from the customer's payment terms (the
 * contact's, else its company's, else the deal's company's) and editable while the document is active.
 */
describe("a document's due date (PAY-02 answer 7)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const company = (terms: string | null, days: number | null) =>
    asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, payment_terms, payment_days) values ($1, 'חברה', $2, $3) returning id", [org, terms, days])).id,
    );
  const contact = (companyId: string | null, terms: string | null = null, days: number | null = null) =>
    asAdmin(async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, payment_terms, payment_days) values ($1, 'לקוח', $2, $3, $4) returning id", [
          org,
          companyId,
          terms,
          days,
        ])
      ).id,
    );
  const doc = (type: string, on: { deal?: string | null; contact?: string | null }, docDate = "2026-10-10", due: string | null = null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string; due_date: string | null }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, $3, $4, $5, $6, 1000, $7) returning id, to_char(due_date, 'YYYY-MM-DD') as due_date",
          [org, on.deal ?? null, on.contact ?? null, type, `DUE-${++n}`, docDate, due],
        )
      ),
    );

  beforeAll(async () => {
    owner = await createUser("due-owner");
    org = await createOrg(owner.id, "עסק המועדים");
    member = await addMember(org, owner.id, "member", "due-member");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true })]));
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
  });

  it("fills the date from the contact's terms, else its company's, else the deal's company's; none without terms", async () => {
    const acme = await company("eom", 30);
    const own = await contact(acme, "net", 15);
    expect((await doc("tax_invoice", { contact: own })).due_date).toBe("2026-10-25");
    const byCompany = await contact(acme);
    // eom + 30: the end of October, then 30 days
    expect((await doc("proforma", { contact: byCompany })).due_date).toBe("2026-11-30");
    const deal = await asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, company_id) values ($1, 'עסקה', $2, $3, $4) returning id", [org, pipelineId, stageId, acme])).id,
    );
    expect((await doc("tax_invoice", { deal })).due_date).toBe("2026-11-30");
    const plain = await contact(null);
    expect((await doc("tax_invoice", { contact: plain })).due_date).toBeNull();
    const immediate = await contact(null, "immediate");
    expect((await doc("tax_invoice", { contact: immediate })).due_date).toBe("2026-10-10");
    // a receipt never gets one
    expect((await doc("receipt", { contact: own })).due_date).toBeNull();
  });

  it("a typed date wins; it goes only on a tax invoice or a proforma, never before the document's date", async () => {
    const c = await contact(null, "net", 30);
    expect((await doc("tax_invoice", { contact: c }, "2026-10-10", "2026-12-01")).due_date).toBe("2026-12-01");
    expect((await pgError(doc("receipt", { contact: c }, "2026-10-10", "2026-12-01"))).hint).toBe("document:due_date");
    expect((await pgError(doc("tax_invoice", { contact: c }, "2026-10-10", "2026-10-09"))).hint).toBe("document:due_date");
  });

  it("a recorder changes or clears it while the document is active; a member cannot; a cancelled document keeps it", async () => {
    const c = await contact(null, "net", 30);
    const { id } = await doc("tax_invoice", { contact: c });
    await run(owner, (q) => q("update public.accounting_documents set due_date = '2027-01-01' where id = $1", [id]));
    expect(await run(member, async (q) => (await q("update public.accounting_documents set due_date = '2027-02-01' where id = $1", [id])).rowCount)).toBe(0);
    await run(owner, (q) => q("update public.accounting_documents set due_date = null where id = $1", [id]));
    await run(owner, (q) => q("update public.accounting_documents set due_date = '2027-01-01' where id = $1", [id]));
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [id]));
    expect((await pgError(run(owner, (q) => q("update public.accounting_documents set due_date = '2027-03-01' where id = $1", [id])))).hint).toBe("document:due_date");
    // nor cleared (review of 020765)
    expect((await pgError(run(owner, (q) => q("update public.accounting_documents set due_date = null where id = $1", [id])))).hint).toBe("document:due_date");
    const row = await asAdmin((q) => one<{ due: string }>(q, "select to_char(due_date, 'YYYY-MM-DD') as due from public.accounting_documents where id = $1", [id]));
    expect(row.due).toBe("2027-01-01");
  });
});
