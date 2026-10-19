import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type OrderRow = {
  id: string;
  status: string;
  source: string;
  number: string | null;
  number_display: string | null;
  quote_id: string | null;
  original_order_id: string | null;
  deal_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  owner_id: string | null;
  shipping_address: string | null;
  notes: string | null;
  prices_include_vat: boolean;
  vat_rate_bp: number | null;
  net_total_agorot: string;
  vat_agorot: string;
  total_agorot: string;
  customer_name: string | null;
  former_contact_id: string | null;
  former_deal_id: string | null;
  customer_deleted_at: string | null;
  cancelled_at: string | null;
};

/**
 * ORD-01 / ORD-03 / ORD-02's status (owner, 19 October 2026): a manual order is a draft and is numbered on confirmation;
 * an order from an accepted quote or a won deal is created numbered. Numbers come from the gap-free 'order' series; a
 * numbered order is never deleted, only cancelled. An order from a quote keeps its lines and prices; one per quote; an
 * accepted addendum is its own order linked to the original's. Rights follow the deal / contact / company, like quotes.
 */
describe("orders (ORD-01, ORD-03)", () => {
  let owner: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, openStage: string, wonStage: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const order = (id: string) => asAdmin((q) => one<OrderRow>(q, "select * from public.orders where id = $1", [id]));
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));

  const newCompany = (u: U, name: string, shipping: string | null = null) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id, shipping_address) values ($1, $2, $3, $4) returning id", [org, name, u.id, shipping])).id);
  const newContact = (u: U, name: string, company: string | null = null, shipping: string | null = null) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id, shipping_address) values ($1, $2, $3, $4, $5) returning id", [
          org,
          name,
          company,
          u.id,
          shipping,
        ])
      ).id,
    );
  const newDeal = (u: U, contact: string | null, stage = openStage) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          stage,
          contact,
          u.id,
        ])
      ).id,
    );
  const draft = (u: U, fields: Record<string, unknown>) =>
    run(u, async (q) => {
      const keys = Object.keys(fields);
      return (
        await one<{ id: string }>(
          q,
          `insert into public.orders (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
          [org, ...Object.values(fields)],
        )
      ).id;
    });
  const addLine = (u: U, orderId: string, name = "עבודה", price = 10000, quantity = 1) =>
    run(u, (q) => q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, $3, $4, $5)", [org, orderId, name, price, quantity]));
  const confirm = (u: U, orderId: string) => run(u, async (q) => (await one<{ r: { number: string } }>(q, "select public.order_confirm($1, $2) as r", [org, orderId])).r);
  const fromQuote = (u: U, quote: string) => run(u, async (q) => (await one<{ id: string }>(q, "select public.order_from_quote($1, $2) as id", [org, quote])).id);
  const fromDeal = (u: U, deal: string) => run(u, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, deal])).id);
  const acceptedQuote = async (deal: string, contact: string, lines: { name: string; price: number; optional?: boolean; selected?: boolean }[]) => {
    const id = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, valid_until) values ($1, 'הצעה', $2, $3, current_date + 14) returning id", [org, deal, contact])).id,
    );
    for (const [i, l] of lines.entries()) {
      await run(member, (q) =>
        q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot, is_optional, optional_selected) values ($1, $2, $3, $4, $5, $6, $7)", [
          org,
          id,
          i,
          l.name,
          l.price,
          l.optional ?? false,
          l.selected ?? false,
        ]),
      );
    }
    await run(member, (q) => q("select public.quote_send($1, $2)", [org, id]));
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [id]));
    return id;
  };
  const purge = async (table: "contacts" | "deals" | "companies", id: string) => {
    await run(owner, (q) => q(`update public.${table} set deleted_at = now() where id = $1`, [id]));
    expect(await run(owner, async (q) => (await q(`delete from public.${table} where id = $1`, [id])).rowCount)).toBe(1);
  };

  beforeAll(async () => {
    owner = await createUser("ord-owner");
    org = await createOrg(owner.id, "עסק ההזמנות");
    member = await addMember(org, owner.id, "member", "ord-member");
    other = await addMember(org, owner.id, "member", "ord-other");
    viewer = await addMember(org, owner.id, "viewer", "ord-viewer");
    outsider = await createUser("ord-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    await setFeatures({ orders: true });
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
  });

  it("a manual order is a draft with no number; confirming numbers it from the gap-free series", async () => {
    const company = await newCompany(member, "חברת הבנייה", "רחוב החברה 1");
    const contact = await newContact(member, "דנה", company, "רחוב הלקוחה 5");
    const id = await draft(member, { contact_id: contact, notes: "להתקשר לפני" });
    const row = await order(id);
    // the server sets the rest: contact's company, its shipping address copied once, the owner, no number
    expect(row).toMatchObject({ status: "draft", source: "manual", number: null, contact_id: contact, company_id: company, owner_id: member.id, shipping_address: "רחוב הלקוחה 5", vat_rate_bp: 1800 });
    // a company-only order takes the company's address
    const byCompany = await draft(member, { company_id: company });
    expect((await order(byCompany)).shipping_address).toBe("רחוב החברה 1");

    // a status cannot be sent on insert, nor set while a draft
    expect((await pgError(draft(member, { contact_id: contact, status: "new" }))).code).toBe("42501");
    expect((await pgError(run(member, (q) => q("update public.orders set status = 'new' where id = $1", [id])))).hint).toBe("order:confirm");

    // an empty draft cannot be confirmed
    expect((await pgError(confirm(member, id))).hint).toBe("order:empty");
    await addLine(member, id, "עבודה", 10000, 2);
    expect(await order(id)).toMatchObject({ net_total_agorot: "20000", vat_agorot: "3600", total_agorot: "23600" });

    const first = await confirm(member, id);
    const after = await order(id);
    expect(after).toMatchObject({ status: "new", number_display: first.number, customer_name: "חברת הבנייה" });
    // the next one takes the next number
    await addLine(member, byCompany);
    const second = await confirm(member, byCompany);
    expect(Number((await order(byCompany)).number)).toBe(Number(after.number) + 1);
    expect(second.number).not.toBe(first.number);
    // twice is refused
    expect((await pgError(confirm(member, id))).hint).toBe("order:frozen");
  });

  it("a numbered order keeps its lines, prices and customer; it moves through the states and is never deleted, only cancelled", async () => {
    const contact = await newContact(member, "רון");
    const id = await draft(member, { contact_id: contact });
    await addLine(member, id);
    await confirm(member, id);
    const line = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.order_lines where order_id = $1", [id])).id);

    expect((await pgError(addLine(member, id))).hint).toBe("order:frozen");
    // RLS writes a draft's lines only: the update finds nothing
    expect(await run(member, async (q) => (await q("update public.order_lines set unit_price_agorot = 1 where id = $1", [line])).rowCount)).toBe(0);
    expect((await pgError(run(member, (q) => q("update public.orders set discount_bp = 1000 where id = $1", [id])))).hint).toBe("order:frozen");
    const another = await newContact(member, "אחר");
    expect((await pgError(run(member, (q) => q("update public.orders set contact_id = $2 where id = $1", [id, another])))).hint).toBe("order:frozen");
    // a numbered order's lines are not deleted by a person (RLS: drafts only)
    expect(await run(member, async (q) => (await q("delete from public.order_lines where id = $1", [line])).rowCount)).toBe(0);

    // delivery details stay editable
    await run(member, (q) => q("update public.orders set delivery_date = current_date + 3, shipping_address = 'כתובת חדשה', notes = 'דחוף' where id = $1", [id]));
    expect((await order(id)).shipping_address).toBe("כתובת חדשה");

    for (const s of ["in_progress", "partly_delivered", "delivered"]) {
      await run(member, (q) => q("update public.orders set status = $2 where id = $1", [id, s]));
      expect((await order(id)).status).toBe(s);
    }
    expect((await pgError(run(member, (q) => q("update public.orders set status = 'draft' where id = $1", [id])))).hint).toBe("order:no_redraft");
    // not deleted: by a person (policy) nor by the server's own role
    expect(await run(owner, async (q) => (await q("delete from public.orders where id = $1", [id])).rowCount)).toBe(0);
    expect((await pgError(asAdmin((q) => q("delete from public.orders where id = $1", [id])))).hint).toBe("order:numbered");

    await run(member, (q) => q("update public.orders set status = 'cancelled' where id = $1", [id]));
    expect((await order(id)).cancelled_at).not.toBeNull();
    expect((await pgError(run(member, (q) => q("update public.orders set status = 'new' where id = $1", [id])))).hint).toBe("order:cancelled");

    // a draft is deleted, with its lines
    const d = await draft(member, { contact_id: contact });
    await addLine(member, d);
    expect(await run(member, async (q) => (await q("delete from public.orders where id = $1", [d])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.order_lines where order_id = $1", [d]))).toBe(0);
  });

  it("an order from an accepted quote is numbered at once with the accepted lines and prices; one per quote; an addendum links to it", async () => {
    const contact = await newContact(member, "שירה");
    const deal = await newDeal(member, contact);
    const quote = await acceptedQuote(deal, contact, [
      { name: "עבודה", price: 50000 },
      { name: "תוספת שנבחרה", price: 10000, optional: true, selected: true },
      { name: "תוספת שלא נבחרה", price: 99999, optional: true },
    ]);
    // not accepted yet → refused
    const qRow = await asAdmin((q) => one<{ total_agorot: string; vat_rate_bp: number }>(q, "select total_agorot::text, vat_rate_bp from public.quotes where id = $1", [quote]));

    // the business's VAT rate changes later: the order keeps the quote's
    const id = await fromQuote(member, quote);
    const row = await order(id);
    expect(row).toMatchObject({ status: "new", source: "quote", quote_id: quote, deal_id: deal, contact_id: contact, vat_rate_bp: qRow.vat_rate_bp, total_agorot: qRow.total_agorot });
    expect(row.number).not.toBeNull();
    const names = await asAdmin(async (q) => (await q<{ name: string }>("select name from public.order_lines where order_id = $1 order by position", [id])).rows.map((r) => r.name));
    expect(names).toEqual(["עבודה", "תוספת שנבחרה"]);

    // one order per quote
    expect((await pgError(fromQuote(member, quote))).hint).toBe("order:exists");
    // the deal has an accepted quote: ordering from the deal goes through it
    await asAdmin((q) => q("update public.deals set stage_id = $2 where id = $1", [deal, wonStage]));
    expect((await pgError(fromDeal(member, deal))).hint).toBe("order:use_quote");

    // an accepted addendum is its own order, linked to the original's
    const addendum = await run(member, async (q) => (await one<{ a: string }>(q, "select public.quote_new_addendum($1, $2) as a", [org, quote])).a);
    await run(member, (q) => q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'מדף', 2000)", [org, addendum]));
    await run(member, (q) => q("select public.quote_send($1, $2)", [org, addendum]));
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [addendum]));
    const second = await fromQuote(member, addendum);
    expect(await order(second)).toMatchObject({ source: "quote", quote_id: addendum, original_order_id: id });
    expect(Number((await order(second)).number)).toBe(Number(row.number) + 1);
  });

  it("refuses a quote that is not accepted, and a person without the right or the plan", async () => {
    const contact = await newContact(member, "עמית");
    const deal = await newDeal(member, contact);
    const quote = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [org, deal, contact])).id,
    );
    expect((await pgError(fromQuote(member, quote))).hint).toBe("order:quote_not_accepted");
    // a colleague who does not read the deal (visibility 'own'), a viewer, an outsider
    expect((await pgError(fromQuote(other, quote))).code).toBe("42501");
    expect((await pgError(fromQuote(viewer, quote))).code).toBe("42501");
    expect((await pgError(fromQuote(outsider, quote))).code).toBe("42501");
    // no plan key
    await setFeatures({ orders: false });
    try {
      expect((await pgError(draft(member, { contact_id: contact }))).hint).toBe("feature:orders");
      expect((await pgError(fromDeal(member, deal))).hint).toBe("feature:orders");
    } finally {
      await setFeatures({ orders: true });
    }
  });

  it("an order from a won deal copies its lines as they are (price, VAT mode, billing); one per deal while not cancelled", async () => {
    const contact = await newContact(member, "יעל");
    const deal = await newDeal(member, contact);
    await run(member, (q) =>
      q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity, billing) values ($1, $2, 'שירות חודשי', 30000, 2, 'monthly')", [org, deal]),
    );
    expect((await pgError(fromDeal(member, deal))).hint).toBe("order:deal_not_won");
    await run(member, (q) => q("update public.deals set stage_id = $2 where id = $1", [deal, wonStage]));
    const id = await fromDeal(member, deal);
    expect(await order(id)).toMatchObject({ status: "new", source: "deal", deal_id: deal, contact_id: contact, prices_include_vat: false, net_total_agorot: "60000", total_agorot: "70800" });
    const line = await asAdmin((q) => one<{ name: string; billing: string; quantity: string; unit_price_agorot: string }>(q, "select name, billing, quantity::text, unit_price_agorot::text from public.order_lines where order_id = $1", [id]));
    expect(line).toEqual({ name: "שירות חודשי", billing: "monthly", quantity: "2", unit_price_agorot: "30000" });
    expect((await pgError(fromDeal(member, deal))).hint).toBe("order:exists");
    await run(member, (q) => q("update public.orders set status = 'cancelled' where id = $1", [id]));
    expect(await fromDeal(member, deal)).not.toBe(id);
  });

  it("rights follow the deal / contact / company: a viewer reads only, a colleague who does not read it sees nothing, an outsider nothing", async () => {
    const contact = await newContact(member, "ליאור");
    const id = await draft(member, { contact_id: contact });
    await addLine(member, id);
    // owner (admin role) edits; viewer reads (visibility 'own' → the viewer reads nothing of member's records)
    expect(await run(owner, async (q) => (await q("update public.orders set notes = 'x' where id = $1", [id])).rowCount)).toBe(1);
    expect(await run(other, (q) => count(q, "select 1 from public.orders where id = $1", [id]))).toBe(0);
    expect(await run(other, async (q) => (await q("update public.orders set notes = 'y' where id = $1", [id])).rowCount)).toBe(0);
    expect(await run(other, async (q) => (await q("delete from public.orders where id = $1", [id])).rowCount)).toBe(0);
    expect(await run(outsider, (q) => count(q, "select 1 from public.orders where id = $1", [id]))).toBe(0);
    expect(await run(outsider, (q) => count(q, "select 1 from public.order_lines where order_id = $1", [id]))).toBe(0);
    expect((await pgError(confirm(outsider, id))).code).toBe("42501");

    await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    try {
      expect(await run(viewer, (q) => count(q, "select 1 from public.orders where id = $1", [id]))).toBe(1);
      expect(await run(viewer, (q) => count(q, "select 1 from public.order_lines where order_id = $1", [id]))).toBe(1);
      expect(await run(viewer, async (q) => (await q("update public.orders set notes = 'v' where id = $1", [id])).rowCount)).toBe(0);
      expect((await pgError(draft(viewer, { contact_id: contact }))).code).toBe("42501");
      expect((await pgError(addLine(viewer, id))).code).toBe("42501");
      expect((await pgError(confirm(viewer, id))).code).toBe("42501");
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    }
    // a contact of another business cannot be linked (composite FK)
    const foreign = await asUser(outsider.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'זר') returning id", [otherOrg])).id,
    );
    const refused = await pgError(draft(member, { contact_id: foreign }));
    expect(refused.code === "42501" || refused.hint === "order:contact").toBe(true);
  });

  it("a read-only business reads its orders but writes nothing", async () => {
    const contact = await newContact(member, "קריאה");
    const id = await draft(member, { contact_id: contact });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await run(member, (q) => count(q, "select 1 from public.orders where id = $1", [id]))).toBe(1);
      expect(await run(owner, async (q) => (await q("update public.orders set notes = 'x' where id = $1", [id])).rowCount)).toBe(0);
      expect((await pgError(addLine(owner, id))).code).toBe("42501");
      expect((await pgError(confirm(owner, id))).code).toBe("42501");
      expect((await pgError(draft(owner, { contact_id: contact }))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a person's order needs a customer; a hidden or binned contact is not linked", async () => {
    expect((await pgError(draft(member, { notes: "בלי לקוח" }))).code).toBe("42501");
    const mine = await newContact(member, "שלי");
    const hidden = await newContact(other, "של אחר");
    const id = await draft(member, { contact_id: mine });
    expect((await pgError(run(member, (q) => q("update public.orders set delivery_contact_id = $2 where id = $1", [id, hidden])))).hint).toBe("order:contact");
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [mine]));
    const binned = await pgError(draft(member, { contact_id: mine }));
    expect(binned.code === "42501" || binned.hint === "order:contact").toBe(true);
  });

  it("a purge never removes a numbered order: it is detached; a draft goes with its record", async () => {
    const contact = await newContact(member, "מיכל");
    const numbered = await draft(member, { contact_id: contact });
    await addLine(member, numbered);
    await confirm(member, numbered);
    const lone = await draft(member, { contact_id: contact });
    await purge("contacts", contact);
    expect(await order(numbered)).toMatchObject({ contact_id: null, former_contact_id: contact });
    expect((await order(numbered)).customer_deleted_at).not.toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from public.orders where id = $1", [lone]))).toBe(0);
    // a detached order is read by owners, admins and managers only
    expect(await run(owner, (q) => count(q, "select 1 from public.orders where id = $1", [numbered]))).toBe(1);
    expect(await run(member, (q) => count(q, "select 1 from public.orders where id = $1", [numbered]))).toBe(0);
  });

  it("privacy erasure empties a detached order's personal details and its lines' free text", async () => {
    const contact = await newContact(member, "אורית", null, "הרחוב של אורית 7");
    const id = await draft(member, { contact_id: contact, notes: "אורית ביקשה" });
    await addLine(member, id, "שורה עם שם אורית");
    await confirm(member, id);
    await purge("contacts", contact);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    expect(await order(id)).toMatchObject({ customer_name: null, shipping_address: null, notes: null, former_contact_id: contact });
    expect((await order(id)).number).not.toBeNull();
    const line = await asAdmin((q) => one<{ name: string; total_agorot: string }>(q, "select name, total_agorot::text from public.order_lines where order_id = $1", [id]));
    expect(line).toEqual({ name: "שורה", total_agorot: "10000" });
    const left = await asAdmin(async (q) =>
      (
        await q<{ changes: unknown }>(
          "select changes from public.audit_log where organization_id = $1 and entity_type in ('orders', 'order_lines') and (entity_id = $2 or changes::text like '%אורית%')",
          [org, id],
        )
      ).rows,
    );
    expect(JSON.stringify(left)).not.toContain("אורית");
  });

  it("a merge carries the duplicate's orders to the kept contact", async () => {
    const keep = await newContact(owner, "נועם");
    const dup = await newContact(owner, "נועם כפול");
    const id = await draft(owner, { contact_id: dup, delivery_contact_id: dup });
    await addLine(owner, id);
    await confirm(owner, id);
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    expect(await order(id)).toMatchObject({ contact_id: keep, status: "new" });
    expect(await asAdmin(async (q) => (await one<{ d: string }>(q, "select delivery_contact_id as d from public.orders where id = $1", [id])).d)).toBe(keep);
  });

  it("the module switch needs the plan's orders key; a member cannot turn it on", async () => {
    await setFeatures({ orders: false });
    expect((await pgError(run(owner, (q) => q("insert into public.org_modules (organization_id, orders_enabled) values ($1, true)", [org])))).hint).toBe("feature:orders");
    await setFeatures({ orders: true });
    await run(owner, (q) => q("insert into public.org_modules (organization_id, orders_enabled) values ($1, true) on conflict (organization_id) do update set orders_enabled = true", [org]));
    expect(await asAdmin(async (q) => (await one<{ e: boolean }>(q, "select orders_enabled as e from public.org_modules where organization_id = $1", [org])).e)).toBe(true);
    expect(await run(member, async (q) => (await q("update public.org_modules set orders_enabled = false where organization_id = $1", [org])).rowCount)).toBe(0);
    // turning it off leaves the orders in place
    const before = await asAdmin((q) => count(q, "select 1 from public.orders where organization_id = $1", [org]));
    await run(owner, (q) => q("update public.org_modules set orders_enabled = false where organization_id = $1", [org]));
    expect(await asAdmin((q) => count(q, "select 1 from public.orders where organization_id = $1", [org]))).toBe(before);
  });

  it("a sample contact with an order is real work and is kept (USR-04); an imported contact with an order is not undone", async () => {
    const o = await createUser("ord-sample");
    const id = await createOrg(o.id, "עסק דוגמה");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"orders\": true}' where organization_id = $1", [id]));
    await asUser(o.id, (q) => q("select public.sample_data_add($1)", [id]));
    const contact = await asAdmin(async (q) => (await one<{ contact_id: string }>(q, "select contact_id from app.sample_records where organization_id = $1 and contact_id is not null limit 1", [id])).contact_id);
    await asUser(o.id, (q) => q("insert into public.orders (organization_id, contact_id) values ($1, $2)", [id, contact]));
    await asUser(o.id, (q) => q("select public.sample_data_remove($1)", [id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1", [contact]))).toBe(1);
    expect(await asAdmin((q) => one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 hour', null) as w", [id, contact]))).toEqual({ w: true });
  });
});
