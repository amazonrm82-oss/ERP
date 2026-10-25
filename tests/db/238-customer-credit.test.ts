import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Credit = { total: number; count: number; payments: { id: string; paid_on: string; method: string; amount: number; credit: number }[] };
type Applied = { allocated: number; payments: { payment_id: string; amount: number }[] };

/**
 * PAY-03: the customer's credit balance is every unallocated part of a recorded or confirmed payment of the same customer
 * (PAY-02's rule: the deal, the contact, and the deals and contacts of their companies); public.money_customer_credit counts
 * it under RLS, and public.money_apply_credit allocates it to a new tax invoice or proforma, oldest payment first, through
 * ordinary allocation inserts, catching only the refusals a race can cause.
 */
describe("customer credit (PAY-03)", () => {
  let owner: U, manager: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const company = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const contact = (name: string, companyId: string | null = null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, ownerId])).id,
    );
  const deal = (contactId: string | null, companyId: string | null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5, $6) returning id",
          [org, pipelineId, stageId, contactId, companyId, owner.id],
        )
      ).id,
    );
  const doc = (type: string, amount: number, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, on.deal ?? null, on.contact ?? null, type, `CR-${++n}`, amount],
        )
      ).id,
    );
  const pay = (amount: number, paidOn: string, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, 'transfer') returning id",
          [org, on.deal ?? null, on.contact ?? null, amount, paidOn],
        )
      ).id,
    );
  const credit = (u: U, where: { deal?: string | null; contact?: string | null; company?: string | null }) =>
    run(u, async (q) =>
      (
        await one<{ c: Credit }>(q, "select public.money_customer_credit($1, $2, $3, $4) as c", [org, where.deal ?? null, where.contact ?? null, where.company ?? null])
      ).c,
    );
  const apply = (u: U, document: string, max: number | null = null) =>
    run(u, async (q) => (await one<{ a: Applied }>(q, "select public.money_apply_credit($1, $2, $3) as a", [org, document, max])).a);
  const docState = (id: string) =>
    run(owner, async (q) =>
      (
        await one<{ s: { documents: { paid: number; balance: number; state: string }[] } }>(q, "select public.money_allocation_state($1, $2, '{}') as s", [org, [id]])
      ).s.documents[0],
    );
  const payCredit = (ids: string[]) =>
    run(owner, async (q) =>
      new Map(
        (await one<{ s: { payments: { id: string; credit: number }[] } }>(q, "select public.money_allocation_state($1, '{}', $2) as s", [org, ids])).s.payments.map((p) => [
          p.id,
          Number(p.credit),
        ]),
      ),
    );

  beforeAll(async () => {
    owner = await createUser("cr-owner");
    org = await createOrg(owner.id, "עסק היתרות");
    manager = await addMember(org, owner.id, "manager", "cr-manager");
    member = await addMember(org, owner.id, "member", "cr-member");
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

  it("counts the unallocated parts of the same customer's recorded and confirmed payments, oldest first, as money_allocation_state does", async () => {
    const x = await company("חברת יתרה");
    const a = await contact("אבי", x);
    const b = await contact("בתיה", x);
    const z = await contact("זיו");
    const d = await deal(b, x);
    const pA = await pay(50000, "2026-01-05", { contact: a });
    const pD = await pay(30000, "2026-02-01", { deal: d });
    const pZ = await pay(10000, "2026-01-01", { contact: z });
    const cancelled = await pay(7000, "2025-12-01", { contact: a });
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    const failed = await pay(9000, "2025-12-02", { contact: a });
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [failed]));
    // part of pA already allocated by hand
    const inv = await doc("tax_invoice", 20000, { contact: a });
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 20000)", [org, pA, inv]));

    const fromA = await credit(owner, { contact: a });
    expect(fromA).toMatchObject({ total: 60000, count: 2 });
    expect(fromA.payments.map((p) => [p.id, Number(p.credit)])).toEqual([
      [pA, 30000],
      [pD, 30000],
    ]);
    // the company card, the deal (with its contact) and a contact of the same company see the same credit
    expect((await credit(owner, { company: x })).total).toBe(60000);
    expect((await credit(owner, { deal: d, contact: b })).total).toBe(60000);
    expect((await credit(owner, { contact: b })).total).toBe(60000);
    // another customer
    expect(await credit(owner, { contact: z })).toMatchObject({ total: 10000, count: 1 });
    expect((await credit(owner, { contact: z })).payments[0].id).toBe(pZ);
    // one rule: each listed credit equals money_allocation_state's
    const state = await payCredit([pA, pD, pZ]);
    for (const p of [...fromA.payments, ...(await credit(owner, { contact: z })).payments]) expect(Number(p.credit)).toBe(state.get(p.id));
    // nothing named: nothing
    expect(await credit(owner, {})).toMatchObject({ total: 0, count: 0, payments: [] });
  });

  it("applies the credit to a new invoice oldest payment first, up to its balance or a cap; a release gives it back", async () => {
    const x = await company("חברת קיזוז");
    const a = await contact("אלה", x);
    const d = await deal(a, x);
    const old = await pay(40000, "2026-03-01", { contact: a });
    const later = await pay(50000, "2026-04-01", { deal: d });
    const invoice = await doc("tax_invoice", 60000, { deal: d, contact: a });
    const applied = await apply(manager, invoice);
    expect(Number(applied.allocated)).toBe(60000);
    expect(applied.payments.map((p) => [p.payment_id, Number(p.amount)])).toEqual([
      [old, 40000],
      [later, 20000],
    ]);
    expect(await docState(invoice)).toMatchObject({ paid: 60000, balance: 0, state: "paid" });
    expect((await credit(owner, { contact: a })).total).toBe(30000);
    // a paid invoice, a receipt, a document the caller may not use: nothing more
    expect(Number((await apply(manager, invoice)).allocated)).toBe(0);
    const receipt = await doc("receipt", 1000, { contact: a });
    expect(await apply(manager, receipt)).toEqual({ allocated: 0, payments: [] });
    // a cap
    const proforma = await doc("proforma", 25000, { contact: a });
    expect(Number((await apply(owner, proforma, 5000)).allocated)).toBe(5000);
    expect(await docState(proforma)).toMatchObject({ paid: 5000, balance: 20000, state: "partial" });
    expect((await pgError(apply(owner, proforma, 0))).hint).toBe("credit:max");
    // cancelling the invoice releases its allocations: the credit comes back
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [invoice]));
    expect((await credit(owner, { contact: a })).total).toBe(85000);
  });

  it("follows RLS and the allocation rights: a member counts only what they read and cannot apply; an outsider gets nothing", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const mine = await contact("של החבר", null, member.id);
      const x = await company("חברה משותפת");
      const theirs = await contact("של הבעלים", x);
      await run(owner, (q) => q("update public.contacts set company_id = $2 where id = $1", [mine, x]));
      await pay(1000, "2026-05-01", { contact: mine });
      await pay(2000, "2026-05-02", { contact: theirs });
      expect((await credit(owner, { contact: mine })).total).toBe(3000);
      // the member reads their own contact's payment only
      expect((await credit(member, { contact: mine })).total).toBe(1000);
      const invoice = await doc("tax_invoice", 3000, { contact: mine });
      // a member does not record payments: the insert is refused and the refusal is not swallowed
      expect((await pgError(apply(member, invoice))).code).toBe("42501");
      const outsider = await createUser("cr-outsider");
      await createOrg(outsider.id, "עסק זר");
      expect(await run(outsider, async (q) => (await one<{ c: Credit }>(q, "select public.money_customer_credit($1, null, $2, null) as c", [org, mine])).c)).toMatchObject({
        total: 0,
        count: 0,
      });
      expect(await run(outsider, async (q) => (await one<{ a: Applied }>(q, "select public.money_apply_credit($1, $2) as a", [org, invoice])).a)).toEqual({ allocated: 0, payments: [] });
      expect(await asAdmin(async (q) => (await q("select 1 from public.payment_allocations where document_id = $1", [invoice])).rowCount)).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("without the documents key nothing is applied, and the refusal is raised", async () => {
    const a = await contact("בלי מסמכים");
    await pay(1000, "2026-06-01", { contact: a });
    const invoice = await doc("tax_invoice", 1000, { contact: a });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: false, payments: true })]));
    try {
      expect((await pgError(apply(owner, invoice))).hint).toBe("feature:documents");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true })]));
    }
  });

  it("a race refusal skips that payment (payment_over, payment_state) or re-reads the document (document_over); any other refusal is raised", async () => {
    const a = await contact("מרוץ");
    const first = await pay(1000, "2026-07-01", { contact: a });
    const second = await pay(1000, "2026-07-02", { contact: a });
    const invoice = await doc("tax_invoice", 1500, { contact: a });
    class Rollback extends Error {}
    // a temporary trigger (rolled back with its transaction) refuses the allocation of one payment with the given hint
    const raced = async (payment: string, hint: string) => {
      let out: Applied | { error: { hint?: string; code?: string } } | null = null;
      await asAdmin(async (q) => {
        await q(
          `create function pg_temp.race() returns trigger language plpgsql as $f$
           begin
             if new.payment_id = current_setting('test.race_payment')::uuid then
               raise exception 'race' using errcode = 'P0001', hint = current_setting('test.race_hint');
             end if;
             return new;
           end $f$`,
        );
        await q("create trigger zz_race before insert on public.payment_allocations for each row execute function pg_temp.race()");
        await q("select set_config('test.race_payment', $1, true), set_config('test.race_hint', $2, true)", [payment, hint]);
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated" })]);
        await q("set local role authenticated");
        await q("savepoint s");
        try {
          out = (await one<{ a: Applied }>(q, "select public.money_apply_credit($1, $2) as a", [org, invoice])).a;
        } catch (error) {
          out = { error: error as { hint?: string; code?: string } };
          await q("rollback to savepoint s");
        }
        throw new Rollback();
      }).catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
      return out!;
    };
    for (const hint of ["allocation:payment_over", "allocation:payment_state"]) {
      const result = (await raced(first, hint)) as Applied;
      expect(result.payments.map((p) => [p.payment_id, Number(p.amount)])).toEqual([[second, 1000]]);
    }
    // document_over: the balance is read again (still 1,500 here), and the next payment takes it
    const reread = (await raced(first, "allocation:document_over")) as Applied;
    expect(reread.payments.map((p) => p.payment_id)).toEqual([second]);
    // anything else is raised
    const other = (await raced(first, "allocation:customer")) as { error: { hint?: string } };
    expect(other.error.hint).toBe("allocation:customer");
    // everything was rolled back
    expect(await asAdmin(async (q) => (await q("select 1 from public.payment_allocations where document_id = $1", [invoice])).rowCount)).toBe(0);
    expect(await asAdmin(async (q) => (await q("select 1 from pg_trigger where tgname = 'zz_race'")).rowCount)).toBe(0);
  });
});
