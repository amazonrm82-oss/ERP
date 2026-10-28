import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * Shared ground (review of 27 October 2026): public.money_allocation_state reads each table once (set-based) and runs with
 * jit off. Its answer must equal the 021077 body's, row for row, for every role and every kind of input: the old body is
 * created inside one transaction under a temporary name in schema app, compared, and the transaction is rolled back.
 */
const ROLLBACK = new Error("rollback the comparison");

describe("money_allocation_state answers as before, faster (shared ground)", () => {
  let owner: U, admin: U, manager: U, member: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const docs: string[] = [];
  const payments: string[] = [];
  let foreignDoc: string;
  let foreignPayment: string;
  let memberInvoice: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const id = async (u: U, sql: string, params: unknown[]) => run(u, async (q) => (await one<{ id: string }>(q, sql, params)).id);
  const contact = (by: U, companyId: string | null = null) =>
    id(by, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, $2, $3, $4) returning id", [org, `לקוח ${++n}`, by.id, companyId]);
  const doc = async (type: string, amount: number, on: { contact?: string; deal?: string; proforma?: string }) => {
    const d = await id(
      owner,
      "insert into public.accounting_documents (organization_id, contact_id, deal_id, doc_type, number, doc_date, amount_agorot, proforma_id) values ($1, $2, $3, $4, $5, '2026-02-01', $6, $7) returning id",
      [org, on.contact ?? null, on.deal ?? null, type, `MS-${++n}`, amount, on.proforma ?? null],
    );
    docs.push(d);
    return d;
  };
  const opening = async (on: { contact?: string; company?: string }, amount: number) => {
    const d = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, $3, $4, '2026-01-01') as id", [org, on.contact ?? null, on.company ?? null, amount])).id,
    );
    docs.push(d);
    return d;
  };
  const pay = async (amount: number, on: { contact?: string; deal?: string }, status = "recorded") => {
    const p = await id(owner, "insert into public.payments (organization_id, contact_id, deal_id, amount_agorot, method, status) values ($1, $2, $3, $4, 'transfer', $5) returning id", [
      org,
      on.contact ?? null,
      on.deal ?? null,
      amount,
      status,
    ]);
    payments.push(p);
    return p;
  };
  const allocate = (payment: string, document: string, amount: number) =>
    id(owner, "insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4) returning id", [org, payment, document, amount]);
  const offset = (credit: string, document: string, amount: number) =>
    id(owner, "insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot) values ($1, $2, $3, $4) returning id", [
      org,
      credit,
      document,
      amount,
    ]);

  beforeAll(async () => {
    owner = await createUser("ms-owner");
    org = await createOrg(owner.id, "עסק המצב");
    admin = await addMember(org, owner.id, "admin", "ms-admin");
    manager = await addMember(org, owner.id, "manager", "ms-manager");
    member = await addMember(org, owner.id, "member", "ms-member");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true, balances: true })]),
    );
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;

    const co = await id(owner, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברה', $2) returning id", [org, owner.id]);
    const cA = await contact(owner, co);
    const cB = await contact(owner);
    const cM = await contact(member);
    const deal = await id(owner, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
      org,
      pipelineId,
      stageId,
      owner.id,
    ]);

    // partly paid by payments, an opening-credit offset and a removed allocation; fully paid; overpaid payment = credit
    const inv1 = await doc("tax_invoice", 10000, { contact: cA });
    const inv2 = await doc("tax_invoice", 5000, { contact: cA });
    const pay1 = await pay(6000, { contact: cA }, "confirmed");
    const pay2 = await pay(5000, { contact: cA });
    await allocate(pay1, inv1, 4000);
    await allocate(pay1, inv2, 2000);
    await allocate(pay2, inv2, 3000);
    const removed = await allocate(pay2, inv1, 500);
    await run(admin, (q) => q("update public.payment_allocations set removed_at = now() where id = $1", [removed]));
    const companyCredit = await opening({ company: co }, -3000);
    await offset(companyCredit, inv1, 1000);
    await opening({ contact: cB }, -500);

    // a proforma paid in part, then billed by an invoice that is paid too; another proforma unpaid
    const pro1 = await doc("proforma", 8000, { contact: cB });
    const pay3 = await pay(3000, { contact: cB });
    await allocate(pay3, pro1, 3000);
    const inv3 = await doc("tax_invoice", 8000, { contact: cB, proforma: pro1 });
    const pay4 = await pay(2000, { contact: cB }, "confirmed");
    await allocate(pay4, inv3, 2000);
    await doc("proforma", 900, { contact: cB });
    // a proforma billed by an invoice that was then cancelled: debt again with its own payments
    const pro3 = await doc("proforma", 700, { contact: cB });
    const pay10 = await pay(300, { contact: cB });
    await allocate(pay10, pro3, 300);
    const inv6 = await doc("tax_invoice", 700, { contact: cB, proforma: pro3 });
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'הוחלפה' where id = $1", [inv6]));

    // a cancelled invoice releases its allocation; a failed and a cancelled payment hold no credit
    const inv4 = await doc("tax_invoice", 1000, { contact: cB });
    const pay5 = await pay(1000, { contact: cB });
    await allocate(pay5, inv4, 1000);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [inv4]));
    const pay6 = await pay(700, { contact: cA });
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [pay6]));
    const pay8 = await pay(400, { contact: cA });
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'בוטל' where id = $1", [pay8]));

    // documents that take no payments
    await doc("receipt", 1200, { contact: cA });
    await doc("tax_invoice_receipt", 1300, { contact: cA });
    await doc("credit_invoice", 400, { contact: cA });

    // the member's own customer: a positive opening balance paid in part
    const memberDebt = await opening({ contact: cM }, 4000);
    const pay7 = await pay(1000, { contact: cM });
    await allocate(pay7, memberDebt, 1000);

    // a deal-only document and payment
    const inv5 = await doc("tax_invoice", 2500, { deal });
    const pay9 = await pay(1500, { deal });
    await allocate(pay9, inv5, 1500);

    // the member's deal on the owner's customer: the member reads the invoice and the payment (through the deal) but not
    // the proforma the invoice bills (contact only), so the proforma's payment counts on the invoice only for the owner
    const memberDeal = await id(owner, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, 'עסקת חבר', $2, $3, $4, $5) returning id", [
      org,
      pipelineId,
      stageId,
      member.id,
      cB,
    ]);
    const pro4 = await doc("proforma", 6000, { contact: cB });
    const pay11 = await pay(2500, { deal: memberDeal, contact: cB });
    await allocate(pay11, pro4, 2500);
    memberInvoice = await doc("tax_invoice", 6000, { deal: memberDeal, contact: cB, proforma: pro4 });

    // the member reads only their own records
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));

    // another business's document and payment, asked for by id
    const other = await createUser("ms-other");
    otherOrg = await createOrg(other.id, "עסק אחר");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [otherOrg, JSON.stringify({ documents: true, payments: true })]),
    );
    const oc = await asUser(other.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [otherOrg, other.id])).id,
    );
    foreignDoc = await asUser(other.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', 'F-1', 100) returning id",
          [otherOrg, oc],
        )
      ).id,
    );
    foreignPayment = await asUser(other.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 100, 'cash') returning id", [otherOrg, oc])).id,
    );
  });

  // the body of public.money_allocation_state as the opening-credit migration (021077) left it, renamed into schema app
  const oldBody = () => {
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_opening_credit.sql"));
    const sql = readFileSync(path.join(dir, file as string), "utf8");
    const start = sql.indexOf("create or replace function public.money_allocation_state(");
    const end = sql.indexOf("\n$$;", start);
    expect(start).toBeGreaterThan(0);
    return sql.slice(start, end + 4).replace("public.money_allocation_state(", "app.money_allocation_state_021077(");
  };

  /** Runs every input as `who` against both bodies in one transaction, then rolls it back. */
  const compare = async (who: U, inputs: [string[] | null, string[] | null][]) => {
    const results: { input: number; same: boolean; old: unknown; now: unknown }[] = [];
    await asAdmin(async (q) => {
      await q(oldBody());
      await q("grant execute on function app.money_allocation_state_021077(uuid, uuid[], uuid[]) to authenticated");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.id, role: "authenticated" })]);
      await q("set local role authenticated");
      for (const [i, [d, p]] of inputs.entries()) {
        const r = await one<{ old: unknown; now: unknown; same: boolean }>(
          q,
          `select app.money_allocation_state_021077($1, $2::uuid[], $3::uuid[]) as old, public.money_allocation_state($1, $2::uuid[], $3::uuid[]) as now,
                  app.money_allocation_state_021077($1, $2::uuid[], $3::uuid[]) = public.money_allocation_state($1, $2::uuid[], $3::uuid[]) as same`,
          [org, d, p],
        );
        results.push({ input: i, ...r });
      }
      throw ROLLBACK;
    }).catch((error) => {
      if (error !== ROLLBACK) throw error;
    });
    return results;
  };

  it("the new body keeps the old answer for every role and input, the unreadable rows included", async () => {
    const inputs: [string[] | null, string[] | null][] = [
      [docs, []],
      [[], payments],
      [docs, payments],
      [null, null],
      [null, payments],
      [docs, null],
      [[...docs, foreignDoc], [...payments, foreignPayment]],
      ...docs.map((d): [string[], string[]] => [[d], []]),
      ...payments.map((p): [string[], string[]] => [[], [p]]),
      // a document asked for twice; an unknown id
      [[docs[0], docs[0], "00000000-0000-0000-0000-000000000001"], [payments[0], payments[0]]],
    ];
    for (const who of [owner, admin, manager, member]) {
      const results = await compare(who, inputs);
      expect(results.length).toBe(inputs.length);
      for (const r of results) expect({ who: who.email, ...r }).toMatchObject({ same: true });
    }
  });

  it("the fixture covers what the rules distinguish (states, transfer, credit, the member's partial view)", async () => {
    const all = await run(owner, async (q) =>
      (
        await one<{ s: { documents: { state: string; credit: number; invoice_number: string | null }[]; payments: { credit: number; allocated: number }[] } }>(
          q,
          "select public.money_allocation_state($1, $2::uuid[], $3::uuid[]) as s",
          [org, docs, payments],
        )
      ).s,
    );
    const states = new Set(all.documents.map((d) => d.state));
    for (const s of ["unpaid", "partial", "paid", "transferred", "none", "paid_on_issue"]) expect(states, s).toContain(s);
    expect(all.documents.some((d) => d.credit > 0)).toBe(true);
    expect(all.payments.some((p) => p.credit > 0)).toBe(true);
    expect(all.payments.some((p) => p.credit === 0 && p.allocated === 0)).toBe(true);
    const seen = await run(member, async (q) =>
      (await one<{ s: { documents: unknown[]; payments: unknown[] } }>(q, "select public.money_allocation_state($1, $2::uuid[], $3::uuid[]) as s", [org, docs, payments])).s,
    );
    expect(seen.documents.length).toBeGreaterThan(0);
    expect(seen.documents.length).toBeLessThan(all.documents.length);
    expect(seen.payments.length).toBeLessThan(all.payments.length);
    // the proforma's payment counts on the invoice that bills it only while the proforma is readable
    const paidOn = (u: U) =>
      run(u, async (q) =>
        (await one<{ paid: number }>(q, "select (public.money_allocation_state($1, array[$2]::uuid[], '{}') -> 'documents' -> 0 ->> 'paid')::int as paid", [org, memberInvoice])).paid,
      );
    expect(await paidOn(owner)).toBe(2500);
    expect(await paidOn(member)).toBe(0);
  });

  it("runs with jit off, invoker, with the same grants", async () => {
    const row = await asAdmin((q) =>
      one<{ config: string[]; definer: boolean; anon: boolean; auth: boolean }>(
        q,
        `select p.proconfig as config, p.prosecdef as definer,
                has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p where p.oid = 'public.money_allocation_state(uuid, uuid[], uuid[])'::regprocedure`,
      ),
    );
    expect(row.config).toEqual(expect.arrayContaining(["search_path=\"\"", "jit=off"]));
    expect(row.definer).toBe(false);
    expect(row.anon).toBe(false);
    expect(row.auth).toBe(true);
  });
});
