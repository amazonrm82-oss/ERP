import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Sale = { deal_id: string; contact_id: string; payment_id: string; document_id: string | null; total_agorot: number };

/**
 * GAP-08: a quick sale at the counter. public.quick_sale (security invoker) makes, in one transaction, the customer (picked or
 * new), a won deal on the default sales process with the product lines, one recorded payment of the lines' total with VAT, and
 * optionally a recorded external document of the same amount. Everything goes through the tables' own RLS and triggers.
 */
describe("quick sale (GAP-08)", () => {
  let owner: U, manager: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let product: string, otherProduct: string, archived: string, monthly: string;

  const setFeatures = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const ALL = { payments: true, documents: true, products: true, granular_permissions: true, price_lists: true, automations: true };

  const sale = (u: U, body: Record<string, unknown>, orgId = org) =>
    asUser(u.id, async (q) => (await q<{ s: Sale }>("select public.quick_sale($1, $2) as s", [orgId, JSON.stringify(body)])).rows[0].s);
  const body = (over: Record<string, unknown> = {}) => ({
    new_contact: { first_name: "רותי", last_name: "לוי", phone: "050-1234567" },
    lines: [{ product_id: product, quantity: 2, unit_price_agorot: 10000, price_source: "product" }],
    payment: { method: "cash" },
    // 2 x 100.00 before VAT + 18%
    expected_total_agorot: 23600,
    ...over,
  });
  const newProduct = async (orgId: string, ownerId: string, name: string, extra = "") =>
    asUser(ownerId, async (q) => {
      const { rows } = await q<{ id: string }>(
        `insert into public.products (organization_id, name, price_agorot${extra ? ", billing" : ""}) values ($1, $2, 10000${extra ? ", $3" : ""}) returning id`,
        extra ? [orgId, name, extra] : [orgId, name],
      );
      return rows[0].id;
    });

  beforeAll(async () => {
    owner = await createUser("qs-owner");
    org = await createOrg(owner.id, "סטודיו");
    manager = await addMember(org, owner.id, "manager", "qs-manager");
    member = await addMember(org, owner.id, "member", "qs-member");
    keyHolder = await addMember(org, owner.id, "member", "qs-key");
    viewer = await addMember(org, owner.id, "viewer", "qs-viewer");
    outsider = await createUser("qs-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setFeatures(org, ALL);
    await setFeatures(otherOrg, ALL);
    await asUser(owner.id, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    await asUser(outsider.id, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [otherOrg]));
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, keyHolder.id]));
    product = await newProduct(org, owner.id, "שיעור יוגה");
    archived = await newProduct(org, owner.id, "מוצר ישן");
    await asUser(owner.id, (q) => q("update public.products set is_active = false where id = $1", [archived]));
    monthly = await newProduct(org, owner.id, "מנוי", "monthly");
    otherProduct = await newProduct(otherOrg, outsider.id, "מוצר של עסק אחר");
  });

  it("makes the contact, a won deal with its lines, the payment and the document in one call", async () => {
    const result = await sale(owner, body({ document: { doc_type: "tax_invoice_receipt", number: "QS-1" }, payment: { method: "credit", installments: 3 } }));
    expect(result.total_agorot).toBe(23600);
    await asAdmin(async (q) => {
      const contact = (await q("select first_name, last_name, phone, owner_id from public.contacts where id = $1", [result.contact_id])).rows[0];
      expect(contact).toMatchObject({ first_name: "רותי", last_name: "לוי", phone: "050-1234567", owner_id: owner.id });
      const deal = (
        await q<{ name: string; status: string; contact_id: string; amount_agorot: string; closed_at: string | null; owner_id: string; is_default: boolean }>(
          `select d.name, d.status, d.contact_id, d.amount_agorot, d.closed_at, d.owner_id, p.is_default
             from public.deals d join public.pipelines p on p.id = d.pipeline_id where d.id = $1`,
          [result.deal_id],
        )
      ).rows[0];
      // no name sent: "מכירה מהירה, <day>"; never the customer's name
      expect(deal.name).toMatch(/^מכירה מהירה, \d{2}\.\d{2}\.\d{4}$/);
      expect(deal).toMatchObject({ status: "won", contact_id: result.contact_id, owner_id: owner.id, is_default: true });
      expect(deal.closed_at).not.toBeNull();
      // DLI-03: the deal's value follows its lines, before VAT
      expect(Number(deal.amount_agorot)).toBe(20000);
      const lines = (await q("select product_id, description, quantity, total_agorot from public.deal_lines where deal_id = $1", [result.deal_id])).rows;
      expect(lines).toEqual([{ product_id: product, description: "שיעור יוגה", quantity: "2", total_agorot: "20000" }]);
      const payment = (
        await q("select deal_id, contact_id, amount_agorot, method, installments, status, created_by from public.payments where id = $1", [result.payment_id])
      ).rows[0];
      expect(payment).toMatchObject({ deal_id: result.deal_id, contact_id: result.contact_id, amount_agorot: "23600", method: "credit", installments: 3, status: "recorded", created_by: owner.id });
      const doc = (await q("select deal_id, contact_id, doc_type, number, amount_agorot, status from public.accounting_documents where id = $1", [result.document_id])).rows[0];
      expect(doc).toMatchObject({ deal_id: result.deal_id, contact_id: result.contact_id, doc_type: "tax_invoice_receipt", number: "QS-1", amount_agorot: "23600", status: "active" });
      // PAY-02 takes only a tax invoice or a proforma: no allocation
      expect(await count(q, "select 1 from public.payment_allocations where payment_id = $1", [result.payment_id])).toBe(0);
    });
  });

  it("takes the screen's deal name; a cheque is in hand or cleared only, and a cleared one is confirmed", async () => {
    const named = await sale(owner, body({ deal_name: "עסקה ממכירה מהירה, 26.10.2026" }));
    expect(await asAdmin(async (q) => (await q("select name from public.deals where id = $1", [named.deal_id])).rows[0].name)).toBe("עסקה ממכירה מהירה, 26.10.2026");
    const cheque = (status: string) => ({
      method: "cheque",
      cheques: [{ cheque_number: "2002", cheque_bank: "12", cheque_branch: "601", cheque_due_date: "2026-12-01", cheque_status: status, amount_agorot: 23600 }],
    });
    expect((await pgError(sale(owner, body({ payment: cheque("deposited") })))).hint).toBe("quick_sale:invalid");
    const cleared = await sale(owner, body({ payment: cheque("cleared") }));
    expect(await asAdmin(async (q) => (await q("select status from public.payments where id = $1", [cleared.payment_id])).rows[0].status)).toBe("confirmed");
  });

  it("sells to an existing contact, with a cheque, and without a document", async () => {
    const contact = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'משה') returning id", [org])).rows[0].id);
    const result = await sale(
      manager,
      body({
        new_contact: undefined,
        contact_id: contact,
        payment: {
          method: "cheque",
          cheques: [{ cheque_number: "1001", cheque_bank: "12", cheque_branch: "601", cheque_due_date: "2026-12-01", cheque_status: "in_hand", amount_agorot: 23600 }],
        },
      }),
    );
    expect(result.contact_id).toBe(contact);
    expect(result.document_id).toBeNull();
    const pay = await asAdmin(async (q) => (await q("select method, cheque_number, cheque_status, status from public.payments where id = $1", [result.payment_id])).rows[0]);
    expect(pay).toMatchObject({ method: "cheque", cheque_number: "1001", cheque_status: "in_hand", status: "recorded" });
  });

  it("is all or nothing: a refused document leaves no contact, deal, line or payment", async () => {
    await sale(owner, body({ new_contact: { first_name: "ראשון" }, document: { doc_type: "receipt", number: "DUP-1" } }));
    const before = await asAdmin(async (q) => ({
      contacts: await count(q, "select 1 from public.contacts where organization_id = $1", [org]),
      deals: await count(q, "select 1 from public.deals where organization_id = $1", [org]),
      payments: await count(q, "select 1 from public.payments where organization_id = $1", [org]),
      lines: await count(q, "select 1 from public.deal_lines where organization_id = $1", [org]),
    }));
    const error = await pgError(sale(owner, body({ new_contact: { first_name: "שני" }, document: { doc_type: "receipt", number: "DUP-1" } })));
    expect(error.hint).toBe("document:duplicate");
    const after = await asAdmin(async (q) => ({
      contacts: await count(q, "select 1 from public.contacts where organization_id = $1", [org]),
      deals: await count(q, "select 1 from public.deals where organization_id = $1", [org]),
      payments: await count(q, "select 1 from public.payments where organization_id = $1", [org]),
      lines: await count(q, "select 1 from public.deal_lines where organization_id = $1", [org]),
    }));
    expect(after).toEqual(before);
  });

  it("refuses a total the screen did not show", async () => {
    expect((await pgError(sale(owner, body({ expected_total_agorot: 20000 })))).hint).toBe("quick_sale:total_changed");
  });

  it("refuses a product that is not offerable, a recurring one, and another business's", async () => {
    const line = (id: string) => [{ product_id: id, quantity: 1, unit_price_agorot: 10000, price_source: "product" }];
    expect((await pgError(sale(owner, body({ lines: line(archived), expected_total_agorot: 11800 })))).hint).toBe("quick_sale:product");
    expect((await pgError(sale(owner, body({ lines: line(monthly), expected_total_agorot: 11800 })))).hint).toBe("quick_sale:recurring");
    // the function looks products up in the business it was called for only: another business's product is not found
    expect((await pgError(sale(owner, body({ lines: line(otherProduct), expected_total_agorot: 11800 })))).hint).toBe("quick_sale:product");
  });

  it("refuses a contact of another business or in the bin", async () => {
    const theirs = await asUser(outsider.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id);
    expect((await pgError(sale(owner, body({ new_contact: undefined, contact_id: theirs })))).hint).toBe("quick_sale:contact");
  });

  it("rights: a member without the key, a viewer and an outsider are refused; the key's holder sells", async () => {
    for (const u of [member, viewer, outsider]) expect((await pgError(sale(u, body())))?.code, u.email).toBe("42501");
    const result = await sale(keyHolder, body());
    expect(result.total_agorot).toBe(23600);
    // a document needs the right to record documents too
    expect((await pgError(sale(keyHolder, body({ document: { doc_type: "receipt", number: "K-1" } })))).code).toBe("42501");
    // an outsider calling with their own business id cannot reach this business's product
    expect((await pgError(sale(outsider, body(), otherOrg))).hint).toBe("quick_sale:product");
  });

  it("flags: payments, products and (with a document) documents", async () => {
    try {
      await setFeatures(org, { ...ALL, payments: false });
      expect((await pgError(sale(owner, body()))).hint).toBe("feature:payments");
      await setFeatures(org, { ...ALL, products: false });
      expect((await pgError(sale(owner, body()))).hint).toBe("feature:products");
      await setFeatures(org, { ...ALL, documents: false });
      expect((await pgError(sale(owner, body({ document: { doc_type: "receipt", number: "F-1" } })))).hint).toBe("feature:documents");
      // without a document the sale still goes through
      expect((await sale(owner, body())).document_id).toBeNull();
    } finally {
      await setFeatures(org, ALL);
    }
  });

  it("asks for the VAT status first", async () => {
    const owner2 = await createUser("qs-owner2");
    const org2 = await createOrg(owner2.id, "בלי מעמד מע\"מ");
    await setFeatures(org2, ALL);
    const p = await newProduct(org2, owner2.id, "פריט");
    const error = await pgError(sale(owner2, body({ lines: [{ product_id: p, quantity: 1, unit_price_agorot: 10000, price_source: "product" }], expected_total_agorot: 10000 }), org2));
    expect(error.hint).toBe("quick_sale:vat_unknown");
  });

  it("refuses a bad shape", async () => {
    expect((await pgError(sale(owner, body({ lines: [] })))).hint).toBe("quick_sale:invalid");
    expect((await pgError(sale(owner, body({ contact_id: product })))).hint).toBe("quick_sale:invalid");
    expect((await pgError(sale(owner, body({ document: { doc_type: "tax_invoice", number: "X" } })))).hint).toBe("quick_sale:invalid");
  });

  it("re-derives each price (PL-03): a made-up price or a wrong list is refused, the customer's list is taken", async () => {
    expect((await pgError(sale(owner, body({ lines: [{ product_id: product, quantity: 2, unit_price_agorot: 9000, price_source: "product" }], expected_total_agorot: 21240 })))).hint).toBe(
      "quick_sale:price",
    );
    const { contact, list, otherList } = await asUser(owner.id, async (q) => {
      const list = (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'מנויים') returning id", [org])).rows[0].id;
      const otherList = (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'אחר') returning id", [org])).rows[0].id;
      await q("insert into public.price_list_lines (organization_id, price_list_id, product_id, price_agorot) values ($1, $2, $3, 8000)", [org, list, product]);
      await q("insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, discount_bp) values ($1, $2, $3, 5, 5000)", [org, list, product]);
      await q("insert into public.price_list_lines (organization_id, price_list_id, product_id, price_agorot) values ($1, $2, $3, 7000)", [org, otherList, product]);
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, price_list_id) values ($1, 'מנוי', $2) returning id", [org, list])).rows[0].id;
      return { contact, list, otherList };
    });
    const at = (price: number, source: string, listId: string | null, quantity = 1) => ({
      new_contact: undefined,
      contact_id: contact,
      lines: [{ product_id: product, quantity, unit_price_agorot: price, price_source: source, price_list_id: listId }],
      expected_total_agorot: Math.round(price * quantity * 1.18),
    });
    // the product's own price while the customer has a list
    expect((await pgError(sale(owner, body(at(10000, "product", null))))).hint).toBe("quick_sale:price");
    // another list
    expect((await pgError(sale(owner, body(at(7000, "price_list", otherList))))).hint).toBe("quick_sale:price");
    const ok = await sale(owner, body(at(8000, "price_list", list)));
    expect(ok.total_agorot).toBe(9440);
    // the quantity tier: half off the product's price from 5
    expect((await sale(owner, body(at(5000, "price_list", list, 5)))).total_agorot).toBe(29500);
    const line = await asAdmin(async (q) => (await q("select unit_price_agorot, price_source, price_list_id, price_list_name from public.deal_lines where deal_id = $1", [ok.deal_id])).rows[0]);
    expect(line).toEqual({ unit_price_agorot: "8000", price_source: "price_list", price_list_id: list, price_list_name: "מנויים" });
  });

  it("the stage move is an ordinary one: deal_won automations run", async () => {
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'תודה', 'deal', 'deal_won', $2) returning id",
          [org, JSON.stringify([{ type: "create_task", title: "להודות ל{{name}}" }])],
        )
      ).rows[0].id,
    );
    try {
      const result = await sale(owner, body({ deal_name: "מכירה לאוטומציה" }));
      await asAdmin((q) => q("select app.process_outbox()"));
      expect(await asAdmin((q) => count(q, "select 1 from public.tasks where deal_id = $1 and title = 'להודות למכירה לאוטומציה'", [result.deal_id]))).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.automations set is_active = false where id = $1", [rule]));
    }
  });

  it("refuses a contact in the recycle bin, and a read-only business", async () => {
    const binned = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'בסל') returning id", [org])).rows[0].id);
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(sale(owner, body({ new_contact: undefined, contact_id: binned })))).hint).toBe("quick_sale:contact");
    try {
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      expect((await pgError(sale(owner, body()))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a business with prices including VAT, a business that charges no VAT, and an exempt product", async () => {
    const make = async (label: string, settings: string) => {
      const o = await createUser(`qs-${label}`);
      const orgId = await createOrg(o.id, label);
      await setFeatures(orgId, ALL);
      await asUser(o.id, (q) => q(`insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, ${settings})`, [orgId]));
      return { o, orgId };
    };
    // prices include VAT: a product typed at 100.00 before VAT costs 118.00 on the line, and that is what is paid
    const gross = await make("gross", "'licensed', true");
    const p1 = await newProduct(gross.orgId, gross.o.id, "פריט");
    const g = await sale(gross.o, body({ lines: [{ product_id: p1, quantity: 1, unit_price_agorot: 11800, price_source: "product" }], expected_total_agorot: 11800 }), gross.orgId);
    await asAdmin(async (q) => {
      expect((await q("select unit_price_agorot, price_includes_vat from public.deal_lines where deal_id = $1", [g.deal_id])).rows[0]).toEqual({ unit_price_agorot: "11800", price_includes_vat: true });
      expect((await q("select amount_agorot from public.deals where id = $1", [g.deal_id])).rows[0].amount_agorot).toBe("10000");
    });
    // no VAT: the net is paid
    const exempt = await make("exempt", "'exempt', false");
    const p2 = await newProduct(exempt.orgId, exempt.o.id, "פריט");
    expect((await sale(exempt.o, body({ lines: [{ product_id: p2, quantity: 3, unit_price_agorot: 10000, price_source: "product" }], expected_total_agorot: 30000 }), exempt.orgId)).total_agorot).toBe(30000);
    // an exempt product next to a taxable one: VAT on the taxable line only
    const book = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot, vat_kind) values ($1, 'ספר', 5000, 'exempt') returning id", [org])).rows[0].id);
    const mixed = await sale(
      owner,
      body({
        lines: [
          { product_id: product, quantity: 1, unit_price_agorot: 10000, price_source: "product" },
          { product_id: book, quantity: 1, unit_price_agorot: 5000, price_source: "product" },
        ],
        expected_total_agorot: 16800,
      }),
    );
    expect(await asAdmin(async (q) => (await q("select vat_exempt from public.deal_lines where deal_id = $1 and product_id = $2", [mixed.deal_id, book])).rows[0].vat_exempt)).toBe(true);
  });

  it("payment status: cash is confirmed, other methods recorded", async () => {
    const statusOf = async (id: string) => asAdmin(async (q) => (await q("select status from public.payments where id = $1", [id])).rows[0].status);
    expect(await statusOf((await sale(owner, body({ payment: { method: "cash" } }))).payment_id)).toBe("confirmed");
    expect(await statusOf((await sale(owner, body({ payment: { method: "transfer" } }))).payment_id)).toBe("recorded");
    expect(await statusOf((await sale(owner, body({ payment: { method: "bit_paybox" } }))).payment_id)).toBe("recorded");
  });

  it("a series of cheques: each its own payment, adding up exactly to the total; at most 36", async () => {
    const row = (n: number, amount: number, status = "in_hand") => ({
      cheque_number: String(3000 + n),
      cheque_bank: "12",
      cheque_branch: "601",
      cheque_due_date: `2026-${String(11 + (n % 2)).padStart(2, "0")}-01`,
      cheque_status: status,
      amount_agorot: amount,
    });
    const three = [row(1, 7868), row(2, 7866), row(3, 7866, "cleared")];
    const result = await sale(owner, body({ payment: { method: "cheque", reference: "סדרה", cheques: three } }));
    expect((result as unknown as { payment_ids: string[] }).payment_ids).toHaveLength(3);
    const pays = await asAdmin(
      async (q) =>
        (await q("select amount_agorot, cheque_number, status, reference from public.payments where deal_id = $1 order by cheque_number", [result.deal_id])).rows,
    );
    expect(pays).toEqual([
      { amount_agorot: "7868", cheque_number: "3001", status: "recorded", reference: "סדרה" },
      { amount_agorot: "7866", cheque_number: "3002", status: "recorded", reference: "סדרה" },
      { amount_agorot: "7866", cheque_number: "3003", status: "confirmed", reference: "סדרה" },
    ]);
    // one agora short
    expect((await pgError(sale(owner, body({ payment: { method: "cheque", cheques: [row(1, 7868), row(2, 7866), row(3, 7865)] } })))).hint).toBe("quick_sale:cheques_total");
    // 37 cheques, an empty list, a cheque of 0
    expect((await pgError(sale(owner, body({ payment: { method: "cheque", cheques: Array.from({ length: 37 }, (_, i) => row(i, 1)) } })))).hint).toBe("quick_sale:invalid");
    expect((await pgError(sale(owner, body({ payment: { method: "cheque", cheques: [] } })))).hint).toBe("quick_sale:invalid");
    expect((await pgError(sale(owner, body({ payment: { method: "cheque", cheques: [row(1, 0), row(2, 23600)] } })))).hint).toBe("quick_sale:invalid");
  });

  it("the sales process is the business's setting; a deleted one falls back to the default; another business's is refused", async () => {
    const { pipeline, won } = await asUser(owner.id, async (q) => {
      const pipeline = (await q<{ id: string }>("insert into public.pipelines (organization_id, name, position) values ($1, 'דלפק', 9) returning id", [org])).rows[0].id;
      await q("insert into public.stages (organization_id, pipeline_id, name, kind, position) values ($1, $2, 'חדשה', 'open', 1)", [org, pipeline]);
      const won = (await q<{ id: string }>("insert into public.stages (organization_id, pipeline_id, name, kind, position) values ($1, $2, 'שולם', 'won', 2) returning id", [org, pipeline]))
        .rows[0].id;
      await q("update public.org_document_settings set quick_sale_pipeline_id = $2 where organization_id = $1", [org, pipeline]);
      return { pipeline, won };
    });
    const where = async (deal: string) => asAdmin(async (q) => (await q("select d.pipeline_id, d.stage_id, p.is_default from public.deals d join public.pipelines p on p.id = d.pipeline_id where d.id = $1", [deal])).rows[0]);
    expect(await where((await sale(owner, body())).deal_id)).toMatchObject({ pipeline_id: pipeline, stage_id: won });
    await asUser(owner.id, (q) => q("update public.pipelines set deleted_at = now() where id = $1", [pipeline]));
    expect(await where((await sale(owner, body())).deal_id)).toMatchObject({ is_default: true });
    // a pipeline of another business cannot be set (composite foreign key)
    const theirs = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 limit 1", [otherOrg])).rows[0].id);
    expect((await pgError(asUser(owner.id, (q) => q("update public.org_document_settings set quick_sale_pipeline_id = $2 where organization_id = $1", [org, theirs])))).code).toBe("23503");
    // a member may not change the setting
    expect((await asUser(member.id, (q) => q("update public.org_document_settings set quick_sale_pipeline_id = null where organization_id = $1", [org]))).rowCount).toBe(0);
    await asUser(owner.id, (q) => q("update public.org_document_settings set quick_sale_pipeline_id = null where organization_id = $1", [org]));
  });

  it("its copy of the PL-03 arithmetic equals app.price_list_discounted and app.product_line_price", async () => {
    const odd = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot, price_includes_vat) values ($1, 'מוזר', 9999, true) returning id", [org])).rows[0].id);
    const { contact, list } = await asUser(owner.id, async (q) => {
      const list = (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'הנחה מוזרה') returning id", [org])).rows[0].id;
      await q("insert into public.price_list_lines (organization_id, price_list_id, product_id, discount_bp) values ($1, $2, $3, 3333)", [org, list, odd]);
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, price_list_id) values ($1, 'מוזרה', $2) returning id", [org, list])).rows[0].id;
      return { contact, list };
    });
    const { price, total } = await asAdmin(async (q) => {
      const price = Number((await q<{ p: string }>("select app.product_line_price(app.price_list_discounted(9999, 3333), true, 'taxable', false, 1800) as p")).rows[0].p);
      const total = Number(
        (await q<{ t: string }>("select app.document_totals(jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price_agorot', $1::bigint)), 1800, false) ->> 'total_agorot' as t", [price])).rows[0].t,
      );
      return { price, total };
    });
    const at = (p: number) => body({ new_contact: undefined, contact_id: contact, lines: [{ product_id: odd, quantity: 1, unit_price_agorot: p, price_source: "price_list", price_list_id: list }], expected_total_agorot: total });
    expect((await pgError(sale(owner, at(price + 1)))).hint).toBe("quick_sale:price");
    expect((await sale(owner, at(price))).total_agorot).toBe(total);
  });
});
