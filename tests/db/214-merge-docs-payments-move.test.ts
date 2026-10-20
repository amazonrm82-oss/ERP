import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * DOC-01 / PAY-01 merge follow-up (lane ד): a contact merge moves the duplicate's accounting documents and payments in
 * app.merge_move_links, as orders since 020590. Each moves once (the `merged` entry's old triggers do nothing now), only
 * its contact link changes, and its files stay with it.
 */
describe("a contact merge moves documents and payments once", () => {
  let owner: U;
  let org: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const newContact = (name: string) =>
    run(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const record = (contact: string) =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', $3, 1000) returning id",
            [org, contact, `MG-${++n}`],
          )
        ).id,
    );
  const pay = (contact: string) =>
    run(
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method, reference) values ($1, $2, 2500, 'cash', $3) returning id", [
          org,
          contact,
          `P-${++n}`,
        ])).id,
    );
  const attach = (column: "accounting_document_id" | "payment_id", id: string) =>
    run(async (q) =>
      (
        await one<{ id: string }>(q, `insert into public.files (organization_id, ${column}, name, mime_type, size_bytes) values ($1, $2, 'קבלה.pdf', 'application/pdf', 100) returning id`, [
          org,
          id,
        ])
      ).id,
    );
  const row = (table: "accounting_documents" | "payments", id: string) =>
    asAdmin((q) => one<Record<string, unknown>>(q, `select * from public.${table} where id = $1`, [id]));
  const updates = (table: string, id: string) =>
    asAdmin((q) =>
      q<{ changes: Record<string, unknown> }>("select changes from public.audit_log where entity_type = $1 and entity_id = $2 and action = 'update' order by id", [table, id]),
    ).then((r) => r.rows.map((x) => x.changes));
  const merge = (keep: string, merged: string) => run((q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, merged]));

  beforeAll(async () => {
    owner = await createUser("mdp-owner");
    org = await createOrg(owner.id, "עסק המיזוג");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true })]));
  });

  it("moves the duplicate's documents and payments to the kept contact, once, changing only the contact link", async () => {
    const keep = await newContact("דנה");
    const dup = await newContact("דנה כפולה");
    const doc = await record(dup);
    const cancelledDoc = await record(dup);
    await run((q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [cancelledDoc]));
    const payment = await pay(dup);
    const cancelledPayment = await pay(dup);
    await run((q) => q("update public.payments set status = 'cancelled', cancel_reason = 'כפול' where id = $1", [cancelledPayment]));
    const docFile = await attach("accounting_document_id", doc);
    const paymentFile = await attach("payment_id", payment);
    const before = {
      docs: await Promise.all([doc, cancelledDoc].map((id) => row("accounting_documents", id))),
      payments: await Promise.all([payment, cancelledPayment].map((id) => row("payments", id))),
      docUpdates: (await updates("accounting_documents", cancelledDoc)).length,
      paymentUpdates: (await updates("payments", cancelledPayment)).length,
    };

    await merge(keep, dup);

    // every one on the kept contact, nothing else of it changed
    for (const [i, id] of [doc, cancelledDoc].entries()) {
      const after = await row("accounting_documents", id);
      expect(after.contact_id).toBe(keep);
      expect({ ...after, contact_id: null, updated_at: null }).toEqual({ ...before.docs[i], contact_id: null, updated_at: null });
    }
    for (const [i, id] of [payment, cancelledPayment].entries()) {
      const after = await row("payments", id);
      expect(after.contact_id).toBe(keep);
      expect({ ...after, contact_id: null, updated_at: null }).toEqual({ ...before.payments[i], contact_id: null, updated_at: null });
    }
    // moved once: one more update entry each, the contact link from the duplicate to the kept contact and nothing else
    for (const [table, id, earlier] of [
      ["accounting_documents", doc, 0],
      ["accounting_documents", cancelledDoc, before.docUpdates],
      ["payments", payment, 0],
      ["payments", cancelledPayment, before.paymentUpdates],
    ] as const) {
      const entries = await updates(table, id);
      expect(entries.length, `${table} ${id}`).toBe(earlier + 1);
      expect(entries[entries.length - 1], `${table} ${id}`).toEqual({ contact_id: { old: dup, new: keep } });
    }
    // their files stay with them
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1 and accounting_document_id = $2", [docFile, doc]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1 and payment_id = $2", [paymentFile, payment]))).toBe(1);
  });

  it("the `merged` entry's old triggers move nothing now", async () => {
    const keep = await newContact("רון");
    const other = await newContact("רון אחר");
    const doc = await record(other);
    const payment = await pay(other);
    // a `merged` entry naming a contact that still holds a document and a payment (as the old triggers read it)
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, metadata, contact_id) values ($1, 'system', 'מוזג', jsonb_build_object('merged_id', $2::text), $3)", [
        org,
        other,
        keep,
      ]),
    );
    expect((await row("accounting_documents", doc)).contact_id).toBe(other);
    expect((await row("payments", payment)).contact_id).toBe(other);
    expect(await updates("accounting_documents", doc)).toEqual([]);
    expect(await updates("payments", payment)).toEqual([]);
  });

  it("a person still cannot move a document's or a payment's contact by hand", async () => {
    const a = await newContact("א");
    const b = await newContact("ב");
    const doc = await record(a);
    const payment = await pay(a);
    const refused = async (sql: string, id: string) => {
      const err = await run((q) => q(sql, [b, id])).then(
        () => null,
        (e: { hint?: string; code?: string }) => e,
      );
      return err?.hint ?? err?.code ?? "none";
    };
    expect(await refused("update public.accounting_documents set contact_id = $1 where id = $2", doc)).not.toBe("none");
    expect(await refused("update public.payments set contact_id = $1 where id = $2", payment)).not.toBe("none");
    expect((await row("accounting_documents", doc)).contact_id).toBe(a);
    expect((await row("payments", payment)).contact_id).toBe(a);
  });
});
