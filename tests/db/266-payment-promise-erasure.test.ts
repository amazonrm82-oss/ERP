import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, count, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * COL-03 follow-up: a privacy erasure (app.audit_erase_core, through audit_erase_record) of a purged contact, deal or company
 * empties the collection note of the payment promises on its documents (the promised date stays) and erases every audit entry
 * of those promises, a removed promise's too. Another customer's promise is untouched.
 */
describe("payment promise erasure (COL-03)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, collection: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const contact = (name: string) =>
    run(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, $2) returning id", [org, name])).id);
  const doc = (on: { contact?: string; deal?: string }) =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, deal_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, $5, 1000) returning id",
            [org, on.contact ?? null, on.deal ?? null, `PE-${++n}`, day(-20)],
          )
        ).id,
    );
  const promise = (document: string, note: string) =>
    run(
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, document_id, promised_date, note) values ($1, $2, $3, $4) returning id", [org, document, day(7), note])).id,
    );
  const row = (id: string) => asAdmin((q) => one<{ note: string | null; promised_date: string }>(q, "select note, promised_date::text from public.payment_promises where id = $1", [id]));
  const liveEntries = (id: string) =>
    asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'payment_promises' and entity_id = $1 and changes <> '{\"erased\": true}'::jsonb", [id]));
  const allEntries = (id: string) => asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'payment_promises' and entity_id = $1", [id]));

  beforeAll(async () => {
    owner = await createUser("pe-owner");
    org = await createOrg(owner.id, "עסק המחיקה");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
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

  it("a contact's erasure: notes emptied (current and removed promises), entries erased, another customer untouched", async () => {
    const gone = await contact("דני");
    const other = await contact("רותי");
    const kept = await promise(await doc({ contact: gone }), "דני ישלם אחרי החג");
    await run((q) => q("update public.payment_promises set note = 'דני אמר שבשבוע הבא' where id = $1", [kept]));
    const removedDoc = await doc({ contact: gone });
    const removed = await promise(removedDoc, "דני ביקש דחייה");
    await run((q) => q("delete from public.payment_promises where id = $1", [removed]));
    const others = await promise(await doc({ contact: other }), "רותי תעביר מחר");
    expect(await liveEntries(kept)).toBe(2);
    expect(await liveEntries(removed)).toBe(2);

    await run((q) => q("update public.contacts set deleted_at = now() where id = $1", [gone]));
    await run((q) => q("delete from public.contacts where id = $1", [gone]));
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, gone]));

    expect(await row(kept)).toEqual({ note: null, promised_date: day(7) });
    expect(await liveEntries(kept)).toBe(0);
    expect(await allEntries(kept)).toBeGreaterThan(2);
    expect(await liveEntries(removed)).toBe(0);
    expect(await row(others)).toEqual({ note: "רותי תעביר מחר", promised_date: day(7) });
    expect(await liveEntries(others)).toBe(1);
  });

  it("a deal's erasure reaches the promise on its document", async () => {
    const deal = await run(
      async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה של יוסי', $2, $3) returning id", [
            org,
            pipelineId,
            stageId,
          ])
        ).id,
    );
    const p = await promise(await doc({ deal }), "יוסי ישלם בצ'ק");
    await run((q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    await run((q) => q("delete from public.deals where id = $1", [deal]));
    await run((q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, deal]));
    expect((await row(p))?.note).toBeNull();
    expect(await liveEntries(p)).toBe(0);
  });

  it("a company's erasure reaches the promise on its opening balance", async () => {
    const company = await run(async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברת שמעון') returning id", [org])).id);
    const balance = await run(async (q) => (await one<{ id: string }>(q, "select public.opening_balance_set($1, null, $2, 5000, $3) as id", [org, company, day(-30)])).id);
    const p = await promise(balance, "שמעון מהחברה הבטיח");
    await asAdmin((q) => q("delete from public.companies where id = $1", [company]));
    await asAdmin((q) => q("select app.audit_erase_core($1, 'companies', $2, null)", [org, company]));
    expect((await row(p))?.note).toBeNull();
    expect(await liveEntries(p)).toBe(0);
  });

  it("a contact's or a company's own customer promise (gone with it at the purge): every entry erased", async () => {
    const alone = await contact("משה");
    await doc({ contact: alone });
    const p = await run(
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, contact_id, promised_date, note) values ($1, $2, $3, 'משה הבטיח לשלם הכול') returning id", [org, alone, day(6)])).id,
    );
    await run((q) => q("update public.payment_promises set note = 'משה ביקש עוד שבוע' where id = $1", [p]));
    expect(await liveEntries(p)).toBe(2);
    await run((q) => q("update public.contacts set deleted_at = now() where id = $1", [alone]));
    await run((q) => q("delete from public.contacts where id = $1", [alone]));
    // the promise went with the contact (cascade); its delete entry holds the note until the erasure
    expect(await row(p)).toBeUndefined();
    expect(await liveEntries(p)).toBe(3);
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, alone]));
    expect(await liveEntries(p)).toBe(0);

    const company = await run(async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'חברת אהרון') returning id", [org])).id);
    await run(async (q) => {
      const c = await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'אהרון', $2) returning id", [org, company]);
      await q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, $4, 1000)", [org, c.id, `PE-${++n}`, day(-5)]);
    });
    const cp = await run(
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.payment_promises (organization_id, company_id, promised_date, note) values ($1, $2, $3, 'אהרון מהנהלת החשבונות') returning id", [org, company, day(6)])).id,
    );
    await asAdmin((q) => q("delete from public.companies where id = $1", [company]));
    await asAdmin((q) => q("select app.audit_erase_core($1, 'companies', $2, null)", [org, company]));
    expect(await liveEntries(cp)).toBe(0);
  });
});
