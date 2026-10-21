import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * RVW-45: erasing a contact also reaches the accounting documents and payments recorded without a contact on a deal that was
 * the contact's when it was purged: a document's cancel reason becomes the neutral text, a payment loses its reference and
 * note, their entries are erased and their files renamed. A deal that had moved to another contact, and a row that names
 * another contact, stay as they are.
 */
describe("erasing a contact reaches documents and payments on their deal (RVW-45)", () => {
  let owner: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const NEUTRAL = "הסיבה נמחקה (מחיקת פרטיות)";

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(fn: (q: Query) => Promise<T>) => asUser(owner.id, fn);
  const contact = (name: string) =>
    run(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const deal = (contactId: string) =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id",
            [org, pipelineId, stageId, contactId, owner.id],
          )
        ).id,
    );
  // a document on the deal only (as the deal page records it), cancelled with a reason that names the customer
  const cancelledDoc = (dealId: string, contactId: string | null, reason: string) =>
    run(async (q) => {
      const id = (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'receipt', $4, 1000) returning id",
          [org, dealId, contactId, `R-${++n}`],
        )
      ).id;
      await q("update public.accounting_documents set status = 'cancelled', cancel_reason = $2 where id = $1", [id, reason]);
      return id;
    });
  const payment = (dealId: string, contactId: string | null, text: string) =>
    run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method, reference, note) values ($1, $2, $3, 2500, 'transfer', $4, $4) returning id",
            [org, dealId, contactId, text],
          )
        ).id,
    );
  const doc = (id: string) => asAdmin((q) => one<{ cancel_reason: string }>(q, "select cancel_reason from public.accounting_documents where id = $1", [id]));
  const pay = (id: string) => asAdmin((q) => one<{ reference: string | null; note: string | null }>(q, "select reference, note from public.payments where id = $1", [id]));
  const history = (table: string, id: string) =>
    asAdmin(async (q) => (await q<{ c: string }>("select changes::text as c from public.audit_log where entity_type = $1 and entity_id = $2", [table, id])).rows.map((r) => r.c));
  const purgeAndErase = async (contactId: string) => {
    await run(async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contactId]);
      await q("delete from public.contacts where id = $1", [contactId]);
    });
    await run((q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contactId]));
  };

  beforeAll(async () => {
    owner = await createUser("edp-owner");
    org = await createOrg(owner.id, "עסק המסמכים");
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

  it("a document and a payment on the contact's deal lose their free text, their history and their file names", async () => {
    const dana = await contact("דנה");
    const dealId = await deal(dana);
    const docId = await cancelledDoc(dealId, null, "דנה לוי ביקשה לבטל");
    const payId = await payment(dealId, null, "העברה מדנה לוי");
    const fileId = await run(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.files (organization_id, accounting_document_id, name, mime_type, size_bytes) values ($1, $2, 'קבלה דנה לוי.pdf', 'application/pdf', 100) returning id",
            [org, docId],
          )
        ).id,
    );

    await purgeAndErase(dana);

    expect((await doc(docId)).cancel_reason).toBe(NEUTRAL);
    expect(await pay(payId)).toEqual({ reference: null, note: null });
    for (const [table, id] of [
      ["accounting_documents", docId],
      ["payments", payId],
      ["files", fileId],
    ] as const) {
      expect((await history(table, id)).filter((c) => c.includes("דנה")), table).toEqual([]);
    }
    expect((await asAdmin((q) => one<{ name: string }>(q, "select name from public.files where id = $1", [fileId]))).name).toMatch(/^מסמך R-\d+\.pdf$/);
    // the deal stays, with its rows
    expect((await asAdmin((q) => one<{ n: number }>(q, "select count(*)::int as n from public.deals where id = $1", [dealId]))).n).toBe(1);
  });

  it("rows recorded on the deal after the contact was unlinked from it keep their text and their history", async () => {
    const shir = await contact("שיר");
    const dealId = await deal(shir);
    const before = await cancelledDoc(dealId, null, "שיר ביקשה לבטל");
    // the contact is unlinked from the deal; what is recorded on it afterwards may be another customer's
    await run((q) => q("update public.deals set contact_id = null where id = $1", [dealId]));
    const laterDoc = await cancelledDoc(dealId, null, "אלון ביקש לבטל");
    const laterPay = await payment(dealId, null, "העברה מאלון");

    await purgeAndErase(shir);

    expect((await doc(before)).cancel_reason).toBe(NEUTRAL);
    expect((await doc(laterDoc)).cancel_reason).toBe("אלון ביקש לבטל");
    expect(await pay(laterPay)).toEqual({ reference: "העברה מאלון", note: "העברה מאלון" });
    expect((await history("accounting_documents", laterDoc)).some((c) => c.includes("אלון ביקש לבטל"))).toBe(true);
    expect((await history("payments", laterPay)).every((c) => c !== '{"erased": true}')).toBe(true);
  });

  it("a deal that had moved to another contact, and a row that names another contact, keep their text", async () => {
    const yoav = await contact("יואב");
    const other = await contact("מיכל");
    const movedDeal = await deal(yoav);
    const movedDoc = await cancelledDoc(movedDeal, null, "מיכל ביקשה לבטל");
    await run((q) => q("update public.deals set contact_id = $2 where id = $1", [movedDeal, other]));
    const ownDeal = await deal(yoav);
    const othersPayment = await payment(ownDeal, other, "העברה ממיכל");

    await purgeAndErase(yoav);

    expect((await doc(movedDoc)).cancel_reason).toBe("מיכל ביקשה לבטל");
    expect(await pay(othersPayment)).toEqual({ reference: "העברה ממיכל", note: "העברה ממיכל" });
  });
});
