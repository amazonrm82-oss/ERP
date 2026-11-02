import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Part = { name: string; quantity: number; unit_name: string | null };

/**
 * PRD-09: a bundle is a product of kind 'bundle' made of other products with quantities (product_bundle_items). No nesting,
 * no self, at most 50 parts; the catalog's rights and the 'products' capability. A bundle line on a deal, quote or order has a
 * display choice (single | itemised); quote and order lines keep the parts as they were when the line was added, so a later
 * change of the bundle never changes a sent quote or a numbered order. The customer's pages list an itemised bundle's parts.
 */
describe("bundles (PRD-09)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, openStage: string;
  let bundle: string, part1: string, part2: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const newProduct = (name: string, kind = "product", price = 10000) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.products (organization_id, name, kind, price_agorot) values ($1, $2, $3, $4) returning id", [org, name, kind, price])).id);
  const addPart = (u: U, b: string, c: string, quantity: number | string = 1, position = 0) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.product_bundle_items (organization_id, bundle_id, component_id, quantity, position) values ($1, $2, $3, $4, $5) returning id", [
          org,
          b,
          c,
          quantity,
          position,
        ])
      ).id,
    );
  const newDeal = () =>
    run(member, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          openStage,
          member.id,
        ])
      ).id,
    );

  beforeAll(async () => {
    owner = await createUser("prd09-owner");
    org = await createOrg(owner.id, "עסק החבילות");
    member = await addMember(org, owner.id, "member", "prd09-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    await setFeatures({ orders: true, quotes: true, products: true });
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    bundle = await newProduct("חבילת התקנה", "bundle", 50000);
    part1 = await newProduct("מזגן");
    part2 = await newProduct("התקנה", "service", 20000);
  });

  it("a bundle is made of other products; members read the parts; only catalog editors write them", async () => {
    await addPart(owner, bundle, part1, 2, 0);
    await addPart(owner, bundle, part2, "1.5", 1);
    const parts = await run(member, async (q) =>
      (await q<{ c: string; n: string }>("select component_id as c, quantity::text as n from public.product_bundle_items where bundle_id = $1 order by position", [bundle])).rows,
    );
    expect(parts).toEqual([
      { c: part1, n: "2" },
      { c: part2, n: "1.5" },
    ]);
    // a member may not add, change or remove a part
    const extra = await newProduct("שלט");
    expect((await pgError(addPart(member, bundle, extra))).code).toBe("42501");
    expect(await run(member, async (q) => (await q("update public.product_bundle_items set quantity = 9 where bundle_id = $1", [bundle])).rowCount)).toBe(0);
    expect(await run(member, async (q) => (await q("delete from public.product_bundle_items where bundle_id = $1", [bundle])).rowCount)).toBe(0);
    // the bundle and the part are fixed once added (no column grant)
    expect((await pgError(run(owner, (q) => q("update public.product_bundle_items set component_id = $2 where bundle_id = $1", [bundle, extra])))).code).toBe("42501");
    // the same part once; quantity above zero, three decimals
    expect((await pgError(addPart(owner, bundle, part1))).code).toBe("23505");
    expect((await pgError(addPart(owner, bundle, extra, 0))).code).toBe("23514");
    expect((await pgError(addPart(owner, bundle, extra, "0.0001"))).code).toBe("23514");
  });

  it("no nesting, no self; only a bundle has parts; an offerable part; the plan's products capability", async () => {
    const other = await newProduct("חבילה אחרת", "bundle");
    expect((await pgError(addPart(owner, other, bundle))).hint).toBe("product_bundle:nested");
    expect((await pgError(addPart(owner, bundle, bundle))).hint).toBe("product_bundle:nested");
    expect((await pgError(addPart(owner, part1, part2))).hint).toBe("product_bundle:not_bundle");
    // a bundle with parts stays a bundle; a part never becomes a bundle
    expect((await pgError(run(owner, (q) => q("update public.products set kind = 'product' where id = $1", [bundle])))).hint).toBe("product_bundle:has_items");
    expect((await pgError(run(owner, (q) => q("update public.products set kind = 'bundle' where id = $1", [part1])))).hint).toBe("product_bundle:nested");
    // an empty bundle may change its kind
    await run(owner, (q) => q("update public.products set kind = 'product' where id = $1", [other]));
    // an archived or inactive product is not added; one archived later stays
    const archived = await newProduct("ישן");
    await run(owner, (q) => q("update public.products set archived_at = now() where id = $1", [archived]));
    const fresh = await newProduct("חבילה חדשה", "bundle");
    expect((await pgError(addPart(owner, fresh, archived))).hint).toBe("product_bundle:component");
    // a part cannot be removed from the catalog, only archived
    expect((await pgError(run(owner, (q) => q("delete from public.products where id = $1", [part2])))).code).toBe("23503");
    // without the capability nothing is added
    await setFeatures({ orders: true, quotes: true, products: false });
    try {
      expect((await pgError(addPart(owner, fresh, part1))).hint).toBe("feature:products");
    } finally {
      await setFeatures({ orders: true, quotes: true, products: true });
    }
    // removing a bundle removes its parts
    await addPart(owner, fresh, part1);
    await run(owner, (q) => q("delete from public.products where id = $1", [fresh]));
    expect(await asAdmin(async (q) => (await q("select 1 from public.product_bundle_items where bundle_id = $1", [fresh])).rowCount)).toBe(0);
  });

  it("at most 50 parts in a bundle", async () => {
    const big = await newProduct("חבילה גדולה", "bundle");
    const ids = await run(owner, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.products (organization_id, name) select $1, 'רכיב ' || g from generate_series(1, 51) g returning id",
          [org],
        )
      ).rows.map((r) => r.id),
    );
    for (const id of ids.slice(0, 50)) await addPart(owner, big, id);
    expect((await pgError(addPart(owner, big, ids[50]))).hint).toBe("product_bundle:max");
  });

  it("a deal line of a bundle has a display choice; other lines have none", async () => {
    const deal = await newDeal();
    const lines = await run(member, async (q) => {
      const b = (
        await one<{ d: string | null }>(
          q,
          "insert into public.deal_lines (organization_id, deal_id, product_id, description, price_source, unit_price_agorot) values ($1, $2, $3, 'חבילה', 'product', 50000) returning bundle_display as d",
          [org, deal, bundle],
        )
      ).d;
      const p = (
        await one<{ d: string | null }>(
          q,
          "insert into public.deal_lines (organization_id, deal_id, product_id, description, price_source, bundle_display) values ($1, $2, $3, 'מזגן', 'product', 'itemised') returning bundle_display as d",
          [org, deal, part1],
        )
      ).d;
      await q("update public.deal_lines set bundle_display = 'itemised' where deal_id = $1 and product_id = $2", [deal, bundle]);
      const after = (await one<{ d: string }>(q, "select bundle_display as d from public.deal_lines where deal_id = $1 and product_id = $2", [deal, bundle])).d;
      return { b, p, after };
    });
    expect(lines).toEqual({ b: "single", p: null, after: "itemised" });
    expect((await pgError(run(member, (q) => q("update public.deal_lines set bundle_display = 'x' where deal_id = $1", [deal])))).code).toBe("23514");
  });

  it("a quote keeps the parts as they were; the customer's page lists an itemised bundle's parts; an order from it keeps both", async () => {
    const deal = await newDeal();
    const quote = await run(member, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, member.id])).id;
      const id = (
        await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, valid_until) values ($1, 'הצעה', $2, $3, current_date + 14) returning id", [
          org,
          deal,
          contact,
        ])
      ).id;
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילת התקנה', 50000, 'product', 'itemised')",
        [org, id, bundle],
      );
      await q("insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source) values ($1, $2, 1, $3, 'מזגן', 10000, 'product')", [
        org,
        id,
        part1,
      ]);
      return id;
    });
    const stored = await asAdmin(async (q) =>
      (await q<{ d: string | null; i: Part[] | null; t: number }>("select bundle_display as d, bundle_items as i, total_agorot::int as t from public.quote_lines where quote_id = $1 order by position", [quote])).rows,
    );
    expect(stored[0]).toEqual({
      d: "itemised",
      i: [
        { name: "מזגן", quantity: 2, unit_name: null },
        { name: "התקנה", quantity: 1.5, unit_name: null },
      ],
      // the bundle line is priced like any line
      t: 50000,
    });
    expect(stored[1]).toEqual({ d: null, i: null, t: 10000 });
    // the parts are server only
    expect((await pgError(run(member, (q) => q("update public.quote_lines set bundle_items = '[]' where quote_id = $1", [quote])))).code).toBe("42501");

    await run(member, (q) => q("select public.quote_send($1, $2)", [org, quote]));
    // a later change of the bundle does not change the sent quote
    await run(owner, (q) => q("update public.product_bundle_items set quantity = 7 where bundle_id = $1 and component_id = $2", [bundle, part1]));
    const token = await run(member, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
    const page = await asService(async (q) =>
      (await one<{ p: { lines: Array<{ name: string; components: Part[] | null }> } }>(q, "select public.quote_public($1) as p", [token])).p,
    );
    expect(page.lines.map((l) => [l.name, l.components])).toEqual([
      [
        "חבילת התקנה",
        [
          { name: "מזגן", quantity: 2, unit_name: null },
          { name: "התקנה", quantity: 1.5, unit_name: null },
        ],
      ],
      ["מזגן", null],
    ]);

    // an order made from the accepted quote keeps the quote line's choice and parts
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    const order = await run(member, async (q) => (await one<{ id: string }>(q, "select public.order_from_quote($1, $2) as id", [org, quote])).id);
    const orderLines = await asAdmin(async (q) =>
      (await q<{ d: string | null; i: Part[] | null }>("select bundle_display as d, bundle_items as i from public.order_lines where order_id = $1 order by position", [order])).rows,
    );
    expect(orderLines).toEqual([
      { d: "itemised", i: stored[0].i },
      { d: null, i: null },
    ]);
    const orderToken = await run(member, async (q) => (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [org, order])).t);
    const orderPage = await asService(async (q) =>
      (await one<{ p: { lines: Array<{ components: Part[] | null }> } }>(q, "select public.order_public($1, $2) as p", [orderToken, null])).p,
    );
    expect(orderPage.lines.map((l) => l.components)).toEqual([stored[0].i, null]);
  });

  it("a single-line bundle shows no parts on the page; a new order line takes the bundle as it is now", async () => {
    const contact = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, member.id])).id,
    );
    const order = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id;
      await q("insert into public.order_lines (organization_id, order_id, product_id, name, unit_price_agorot, price_source) values ($1, $2, $3, 'חבילת התקנה', 50000, 'product')", [
        org,
        id,
        bundle,
      ]);
      await q("select public.order_confirm($1, $2)", [org, id]);
      return id;
    });
    const line = await asAdmin(async (q) => one<{ d: string; i: Part[] }>(q, "select bundle_display as d, bundle_items as i from public.order_lines where order_id = $1", [order]));
    expect(line.d).toBe("single");
    expect(line.i[0]).toEqual({ name: "מזגן", quantity: 7, unit_name: null });
    // a numbered order's line does not change
    expect(await run(member, async (q) => (await q("update public.order_lines set bundle_display = 'itemised' where order_id = $1", [order])).rowCount)).toBe(0);
    const token = await run(member, async (q) => (await one<{ t: string }>(q, "select public.order_link_create($1, $2) as t", [org, order])).t);
    const page = await asService(async (q) => (await one<{ p: { lines: Array<{ components: Part[] | null }> } }>(q, "select public.order_public($1, $2) as p", [token, null])).p);
    expect(page.lines.map((l) => l.components)).toEqual([null]);
  });

  it("a new version keeps each bundle line's choice and parts; a duplicate keeps the choice; a sent quote's choice is frozen", async () => {
    const deal = await newDeal();
    const quote = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'הצעה', $2, current_date + 14) returning id", [org, deal])).id;
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילת התקנה', 50000, 'product', 'itemised')",
        [org, id, bundle],
      );
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const sent = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.quote_lines where quote_id = $1", [quote]));
    // the bundle changes after the quote was sent: the version still shows the parts the customer saw
    await run(owner, (q) => q("update public.product_bundle_items set quantity = 9 where bundle_id = $1 and component_id = $2", [bundle, part1]));
    const version = await run(member, async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, quote])).id);
    const copied = await asAdmin(async (q) => one<{ d: string; i: Part[] }>(q, "select bundle_display as d, bundle_items as i from public.quote_lines where quote_id = $1", [version]));
    expect(copied).toEqual({ d: "itemised", i: sent.i });

    // a duplicate is a new quote: the choice is kept, the parts are taken from the catalog again
    const dup = await run(member, async (q) => (await one<{ r: { quote: string } }>(q, "select public.quote_duplicate($1, $2) as r", [org, quote])).r.quote);
    const dupLine = await asAdmin(async (q) => one<{ d: string; i: Part[] }>(q, "select bundle_display as d, bundle_items as i from public.quote_lines where quote_id = $1", [dup]));
    expect(dupLine.d).toBe("itemised");
    expect(dupLine.i.find((p) => p.name === "מזגן")?.quantity).toBe(9);

    // a sent quote's choice is frozen for every writer, the server included
    const err = await pgError(asAdmin((q) => q("update public.quote_lines set bundle_display = 'single' where quote_id = $1", [quote])));
    expect([err.code, err.hint]).toEqual(["P0001", "quote:frozen"]);
    // the draft version's choice may change
    expect(await run(member, async (q) => (await q("update public.quote_lines set bundle_display = 'single' where quote_id = $1", [version])).rowCount)).toBe(1);
  });

  it("a numbered order's choice is frozen for every writer; an order from a won deal takes the deal line's choice", async () => {
    const deal = await newDeal();
    await run(member, (q) =>
      q("insert into public.deal_lines (organization_id, deal_id, position, product_id, description, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילת התקנה', 50000, 'product', 'itemised')", [
        org,
        deal,
        bundle,
      ]),
    );
    const won = await asAdmin(async (q) => one<{ id: string }>(q, "select id from public.stages where pipeline_id = $1 and kind = 'won' order by position limit 1", [pipelineId]));
    await run(member, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, member.id])).id;
      await q("update public.deals set stage_id = $2, contact_id = $3 where id = $1", [deal, won.id, contact]);
    });
    const order = await run(member, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, deal])).id);
    const line = await asAdmin(async (q) => one<{ d: string; i: Part[] }>(q, "select bundle_display as d, bundle_items as i from public.order_lines where order_id = $1", [order]));
    expect(line.d).toBe("itemised");
    expect(line.i.length).toBe(2);
    const err = await pgError(asAdmin((q) => q("update public.order_lines set bundle_display = 'single' where order_id = $1", [order])));
    expect([err.code, err.hint]).toEqual(["P0001", "order:frozen"]);
  });
  // the fingerprint expression as it was before PRD-09 (020370 / 020625), read from the migration that defined it
  const oldFingerprint = (suffix: string, fn: string, param: string) => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const sql = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith(suffix)) as string), "utf8");
    const start = sql.indexOf(`create or replace function ${fn}`);
    const body = sql.slice(sql.indexOf("as $$", start) + 5, sql.indexOf("$$;", start)).trim().replace(/;$/, "");
    expect(body.startsWith("select encode(")).toBe(true);
    // the old body reads its argument by name; a table alias of the same name stands in for it
    return `${body} as h from public.${param === "p_quote" ? "quotes" : "orders"} ${param} where ${param}.id = $1`;
  };
  const partsNow = () =>
    asAdmin(async (q) => (await one<{ s: Part[] }>(q, "select app.bundle_snapshot($1, $2) as s", [org, bundle])).s);

  it("the fingerprint covers a bundle line's choice and parts; a document without a bundle keeps its old hash", async () => {
    const deal = await newDeal();
    const [plain, withBundle] = await run(member, async (q) => {
      const a = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'רגילה', $2, current_date + 14) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source) values ($1, $2, 0, $3, 'מזגן', 10000, 'product')", [org, a, part1]);
      const b = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'חבילה', $2, current_date + 14) returning id", [org, deal])).id;
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילת התקנה', 50000, 'product', 'single')",
        [org, b, bundle],
      );
      return [a, b];
    });
    const fp = (id: string) => asAdmin(async (q) => (await one<{ h: string }>(q, "select app.quote_fingerprint(q) as h from public.quotes q where q.id = $1", [id])).h);
    const before = await asAdmin(async (q) => (await one<{ h: string }>(q, oldFingerprint("_quote_decisions.sql", "app.quote_fingerprint", "p_quote"), [plain])).h);
    expect(await fp(plain)).toBe(before);

    // the choice counts
    const single = await fp(withBundle);
    await run(member, (q) => q("update public.quote_lines set bundle_display = 'itemised' where quote_id = $1", [withBundle]));
    const itemised = await fp(withBundle);
    expect(itemised).not.toBe(single);
    // the parts count: the catalog changes, and sending takes the parts again (a draft may wait for weeks)
    await run(owner, (q) => q("update public.product_bundle_items set quantity = 11 where bundle_id = $1 and component_id = $2", [bundle, part1]));
    await run(member, (q) => q("select public.quote_send($1, $2)", [org, withBundle]));
    const sent = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.quote_lines where quote_id = $1", [withBundle]));
    expect(sent.i).toEqual(await partsNow());
    expect(sent.i.find((p) => p.name === "מזגן")?.quantity).toBe(11);
    expect(await fp(withBundle)).not.toBe(itemised);
    // after sending the parts never change, whatever the catalog does
    await run(owner, (q) => q("update public.product_bundle_items set quantity = 12 where bundle_id = $1 and component_id = $2", [bundle, part1]));
    const kept = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.quote_lines where quote_id = $1", [withBundle]));
    expect(kept.i).toEqual(sent.i);

    // an order without a bundle keeps its old hash too
    const order = await run(member, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, member.id])).id;
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id;
      await q("insert into public.order_lines (organization_id, order_id, product_id, name, unit_price_agorot, price_source) values ($1, $2, $3, 'מזגן', 10000, 'product')", [org, id, part1]);
      await q("select public.order_confirm($1, $2)", [org, id]);
      return id;
    });
    const orderNow = await asAdmin(async (q) => (await one<{ h: string }>(q, "select app.order_fingerprint(o) as h from public.orders o where o.id = $1", [order])).h);
    const orderBefore = await asAdmin(async (q) => (await one<{ h: string }>(q, oldFingerprint("_order_links.sql", "app.order_fingerprint", "p_order"), [order])).h);
    expect(orderNow).toBe(orderBefore);
  });

  it("numbering a draft order takes the parts again; a version keeps the parts of the version before it, also when sent", async () => {
    const contact = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, member.id])).id,
    );
    const order = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id;
      await q(
        "insert into public.order_lines (organization_id, order_id, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, $3, 'חבילת התקנה', 50000, 'product', 'itemised')",
        [org, id, bundle],
      );
      return id;
    });
    await run(owner, (q) => q("update public.product_bundle_items set quantity = 13 where bundle_id = $1 and component_id = $2", [bundle, part1]));
    await run(member, (q) => q("select public.order_confirm($1, $2)", [org, order]));
    const line = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.order_lines where order_id = $1", [order]));
    expect(line.i.find((p) => p.name === "מזגן")?.quantity).toBe(13);

    const deal = await newDeal();
    const first = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'הצעה', $2, current_date + 14) returning id", [org, deal])).id;
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילת התקנה', 50000, 'product', 'itemised')",
        [org, id, bundle],
      );
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const seen = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.quote_lines where quote_id = $1", [first]));
    await run(owner, (q) => q("update public.product_bundle_items set quantity = 14 where bundle_id = $1 and component_id = $2", [bundle, part1]));
    const version = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, first])).id;
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const versionLine = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.quote_lines where quote_id = $1", [version]));
    expect(versionLine.i).toEqual(seen.i);
  });

  it("an order made from a quote matches each line to the quote line of the same place and product", async () => {
    const deal = await newDeal();
    const quote = await run(member, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, member.id])).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, valid_until) values ($1, 'הצעה', $2, $3, current_date + 14) returning id", [org, deal, contact])).id;
      // the same bundle twice, shown differently
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילה א', 50000, 'product', 'single')",
        [org, id, bundle],
      );
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 1, $3, 'חבילה ב', 50000, 'product', 'itemised')",
        [org, id, bundle],
      );
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    const order = await run(member, async (q) => (await one<{ id: string }>(q, "select public.order_from_quote($1, $2) as id", [org, quote])).id);
    const rows = await asAdmin(async (q) => (await q<{ n: string; d: string }>("select name as n, bundle_display as d from public.order_lines where order_id = $1 order by position", [order])).rows);
    expect(rows).toEqual([
      { n: "חבילה א", d: "single" },
      { n: "חבילה ב", d: "itemised" },
    ]);
  });

  it("a bundle line saved before bundles: a draft's line takes a choice and its parts; the migration fills drafts only", async () => {
    const deal = await newDeal();
    const [draft, sent] = await run(member, async (q) => {
      const ids: string[] = [];
      for (const title of ["טיוטה", "נשלחה"]) {
        const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, $2, $3, current_date + 14) returning id", [org, title, deal])).id;
        await q("insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source) values ($1, $2, 0, $3, 'חבילה', 50000, 'product')", [org, id, bundle]);
        ids.push(id);
      }
      await q("select public.quote_send($1, $2)", [org, ids[1]]);
      return ids;
    });
    // as a line saved before this migration: no choice, no parts (triggers held back for the setup only)
    const clear = () =>
      asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.quote_lines set bundle_display = null, bundle_items = null where quote_id = any($1)", [[draft, sent]]);
      });
    await clear();
    // a person picks a choice on the draft: the parts come with it; the sent quote's line takes none
    await run(member, (q) => q("update public.quote_lines set bundle_display = 'itemised' where quote_id = $1", [draft]));
    const picked = await asAdmin(async (q) => one<{ d: string; i: Part[] }>(q, "select bundle_display as d, bundle_items as i from public.quote_lines where quote_id = $1", [draft]));
    expect(picked).toEqual({ d: "itemised", i: await partsNow() });
    await asAdmin((q) => q("update public.quote_lines set bundle_display = 'itemised' where quote_id = $1", [sent]));
    const untouched = await asAdmin(async (q) => one<{ d: string | null; i: Part[] | null }>(q, "select bundle_display as d, bundle_items as i from public.quote_lines where quote_id = $1", [sent]));
    expect(untouched).toEqual({ d: null, i: null });

    // the migration's own fill: 'single' and the parts on the draft, nothing on the sent quote
    await clear();
    const dir = path.join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_product_bundles.sql")) as string;
    await asAdmin((q) => q(readFileSync(path.join(dir, file), "utf8")));
    const filled = await asAdmin(async (q) =>
      (await q<{ id: string; d: string | null; i: Part[] | null }>("select quote_id as id, bundle_display as d, bundle_items as i from public.quote_lines where quote_id = any($1)", [[draft, sent]])).rows,
    );
    expect(filled.find((r) => r.id === draft)).toEqual({ id: draft, d: "single", i: await partsNow() });
    expect(filled.find((r) => r.id === sent)).toEqual({ id: sent, d: null, i: null });
  });

  it("a plain quote sent after the catalog changed shows the bundle as it is on sending", async () => {
    const deal = await newDeal();
    const quote = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'הצעה', $2, current_date + 14) returning id", [org, deal])).id;
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילת התקנה', 50000, 'product', 'itemised')",
        [org, id, bundle],
      );
      return id;
    });
    const atDraft = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.quote_lines where quote_id = $1", [quote]));
    await run(owner, (q) => q("update public.product_bundle_items set quantity = 15 where bundle_id = $1 and component_id = $2", [bundle, part1]));
    await run(member, (q) => q("select public.quote_send($1, $2)", [org, quote]));
    const atSending = await asAdmin(async (q) => one<{ i: Part[] }>(q, "select bundle_items as i from public.quote_lines where quote_id = $1", [quote]));
    expect(atSending.i).not.toEqual(atDraft.i);
    expect(atSending.i.find((p) => p.name === "מזגן")?.quantity).toBe(15);
  });

  it("sending leaves a line alone when its product is no longer a bundle (no update, no audit entry)", async () => {
    const former = await newProduct("חבילה לשעבר", "bundle", 30000);
    const extra = await newProduct("רכיב זמני");
    const item = await addPart(owner, former, extra, 1, 0);
    const deal = await newDeal();
    const [quote, line] = await run(member, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'הצעה', $2, current_date + 14) returning id", [org, deal])).id;
      const l = (
        await one<{ id: string }>(
          q,
          "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, bundle_display) values ($1, $2, 0, $3, 'חבילה לשעבר', 30000, 'product', 'itemised') returning id",
          [org, id, former],
        )
      ).id;
      return [id, l];
    });
    // the bundle loses its parts and becomes a plain product
    await run(owner, async (q) => {
      await q("delete from public.product_bundle_items where id = $1", [item]);
      await q("update public.products set kind = 'product' where id = $1", [former]);
    });
    const audits = () =>
      asAdmin(async (q) => Number((await one<{ n: string }>(q, "select count(*) as n from public.audit_log where entity_type = 'quote_lines' and entity_id = $1", [line])).n));
    const before = await audits();
    const kept = await asAdmin(async (q) => one<{ i: Part[]; u: string }>(q, "select bundle_items as i, updated_at::text as u from public.quote_lines where id = $1", [line]));
    await run(member, (q) => q("select public.quote_send($1, $2)", [org, quote]));
    const after = await asAdmin(async (q) => one<{ i: Part[]; u: string }>(q, "select bundle_items as i, updated_at::text as u from public.quote_lines where id = $1", [line]));
    expect(after).toEqual(kept);
    expect(await audits()).toBe(before);
  });

  it("a deal line of a bundle saved before bundles keeps its empty choice through the migration", async () => {
    const deal = await newDeal();
    const line = await run(member, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deal_lines (organization_id, deal_id, position, product_id, description, unit_price_agorot, price_source) values ($1, $2, 0, $3, 'חבילה', 50000, 'product') returning id",
          [org, deal, bundle],
        )
      ).id,
    );
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.deal_lines set bundle_display = null where id = $1", [line]);
    });
    const dir = path.join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_product_bundles.sql")) as string;
    await asAdmin((q) => q(readFileSync(path.join(dir, file), "utf8")));
    const row = await asAdmin(async (q) => one<{ d: string | null }>(q, "select bundle_display as d from public.deal_lines where id = $1", [line]));
    expect(row.d).toBeNull();
    // its next update gives it the default choice
    await run(member, (q) => q("update public.deal_lines set quantity = 2 where id = $1", [line]));
    const updated = await asAdmin(async (q) => one<{ d: string | null }>(q, "select bundle_display as d from public.deal_lines where id = $1", [line]));
    expect(updated.d).toBe("single");
  });
});
