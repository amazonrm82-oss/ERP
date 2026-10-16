import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };
type QuoteLine = {
  name: string;
  description: string | null;
  unit_name: string | null;
  unit_price_agorot: string;
  vat_exempt: boolean;
  billing: string;
  total_agorot: string;
};
type DealLine = { description: string; unit_price_agorot: string; vat_exempt: boolean; billing: string | null; total_agorot: string };

/**
 * PRD-03: a line copies the product's name, description and price (and with them its unit, VAT kind and
 * billing) when it is made. A later change of the product, or of its unit, never changes a line that
 * already exists: not the quote's (QUO-02) and not the deal's (DLI-01), nor their totals, whoever writes
 * the line afterwards. The copy itself is checked in tests 107 and 123; here: that nothing follows the product.
 */
describe("lines keep their copy of the product (PRD-03)", () => {
  let owner: U;
  let org: string, pipelineId: string, stageId: string;
  let unitA: string, unitB: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[]) => (await q<T>(sql, params)).rows[0];
  const quoteLine = (id: string) => asAdmin((q) => one<QuoteLine>(q, "select * from public.quote_lines where id = $1", [id]));
  const dealLine = (id: string) => asAdmin((q) => one<DealLine>(q, "select * from public.deal_lines where id = $1", [id]));
  const quoteTotals = (id: string) =>
    asAdmin((q) => one<{ net_total_agorot: string; vat_agorot: string; total_agorot: string }>(q, "select net_total_agorot, vat_agorot, total_agorot from public.quotes where id = $1", [id]));
  // everything but what the later edit itself changes
  const copied = (row: object) => {
    const rest: Record<string, unknown> = { ...row };
    delete rest.quantity;
    delete rest.updated_at;
    delete rest.total_agorot;
    return rest;
  };
  const dealAmount = (id: string) => asAdmin(async (q) => (await one<{ amount_agorot: string | null }>(q, "select amount_agorot from public.deals where id = $1", [id])).amount_agorot);

  const newProduct = (name: string) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, description, price_agorot, vat_kind, billing, unit_id)
           values ($1, $2, 'תיאור מקורי', 10000, 'taxable', 'one_time', $3) returning id`,
          [org, name, unitA],
        )
      ).id,
    );
  const newDeal = () =>
    asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [org, pipelineId, stageId])).id,
    );
  // the whole product changes: name, description, price, VAT kind, billing and unit; the old unit is renamed
  const changeEverything = (product: string) =>
    asUser(owner.id, async (q) => {
      await q(
        `update public.products set name = 'שם חדש', description = 'תיאור חדש', price_agorot = 55500, vat_kind = 'exempt',
                billing = 'monthly', unit_id = $2 where id = $1`,
        [product, unitB],
      );
      await q("update public.product_units set name = 'יחידה ששמה שונה' where id = $1", [unitA]);
    });

  beforeAll(async () => {
    owner = await createUser("prd03-owner");
    org = await createOrg(owner.id, "עסק העותקים");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    const units = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("select id from public.product_units where organization_id = $1 order by position, id limit 2", [org])).rows.map((r) => r.id),
    );
    [unitA, unitB] = units;
    expect(unitB).toBeDefined();
  });

  it("a quote line keeps the name, description, unit, price, VAT and billing it copied, and the quote its totals", async () => {
    const product = await newProduct("מוצר מקורי");
    const deal = await newDeal();
    const quote = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id,
    );
    const lineId = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.quote_lines (organization_id, quote_id, product_id, name, description, quantity, unit_price_agorot, price_source)
           values ($1, $2, $3, 'מוצר מקורי', 'תיאור מקורי', 2, 10000, 'product') returning id`,
          [org, quote, product],
        )
      ).id,
    );
    const before = await quoteLine(lineId);
    expect(before).toMatchObject({ name: "מוצר מקורי", description: "תיאור מקורי", unit_price_agorot: "10000", vat_exempt: false, billing: "one_time", total_agorot: "20000" });
    expect(before.unit_name).not.toBeNull();
    const totals = await quoteTotals(quote);
    expect(totals).toMatchObject({ net_total_agorot: "20000", vat_agorot: "3600", total_agorot: "23600" });

    await changeEverything(product);
    expect(await quoteLine(lineId)).toEqual(before);
    expect(await quoteTotals(quote)).toEqual(totals);

    // editing the line later (a person, then the server) does not pull the product's new values either
    await asUser(owner.id, (q) => q("update public.quote_lines set quantity = 3 where id = $1", [lineId]));
    await asAdmin((q) => q("update public.quote_lines set vat_exempt = true, billing = 'yearly', unit_name = 'אחר' where id = $1", [lineId]));
    const edited = await quoteLine(lineId);
    expect(copied(edited)).toEqual(copied(before));
    expect(edited.total_agorot).toBe("30000");

    // archiving the product leaves the line as it is
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [product]));
    expect(await quoteLine(lineId)).toEqual(edited);
  });

  it("a deal line keeps its description, price, VAT and billing, and the deal its value", async () => {
    const product = await newProduct("מוצר לעסקה");
    const deal = await newDeal();
    const lineId = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.deal_lines (organization_id, deal_id, product_id, description, quantity, unit_price_agorot, price_source)
           values ($1, $2, $3, 'מוצר לעסקה', 2, 10000, 'product') returning id`,
          [org, deal, product],
        )
      ).id,
    );
    const before = await dealLine(lineId);
    expect(before).toMatchObject({ description: "מוצר לעסקה", unit_price_agorot: "10000", vat_exempt: false, billing: "one_time", total_agorot: "20000" });
    const amount = await dealAmount(deal);
    expect(amount).toBe("20000");

    await changeEverything(product);
    expect(await dealLine(lineId)).toEqual(before);
    expect(await dealAmount(deal)).toBe(amount);

    await asUser(owner.id, (q) => q("update public.deal_lines set quantity = 3 where id = $1", [lineId]));
    await asAdmin((q) => q("update public.deal_lines set vat_exempt = true where id = $1", [lineId]));
    const edited = await dealLine(lineId);
    expect(copied(edited)).toEqual(copied(before));
    expect(edited.total_agorot).toBe("30000");
    expect(await dealAmount(deal)).toBe("30000");
  });
});
