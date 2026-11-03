import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type U = { id: string; email: string };

/**
 * PKG-01 (owner's answer (66) ג, 3 November 2026; defaults of spec 22.9): a product of kind 'punch_card' with entries,
 * validity and the meeting types it covers; a customer's card opens with a payment of the contact or by an owner/admin by
 * hand; owners and admins cancel (with a reason) and transfer it. Its entries (PKG-02) are tested in 294-punch-card-uses.
 */
describe("punch cards (PKG-01)", () => {
  let owner: U, admin: U, manager: U, member: U, seller: U, stranger: U;
  let org: string;
  let typeA: string;
  let product: string;
  const FEATURES = { products: true, payments: true, punch_cards: true, orders: true, quotes: true, documents: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const contact = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const pay = (contactId: string, amount = 1000000) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, current_date, 'cash') returning id", [
          org,
          contactId,
          amount,
        ])
      ).id,
    );
  const punchProduct = (u: U, settings: { entries?: number | null; count?: number | null; unit?: string | null; types?: string[] | null } = {}) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
           values ($1, 'כרטיסייה 10 טיפולים', 'punch_card', 50000, $2, $3, $4, $5) returning id`,
          [org, settings.entries === undefined ? 10 : settings.entries, settings.count ?? null, settings.unit ?? null, settings.types === undefined ? [typeA] : settings.types],
        )
      ).id,
    );
  const open = (u: U, contactId: string, opts: { product?: string; payment?: string | null; activate?: boolean } = {}) =>
    run(u, async (q) =>
      (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, $4, $5) as id", [org, contactId, opts.product ?? product, opts.payment ?? null, opts.activate ?? false])).id,
    );
  const card = (id: string) =>
    asAdmin(async (q) =>
      one<{ status: string; expires_on: string | null; contact_id: string; manual: boolean; payment_id: string | null; total: number }>(
        q,
        `select c.status, c.expires_on::text, c.contact_id, c.activated_manually as manual, c.payment_id, c.entries_total as total
           from public.punch_cards c where c.id = $1`,
        [id],
      ),
    );
  beforeAll(async () => {
    owner = await createUser("pc-owner");
    org = await createOrg(owner.id, "סטודיו הכרטיסיות");
    admin = await addMember(org, owner.id, "admin", "pc-admin");
    manager = await addMember(org, owner.id, "manager", "pc-manager");
    member = await addMember(org, owner.id, "member", "pc-member");
    seller = await addMember(org, owner.id, "member", "pc-seller");
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, seller.id]));
    stranger = await createUser("pc-stranger");
    await createOrg(stranger.id, "עסק זר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    await asAdmin((q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    const types = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 order by position, created_at, id", [org])).rows.map((r) => r.id),
    );
    [typeA] = types;
    product = await punchProduct(owner, { entries: 3, count: 3, unit: "months" });
  });

  it("a punch card product: settings only on its kind, meeting types of the business, the plan key", async () => {
    // another kind keeps the settings empty: turning a punch card into a service empties them
    const p = await punchProduct(owner, { entries: 5 });
    await run(owner, (q) => q("update public.products set kind = 'service' where id = $1", [p]));
    expect(await asAdmin(async (q) => one(q, "select punch_entries, punch_meeting_type_ids from public.products where id = $1", [p]))).toEqual({
      punch_entries: null,
      punch_meeting_type_ids: null,
    });
    // a meeting type of another business, or the same type twice, is refused
    const foreign = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meeting_types where organization_id <> $1 limit 1", [org])).id);
    expect(await pgError(punchProduct(owner, { types: [foreign] }))).toMatchObject({ hint: "punch_card:meeting_types" });
    expect(await pgError(punchProduct(owner, { types: [typeA, typeA] }))).toMatchObject({ hint: "punch_card:meeting_types" });
    // validity: both parts or neither
    expect((await pgError(punchProduct(owner, { count: 3, unit: null }))).code).toBe("23514");
    // a settings column on another kind is refused by the shape... and emptied by the trigger first
    const s = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, kind, punch_entries) values ($1, 'שירות', 'service', 4) returning id", [org])).id,
    );
    expect(await asAdmin(async (q) => (await one<{ e: number | null }>(q, "select punch_entries as e from public.products where id = $1", [s])).e)).toBeNull();
    // the plan key: a person makes or changes a punch card product only with it
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
    try {
      expect(await pgError(punchProduct(owner))).toMatchObject({ hint: "feature:punch_cards" });
      expect(await pgError(run(owner, (q) => q("update public.products set punch_entries = 9 where id = $1", [product])))).toMatchObject({ hint: "feature:punch_cards" });
      // another field of the product still saves
      await run(owner, (q) => q("update public.products set price_agorot = 51000 where id = $1", [product]));
      // a member without the catalog right gets RLS's plain refusal, never the plan's hint
      expect((await pgError(punchProduct(member))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
    // the plans: personal off, basic and up on, a plan without the key off
    const flags = await asAdmin(async (q) => (await q<{ key: string; f: boolean | null }>("select key, (features ->> 'punch_cards')::boolean as f from public.plans")).rows);
    expect(Object.fromEntries(flags.map((r) => [r.key, r.f]))).toMatchObject({ personal: false, basic: true, pro: true, business: true, free: false });
  });

  it("opens with a payment of the contact, waits without one, and an owner/admin activates by hand", async () => {
    const c = await contact("נועה");
    const p = await pay(c);
    const withPayment = await open(seller, c, { payment: p });
    const a = await card(withPayment);
    expect(a).toMatchObject({ status: "active", manual: false, payment_id: p, total: 3 });
    const today = await asAdmin(async (q) => (await one<{ d: string }>(q, "select ((now() at time zone 'Asia/Jerusalem')::date + interval '3 months')::date::text as d")).d);
    expect(a.expires_on).toBe(today);
    // a payment of another contact is refused
    const other = await contact("אחר");
    expect(await pgError(open(seller, other, { payment: p }))).toMatchObject({ hint: "punch_card:payment" });
    // without a payment it waits; only an owner/admin activates by hand
    const waiting = await open(seller, c);
    expect((await card(waiting)).status).toBe("pending");
    expect(await pgError(run(seller, (q) => q("select public.punch_card_activate($1, $2, null)", [org, waiting])))).toMatchObject({ hint: "punch_card:activate_admin" });
    expect(await pgError(open(seller, c, { activate: true }))).toMatchObject({ hint: "punch_card:activate_admin" });
    await run(seller, (q) => q("select public.punch_card_activate($1, $2, $3)", [org, waiting, p]));
    expect((await card(waiting)).status).toBe("active");
    expect(await pgError(run(admin, (q) => q("select public.punch_card_activate($1, $2, null)", [org, waiting])))).toMatchObject({ hint: "punch_card:not_pending" });
    const manual = await open(admin, c, { activate: true });
    expect(await card(manual)).toMatchObject({ status: "active", manual: true, payment_id: null });
    // a member who does not record payments, a stranger: plain refusals
    expect((await pgError(open(member, c))).code).toBe("42501");
    expect((await pgError(open(stranger, c))).code).toBe("42501");
    // no client writes to the table at all
    expect((await pgError(run(owner, (q) => q("update public.punch_cards set entries_total = 99 where id = $1", [manual])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("delete from public.punch_cards where id = $1", [manual])))).code).toBe("42501");
    // an inactive product is not offered
    const archived = await punchProduct(owner);
    await run(owner, (q) => q("update public.products set is_active = false where id = $1", [archived]));
    expect(await pgError(open(seller, c, { product: archived, payment: p }))).toMatchObject({ hint: "punch_card:product" });
    // the plan key
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
    try {
      expect(await pgError(open(seller, c, { payment: p }))).toMatchObject({ hint: "feature:punch_cards" });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
    // a product a card uses can only be archived, and stays a punch card while a card lives
    expect((await pgError(run(owner, (q) => q("delete from public.products where id = $1", [product])))).code).toBe("23503");
    expect(await pgError(run(owner, (q) => q("update public.products set kind = 'service' where id = $1", [product])))).toMatchObject({ hint: "punch_card:kind_in_use" });
  });

  it("a payment opens at most what it paid for; a payment that stops counting marks its cards (review finding 1)", async () => {
    const c = await contact("גל");
    // owner (93) ב: the card's price is the product's price with VAT at today's rate
    const price = await asAdmin(async (q) => Number((await one<{ p: string }>(q, "select app.punch_product_price($1, $2) as p", [org, product])).p));
    const p = await pay(c, price + 1000);
    const first = await open(seller, c, { payment: p });
    expect(await asAdmin(async (q) => Number((await one<{ p: string }>(q, "select price_agorot as p from public.punch_cards where id = $1", [first])).p))).toBe(price);
    expect(await pgError(open(seller, c, { payment: p }))).toMatchObject({ hint: "punch_card:payment_used" });
    const waiting = await open(seller, c);
    expect(await pgError(run(seller, (q) => q("select public.punch_card_activate($1, $2, $3)", [org, waiting, p])))).toMatchObject({ hint: "punch_card:payment_used" });
    // a cancelled card frees its share
    await run(admin, (q) => q("select public.punch_card_cancel($1, $2, 'נפתחה בטעות')", [org, first]));
    await run(seller, (q) => q("select public.punch_card_activate($1, $2, $3)", [org, waiting, p]));
    // the payment fails: the card stays active, marked; it counts again: the mark goes
    const voidAt = () => asAdmin(async (q) => (await one<{ v: string | null; s: string }>(q, "select payment_void_at as v, status as s from public.punch_cards where id = $1", [waiting])));
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [p]));
    expect(await voidAt()).toMatchObject({ s: "active" });
    expect((await voidAt()).v).not.toBeNull();
    await run(owner, (q) => q("update public.payments set status = 'recorded' where id = $1", [p]));
    expect((await voidAt()).v).toBeNull();
  });

  // second review, finding 1: the first automatic opening of this file goes through a quote, so the quote branch runs in a
  // session that never ran the order branch (a record field read in the wrong branch raised 42703 and was swallowed).
  // Owner (95) ב: an advance on a quote opens nothing until the quote is accepted; the customer's acceptance on the public
  // page (quote_public_decide) opens it; one timeline entry per payment (94) ב.
  it("a quote's advance opens its card when the customer accepts the quote on its page, in a session that never ran an order", async () => {
    const c = await contact("ציפי");
    const cardsOf = () =>
      asAdmin(async (q) => (await q<{ quote_line_id: string | null }>("select quote_line_id from public.punch_cards where contact_id = $1", [c])).rows);
    const q1 = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id);
    await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 30000, 1)", [org, q1, product]));
    const qnum = await run(owner, async (q) => (await one<{ r: { number: string } }>(q, "select public.quote_send($1, $2) as r", [org, q1])).r.number);
    await run(owner, (q) =>
      q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, 40000, current_date, 'cash', true, $3)", [org, c, q1]),
    );
    expect((await cardsOf()).length).toBe(0);
    const token = await run(owner, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, q1])).t);
    const fingerprint = await asService(async (q) => (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v.fingerprint);
    const answer = await asService(async (q) =>
      (
        await one<{ a: { status: string } }>(
          q,
          `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'ציפי', p_id_number => null,
                    p_signature_kind => 'drawn', p_signature_image => $3, p_wording_version => 'draft-2026-10-18', p_agreed => true, p_decline_reason => null,
                    p_ip => '2001:db8::1', p_user_agent => 'Mozilla/5.0') as a`,
          [token, fingerprint, PNG],
        )
      ).a,
    );
    expect(answer.status).not.toBe("closed");
    expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [q1])).s)).toBe("accepted");
    expect((await cardsOf()).length).toBe(1);
    expect(
      await asAdmin(async (q) => (await q<{ body: string }>("select body from public.activities where contact_id = $1 and metadata ->> 'kind' = 'punch_card_opened'", [c])).rows.map((r) => r.body)),
    ).toEqual([`נפתחה כרטיסייה אוטומטית מתשלום על הצעה ${qnum}`]);
    // finding 3: the order made from the accepted quote never opens that card again, whoever pays on it
    const orderId = await run(owner, async (q) => (await one<{ r: string }>(q, "select public.order_from_quote($1, $2) as r", [org, q1])).r);
    await run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 90000, current_date, 'cash')", [org, c, orderId]));
    expect((await cardsOf()).length).toBe(1);
  });

  it("an allocation opens only what reached the order: 10,000 of a 200,000 payment opens no 90,000 card (second review, finding 2)", async () => {
    const c = await contact("פרובה");
    const order = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 90000, 1)", [org, order, product]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order]));
    const invoice = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, order_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', 'PROBE-1', 105300) returning id", [org, c, order])).id,
    );
    const big = await pay(c, 200000);
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 10000)", [org, big, invoice]));
    expect(await asAdmin((q) => count(q, "select 1 from public.punch_cards where contact_id = $1", [c]))).toBe(0);
    // a direct link counts the payment less what it allocated elsewhere: 150,000 allocated to another document leaves 50,000
    const other = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', 'PROBE-2', 150000) returning id", [org, c])).id,
    );
    const linked = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 200000, current_date, 'cash') returning id", [org, c])).id,
    );
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 150000)", [org, linked, other]));
    expect(await asAdmin(async (q) => Number((await one<{ r: string }>(q, "select app.punch_cards_room($1, $2, $3, null, 'link') as r", [org, linked, order])).r))).toBe(50000);
    expect(await asAdmin(async (q) => Number((await one<{ r: string }>(q, "select app.punch_cards_room($1, $2, $3, null, 'allocation') as r", [org, big, order])).r))).toBe(10000);
  });

  it("two payments on one order at the same time each open their unit (second review, finding 4)", async () => {
    const c = await contact("מקביל");
    const order = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 40000, 2)", [org, order, product]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order]));
    const payOrder = () =>
      run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 50000, current_date, 'cash')", [org, c, order]));
    await Promise.all([payOrder(), payOrder()]);
    expect(await asAdmin(async (q) => (await q<{ unit_no: number }>("select unit_no from public.punch_cards where contact_id = $1 order by unit_no", [c])).rows.map((r) => r.unit_no))).toEqual([1, 2]);
  });

  it("payments on two different orders never wait for each other (owner (99) ב)", async () => {
    const mkOrder = async (name: string) => {
      const c = await contact(name);
      const order = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
      await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 10000, 1)", [org, order, product]));
      await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order]));
      return { c, order };
    };
    const a = await mkOrder("הזמנה א");
    const b = await mkOrder("הזמנה ב");
    const payOn = (q: Query, x: { c: string; order: string }) =>
      q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 50000, current_date, 'cash')", [org, x.c, x.order]);
    // A's transaction stays open (holding its payment and its order's key) while B pays on another order: B must not wait
    await run(owner, async (q) => {
      await payOn(q, a);
      await run(owner, async (q2) => {
        await q2("set local lock_timeout = '2s'");
        await payOn(q2, b);
      });
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.punch_cards where contact_id = any ($1)", [[a.c, b.c]]))).toBe(2);
  });

  it("an addendum opens its own cards; an order from a quote does not open a line its quote opened (owner (100) ב, (101) א)", async () => {
    const c = await contact("נספח");
    const cardsOf = () => asAdmin(async (q) => (await q<{ quote_line_id: string | null; order_line_id: string | null }>("select quote_line_id, order_line_id from public.punch_cards where contact_id = $1", [c])).rows);
    const quote = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id);
    // two lines of the same product: position 1 (one unit) and position 2 (two units)
    await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, position, name, product_id, unit_price_agorot, quantity) values ($1, $2, 1, 'כרטיסייה', $3, 10000, 1)", [org, quote, product]));
    await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, position, name, product_id, unit_price_agorot, quantity) values ($1, $2, 2, 'כרטיסייה', $3, 10000, 2)", [org, quote, product]));
    await run(owner, (q) => q("select public.quote_send($1, $2)", [org, quote]));
    const unit = await asAdmin(async (q) => Number((await one<{ p: string }>(q, "select app.punch_with_vat(10000, q.prices_include_vat, false, q.vat_rate_bp) as p from public.quotes q where q.id = $1", [quote])).p));
    // an advance that covers one card: the first line's
    await run(owner, (q) =>
      q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, $3, current_date, 'cash', true, $4)", [org, c, unit, quote]),
    );
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    expect((await cardsOf()).length).toBe(1);
    // the order made from it: the first line is covered through its quote line (same position and product); the second
    // line's two units open from a payment on the order
    const order = await run(owner, async (q) => (await one<{ r: string }>(q, "select public.order_from_quote($1, $2) as r", [org, quote])).r);
    await run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 1000000, current_date, 'cash')", [org, c, order]));
    let cards = await cardsOf();
    expect(cards.filter((k) => k.quote_line_id).length).toBe(1);
    expect(cards.filter((k) => k.order_line_id).length).toBe(2);
    // an addendum of the accepted quote with the same product is its own purchase: it opens its own card
    const addendum = await run(owner, async (q) => (await one<{ a: string }>(q, "select public.quote_new_addendum($1, $2) as a", [org, quote])).a);
    await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, position, name, product_id, unit_price_agorot, quantity) values ($1, $2, 1, 'כרטיסייה', $3, 10000, 1)", [org, addendum, product]));
    await run(owner, (q) => q("select public.quote_send($1, $2)", [org, addendum]));
    await run(owner, (q) =>
      q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, $3, current_date, 'cash', true, $4)", [org, c, unit, addendum]),
    );
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [addendum]));
    cards = await cardsOf();
    expect(cards.length).toBe(4);
  });

  it("an acceptance and an advance at the same moment open the card once, in either order (fourth review, finding 1)", async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const setup = async (name: string) => {
      const c = await contact(name);
      const quote = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id);
      await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 10000, 1)", [org, quote, product]));
      await run(owner, (q) => q("select public.quote_send($1, $2)", [org, quote]));
      return { c, quote };
    };
    const advance = (q: Query, x: { c: string; quote: string }) =>
      q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, 100000, current_date, 'cash', true, $3)", [org, x.c, x.quote]);
    const accept = (x: { quote: string }) => asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [x.quote]));
    const cards = (x: { c: string }) => asAdmin((q) => count(q, "select 1 from public.punch_cards where contact_id = $1", [x.c]));
    // the advance's transaction is open (it read the quote as sent) while the acceptance runs and commits after it
    const a = await setup("מרוץ א");
    let accepted: Promise<unknown> = Promise.resolve();
    await run(owner, async (q) => {
      await advance(q, a);
      accepted = accept(a);
      await pause(300);
    });
    await accepted;
    expect(await cards(a)).toBe(1);
    // the acceptance's transaction is open while the advance is recorded and commits after it
    const b = await setup("מרוץ ב");
    let paid: Promise<unknown> = Promise.resolve();
    await asAdmin(async (q) => {
      await q("update public.quotes set status = 'accepted' where id = $1", [b.quote]);
      paid = run(owner, (q2) => advance(q2, b));
      await pause(300);
    });
    await paid;
    expect(await cards(b)).toBe(1);
  });

  it("a card opened by hand with a payment on an order takes the order line's unit, so the line never opens it again (fourth review, finding 2)", async () => {
    const c = await contact("ביד והזמנה");
    const order = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 10000, 1)", [org, order, product]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order]));
    // the payment is allocated to the order's invoice with the automatic opening switched off for that one insert (as if it had
    // failed), so the card is opened by hand
    const total = await asAdmin(async (q) => Number((await one<{ t: string }>(q, "select total_agorot as t from public.orders where id = $1", [order])).t));
    const p = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, current_date, 'cash') returning id", [org, c, total])).id,
    );
    const invoice = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, order_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', 'HAND-1', $4) returning id", [org, c, order, total])).id,
    );
    // opened by hand first (the allocation comes later)
    await asAdmin((q) => q("alter table public.payment_allocations disable trigger payment_allocations_zz_punch_cards"));
    try {
      await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, p, invoice, total]));
    } finally {
      await asAdmin((q) => q("alter table public.payment_allocations enable trigger payment_allocations_zz_punch_cards"));
    }
    const hand = await open(seller, c, { payment: p });
    const row = await asAdmin(async (q) => one<{ order_line_id: string | null; unit_no: number | null; price: string }>(q, "select order_line_id, unit_no, price_agorot as price from public.punch_cards where id = $1", [hand]));
    expect(row.order_line_id).not.toBeNull();
    expect(row.unit_no).toBe(1);
    expect(Number(row.price)).toBe(total);
    // another payment on the order opens nothing: the line's one unit is taken
    await run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 1000000, current_date, 'cash')", [org, c, order]));
    expect(await asAdmin((q) => count(q, "select 1 from public.punch_cards where contact_id = $1", [c]))).toBe(1);
  });

  it("the automatic entry is history: nobody edits or removes it, and it has no author", async () => {
    const entry = await asAdmin(async (q) =>
      one<{ id: string; created_by: string | null; contact_id: string }>(q, "select id, created_by, contact_id from public.activities where organization_id = $1 and metadata ->> 'kind' = 'punch_card_opened' limit 1", [org]),
    );
    expect(entry.created_by).toBeNull();
    for (const u of [owner, admin]) {
      expect(await pgError(run(u, (q) => q("update public.activities set body = 'x' where id = $1", [entry.id])))).toMatchObject({ hint: "activity:punch_card_entry" });
      expect(await pgError(run(u, (q) => q("delete from public.activities where id = $1", [entry.id])))).toMatchObject({ hint: "activity:punch_card_entry" });
      expect(
        await pgError(run(u, (q) => q("insert into public.activities (organization_id, type, body, contact_id, metadata) values ($1, 'note', 'x', $2, '{\"kind\": \"punch_card_opened\"}')", [org, entry.contact_id]))),
      ).toMatchObject({ hint: "activity:punch_card_entry" });
    }
  });

  it("a partial refund that leaves the payment short marks its cards; cancelling the refund clears it (second review, finding 7)", async () => {
    const c = await contact("החזר חלקי");
    // owner (93) ב: the card's price is the product's price with VAT at today's rate
    const price = await asAdmin(async (q) => Number((await one<{ p: string }>(q, "select app.punch_product_price($1, $2) as p", [org, product])).p));
    const p = await pay(c, price);
    const id = await open(seller, c, { payment: p });
    const marked = async () => (await asAdmin(async (q) => one<{ v: string | null }>(q, "select payment_void_at as v from public.punch_cards where id = $1", [id]))).v !== null;
    const refund = await run(admin, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payment_refunds (organization_id, payment_id, amount_agorot, method) values ($1, $2, 100, 'cash') returning id", [org, p])).id,
    );
    expect(await marked()).toBe(true);
    await run(admin, (q) => q("update public.payment_refunds set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [refund]));
    expect(await marked()).toBe(false);
  });

  it("a quick sale opens the cards it sold, at its share of the charge, only on its own marked deal (owner (107) ב; reviews 3 and 4)", async () => {
    const c = await contact("מכירה");
    const saleProduct = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, kind, price_agorot, punch_entries, punch_meeting_type_ids) values ($1, 'כרטיסייה למכירה מהירה', 'punch_card', 5043, 5, $2) returning id", [org, [typeA]])).id,
    );
    const quickSale = (u: U, over: Record<string, unknown> = {}) =>
      run(u, async (q) =>
        (
          await one<{ s: { deal_id: string; payment_ids: string[]; total_agorot: number } }>(q, "select public.quick_sale($1, $2) as s", [
            org,
            JSON.stringify({ contact_id: c, lines: [{ product_id: saleProduct, quantity: 2, unit_price_agorot: 5043, price_source: "product" }], payment: { method: "cash" }, expected_total_agorot: 11901, ...over }),
          ])
        ).s,
      );
    const forSale = (u: U, deal: string) => run(u, async (q) => (await one<{ r: { opened: number; failed: number } }>(q, "select public.punch_card_open_for_sale($1, $2) as r", [org, deal])).r);
    const s1 = await quickSale(seller);
    // the marker is the server's: on the sale's deal only
    expect(await asAdmin(async (q) => (await one<{ m: string | null }>(q, "select quick_sale_at as m from public.deals where id = $1", [s1.deal_id])).m)).not.toBeNull();
    expect((await pgError(forSale(member, s1.deal_id))).code).toBe("42501");
    // fourth review, finding 4: a punch line added after the sale (free, 20 units) opens nothing
    await run(owner, (q) => q("insert into public.deal_lines (organization_id, deal_id, product_id, description, quantity, unit_price_agorot, price_source) values ($1, $2, $3, 'נוספה אחר כך', 20, 0, 'manual')", [org, s1.deal_id, saleProduct]));
    expect(await forSale(seller, s1.deal_id)).toEqual({ opened: 2, failed: 0 });
    // the units sum exactly to what the sale charged (third review, finding 3)
    expect(await asAdmin(async (q) => Number((await one<{ s: string }>(q, "select sum(price_agorot) as s from public.punch_cards c join public.deal_lines l on l.id = c.deal_line_id where l.deal_id = $1", [s1.deal_id])).s))).toBe(s1.total_agorot);
    expect(await forSale(seller, s1.deal_id)).toEqual({ opened: 0, failed: 0 });
    // probe C: the sale's payment already went to something else: no card can be covered
    const s2 = await quickSale(seller);
    const other = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', 'SALE-X', 100000) returning id", [org, c])).id,
    );
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, s2.payment_ids[0], other, s2.total_agorot]));
    expect(await forSale(seller, s2.deal_id)).toEqual({ opened: 0, failed: 2 });
    // probe C2: a deal made by hand carries no marker, whatever the person sends
    const pipe = await asAdmin(async (q) =>
      one<{ p: string; w: string }>(q, "select p.id as p, (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'won' order by s.position limit 1) as w from public.pipelines p where p.organization_id = $1 and p.is_default", [org]),
    );
    const handDeal = await run(seller, async (q) =>
      (await one<{ id: string; m: string | null }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, quick_sale_at) values ($1, 'ביד', $2, $3, $4, now()) returning id, quick_sale_at as m", [org, pipe.p, pipe.w, c])),
    );
    expect(handDeal.m).toBeNull();
    expect(await pgError(forSale(seller, handDeal.id))).toMatchObject({ hint: "punch_card:not_quick_sale" });
    // an update never sets or clears it
    await run(owner, (q) => q("update public.deals set quick_sale_at = now() where id = $1", [handDeal.id]));
    await run(owner, (q) => q("update public.deals set quick_sale_at = null where id = $1", [s1.deal_id]));
    expect(await asAdmin(async (q) => (await q<{ id: string; m: string | null }>("select id, quick_sale_at as m from public.deals where id = any ($1)", [[handDeal.id, s1.deal_id]])).rows.map((r) => [r.id === s1.deal_id, r.m !== null]).sort())).toEqual([[false, false], [true, true]]);
    // the setting marks only the deal it names
    const named = await run(seller, async (q) => {
      await q("select set_config('app.quick_sale_deal', gen_random_uuid()::text, true)");
      return (await one<{ m: string | null }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'אחר', $2, $3, $4) returning quick_sale_at as m", [org, pipe.p, pipe.w, c])).m;
    });
    expect(named).toBeNull();
  });

  it("an order paid exactly opens every unit: the units share what the document charges (third review, finding 3)", async () => {
    const c = await contact("עיגול");
    const order = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 5043, 2)", [org, order, product]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order]));
    const total = await asAdmin(async (q) => Number((await one<{ t: string }>(q, "select total_agorot as t from public.orders where id = $1", [order])).t));
    await run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, current_date, 'cash')", [org, c, order, total]));
    const prices = await asAdmin(async (q) => (await q<{ p: string }>("select price_agorot as p from public.punch_cards where contact_id = $1 order by unit_no", [c])).rows.map((r) => Number(r.p)));
    expect(prices.length).toBe(2);
    expect(prices[0] + prices[1]).toBe(total);
  });

  it("a quote with two lines of the same punch card opens two cards (third review, finding 2)", async () => {
    const c = await contact("שתי שורות");
    const quote = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id);
    for (let i = 0; i < 2; i += 1) {
      await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 10000, 1)", [org, quote, product]));
    }
    await run(owner, (q) => q("select public.quote_send($1, $2)", [org, quote]));
    await run(owner, (q) =>
      q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, 1000000, current_date, 'cash', true, $3)", [org, c, quote]),
    );
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    expect(await asAdmin((q) => count(q, "select 1 from public.punch_cards where contact_id = $1", [c]))).toBe(2);
  });

  it("a card opened by hand counts the payment's allocations elsewhere (third review, finding 6)", async () => {
    const c = await contact("שיוך");
    const price = await asAdmin(async (q) => Number((await one<{ p: string }>(q, "select app.punch_product_price($1, $2) as p", [org, product])).p));
    const p = await pay(c, price);
    const invoice = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', 'ALLOC-1', $3) returning id", [org, c, price])).id,
    );
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 1)", [org, p, invoice]));
    expect(await pgError(open(seller, c, { payment: p }))).toMatchObject({ hint: "punch_card:payment_used" });
  });

  it("a failed automatic opening leaves a notice to owners and admins (third review, finding 4)", async () => {
    const c = await contact("נכשל");
    const before = await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = 'כרטיסייה לא נפתחה אוטומטית'", [org]));
    await asAdmin((q) => q("select app.punch_cards_failed_notice($1, null, $2)", [org, c]));
    const after = await asAdmin(async (q) => (await q<{ user_id: string; entity_type: string }>("select user_id, entity_type from public.notifications where organization_id = $1 and title = 'כרטיסייה לא נפתחה אוטומטית'", [org])).rows);
    expect(after.length - before).toBe(2);
    expect(after.map((r) => r.user_id).sort()).toEqual(expect.arrayContaining([owner.id, admin.id]));
  });

  it("opens by itself from a counted payment on an order or a quote with a punch card line, never twice (owner (85) ב)", async () => {
    const c = await contact("אביב");
    const entries = (contactId: string) =>
      asAdmin(async (q) => (await q<{ body: string }>("select body from public.activities where contact_id = $1 and metadata ->> 'kind' = 'punch_card_opened' order by created_at, id", [contactId])).rows.map((r) => r.body));
    const cardsOf = (contactId: string) =>
      asAdmin(async (q) => (await q<{ id: string; order_line_id: string | null; quote_line_id: string | null; unit_no: number; payment_id: string; price: string }>(
        "select id, order_line_id, quote_line_id, unit_no, payment_id, price_agorot as price from public.punch_cards where contact_id = $1 order by unit_no, id", [contactId])).rows);
    // an order with two units of a punch card and a plain line
    const order = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 40000, 2)", [org, order, product]));
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'משהו אחר', 1000, 1)", [org, order]));
    const number = await run(owner, async (q) => (await one<{ r: { number: string } }>(q, "select public.order_confirm($1, $2) as r", [org, order])).r.number);
    // a payment that covers one card opens one; the second waits for room
    const p1 = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 50000, current_date, 'cash') returning id", [org, c, order])).id,
    );
    let cards = await cardsOf(c);
    const unitWithVat = await asAdmin(async (q) =>
      Number((await one<{ p: string }>(q, "select app.punch_with_vat(40000, o.prices_include_vat, false, o.vat_rate_bp) as p from public.orders o where o.id = $1", [order])).p),
    );
    expect(unitWithVat).toBe(47200);
    expect(cards.map((k) => [k.unit_no, k.payment_id, Number(k.price)])).toEqual([[1, p1, unitWithVat]]);
    // owner (94) ב: one entry per payment
    expect(await entries(c)).toEqual([`נפתחה כרטיסייה אוטומטית מתשלום על הזמנה ${number}`]);
    // a second payment on the order opens the second unit only, never the first again
    const p2 = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 90000, current_date, 'cash') returning id", [org, c, order])).id,
    );
    cards = await cardsOf(c);
    expect(cards.map((k) => [k.unit_no, k.payment_id])).toEqual([[1, p1], [2, p2]]);
    await run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 90000, current_date, 'cash')", [org, c, order]));
    expect((await cardsOf(c)).length).toBe(2);
    const d = await contact("ברק");
    const order2 = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, d])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 40000, 1.5)", [org, order2, product]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order2]));
    await run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 90000, current_date, 'cash')", [org, d, order2]));
    // a quantity of 1.5 opens one card (whole units only)
    expect((await cardsOf(d)).map((k) => k.unit_no)).toEqual([1]);

    // a quote's advance (QUO / PAY-03) opens its lines' cards once the quote is accepted (owner (95) ב)
    const e = await contact("גיא");
    const quote = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, e])).id);
    await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 30000, 1)", [org, quote, product]));
    const qnum = await run(owner, async (q) => (await one<{ r: { number: string } }>(q, "select public.quote_send($1, $2) as r", [org, quote])).r.number);
    await run(owner, (q) =>
      q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, 40000, current_date, 'cash', true, $3)", [org, e, quote]),
    );
    expect((await cardsOf(e)).length).toBe(0);
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    expect((await cardsOf(e)).map((k) => Boolean(k.quote_line_id))).toEqual([true]);
    expect(await entries(e)).toEqual([`נפתחה כרטיסייה אוטומטית מתשלום על הצעה ${qnum}`]);

    // a payment allocated to a document of an order (PAY-02) opens the order's cards
    const f = await contact("דור");
    const order3 = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, f])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 20000, 1)", [org, order3, product]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order3]));
    const invoice = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, order_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', 'PC-1', 30000) returning id", [org, f, order3])).id,
    );
    const plain = await pay(f, 30000);
    expect((await cardsOf(f)).length).toBe(0);
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 30000)", [org, plain, invoice]));
    expect((await cardsOf(f)).map((k) => k.payment_id)).toEqual([plain]);
    // no key: nothing opens, and the payment is still recorded
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
    try {
      const g = await contact("הדס");
      const order4 = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, g])).id);
      await asAdmin((q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 20000, 1)", [org, order4, product]));
      await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order4]));
      await run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 90000, current_date, 'cash')", [org, g, order4]));
      expect((await cardsOf(g)).length).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
  });

  it("is in the action log; erasure reaches only what was the person's (owner (87) ב, second review finding 5)", async () => {
    const c = await contact("לוי");
    const d = await contact("כהן");
    const e = await contact("פרץ");
    const gone = await open(admin, c, { activate: true });
    const moved = await open(admin, c, { activate: true });
    await run(admin, (q) => q("select public.punch_card_cancel($1, $2, 'לוי ביקש לבטל')", [org, gone]));
    await run(admin, (q) => q("select public.punch_card_transfer($1, $2, $3)", [org, moved, d]));
    await run(admin, (q) => q("select public.punch_card_transfer($1, $2, $3)", [org, moved, e]));
    await run(admin, (q) => q("select public.punch_card_cancel($1, $2, 'פרץ ביקש לבטל')", [org, moved]));
    const log = (id: string) =>
      asAdmin(async (q) => (await q<{ action: string; changes: Record<string, unknown> }>("select action, changes from public.audit_log where entity_type = 'punch_cards' and entity_id = $1 order by id", [id])).rows);
    expect((await log(gone)).map((r) => r.action)).toEqual(["insert", "update"]);
    expect(await asAdmin(async (q) => (await one<{ f: string[] }>(q, "select former_contact_ids as f from public.punch_cards where id = $1", [moved])).f)).toEqual([c, d]);
    const before = await log(moved);
    await asAdmin((q) => q("delete from public.contacts where id = $1", [c]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, c]));
    // the gone card: every entry erased
    expect((await log(gone)).every((r) => JSON.stringify(r.changes) === '{"erased":true}')).toBe(true);
    // the transferred card stays with its holder: its numbers, the later holders and the later reason are kept
    const row = await asAdmin(async (q) =>
      one<{ contact_id: string; entries_total: number; cancel_reason: string; former_contact_ids: string[]; holder_history: { contact?: string }[] }>(
        q,
        "select contact_id, entries_total, cancel_reason, former_contact_ids, holder_history from public.punch_cards where id = $1",
        [moved],
      ),
    );
    expect(row).toMatchObject({ contact_id: e, entries_total: 3, cancel_reason: "פרץ ביקש לבטל", former_contact_ids: [d] });
    expect(row.holder_history.map((h) => h.contact ?? null)).toEqual([null, d]);
    // the entries written while the person held it are erased; the later ones keep their facts without the person's id
    const after = await log(moved);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    expect(JSON.stringify(after)).not.toContain(c);
    expect(JSON.stringify(after[0].changes)).toBe('{"erased":true}');
    expect(after.some((r) => JSON.stringify(r.changes).includes(d))).toBe(true);
    expect(after.some((r) => JSON.stringify(r.changes).includes("פרץ ביקש לבטל"))).toBe(true);
  });

  it("a card merged away from the person: the reason written while they held it is erased, with every trace of it", async () => {
    const keep = await contact("שמר");
    const dup = await contact("שמר כפול");
    const id = await open(admin, dup, { activate: true });
    await run(admin, (q) => q("select public.punch_card_cancel($1, $2, 'שמר כפול ביקש לבטל')", [org, id]));
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, dup]));
    expect(await asAdmin(async (q) => (await one<{ r: string }>(q, "select cancel_reason as r from public.punch_cards where id = $1", [id])).r)).toBe("הסיבה נמחקה (מחיקת פרטיות)");
    const left = JSON.stringify(await asAdmin(async (q) => (await q("select changes from public.audit_log where entity_type = 'punch_cards' and entity_id = $1", [id])).rows));
    expect(left).not.toContain("שמר כפול ביקש");
    expect(left).not.toContain(dup);
  });

  it("a punch card is work: an import undo keeps the contact (review finding 7)", async () => {
    const c = await contact("יבוא");
    const worked = () =>
      asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 hour', null) as w", [org, c])).w);
    expect(await worked()).toBe(false);
    await open(admin, c, { activate: true });
    expect(await worked()).toBe(true);
  });

  it("cancel and transfer are for owners and admins", async () => {
    const c = await contact("מיכל");
    const d = await contact("רון");
    const id = await open(admin, c, { activate: true });
    const transfer = (u: U, to: string) => run(u, (q) => q("select public.punch_card_transfer($1, $2, $3)", [org, id, to]));
    expect((await pgError(transfer(manager, d))).code).toBe("42501");
    expect((await pgError(transfer(seller, d))).code).toBe("42501");
    expect(await pgError(transfer(admin, c))).toMatchObject({ hint: "punch_card:contact" });
    await transfer(admin, d);
    expect((await card(id)).contact_id).toBe(d);
    const cancel = (u: U, reason: string) => run(u, (q) => q("select public.punch_card_cancel($1, $2, $3)", [org, id, reason]));
    expect((await pgError(cancel(manager, "x"))).code).toBe("42501");
    expect(await pgError(cancel(owner, ""))).toMatchObject({ hint: "punch_card:reason" });
    await cancel(owner, "הלקוח ביקש החזר");
    expect((await card(id)).status).toBe("cancelled");
    expect(await pgError(cancel(owner, "שוב"))).toMatchObject({ hint: "punch_card:cancelled" });
    expect(await pgError(transfer(admin, c))).toMatchObject({ hint: "punch_card:cancelled" });
  });

  it("whoever reads the contact reads its cards", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const c = await contact("פרטי");
      const id = await open(owner, c, { payment: await pay(c) });
      const seen = (u: U) => run(u, (q) => count(q, "select 1 from public.punch_cards where id = $1", [id]));
      expect(await seen(owner)).toBe(1);
      expect(await seen(admin)).toBe(1);
      expect(await seen(member)).toBe(0);
      expect(await seen(stranger)).toBe(0);
      // and a seller who cannot read the contact cannot open a card on it
      expect(await pgError(open(seller, c))).toMatchObject({ hint: "punch_card:contact" });
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a merge moves the duplicate's cards; the card goes with a purged contact", async () => {
    const keep = await contact("משה");
    const dup = await contact("משה כפול");
    const id = await open(admin, dup, { activate: true });
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect((await card(id)).contact_id).toBe(keep);
    // purging the contact takes the card
    await asAdmin((q) => q("delete from public.contacts where id = $1", [keep]));
    expect(await asAdmin((q) => count(q, "select 1 from public.punch_cards where id = $1", [id]))).toBe(0);
  });

  describe("a failed automatic opening is tried again in the background (owner (109) ב)", () => {
    type Retry = { kind: string; attempts: number; last_sqlstate: string | null; done: boolean; given_up: boolean; due_in_minutes: number };
    const FAILED = "כרטיסייה לא נפתחה אוטומטית";
    const GAVE_UP = "כרטיסייה לא נפתחה גם בניסיונות חוזרים";
    const EMPTY = "הניסיון החוזר לפתוח כרטיסייה הסתיים";
    const retries = (where: string, params: unknown[]) =>
      asAdmin(async (q) =>
        (
          await q<Retry>(
            `select kind, attempts, last_sqlstate, done_at is not null as done, given_up_at is not null as given_up,
                    round(extract(epoch from next_try_at - now()) / 60)::integer as due_in_minutes
               from app.punch_card_retries where organization_id = $1 and ${where} order by created_at, id`,
            [org, ...params],
          )
        ).rows,
      );
    const due = (where: string, params: unknown[]) =>
      asAdmin((q) => q(`update app.punch_card_retries set next_try_at = now() - interval '1 second' where organization_id = $1 and ${where}`, [org, ...params]));
    const retry = (perOrg = 50) => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.retry_punch_card_openings($1, 500) as n", [perOrg])).n);
    const holdKeys = (q: Query, order: string | null, quote: string | null) =>
      q("select pg_advisory_xact_lock(k) from unnest(app.punch_card_keys($1, $2, $3)) k", [org, order, quote]);
    const cardsOf = (c: string) => asAdmin((q) => count(q, "select 1 from public.punch_cards where contact_id = $1", [c]));
    const notices = (title: string, c: string) =>
      asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = $2 and entity_id = $3", [org, title, c]));
    const order = async (c: string, quantity: number) => {
      const id = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
      await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 40000, $4)", [org, id, product, quantity]));
      await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, id]));
      return id;
    };
    // the payment's transaction gives up on the key after 300 ms (55P03), the opening is caught, the payment is recorded
    const payTimedOut = (c: string, orderId: string) =>
      run(owner, async (q) => {
        await q("set local lock_timeout = '300ms'");
        return (
          await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 50000, current_date, 'cash') returning id", [
            org,
            c,
            orderId,
          ])
        ).id;
      });
    const payOrder = (c: string, orderId: string) =>
      run(owner, (q) => q("insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 50000, current_date, 'cash')", [org, c, orderId]));

    it("a key held elsewhere: the payment is recorded, one row waits, the job opens the card later, never twice", async () => {
      const c = await contact("ניסיון חוזר");
      const o = await order(c, 2);
      // another session holds the order's key while two payments are recorded: neither opens a card, each leaves one row
      const [a, b] = await asAdmin(async (q) => {
        await holdKeys(q, o, null);
        const first = await payTimedOut(c, o);
        const second = await payTimedOut(c, o);
        // the job meets the same held key: nothing opens, the try is counted, the next one waits 15 minutes
        await due("payment_id = any ($2)", [[first, second]]);
        expect(await retry()).toBe(0);
        return [first, second];
      });
      expect(await cardsOf(c)).toBe(0);
      expect(await retries("payment_id = any ($2)", [[a, b]])).toEqual([
        { kind: "open", attempts: 1, last_sqlstate: "55P03", done: false, given_up: false, due_in_minutes: 15 },
        { kind: "open", attempts: 1, last_sqlstate: "55P03", done: false, given_up: false, due_in_minutes: 15 },
      ]);
      // one notice per event (owner and admin), none for the job's own tries
      expect(await notices(FAILED, c)).toBe(4);
      // the key is free: a business's rows take turns (one a run here), each opens its own unit
      await due("payment_id = any ($2)", [[a, b]]);
      expect(await retry(1)).toBe(1);
      expect(await cardsOf(c)).toBe(1);
      expect(await retry(1)).toBe(1);
      expect(await cardsOf(c)).toBe(2);
      expect((await retries("payment_id = any ($2)", [[a, b]])).map((r) => [r.attempts, r.done])).toEqual([
        [2, true],
        [2, true],
      ]);
      // one timeline entry per payment, as a normal opening
      expect(await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and metadata ->> 'kind' = 'punch_card_opened'", [c]))).toBe(2);
      // nothing more: neither another run, nor a later normal payment on the full line
      expect(await retry()).toBe(0);
      await payOrder(c, o);
      expect(await cardsOf(c)).toBe(2);
    });

    it("a retry after the line was opened normally opens nothing more", async () => {
      const c = await contact("פתוחה כבר");
      const o = await order(c, 1);
      const a = await asAdmin(async (q) => {
        await holdKeys(q, o, null);
        return payTimedOut(c, o);
      });
      // a normal payment opens the line's one unit first
      await payOrder(c, o);
      expect(await cardsOf(c)).toBe(1);
      await due("payment_id = $2", [a]);
      expect(await retry()).toBe(1);
      expect(await cardsOf(c)).toBe(1);
      expect((await retries("payment_id = $2", [a]))[0]).toMatchObject({ done: true });
      // owners were told it would be tried again: the end without a card is told once (fifth review, finding 4)
      expect(await notices(EMPTY, c)).toBe(2);
      expect(await retry()).toBe(0);
      expect(await notices(EMPTY, c)).toBe(2);
    });

    it("an acceptance whose key is held elsewhere: the quote waits, and its advance opens the card later", async () => {
      const c = await contact("הצעה בהמתנה");
      const quote = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id);
      await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 10000, 1)", [org, quote, product]));
      await run(owner, (q) => q("select public.quote_send($1, $2)", [org, quote]));
      await run(owner, (q) =>
        q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, 100000, current_date, 'cash', true, $3)", [org, c, quote]),
      );
      await asAdmin(async (q) => {
        await holdKeys(q, null, quote);
        await asAdmin(async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          await q2("update public.quotes set status = 'accepted' where id = $1", [quote]);
        });
      });
      expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [quote])).s)).toBe("accepted");
      expect(await cardsOf(c)).toBe(0);
      expect(await retries("quote_id = $2", [quote])).toMatchObject([{ kind: "quote", attempts: 0, done: false }]);
      await due("quote_id = $2", [quote]);
      expect(await retry()).toBe(1);
      expect(await cardsOf(c)).toBe(1);
    });

    it("a business that cannot write keeps its row untried; after 3 days the job gives up with one notice", async () => {
      const c = await contact("לא נפתחה");
      const o = await order(c, 1);
      const a = await asAdmin(async (q) => {
        await holdKeys(q, o, null);
        return payTimedOut(c, o);
      });
      const status = await asAdmin(async (q) => (await one<{ s: string }>(q, "select status::text as s from public.organizations where id = $1", [org])).s);
      await due("payment_id = $2", [a]);
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        expect(await retry()).toBe(0);
      } finally {
        await asAdmin((q) => q("update public.organizations set status = $2::public.org_status where id = $1", [org, status]));
      }
      expect((await retries("payment_id = $2", [a]))[0]).toMatchObject({ attempts: 0, done: false, given_up: false, due_in_minutes: 60 });
      // three days after the failure the key is still held: the try fails and the row is given up
      await asAdmin((q) => q("update app.punch_card_retries set created_at = now() - interval '3 days' where organization_id = $1 and payment_id = $2", [org, a]));
      await due("payment_id = $2", [a]);
      await asAdmin(async (q) => {
        await holdKeys(q, o, null);
        expect(await retry()).toBe(0);
      });
      expect((await retries("payment_id = $2", [a]))[0]).toMatchObject({ attempts: 1, last_sqlstate: "55P03", done: false, given_up: true });
      expect(await notices(GAVE_UP, c)).toBe(2);
      // given up is final: no more tries, no more notices
      expect(await retry()).toBe(0);
      expect(await notices(GAVE_UP, c)).toBe(2);
      expect(await cardsOf(c)).toBe(0);
      // the retries are server state: no client reads or writes them
      expect((await pgError(run(owner, (q) => q("select 1 from app.punch_card_retries")))).code).toBe("42501");
    });
    it("a link removed or moved before the retry: nothing opens on the old order (fifth review, finding 1)", async () => {
      const c = await contact("קישור שהשתנה");
      const o1 = await order(c, 1);
      const o2 = await order(c, 1);
      const [removed, moved] = await asAdmin(async (q) => {
        await holdKeys(q, o1, null);
        const advance = () =>
          run(owner, async (q2) => {
            await q2("set local lock_timeout = '300ms'");
            return (
              await one<{ id: string }>(
                q2,
                "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_order_id) values ($1, $2, 50000, current_date, 'cash', true, $3) returning id",
                [org, c, o1],
              )
            ).id;
          });
        return [await advance(), await advance()];
      });
      expect(await retries("payment_id = any ($2)", [[removed, moved]])).toHaveLength(2);
      await run(owner, (q) => q("update public.payments set is_advance = false, advance_order_id = null where id = $1", [removed]));
      await run(owner, (q) => q("update public.payments set advance_order_id = $2 where id = $1", [moved, o2]));
      const onOrder = (o: string) =>
        asAdmin((q) => count(q, "select 1 from public.punch_cards c join public.order_lines l on l.organization_id = c.organization_id and l.id = c.order_line_id where l.order_id = $1", [o]));
      // the moved payment opens on its new order at once
      expect(await onOrder(o2)).toBe(1);
      await due("payment_id = any ($2)", [[removed, moved]]);
      expect(await retry()).toBe(2);
      expect(await onOrder(o1)).toBe(0);
      expect(await onOrder(o2)).toBe(1);
      expect((await retries("payment_id = any ($2)", [[removed, moved]])).map((r) => r.done)).toEqual([true, true]);
      expect(await notices(EMPTY, c)).toBe(4);
    });

    it("a payment cancelled, or an allocation undone, before the retry: nothing opens and the end is told once", async () => {
      const c = await contact("בוטל לפני הניסיון");
      const o = await order(c, 1);
      const a = await asAdmin(async (q) => {
        await holdKeys(q, o, null);
        return payTimedOut(c, o);
      });
      await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [a]));
      await due("payment_id = $2", [a]);
      expect(await retry()).toBe(1);
      expect(await cardsOf(c)).toBe(0);
      expect(await notices(EMPTY, c)).toBe(2);
      // an allocation to the order's invoice, kept for a retry, then undone by an owner
      const invoice = await run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, order_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, 47200) returning id",
            [org, c, o, `RT-${Date.now()}`],
          )
        ).id,
      );
      const p = await pay(c, 50000);
      const allocation = await asAdmin(async (q) => {
        await holdKeys(q, o, null);
        return run(owner, async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          return (await one<{ id: string }>(q2, "insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 47200) returning id", [org, p, invoice])).id;
        });
      });
      expect(await asAdmin((q) => count(q, "select 1 from app.punch_card_retries where allocation_id = $1 and kind = 'open' and source = 'allocation'", [allocation]))).toBe(1);
      await run(owner, (q) => q("update public.payment_allocations set removed_at = now() where id = $1", [allocation]));
      await due("payment_id = $2", [p]);
      expect(await retry()).toBe(1);
      expect(await cardsOf(c)).toBe(0);
      expect(await notices(EMPTY, c)).toBe(4);
    });

    it("a payment's cards judged again: a card row held elsewhere leaves a void_sync row, the job marks the card later", async () => {
      const c = await contact("סימון חוזר");
      const o = await order(c, 1);
      const p = await run(owner, async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, 50000, current_date, 'cash') returning id", [
            org,
            c,
            o,
          ])
        ).id,
      );
      const cardId = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.punch_cards where contact_id = $1", [c])).id);
      const voided = () => asAdmin(async (q) => (await one<{ v: boolean }>(q, "select payment_void_at is not null as v from public.punch_cards where id = $1", [cardId])).v);
      await asAdmin(async (q) => {
        await q("select 1 from public.punch_cards where id = $1 for update", [cardId]);
        await run(owner, async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          await q2("update public.payments set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [p]);
        });
      });
      expect(await asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.payments where id = $1", [p])).s)).toBe("cancelled");
      expect(await voided()).toBe(false);
      expect(await retries("payment_id = $2", [p])).toMatchObject([{ kind: "void_sync", attempts: 0, last_sqlstate: "55P03", done: false }]);
      await due("payment_id = $2", [p]);
      expect(await retry()).toBe(1);
      expect(await voided()).toBe(true);
      // judging again is not an opening: no "ended without a card" notice
      expect(await notices(EMPTY, c)).toBe(0);
    });

    it("a quote retry never waits for a payment row held elsewhere (nowait), and opens once it is free", async () => {
      const c = await contact("הצעה ותשלום תפוס");
      const quote = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id);
      await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 10000, 1)", [org, quote, product]));
      await run(owner, (q) => q("select public.quote_send($1, $2)", [org, quote]));
      const p = await run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, 100000, current_date, 'cash', true, $3) returning id",
            [org, c, quote],
          )
        ).id,
      );
      await asAdmin(async (q) => {
        await holdKeys(q, null, quote);
        await asAdmin(async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          await q2("update public.quotes set status = 'accepted' where id = $1", [quote]);
        });
      });
      await due("quote_id = $2", [quote]);
      await asAdmin(async (q) => {
        await q("select 1 from public.payments where id = $1 for update", [p]);
        expect(await retry()).toBe(0);
      });
      expect(await retries("quote_id = $2", [quote])).toMatchObject([{ kind: "quote", attempts: 1, last_sqlstate: "55P03", done: false }]);
      await due("quote_id = $2", [quote]);
      expect(await retry()).toBe(1);
      expect(await cardsOf(c)).toBe(1);
    });

    it("recording a retry never fails the write it was called from", async () => {
      const c = await contact("רישום שנכשל");
      const o = await order(c, 1);
      const before = await asAdmin((q) => count(q, "select 1 from app.punch_card_retries where organization_id = $1", [org]));
      // an unknown payment (foreign key) and a kind outside the list (check): one warning each, no error, no row
      await asAdmin((q) => q("select app.punch_card_retry_record($1, 'open', gen_random_uuid(), $2, null, null, 'link', '55P03')", [org, o]));
      await asAdmin((q) => q("select app.punch_card_retry_record($1, 'bogus', null, null, null, null, null, 'XX000')", [org]));
      expect(await asAdmin((q) => count(q, "select 1 from app.punch_card_retries where organization_id = $1", [org]))).toBe(before);
    });

    it("a business that still cannot write after 3 days: the row is given up with one notice (fifth review, finding 2)", async () => {
      const c = await contact("סגור שלושה ימים");
      const o = await order(c, 1);
      const a = await asAdmin(async (q) => {
        await holdKeys(q, o, null);
        return payTimedOut(c, o);
      });
      await asAdmin((q) =>
        q("update app.punch_card_retries set created_at = now() - interval '3 days 1 minute', next_try_at = now() - interval '1 second' where organization_id = $1 and payment_id = $2", [org, a]),
      );
      const status = await asAdmin(async (q) => (await one<{ s: string }>(q, "select status::text as s from public.organizations where id = $1", [org])).s);
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        expect(await retry()).toBe(0);
      } finally {
        await asAdmin((q) => q("update public.organizations set status = $2::public.org_status where id = $1", [org, status]));
      }
      expect((await retries("payment_id = $2", [a]))[0]).toMatchObject({ attempts: 0, done: false, given_up: true });
      expect(await notices(GAVE_UP, c)).toBe(2);
      expect(await retry()).toBe(0);
      expect(await cardsOf(c)).toBe(0);
    });
    it("no plan key, or no punch card line: a payment or an allocation never waits on a key and leaves nothing (re-review N1)", async () => {
      const c = await contact("בלי כרטיסייה");
      const service = await run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.products (organization_id, name, kind, price_agorot) values ($1, 'שירות רגיל', 'service', 10000) returning id", [org])).id,
      );
      const serviceOrder = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, c])).id);
      await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'שירות', $3, 10000, 1)", [org, serviceOrder, service]));
      await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, serviceOrder]));
      const punchOrder = await order(c, 1);
      const rows = () => asAdmin((q) => count(q, "select 1 from app.punch_card_retries where organization_id = $1 and order_id = any ($2)", [org, [serviceOrder, punchOrder]]));
      // an order with no punch card line: its key is held, the payment and an allocation pass at once
      const invoice = await run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, order_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, 11800) returning id",
            [org, c, serviceOrder, `SV-${Date.now()}`],
          )
        ).id,
      );
      const loose = await pay(c, 20000);
      await asAdmin(async (q) => {
        await holdKeys(q, serviceOrder, null);
        await payTimedOut(c, serviceOrder);
        await run(owner, async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          await q2("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 11800)", [org, loose, invoice]);
        });
      });
      // without the plan key, an order with a punch card line: the same
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
      try {
        await asAdmin(async (q) => {
          await holdKeys(q, punchOrder, null);
          await payTimedOut(c, punchOrder);
        });
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
      }
      expect(await rows()).toBe(0);
      expect(await notices(FAILED, c)).toBe(0);
      expect(await cardsOf(c)).toBe(0);
    });

    it("one event's rows tell their empty end once; a business that lost the key closes them silently (re-review N2, N3)", async () => {
      const c = await contact("אירוע אחד");
      const o1 = await order(c, 1);
      const o2 = await order(c, 1);
      // one payment linked to one order and an advance of another: one failure, two rows
      const p = await asAdmin(async (q) => {
        await holdKeys(q, o1, null);
        await holdKeys(q, o2, null);
        return run(owner, async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          return (
            await one<{ id: string }>(
              q2,
              "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method, is_advance, advance_order_id) values ($1, $2, $3, 100000, current_date, 'cash', true, $4) returning id",
              [org, c, o1, o2],
            )
          ).id;
        });
      });
      expect(await retries("payment_id = $2", [p])).toHaveLength(2);
      expect(await notices(FAILED, c)).toBe(2);
      await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'נרשם בטעות' where id = $1", [p]));
      await due("payment_id = $2", [p]);
      // the first row ends while its sibling waits: no notice yet; the second ends the event: one notice
      expect(await retry(1)).toBe(1);
      expect(await notices(EMPTY, c)).toBe(0);
      expect(await retry(1)).toBe(1);
      expect(await notices(EMPTY, c)).toBe(2);
      // the plan key is gone before the retry: the row is closed, no card, no notice
      const d = await contact("המפתח הוסר");
      const o3 = await order(d, 1);
      const a = await asAdmin(async (q) => {
        await holdKeys(q, o3, null);
        return payTimedOut(d, o3);
      });
      await due("payment_id = $2", [a]);
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
      try {
        expect(await retry()).toBe(1);
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
      }
      expect((await retries("payment_id = $2", [a]))[0]).toMatchObject({ done: true, attempts: 0 });
      expect(await notices(EMPTY, d)).toBe(0);
      expect(await cardsOf(d)).toBe(0);
    });
    it("one event's rows given up tell it once; every punch card helper has no grant (re-review N2 follow-up)", async () => {
      const c = await contact("ויתור על אירוע");
      const o1 = await order(c, 1);
      const o2 = await order(c, 1);
      const p = await asAdmin(async (q) => {
        await holdKeys(q, o1, null);
        await holdKeys(q, o2, null);
        return run(owner, async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          return (
            await one<{ id: string }>(
              q2,
              "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method, is_advance, advance_order_id) values ($1, $2, $3, 100000, current_date, 'cash', true, $4) returning id",
              [org, c, o1, o2],
            )
          ).id;
        });
      });
      expect(await retries("payment_id = $2", [p])).toHaveLength(2);
      // both rows reach the end of the window while the keys are still held: both are given up, the event is told once
      await asAdmin((q) =>
        q("update app.punch_card_retries set created_at = created_at - interval '3 days', next_try_at = now() - interval '1 second' where organization_id = $1 and payment_id = $2", [org, p]),
      );
      await asAdmin(async (q) => {
        await holdKeys(q, o1, null);
        await holdKeys(q, o2, null);
        expect(await retry(1)).toBe(0);
        expect(await notices(GAVE_UP, c)).toBe(0);
        expect(await retry(1)).toBe(0);
      });
      expect((await retries("payment_id = $2", [p])).map((r) => r.given_up)).toEqual([true, true]);
      const recipients = await asAdmin(async (q) =>
        (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and title = $2 and entity_id = $3 order by user_id", [org, GAVE_UP, c])).rows.map((r) => r.user_id),
      );
      expect(recipients).toEqual([owner.id, admin.id].sort());
      expect(await notices(EMPTY, c)).toBe(0);
      // no API role executes any punch card helper of schema app
      const granted = await asAdmin(async (q) =>
        (
          await q<{ name: string }>(
            `select p.proname as name from pg_proc p
              where p.pronamespace = 'app'::regnamespace and p.proname like '%punch%'
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                     or has_function_privilege('service_role', p.oid, 'execute'))`,
          )
        ).rows.map((r) => r.name),
      );
      expect(granted).toEqual([]);
      const helpers = await asAdmin(async (q) =>
        (await q<{ name: string }>("select proname as name from pg_proc where pronamespace = 'app'::regnamespace and proname = any ($1)", [["punch_doc_has_lines", "punch_card_retry_event_end", "punch_card_retry_record", "retry_punch_card_openings"]])).rows.map((r) => r.name).sort(),
      );
      expect(helpers).toEqual(["punch_card_retry_event_end", "punch_card_retry_record", "punch_doc_has_lines", "retry_punch_card_openings"]);
    });
    it("a part-success still tells a sibling's give-up; a key-lost close tells an earlier give-up (final review F1, F2)", async () => {
      const twoOrders = async (name: string) => {
        const c = await contact(name);
        const o1 = await order(c, 1);
        const o2 = await order(c, 1);
        const p = await asAdmin(async (q) => {
          await holdKeys(q, o1, null);
          await holdKeys(q, o2, null);
          return run(owner, async (q2) => {
            await q2("set local lock_timeout = '300ms'");
            return (
              await one<{ id: string }>(
                q2,
                "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method, is_advance, advance_order_id) values ($1, $2, $3, 100000, current_date, 'cash', true, $4) returning id",
                [org, c, o1, o2],
              )
            ).id;
          });
        });
        await asAdmin((q) => q("update app.punch_card_retries set created_at = created_at - interval '3 days' where organization_id = $1 and payment_id = $2", [org, p]));
        return { c, o1, o2, p };
      };
      // F1: the order opens on the retry, the advance's order is still held and is given up: one give-up notice
      const a = await twoOrders("חלקי");
      await due("payment_id = $2", [a.p]);
      await asAdmin(async (q) => {
        await holdKeys(q, a.o2, null);
        expect(await retry()).toBe(1);
      });
      expect(await cardsOf(a.c)).toBe(1);
      expect(await notices(GAVE_UP, a.c)).toBe(2);
      expect(await notices(EMPTY, a.c)).toBe(0);
      // F1, an acceptance: two payments' rows of one quote; the first opens, the second's payment row is held and is given up
      const c = await contact("קבלה חלקית");
      const quote = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה', $2) returning id", [org, c])).id);
      await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, product_id, unit_price_agorot, quantity) values ($1, $2, 'כרטיסייה', $3, 10000, 2)", [org, quote, product]));
      await run(owner, (q) => q("select public.quote_send($1, $2)", [org, quote]));
      const advance = () =>
        run(owner, async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id) values ($1, $2, 20000, current_date, 'cash', true, $3) returning id",
              [org, c, quote],
            )
          ).id,
        );
      const p1 = await advance();
      const p2 = await advance();
      // the acceptance itself is held at the chain key (one quote row), then the event's rows are arranged per payment
      await asAdmin(async (q) => {
        await holdKeys(q, null, quote);
        await asAdmin(async (q2) => {
          await q2("set local lock_timeout = '300ms'");
          await q2("update public.quotes set status = 'accepted' where id = $1", [quote]);
        });
      });
      await asAdmin(async (q) => {
        await q("update app.punch_card_retries set done_at = now() where organization_id = $1 and quote_id = $2", [org, quote]);
        await q("select app.punch_card_retry_record($1, 'open', $2, null, $3, null, 'link', '55P03')", [org, p1, quote]);
        await q("select app.punch_card_retry_record($1, 'open', $2, null, $3, null, 'link', '55P03')", [org, p2, quote]);
        await q("update app.punch_card_retries set created_at = created_at - interval '3 days', next_try_at = now() - interval '1 second' where organization_id = $1 and quote_id = $2 and kind = 'open'", [org, quote]);
      });
      await asAdmin(async (q) => {
        await q("select 1 from public.payments where id = $1 for update", [p2]);
        expect(await retry()).toBe(1);
      });
      expect(await cardsOf(c)).toBe(1);
      expect(await notices(GAVE_UP, c)).toBe(2);
      expect(await notices(EMPTY, c)).toBe(0);
      // F2: the advance's row is given up while the order's row still waits (no notice yet); the business then loses the
      // key and the waiting row is closed silently, which tells the earlier give-up once
      const b = await twoOrders("מפתח אבד אחרי ויתור");
      await asAdmin((q) =>
        q(
          `update app.punch_card_retries set next_try_at = case when order_id = $3 then now() - interval '1 second' else now() + interval '1 hour' end
            where organization_id = $1 and payment_id = $2`,
          [org, b.p, b.o2],
        ),
      );
      await asAdmin(async (q) => {
        await holdKeys(q, b.o2, null);
        expect(await retry()).toBe(0);
      });
      expect(await notices(GAVE_UP, b.c)).toBe(0);
      await due("payment_id = $2 and order_id = $3", [b.p, b.o1]);
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"punch_cards\": false}' where organization_id = $1", [org]));
      try {
        expect(await retry()).toBe(1);
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
      }
      expect((await retries("payment_id = $2", [b.p])).map((r) => [r.done, r.given_up]).sort()).toEqual([
        [false, true],
        [true, false],
      ]);
      expect(await notices(GAVE_UP, b.c)).toBe(2);
      expect(await notices(EMPTY, b.c)).toBe(0);
      expect(await cardsOf(b.c)).toBe(0);
      // the sibling read is served by indexes, not a scan of a table that is never pruned
      for (const [col, val, index] of [
        ["payment_id", b.p, "punch_card_retries_payment_idx"],
        ["quote_id", quote, "punch_card_retries_quote_idx"],
      ] as const) {
        const plan = await asAdmin(async (q) => {
          await q("set local enable_seqscan = off");
          return (
            await q<{ "QUERY PLAN": string }>(`explain select 1 from app.punch_card_retries r where r.organization_id = $1 and r.${col} = $2 and r.created_at = now()`, [org, val])
          ).rows
            .map((r) => r["QUERY PLAN"])
            .join("\n");
        });
        expect(plan).toContain(index);
        expect(plan).not.toContain("Seq Scan");
      }
    });
  });
});
