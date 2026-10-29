import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discountSplit } from "@/features/tax/discount-split";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Case = { name: string; totals: number[]; discount: number; shares: number[] | null };
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "../unit/fixtures/discount-split.json"), "utf8")) as { cases: Case[] };

/**
 * DSC-01 (the document part): a document discount split between the lines for reports. An accepted quote replaces its
 * deal's lines without its document discount (QUO-13), while the deal's amount is the quote's net (020510); the line
 * reports split the quote's discount between the deal's lines at read time, so their sum equals the deal's amount.
 */
describe("document discount split (DSC-01)", () => {
  it("app.discount_split answers the shared fixture exactly as discountSplit()", async () => {
    await asAdmin(async (q) => {
      for (const c of fixture.cases) {
        const r = await q<{ s: string[] | null }>("select app.discount_split($1::bigint[], $2::bigint)::text[] as s", [c.totals.map(String), c.discount]);
        const sql = r.rows[0].s === null ? null : r.rows[0].s.map(Number);
        expect(sql, c.name).toEqual(c.shares);
        expect(discountSplit(c.totals, c.discount), c.name).toEqual(c.shares);
      }
      // null in, null out; never an error
      expect((await q<{ s: unknown }>("select app.discount_split(null, 1) as s")).rows[0].s).toBeNull();
      expect((await q<{ s: unknown }>("select app.discount_split(array[1, null]::bigint[], 1) as s")).rows[0].s).toBeNull();
      expect((await q<{ s: unknown }>("select app.discount_split(array[1]::bigint[], null) as s")).rows[0].s).toBeNull();
    });
  });

  it("matches discountSplit() on random cases", async () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const cases = Array.from({ length: 200 }, () => {
      const totals = Array.from({ length: rand(9) }, () => (rand(4) === 0 ? 0 : rand(1_000_000)));
      const sum = totals.reduce((a, b) => a + b, 0);
      return { totals, discount: rand(sum + 2) };
    });
    await asAdmin(async (q) => {
      for (const c of cases) {
        const r = await q<{ s: string[] | null }>("select app.discount_split($1::bigint[], $2::bigint)::text[] as s", [c.totals.map(String), c.discount]);
        expect(r.rows[0].s === null ? null : r.rows[0].s.map(Number)).toEqual(discountSplit(c.totals, c.discount));
      }
    });
  });

  describe("the line reports", () => {
    let owner: U, member: U;
    let org: string, pipelineId: string, openStage: string, product: string;
    const from = () => new Date(Date.now() - 86_400_000).toISOString();
    const to = () => new Date(Date.now() + 86_400_000).toISOString();
    const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
    type Obj = Record<string, unknown> & { totals: Record<string, number> };
    const report = (fn: string) =>
      asUser(owner.id, async (q) => (await one<{ r: Obj }>(q, `select public.${fn}($1, $2, $3, null, null) as r`, [org, from(), to()])).r);
    const amounts = (rows: unknown) => (rows as { amount: number }[]).map((r) => Number(r.amount)).sort((a, b) => b - a);

    let deal: string, quote: string;

    beforeAll(async () => {
      owner = await createUser("dsc01-owner");
      org = await createOrg(owner.id, "עסק ההנחות");
      member = await addMember(org, owner.id, "member", "dsc01-member");
      const pipe = await defaultPipeline(org);
      pipelineId = pipe.pipelineId;
      openStage = pipe.stages.find((s) => s.kind === "open")!.id;
      await asAdmin((q) =>
        q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: true, products: true, discounts: true })]),
      );
      await asUser(owner.id, async (q) => {
        await q(
          "insert into public.org_document_settings (organization_id, vat_status, quote_accept_deal) values ($1, 'licensed', 'auto') on conflict (organization_id) do update set quote_accept_deal = 'auto'",
          [org],
        );
        product = (
          await one<{ id: string }>(q, "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat) values ($1, 'כיסא', 30000, 'taxable', false) returning id", [org])
        ).id;
        await q("insert into public.product_costs (organization_id, product_id, cost_agorot) values ($1, $2, 10000)", [org, product]);
      });
      // a quote with a 10% document discount: lines 60,000 + 20,000 + 10,001 = 90,001; discount 9,000; net 81,001
      const made = await asUser(member.id, async (q) => {
        const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [org, member.id])).id;
        const d = (
          await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'ריהוט', $2, $3, $4, $5) returning id", [
            org,
            pipelineId,
            openStage,
            contact,
            member.id,
          ])
        ).id;
        const qt = (
          await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, discount_bp) values ($1, 'ריהוט משרד', $2, $3, 1000) returning id", [org, d, contact])
        ).id;
        await q(
          "insert into public.quote_lines (organization_id, quote_id, position, product_id, name, unit_price_agorot, price_source, quantity) values ($1, $2, 1, $3, 'כיסא', 30000, 'product', 2)",
          [org, qt, product],
        );
        await q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot, quantity) values ($1, $2, 2, 'התקנה', 20000, 1)", [org, qt]);
        await q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot, quantity) values ($1, $2, 3, 'הובלה', 10001, 1)", [org, qt]);
        await q("select public.quote_send($1, $2)", [org, qt]);
        const token = (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, qt])).t;
        return { d, qt, token };
      });
      deal = made.d;
      quote = made.qt;
      await asService(async (q) => {
        const fp = (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [made.token])).v.fingerprint;
        await q(
          `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'דנה לוי',
                    p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true)`,
          [made.token, fp],
        );
      });
    });

    it("the accepted quote moved the deal: its lines carry no document discount, its amount does", async () => {
      const state = await asAdmin(async (q) =>
        one<{ status: string; amount: string; mark: string | null; lines: string; discount: string }>(
          q,
          `select d.status, d.amount_agorot::text as amount, d.amount_quote_id as mark,
                  (select sum(l.total_agorot)::text from public.deal_lines l where l.deal_id = d.id) as lines,
                  (select discount_total_agorot::text from public.quotes where id = $2) as discount
             from public.deals d where d.id = $1`,
          [deal, quote],
        ),
      );
      expect(state).toEqual({ status: "won", amount: "81001", mark: quote, lines: "90001", discount: "9000" });
    });

    it("revenue by product and by category split the discount, so their sum is the deal's amount", async () => {
      const products = await report("report_revenue_by_product");
      // shares 6,000 / 2,000 / 1,000 (largest remainders), so 54,000 / 18,000 / 9,001
      expect(amounts(products.by_product)).toEqual([54000, 27001]);
      expect(products.totals).toMatchObject({ deals_with_document_discount: 1, document_discount_agorot: 9000 });
      expect((products.by_billing as { amount: number }[]).reduce((a, b) => a + Number(b.amount), 0)).toBe(81001);

      const categories = await report("report_revenue_by_category");
      expect(amounts(categories.by_category)).toEqual([54000, 27001]);
      expect(categories.totals).toMatchObject({ deals_with_document_discount: 1, document_discount_agorot: 9000 });
    });

    it("gross profit takes the line's share off its net amount", async () => {
      const profit = await report("report_gross_profit");
      expect(profit.totals).toMatchObject({ deals_with_document_discount: 1, costed_lines: 1 });
      expect(profit.by_product).toEqual([expect.objectContaining({ revenue: 54000, cost: 20000, profit: 34000 })]);
    });

    it("once the amount is no longer the quote's, nothing is split", async () => {
      await asUser(member.id, (q) => q("update public.deals set amount_agorot = 80000 where id = $1", [deal]));
      const products = await report("report_revenue_by_product");
      expect(amounts(products.by_product)).toEqual([60000, 30001]);
      expect(products.totals).toMatchObject({ deals_with_document_discount: 0, document_discount_agorot: 0 });
      const profit = await report("report_gross_profit");
      expect(profit.by_product).toEqual([expect.objectContaining({ revenue: 60000, profit: 40000 })]);
    });
  });
});
