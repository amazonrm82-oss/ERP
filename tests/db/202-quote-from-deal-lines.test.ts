import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * DLI-05 part one: applyDealLinesToQuote (src/features/quotes/from-deal-server.ts) copies a deal's lines into a new draft
 * with the user's session, in ONE quote_lines insert of this shape. These tests send the same shape as a person and show
 * what app.quote_lines_check makes of it: a list price names its list (the name comes from the list), a product line keeps
 * the deal's price with price_source 'product', and a discounted line without the plan's discounts refuses the whole insert.
 */
describe("a quote from its deal's lines (DLI-05)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let product: string, list: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));

  const newDraft = () =>
    asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, member.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          stageId,
          contact,
          member.id,
        ])
      ).id;
      return (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
    });

  // the shape applyDealLinesToQuote sends (one row per copied line)
  type Row = {
    product_id: string | null;
    name: string;
    description: string | null;
    quantity: number;
    unit_price_agorot: number;
    discount_bp: number | null;
    discount_agorot: number | null;
    price_source: string;
    price_list_id: string | null;
    vat_exempt?: boolean;
    billing?: string;
  };
  const insertCopy = (quote: string, rows: Row[]) =>
    asUser(member.id, (q) =>
      q(
        `insert into public.quote_lines (organization_id, quote_id, position, kind, product_id, name, description, quantity, unit_price_agorot,
                                         discount_bp, discount_agorot, vat_exempt, billing, price_source, price_list_id)
         select $1, $2, r.position, 'item', r.product_id, r.name, r.description, r.quantity, r.unit_price_agorot, r.discount_bp,
                r.discount_agorot, coalesce(r.vat_exempt, false), coalesce(r.billing, 'one_time'), r.price_source, r.price_list_id
           from jsonb_to_recordset($3::jsonb) as r(position int, product_id uuid, name text, description text, quantity numeric,
                unit_price_agorot bigint, discount_bp int, discount_agorot bigint, vat_exempt boolean, billing text, price_source text,
                price_list_id uuid)`,
        [org, quote, JSON.stringify(rows.map((row, i) => ({ position: i + 1, ...row })))],
      ),
    );
  const base: Row = { product_id: null, name: "עבודה", description: null, quantity: 1, unit_price_agorot: 1000, discount_bp: null, discount_agorot: null, price_source: "manual", price_list_id: null };

  beforeAll(async () => {
    owner = await createUser("qfd-owner");
    org = await createOrg(owner.id, "עסק הצעות מעסקה");
    member = await addMember(org, owner.id, "member", "qfd-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    await setFeatures({ quotes: true, products: true, price_lists: true, discounts: true });
    await asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    product = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot) values ($1, 'מדף', 10000) returning id", [org])).id,
    );
    list = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.price_lists (organization_id, name) values ($1, 'מחירון סיטונאי') returning id", [org])).id,
    );
  });

  it("(a) a list price names its list; the line keeps the list's own name", async () => {
    const quote = await newDraft();
    await insertCopy(quote, [{ ...base, product_id: product, name: "מדף", unit_price_agorot: 8000, price_source: "price_list", price_list_id: list }]);
    expect(
      await asAdmin((q) => one(q, "select price_source, price_list_id, price_list_name, unit_price_agorot::int as price from public.quote_lines where quote_id = $1", [quote])),
    ).toEqual({ price_source: "price_list", price_list_id: list, price_list_name: "מחירון סיטונאי", price: 8000 });
  });

  it("(b) a product line keeps the deal's price with price_source 'product', even when the catalog price differs", async () => {
    const quote = await newDraft();
    await insertCopy(quote, [{ ...base, product_id: product, name: "מדף", unit_price_agorot: 9300, price_source: "product" }]);
    expect(
      await asAdmin((q) => one(q, "select price_source, price_list_id, unit_price_agorot::int as price, total_agorot::int as total from public.quote_lines where quote_id = $1", [quote])),
    ).toEqual({ price_source: "product", price_list_id: null, price: 9300, total: 9300 });
  });

  it("(c) a discounted line without the plan's discounts refuses the whole insert", async () => {
    const quote = await newDraft();
    await setFeatures({ quotes: true, products: true, price_lists: true, discounts: false });
    try {
      const refused = await pgError(insertCopy(quote, [base, { ...base, name: "בהנחה", discount_bp: 1000 }]));
      expect(refused.hint).toBe("feature:discounts");
      expect(await asAdmin((q) => count(q, "select 1 from public.quote_lines where quote_id = $1", [quote]))).toBe(0);
    } finally {
      await setFeatures({ quotes: true, products: true, price_lists: true, discounts: true });
    }
  });
});
