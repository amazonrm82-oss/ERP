import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Entry = { body: string; created_by: string | null; deal_id: string | null; contact_id: string | null; metadata: Record<string, string> };

/**
 * DOC-04: recording or cancelling a document, and receiving or cancelling a payment, writes one system entry with no author on
 * the row's deal and contact: type and number, or the method; never an amount. A person never writes, changes or removes such
 * an entry. A privacy erasure removes the cancel reason from it.
 */
describe("documents and payments on the timeline (DOC-04)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const contact = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const deal = (contactId: string) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          stageId,
          contactId,
          member.id,
        ])
      ).id,
    );
  const doc = (dealId: string | null, contactId: string | null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, 123456) returning id",
          [org, dealId, contactId, `TL-${++n}`],
        )
      ).id,
    );
  const pay = (dealId: string | null, contactId: string | null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method) values ($1, $2, $3, 98765, 'transfer') returning id",
          [org, dealId, contactId],
        )
      ).id,
    );
  const entries = (key: "document_id" | "payment_id", id: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Entry>(
            "select body, created_by, deal_id, contact_id, metadata from public.activities where type = 'system' and metadata ->> $1 = $2 order by created_at, metadata ->> 'kind' desc",
            [key, id],
          )
        ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("tl-owner");
    org = await createOrg(owner.id, "עסק ציר הזמן");
    member = await addMember(org, owner.id, "member", "tl-member");
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

  it("a document recorded and cancelled: type and number, no author, no amount, on its deal and contact", async () => {
    const c = await contact("רון");
    const d = await deal(c);
    const id = await doc(d, c);
    let rows = await entries("document_id", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: `נרשם מסמך: חשבונית מס TL-${n}`, created_by: null, deal_id: d, contact_id: c });
    expect(rows[0].metadata).toMatchObject({ kind: "document_recorded", doc_type: "tax_invoice", number: `TL-${n}` });
    // the deal's owner (a member) reads it through the deal
    expect(await run(member, (q) => count(q, "select 1 from public.activities where metadata ->> 'document_id' = $1", [id]))).toBe(1);

    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [id]));
    rows = await entries("document_id", id);
    expect(rows.map((r) => r.metadata.kind).sort()).toEqual(["document_cancelled", "document_recorded"]);
    const cancelled = rows.find((r) => r.metadata.kind === "document_cancelled")!;
    expect(cancelled).toMatchObject({ body: `בוטל מסמך: חשבונית מס TL-${n} · סיבה: נרשם בטעות`, created_by: null });
    for (const r of rows) expect(r.body).not.toMatch(/1,?234|123456/);
  });

  it("a payment received names its method; confirming writes nothing; cancelling writes one entry", async () => {
    const c = await contact("שירה");
    const id = await pay(null, c);
    let rows = await entries("payment_id", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "התקבל תשלום · העברה בנקאית", created_by: null, deal_id: null, contact_id: c });
    expect(rows[0].metadata).toMatchObject({ kind: "payment_received", method: "transfer" });
    expect(rows[0].body).not.toMatch(/987/);

    await run(owner, (q) => q("update public.payments set status = 'confirmed' where id = $1", [id]));
    expect(await entries("payment_id", id)).toHaveLength(1);

    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'כפול' where id = $1", [id]));
    rows = await entries("payment_id", id);
    expect(rows.map((r) => r.metadata.kind).sort()).toEqual(["payment_cancelled", "payment_received"]);
    expect(rows.find((r) => r.metadata.kind === "payment_cancelled")).toMatchObject({ body: "בוטל תשלום · העברה בנקאית · סיבה: כפול", created_by: null });
  });

  it("a person never writes, changes or removes such an entry, owners included", async () => {
    const c = await contact("גל");
    const id = await doc(null, c);
    const entry = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.activities where metadata ->> 'document_id' = $1", [id])).id);
    for (const sql of [
      "update public.activities set body = 'שונה' where id = $1",
      "update public.activities set is_pinned = true where id = $1",
      "delete from public.activities where id = $1",
    ]) {
      const e = await pgError(run(owner, (q) => q(sql, [entry])));
      expect(e.code, sql).toBe("42501");
      expect(e.hint, sql).toBe("activity:money_entry");
    }
    for (const kind of ["document_recorded", "payment_received"]) {
      for (const type of ["note", "system"]) {
        const e = await pgError(
          run(owner, (q) =>
            q("insert into public.activities (organization_id, type, contact_id, body, metadata) values ($1, $2, $3, 'מזויף', $4)", [org, type, c, JSON.stringify({ kind })]),
          ),
        );
        expect(e.code, `${type} ${kind}`).toBe("42501");
      }
    }
    // a person's own note with the kind added later is refused too
    const note = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.activities (organization_id, type, contact_id, body) values ($1, 'note', $2, 'הערה') returning id", [org, c])).id);
    expect((await pgError(run(owner, (q) => q(`update public.activities set metadata = '{"kind": "payment_cancelled"}' where id = $1`, [note])))).hint).toBe("activity:money_entry");
  });

  it("a privacy erasure removes the cancel reason from the entries; type, number and method stay", async () => {
    const c = await contact("דנה");
    const d = await deal(c);
    const docId = await doc(d, c);
    const number = `TL-${n}`;
    const payId = await pay(d, c);
    await run(owner, async (q) => {
      await q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'דנה לוי ביקשה לבטל' where id = $1", [docId]);
      await q("update public.payments set status = 'cancelled', cancel_reason = 'דנה לוי שילמה פעמיים' where id = $1", [payId]);
    });
    // an untouched entry on another contact keeps its reason
    const other = await contact("אחר");
    const otherDoc = await doc(null, other);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'סיבה אחרת' where id = $1", [otherDoc]));

    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [c]);
      await q("delete from public.contacts where id = $1", [c]);
    });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, c]));

    const docRows = await entries("document_id", docId);
    expect(docRows.find((r) => r.metadata.kind === "document_cancelled")?.body).toBe(`בוטל מסמך: חשבונית מס ${number}`);
    const payRows = await entries("payment_id", payId);
    expect(payRows.find((r) => r.metadata.kind === "payment_cancelled")?.body).toBe("בוטל תשלום · העברה בנקאית");
    for (const r of [...docRows, ...payRows]) expect(r.body).not.toContain("דנה");
    expect((await entries("document_id", otherDoc)).find((r) => r.metadata.kind === "document_cancelled")?.body).toContain("סיבה אחרת");
  });
});
