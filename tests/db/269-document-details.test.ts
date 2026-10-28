import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * DOC-02: the document as the system keeps it. New nullable columns on accounting_documents (provider and its id, server only;
 * allocation number on tax invoices; the VAT split; the source quote; a credit invoice's original), insert-only and frozen for
 * every writer; and public.accounting_document_lines, written only with their document (public.accounting_document_record, one
 * transaction), read like the document, never changed, emptied of text by a privacy erasure.
 */
describe("document details and lines (DOC-02)", () => {
  let owner: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  let product: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const newContact = (name: string, orgId = org, u: U = owner) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
  const newDeal = (contact: string | null, u: U = owner) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
            [org, pipelineId, stageId, contact, u.id],
          )
        ).id,
    );
  let seq = 0;
  const recordWith = (u: U, doc: Record<string, unknown>, lines: unknown[] | null = null, orgId = org) =>
    run(u, async (q) => (await one<{ id: string }>(q, "select public.accounting_document_record($1, $2, $3) as id", [orgId, JSON.stringify(doc), lines === null ? null : JSON.stringify(lines)])).id);
  const docOf = (contact: string, extra: Record<string, unknown> = {}) => ({ contact_id: contact, doc_type: "tax_invoice", number: `N-${++seq}`, amount_agorot: 11700, ...extra });
  const row = (id: string) =>
    asAdmin((q) =>
      one<Record<string, unknown>>(
        q,
        "select provider, provider_document_id, allocation_number, net_agorot, vat_agorot, vat_rate_bp, quote_id, original_document_id from public.accounting_documents where id = $1",
        [id],
      ),
    );
  const lines = (id: string) =>
    asAdmin(async (q) =>
      (
        await q<{ position: number; description: string; total_agorot: string; product_id: string | null }>(
          "select position, description, total_agorot, product_id from public.accounting_document_lines where document_id = $1 order by position",
          [id],
        )
      ).rows,
    );
  const acceptedQuote = async (deal: string | null, contact: string | null) => {
    const id = await asAdmin(
      async (q) =>
        (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [org, deal, contact])).id,
    );
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [id]));
    return id;
  };

  beforeAll(async () => {
    owner = await createUser("d02-owner");
    org = await createOrg(owner.id, "עסק פרטי מסמך");
    manager = await addMember(org, owner.id, "manager", "d02-manager");
    member = await addMember(org, owner.id, "member", "d02-member");
    viewer = await addMember(org, owner.id, "viewer", "d02-viewer");
    outsider = await createUser("d02-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = '{\"documents\": true, \"payments\": true, \"products\": true, \"quotes\": true}' where organization_id = any($1::uuid[])", [[org, otherOrg]]),
    );
    product = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'ייעוץ', 10000) returning id", [org])).id);
  });

  it("records a document with its details and lines in one call; the server works out each line's total", async () => {
    const contact = await newContact("דנה");
    const id = await recordWith(
      manager,
      docOf(contact, { allocation_number: "123456789", net_agorot: 10000, vat_agorot: 1700, vat_rate_bp: 1700 }),
      [
        { description: "עבודה", quantity: 2.5, unit_price_agorot: 3333, discount_agorot: 100 },
        { description: "ייעוץ", quantity: 1, unit_price_agorot: 1768 },
      ],
    );
    expect(await row(id)).toMatchObject({ provider: null, allocation_number: "123456789", net_agorot: "10000", vat_agorot: "1700", vat_rate_bp: 1700 });
    // 2.5 x 3333 = 8332.5 -> 8333 (half up), less 100; a product line without text takes the product's name
    expect(await lines(id)).toEqual([
      { position: 1, description: "עבודה", total_agorot: "8233", product_id: null },
      { position: 2, description: "ייעוץ", total_agorot: "1768", product_id: null },
    ]);
    // a person never names a product on a line (no grant; the call ignores it); the server may, and a product line without
    // text takes the product's name
    expect(
      (
        await pgError(
          run(manager, async (q) => {
            const d = (await one<{ id: string }>(q, "select public.accounting_document_record($1, $2, '[]') as id", [org, JSON.stringify(docOf(contact))])).id;
            await q("insert into public.accounting_document_lines (organization_id, document_id, product_id, description) values ($1, $2, $3, 'x')", [org, d, product]);
          }),
        )
      ).code,
    ).toBe("42501");
    const serverDoc = await asAdmin(async (q) => {
      const d = (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'SRV-1', 100) returning id", [org, contact])).id;
      await q("insert into public.accounting_document_lines (organization_id, document_id, product_id, unit_price_agorot) values ($1, $2, $3, 100)", [org, d, product]);
      return d;
    });
    expect(await lines(serverDoc)).toEqual([{ position: 1, description: "ייעוץ", total_agorot: "100", product_id: product }]);
    // a document without lines too
    const bare = await recordWith(owner, docOf(contact), []);
    expect(await lines(bare)).toEqual([]);
  });

  it("the shapes: allocation number, VAT split, provider, source", async () => {
    const contact = await newContact("רון");
    // an allocation number only on a tax invoice or invoice-receipt, digits only
    expect((await pgError(recordWith(owner, docOf(contact, { doc_type: "receipt", allocation_number: "123" })))).code).toBe("23514");
    expect((await pgError(recordWith(owner, docOf(contact, { allocation_number: "12-34" })))).code).toBe("23514");
    await recordWith(owner, docOf(contact, { doc_type: "tax_invoice_receipt", allocation_number: "987654321" }));
    // net + vat = amount, both or neither, the rate only with them
    expect((await pgError(recordWith(owner, docOf(contact, { net_agorot: 10000, vat_agorot: 1600 })))).code).toBe("23514");
    expect((await pgError(recordWith(owner, docOf(contact, { net_agorot: 11700 })))).code).toBe("23514");
    expect((await pgError(recordWith(owner, docOf(contact, { vat_rate_bp: 1700 })))).code).toBe("23514");
    // a person never names a provider (no grant; the trigger answers too)
    expect(
      (
        await pgError(
          run(owner, (q) =>
            q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, provider, provider_document_id) values ($1, $2, 'receipt', 'PRV-1', 1, 'icount', 'x1')", [org, contact]),
          ),
        )
      ).code,
    ).toBe("42501");
    // the server does, once per provider id in a business
    await asAdmin((q) =>
      q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, provider, provider_document_id) values ($1, $2, 'receipt', 'PRV-2', 1, 'icount', 'x1')", [org, contact]),
    );
    expect(
      (
        await pgError(
          asAdmin((q) =>
            q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, provider, provider_document_id) values ($1, $2, 'receipt', 'PRV-3', 1, 'icount', 'x1')", [org, contact]),
          ),
        )
      ).code,
    ).toBe("23505");
    expect(
      (
        await pgError(
          asAdmin((q) =>
            q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot, provider, provider_document_id) values ($1, $2, 'receipt', 'PRV-4', 1, 'Bad Name', 'x2')", [org, contact]),
          ),
        )
      ).code,
    ).toBe("23514");
  });

  it("the source quote is an accepted quote of the same customer; the original of a credit invoice a tax invoice of the same customer", async () => {
    const contact = await newContact("שירה");
    const deal = await newDeal(contact);
    const otherContact = await newContact("אחר");
    const accepted = await acceptedQuote(deal, contact);
    const ok = await recordWith(manager, { deal_id: deal, contact_id: contact, doc_type: "tax_invoice", number: "Q-1", amount_agorot: 100, quote_id: accepted });
    expect((await row(ok)).quote_id).toBe(accepted);
    expect((await pgError(recordWith(manager, docOf(otherContact, { quote_id: accepted })))).hint).toBe("document:source");
    const draft = await asAdmin(
      async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'טיוטה', $2, $3) returning id", [org, deal, contact])).id,
    );
    expect((await pgError(recordWith(manager, docOf(contact, { quote_id: draft })))).hint).toBe("document:source");
    // the original
    const credit = await recordWith(manager, docOf(contact, { doc_type: "credit_invoice", original_document_id: ok }));
    expect((await row(credit)).original_document_id).toBe(ok);
    // the original is an ACTIVE tax invoice
    const cancelledInvoice = await recordWith(manager, docOf(contact));
    await run(manager, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelledInvoice]));
    expect((await pgError(recordWith(manager, docOf(contact, { doc_type: "credit_invoice", original_document_id: cancelledInvoice })))).hint).toBe("document:original");
    const receipt = await recordWith(manager, docOf(contact, { doc_type: "receipt" }));
    expect((await pgError(recordWith(manager, docOf(contact, { doc_type: "credit_invoice", original_document_id: receipt })))).hint).toBe("document:original");
    const foreignInvoice = await recordWith(manager, docOf(otherContact));
    expect((await pgError(recordWith(manager, docOf(contact, { doc_type: "credit_invoice", original_document_id: foreignInvoice })))).hint).toBe("document:original");
    // only a credit invoice has an original
    expect((await pgError(recordWith(manager, docOf(contact, { original_document_id: ok })))).code).toBe("23514");
  });

  it("a quote or document the recorder cannot read answers like one that does not exist", async () => {
    // own visibility: the member-with-key reads only their own records
    const keyHolder = await addMember(org, owner.id, "member", "d02-key");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"granular_permissions\": true}' where organization_id = $1", [org]));
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents}')", [org, keyHolder.id]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const mine = await newContact("שלי", org, keyHolder);
      const theirs = await newContact("של אחר");
      // a company both contacts share, so the same-customer rule would hold if the hidden rows were read
      const company = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name) values ($1, 'משותפת') returning id", [org])).id);
      await asAdmin((q) => q("update public.contacts set company_id = $2 where id = any($1::uuid[])", [[mine, theirs], company]));
      const hiddenQuote = await acceptedQuote(null, theirs);
      const hiddenInvoice = await recordWith(owner, docOf(theirs));
      expect((await pgError(recordWith(keyHolder, docOf(mine, { quote_id: hiddenQuote })))).hint).toBe("document:source");
      expect((await pgError(recordWith(keyHolder, docOf(mine, { doc_type: "credit_invoice", original_document_id: hiddenInvoice })))).hint).toBe("document:original");
      // the owner, who reads both, may link them
      expect(await recordWith(owner, docOf(mine, { quote_id: hiddenQuote }))).toBeTruthy();
      // a line on a document the recorder cannot read: the neutral answer
      expect(
        (await pgError(run(keyHolder, (q) => q("insert into public.accounting_document_lines (organization_id, document_id, description) values ($1, $2, 'x')", [org, hiddenInvoice])))).hint,
      ).toBe("document_line:frozen");
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("every new column is frozen after the insert, for every writer; the server fills the provider's fields once", async () => {
    const contact = await newContact("נועה");
    const id = await recordWith(owner, docOf(contact, { allocation_number: "111" }));
    for (const set of ["allocation_number = '222'", "net_agorot = 10000, vat_agorot = 1700", "quote_id = null"]) {
      // a person has no update grant on them
      expect((await pgError(run(owner, (q) => q(`update public.accounting_documents set ${set} where id = $1`, [id])))).code, set).toBe("42501");
    }
    expect((await pgError(asAdmin((q) => q("update public.accounting_documents set allocation_number = '222' where id = $1", [id])))).hint).toBe("document:frozen");
    expect((await pgError(asAdmin((q) => q("update public.accounting_documents set net_agorot = 10000, vat_agorot = 1700 where id = $1", [id])))).hint).toBe("document:frozen");
    await asAdmin((q) => q("update public.accounting_documents set provider = 'morning', provider_document_id = 'M-9' where id = $1", [id]));
    expect(await row(id)).toMatchObject({ provider: "morning", provider_document_id: "M-9" });
    expect((await pgError(asAdmin((q) => q("update public.accounting_documents set provider_document_id = 'M-10' where id = $1", [id])))).hint).toBe("document:frozen");
    // a server fills a missing allocation number once
    const plain = await recordWith(owner, docOf(contact));
    await asAdmin((q) => q("update public.accounting_documents set allocation_number = '555' where id = $1", [plain]));
    expect((await pgError(asAdmin((q) => q("update public.accounting_documents set allocation_number = '556' where id = $1", [plain])))).hint).toBe("document:frozen");
  });

  it("lines: only with their document, never on an opening balance, at most 200, never changed or removed", async () => {
    const contact = await newContact("עדי");
    const id = await recordWith(manager, docOf(contact), [{ description: "שורה", unit_price_agorot: 100 }]);
    // a later line, by the same person in another transaction, is refused
    expect(
      (await pgError(run(manager, (q) => q("insert into public.accounting_document_lines (organization_id, document_id, description) values ($1, $2, 'מאוחר')", [org, id])))).hint,
    ).toBe("document_line:frozen");
    // no update or delete grant
    expect((await pgError(run(owner, (q) => q("update public.accounting_document_lines set description = 'x' where document_id = $1", [id])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("delete from public.accounting_document_lines where document_id = $1", [id])))).code).toBe("42501");
    // and the server's own change is refused but for an erasure's neutral text
    expect((await pgError(asAdmin((q) => q("update public.accounting_document_lines set description = 'x' where document_id = $1", [id])))).hint).toBe("document_line:frozen");
    // a discount larger than the line
    expect((await pgError(recordWith(manager, docOf(contact), [{ description: "x", unit_price_agorot: 10, discount_agorot: 11 }]))).hint).toBe("document_line:total");
    // a line needs a text (or a product)
    expect((await pgError(recordWith(manager, docOf(contact), [{ unit_price_agorot: 10 }]))).hint).toBe("document_line:description");
    // 201 lines
    const many = Array.from({ length: 201 }, (_, i) => ({ description: `שורה ${i}` }));
    expect((await pgError(recordWith(manager, docOf(contact), many))).hint).toBe("document_lines:max");
    // the whole call is one transaction: nothing was recorded
    expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where organization_id = $1 and number = $2", [org, `N-${seq}`]))).toBe(0);
    // an opening balance has no lines (owners only record one; the trigger answers)
    const opening = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, null, 500, current_date) as id", [org, contact])).id);
    expect(
      (await pgError(run(owner, (q) => q("insert into public.accounting_document_lines (organization_id, document_id, description) values ($1, $2, 'x')", [org, opening])))).hint,
    ).toBe("document_line:opening");
  });

  it("rights: recorders only; lines are read with their document; nothing crosses businesses", async () => {
    const contact = await newContact("גל");
    for (const u of [member, viewer, outsider]) {
      expect((await pgError(recordWith(u, docOf(contact), [{ description: "x" }]))).code, u.email).toBe("42501");
    }
    const id = await recordWith(manager, docOf(contact), [{ description: "נראה" }]);
    // the owner reads the contact; the member (own visibility depends on settings) reads lines only with the document
    const docSeen = (u: U) => run(u, (q) => count(q, "select 1 from public.accounting_documents where id = $1", [id]));
    const linesSeen = (u: U) => run(u, (q) => count(q, "select 1 from public.accounting_document_lines where document_id = $1", [id]));
    for (const u of [owner, manager, member, viewer, outsider]) {
      expect(await linesSeen(u), u.email).toBe((await docSeen(u)) > 0 ? 1 : 0);
    }
    expect(await linesSeen(outsider)).toBe(0);
    // a line of another business's document: answered like an unknown id, and nothing is written
    const foreignContact = await newContact("זר", otherOrg, outsider);
    const foreign = await recordWith(outsider, docOf(foreignContact), [{ description: "זר" }], otherOrg);
    expect(
      (await pgError(run(owner, (q) => q("insert into public.accounting_document_lines (organization_id, document_id, description) values ($1, $2, 'x')", [org, foreign])))).code,
    ).toMatch(/23503|42501|P0001/);
    expect(
      (await pgError(run(owner, (q) => q("insert into public.accounting_document_lines (organization_id, document_id, description) values ($1, $2, 'x')", [otherOrg, foreign])))).code,
    ).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.accounting_document_lines where document_id = $1", [foreign]))).toBe(1);
    // a product of another business (only the server names a product): the composite FK refuses it
    const foreignProduct = await run(outsider, async (q) => (await one<{ id: string }>(q, "insert into public.products (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).id);
    expect(
      (
        await pgError(
          asAdmin(async (q) => {
            const d = (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'SRV-X', 1) returning id", [org, contact])).id;
            await q("insert into public.accounting_document_lines (organization_id, document_id, product_id, description) values ($1, $2, $3, 'x')", [org, d, foreignProduct]);
          }),
        )
      ).code,
    ).toBe("23503");
  });

  it("a privacy erasure empties the lines' text and erases their entries; numbers stay", async () => {
    const contact = await newContact("מחיקה");
    const id = await recordWith(owner, docOf(contact), [{ description: "עבודה אצל מחיקה", unit_price_agorot: 500 }]);
    await asAdmin((q) => q("delete from public.contacts where id = $1", [contact]));
    await asAdmin((q) => q("select app.audit_erase_core($1, 'contacts', $2, null)", [org, contact]));
    expect(await lines(id)).toEqual([{ position: 1, description: "הפריט נמחק (מחיקת פרטיות)", total_agorot: "500", product_id: null }]);
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.audit_log where entity_type = 'accounting_document_lines' and changes::text like '%עבודה אצל%'", []),
      ),
    ).toBe(0);
  });
});
