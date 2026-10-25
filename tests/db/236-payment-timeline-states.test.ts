import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Entry = { body: string; created_by: string | null; kind: string };

/**
 * DOC-04 follow-up (owner, 25 October 2026): a payment that fails or is refunded is written on the timeline with its method
 * and no amount; a failed payment received after all is written again as received. Confirming writes nothing.
 */
describe("failed and refunded payments on the timeline (DOC-04 follow-up)", () => {
  let owner: U;
  let org: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const entries = (paymentId: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Entry>("select body, created_by, metadata ->> 'kind' as kind from public.activities where type = 'system' and metadata ->> 'payment_id' = $1 order by created_at, id", [
            paymentId,
          ])
        ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("pts-owner");
    org = await createOrg(owner.id, "עסק המצבים");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ payments: true })]));
  });

  const payment = async () => {
    const contact = await run(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [org])).id);
    const id = await run(async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 54321, 'transfer') returning id", [org, contact])).id,
    );
    return id;
  };
  const setStatus = (id: string, status: string) => run((q) => q("update public.payments set status = $2 where id = $1", [id, status]));

  it("failed, then received after all, is written twice; confirming writes nothing", async () => {
    const id = await payment();
    await setStatus(id, "confirmed");
    await setStatus(id, "failed");
    await setStatus(id, "recorded");
    const rows = await entries(id);
    expect(rows.map((r) => r.kind)).toEqual(["payment_received", "payment_failed", "payment_received"]);
    expect(rows.map((r) => r.body)).toEqual(["התקבל תשלום · העברה בנקאית", "תשלום נכשל · העברה בנקאית", "התקבל תשלום · העברה בנקאית"]);
    for (const r of rows) {
      expect(r.created_by).toBeNull();
      expect(r.body).not.toMatch(/543/);
    }
  });

  it("a refund is written with the method and no amount", async () => {
    const id = await payment();
    await setStatus(id, "refunded");
    expect((await entries(id)).map((r) => [r.kind, r.body])).toEqual([
      ["payment_received", "התקבל תשלום · העברה בנקאית"],
      ["payment_refunded", "תשלום הוחזר · העברה בנקאית"],
    ]);
  });

  it("a person never writes, changes or removes the new entries", async () => {
    const id = await payment();
    await setStatus(id, "failed");
    const entry = (await asAdmin((q) => one<{ id: string }>(q, "select id from public.activities where metadata ->> 'kind' = 'payment_failed' and metadata ->> 'payment_id' = $1", [id]))).id;
    for (const sql of ["update public.activities set body = 'x' where id = $1", "delete from public.activities where id = $1"]) {
      expect((await pgError(run((q) => q(sql, [entry])))).hint, sql).toBe("activity:money_entry");
    }
    for (const kind of ["payment_failed", "payment_refunded"]) {
      const forged = await pgError(
        run(async (q) => {
          const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'x') returning id", [org])).id;
          await q("insert into public.activities (organization_id, type, contact_id, body, metadata) values ($1, 'note', $2, 'x', $3)", [org, contact, JSON.stringify({ kind })]);
        }),
      );
      expect(forged.hint, kind).toBe("activity:money_entry");
    }
  });
});
