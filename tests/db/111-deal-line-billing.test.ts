import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dealLinesSums } from "@/features/deal-lines/pricing";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

const migration = (suffix: string) => {
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  const file = fs.readdirSync(dir).find((name) => name.endsWith(suffix));
  expect(file, suffix).toBeTruthy();
  return fs.readFileSync(path.join(dir, file!), "utf8");
};

/**
 * DLI-04 (owner, 14 October 2026): every deal line keeps a billing mode. A product line copies its
 * product's when it is added; a free line is the person's choice (one-time by default). The recurring
 * amount comes from the recurring lines, converted to the deal's period; the value is their first year
 * plus the one-time lines. The pure rule is checked against the shared fixtures in tests/db/106.
 */
describe("one-time and recurring lines in one deal (DLI-04)", () => {
  let owner: U, member: U, outsider: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let monthlyProduct: string, yearlyProduct: string, setupProduct: string;

  const newDeal = (values: Record<string, unknown> = {}) =>
    asUser(member.id, async (q) => {
      const keys = ["organization_id", "name", "pipeline_id", "stage_id", ...Object.keys(values)];
      const params = [org, "עסקה", pipelineId, stageId, ...Object.values(values)];
      return (await q<{ id: string }>(`insert into public.deals (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, params))
        .rows[0].id;
    });
  const addLine = (deal: string, unit: number, extra: Record<string, unknown> = {}) =>
    asUser(member.id, async (q) => {
      const values: Record<string, unknown> = { deal_id: deal, description: "שורה", quantity: 1, unit_price_agorot: unit, ...extra };
      const keys = Object.keys(values);
      return (
        await q<{ id: string; billing: string | null }>(
          `insert into public.deal_lines (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id, billing`,
          [org, ...Object.values(values)],
        )
      ).rows[0];
    });
  const billingOf = (line: string) =>
    asAdmin(async (q) => (await q<{ billing: string | null }>("select billing from public.deal_lines where id = $1", [line])).rows[0].billing);
  const value = (deal: string) =>
    asAdmin(async (q) => {
      const row = (
        await q<{ amount: string; auto: boolean | null; source: string | null; recurring: string | null; recurring_auto: boolean | null }>(
          `select amount_agorot::text as amount, amount_auto as auto, amount_source as source,
                  recurring_amount_agorot::text as recurring, recurring_amount_auto as recurring_auto
             from public.deals where id = $1`,
          [deal],
        )
      ).rows[0];
      return {
        amount: Number(row.amount),
        auto: row.auto,
        source: row.source,
        recurring: row.recurring === null ? null : Number(row.recurring),
        recurring_auto: row.recurring_auto,
      };
    });
  const newProduct = (name: string, billing: string, price = 10000) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat, billing) values ($1, $2, $3, 'taxable', false, $4) returning id",
          [org, name, price, billing],
        )
      ).rows[0].id,
    );
  // a line saved before DLI-04 (billing null): only a server can make one, with the trigger off
  const makeLegacy = (line: string) =>
    asAdmin(async (q) => {
      await q("alter table public.deal_lines disable trigger deal_lines_billing");
      await q("alter table public.deal_lines disable trigger deal_lines_recompute_update");
      await q("update public.deal_lines set billing = null where id = $1", [line]);
      await q("alter table public.deal_lines enable trigger deal_lines_billing");
      await q("alter table public.deal_lines enable trigger deal_lines_recompute_update");
    });

  beforeAll(async () => {
    owner = await createUser("line-billing-owner");
    org = await createOrg(owner.id, "עסק חיוב בשורות");
    member = await addMember(org, owner.id, "member", "line-billing-member");
    outsider = await createUser("line-billing-outsider");
    await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    monthlyProduct = await newProduct("מנוי חודשי", "monthly", 10000);
    yearlyProduct = await newProduct("רישיון שנתי", "yearly", 120000);
    setupProduct = await newProduct("התקנה", "one_time", 50000);
  });

  it("a product line copies its product's billing and keeps it; a free line is the person's, one-time by default", async () => {
    const deal = await newDeal();
    // whatever the writer sends, a product line takes the product's
    const product = await addLine(deal, 10000, { product_id: monthlyProduct, billing: "one_time", price_source: "product" });
    expect(product.billing).toBe("monthly");
    await asUser(member.id, (q) => q("update public.deal_lines set billing = 'yearly' where id = $1", [product.id]));
    expect(await billingOf(product.id)).toBe("monthly");
    // a later change of the product does not move the line
    await asUser(owner.id, (q) => q("update public.products set billing = 'quarterly' where id = $1", [monthlyProduct]));
    await asUser(member.id, (q) => q("update public.deal_lines set quantity = 2 where id = $1", [product.id]));
    expect(await billingOf(product.id)).toBe("monthly");
    await asUser(owner.id, (q) => q("update public.products set billing = 'monthly' where id = $1", [monthlyProduct]));

    const free = await addLine(deal, 500);
    expect(free.billing).toBe("one_time");
    const picked = await addLine(deal, 500, { billing: "quarterly" });
    expect(picked.billing).toBe("quarterly");
    await asUser(member.id, (q) => q("update public.deal_lines set billing = 'yearly' where id = $1", [picked.id]));
    expect(await billingOf(picked.id)).toBe("yearly");
    // a write that does not send it (or sends null) keeps it
    await asUser(member.id, (q) => q("update public.deal_lines set billing = null, quantity = 3 where id = $1", [picked.id]));
    expect(await billingOf(picked.id)).toBe("yearly");
    // an unknown mode is refused
    const e = await pgError(asUser(member.id, (q) => q("update public.deal_lines set billing = 'weekly' where id = $1", [free.id])));
    expect(e.code).toBe("23514");
  });

  it("a one-time deal counts a recurring line's first year plus the one-time lines, and is never made recurring by itself", async () => {
    const deal = await newDeal();
    await addLine(deal, 10000, { product_id: monthlyProduct, price_source: "product" });
    await addLine(deal, 50000, { product_id: setupProduct, price_source: "product" });
    expect(await value(deal)).toEqual({ amount: 12 * 10000 + 50000, auto: true, source: "lines", recurring: null, recurring_auto: null });
    await asAdmin(async (q) => {
      expect((await q<{ k: string | null }>("select billing_kind as k from public.deals where id = $1", [deal])).rows[0].k).toBeNull();
    });
  });

  it("a monthly deal: the recurring lines converted to a month, the value their first year plus the one-time lines", async () => {
    const deal = await newDeal({ billing_kind: "monthly", recurring_start_date: "2026-11-01", amount_agorot: null });
    await addLine(deal, 10000, { product_id: monthlyProduct, price_source: "product" });
    await addLine(deal, 120000, { product_id: yearlyProduct, price_source: "product" });
    await addLine(deal, 30000, { billing: "quarterly" });
    const setup = await addLine(deal, 50000, { product_id: setupProduct, price_source: "product" });
    // 10000 + 120000 / 12 + 30000 / 3 = 30000 a month
    expect(await value(deal)).toEqual({ amount: 30000 * 12 + 50000, auto: true, source: "lines", recurring: 30000, recurring_auto: true });

    // to yearly: the same lines as a year
    await asUser(member.id, (q) => q("update public.deals set billing_kind = 'yearly' where id = $1", [deal]));
    expect(await value(deal)).toEqual({ amount: 360000 + 50000, auto: true, source: "lines", recurring: 360000, recurring_auto: true });
    await asUser(member.id, (q) => q("update public.deals set billing_kind = 'monthly' where id = $1", [deal]));

    // a free line's mode changed: the deal follows
    const free = await addLine(deal, 6000);
    expect((await value(deal)).amount).toBe(360000 + 56000);
    await asUser(member.id, (q) => q("update public.deal_lines set billing = 'monthly' where id = $1", [free.id]));
    expect(await value(deal)).toEqual({ amount: 36000 * 12 + 50000, auto: true, source: "lines", recurring: 36000, recurring_auto: true });

    // every recurring line gone: the recurring amount keeps its last value; the one-time line still counts
    await asUser(member.id, (q) => q("delete from public.deal_lines where deal_id = $1 and billing <> 'one_time'", [deal]));
    expect(await value(deal)).toEqual({ amount: 36000 * 12 + 50000, auto: true, source: "lines", recurring: 36000, recurring_auto: true });

    // and with the last line gone, the first year of the kept amount
    await asUser(member.id, (q) => q("delete from public.deal_lines where id = $1", [setup.id]));
    expect(await value(deal)).toEqual({ amount: 36000 * 12, auto: true, source: "first_year", recurring: 36000, recurring_auto: true });
  });

  // Owner's decision of 14 October 2026 ("עיגול השווי בעסקה חודשית"): 12 x the rounded monthly amount, as the
  // card shows it, not the exact first year. Do not change this test to expect 1,002.
  it("owner's rounding rule: a 1,002-agorot yearly line on a monthly deal is 84 a month and a value of 1,008", async () => {
    const deal = await newDeal({ billing_kind: "monthly", recurring_start_date: "2026-11-01", amount_agorot: null });
    await addLine(deal, 1002, { billing: "yearly" });
    expect(await value(deal)).toEqual({ amount: 1008, auto: true, source: "lines", recurring: 84, recurring_auto: true });
  });

  it("a typed value, and a typed recurring amount, still win", async () => {
    const deal = await newDeal({ billing_kind: "monthly", recurring_start_date: "2026-11-01", recurring_amount_agorot: 70000, amount_agorot: null });
    await addLine(deal, 10000, { product_id: monthlyProduct, price_source: "product" });
    await addLine(deal, 50000, { product_id: setupProduct, price_source: "product" });
    // the typed recurring amount stays; its first year plus the one-time line
    expect(await value(deal)).toEqual({ amount: 70000 * 12 + 50000, auto: true, source: "lines", recurring: 70000, recurring_auto: null });
    await asUser(member.id, (q) => q("update public.deals set amount_agorot = 1234 where id = $1", [deal]));
    await addLine(deal, 999, { billing: "yearly" });
    expect((await value(deal)).amount).toBe(1234);
  });

  it("a line saved before DLI-04 counts in the deal's period, as before; filling it uses the product's mode", async () => {
    const deal = await newDeal({ billing_kind: "monthly", recurring_start_date: "2026-11-01", amount_agorot: null });
    const setup = await addLine(deal, 50000, { product_id: setupProduct, price_source: "product" });
    const free = await addLine(deal, 2000);
    expect(await value(deal)).toEqual({ amount: 52000, auto: true, source: "lines", recurring: 0, recurring_auto: true });
    await makeLegacy(setup.id);
    await makeLegacy(free.id);
    // recomputed (a no-op write): both count as monthly lines, the DLI-03 meaning
    await asUser(member.id, (q) => q("update public.deals set name = name where id = $1", [deal]));
    expect(await value(deal)).toEqual({ amount: 52000 * 12, auto: true, source: "lines", recurring: 52000, recurring_auto: true });
    // a product line saved before DLI-04 takes its product's mode when filled, whatever is sent
    await asUser(member.id, (q) => q("update public.deal_lines set billing = 'yearly' where id = $1", [setup.id]));
    expect(await billingOf(setup.id)).toBe("one_time");
    expect(await value(deal)).toEqual({ amount: 2000 * 12 + 50000, auto: true, source: "lines", recurring: 2000, recurring_auto: true });
    // a write that does not fill it keeps it null
    await asUser(member.id, (q) => q("update public.deal_lines set quantity = 1 where id = $1", [free.id]));
    expect(await billingOf(free.id)).toBeNull();
  });

  it("app.deal_lines_sums matches dealLinesSums(), prices including VAT too", async () => {
    await asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, prices_include_vat, vat_status) values ($1, true, 'licensed')
         on conflict (organization_id) do update set prices_include_vat = true, vat_status = 'licensed'`,
        [org],
      ),
    );
    try {
      const deal = await newDeal({ billing_kind: "monthly", recurring_start_date: "2026-11-01", amount_agorot: null });
      const lines = [
        { unit: 11800, quantity: 1, billing: "monthly", exempt: false, discount: null },
        { unit: 3333, quantity: 3, billing: "monthly", exempt: false, discount: 99 },
        { unit: 5000, quantity: 1, billing: "quarterly", exempt: true, discount: null },
        { unit: 7777, quantity: 2, billing: "one_time", exempt: false, discount: null },
      ] as const;
      for (const l of lines) {
        await addLine(deal, l.unit, { quantity: l.quantity, billing: l.billing, vat_exempt: l.exempt, discount_agorot: l.discount });
      }
      const rate = await asAdmin(async (q) => Number((await q<{ r: number }>("select app.vat_rate_at((now() at time zone 'Asia/Jerusalem')::date) as r")).rows[0].r));
      const sums = await asAdmin(
        async (q) =>
          (
            await q<{ once: string | null; monthly: string | null; quarterly: string | null; yearly: string | null }>(
              "select once::text, monthly::text, quarterly::text, yearly::text from app.deal_lines_sums($1, $2, 'monthly')",
              [org, deal],
            )
          ).rows[0],
      );
      const expected = dealLinesSums(
        lines.map((l) => ({ quantity: l.quantity, unitPriceAgorot: l.unit, discountBp: null, discountAgorot: l.discount, vatExempt: l.exempt, billing: l.billing })),
        "monthly",
        rate,
        true,
      );
      const asNumbers = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, v === null ? null : Number(v)]));
      expect(asNumbers).toEqual(expected);
      expect(expected.yearly).toBeNull();
      expect(expected.monthly).not.toBeNull();
    } finally {
      await asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = false, vat_status = null where organization_id = $1", [org]));
    }
  });

  it("another business cannot write a line's billing", async () => {
    const deal = await newDeal();
    const line = await addLine(deal, 1000, { billing: "monthly" });
    const e = await pgError(
      asUser(outsider.id, (q) =>
        q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot, billing) values ($1, $2, 'x', 1, 1, 'yearly')", [org, deal]),
      ),
    );
    expect(e.code).toBe("42501");
    await asUser(outsider.id, (q) => q("update public.deal_lines set billing = 'yearly'"));
    expect(await billingOf(line.id)).toBe("monthly");
  });

  it("the sums are internal, the rule not open to anon, and the trigger function to no client", async () => {
    await asAdmin(async (q) => {
      const r = await q<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
        `select p.proname as name,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app' and p.proname in ('deal_lines_sums', 'deal_value_rule', 'deal_lines_billing')`,
      );
      const byName = Object.fromEntries(r.rows.map((row) => [row.name, row]));
      expect(Object.keys(byName).sort()).toEqual(["deal_lines_billing", "deal_lines_sums", "deal_value_rule"]);
      for (const row of r.rows) expect(row.anon, row.name).toBe(false);
      expect(byName.deal_lines_sums.auth).toBe(false);
      expect(byName.deal_lines_sums.svc).toBe(false);
      expect(byName.deal_lines_billing.auth).toBe(false);
      expect(byName.deal_value_rule.auth).toBe(true);
      // one function per name (no overloads)
      expect(await count(q, "select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'deal_amount_rule'")).toBe(1);
    });
  });

  it("the migration is safe to run twice and leaves stored values as they were", async () => {
    const deal = await newDeal({ billing_kind: "monthly", recurring_start_date: "2026-11-01", amount_agorot: null });
    await addLine(deal, 10000, { product_id: monthlyProduct, price_source: "product" });
    await addLine(deal, 50000, { product_id: setupProduct, price_source: "product" });
    const before = await value(deal);
    const sql = migration("_deal_line_billing.sql");
    expect(sql).not.toMatch(/^\s*drop\s/im);
    expect(sql).not.toMatch(/delete\s+from/i);
    expect(sql).not.toMatch(/\\u[0-9a-f]{4}/i);
    await asAdmin((q) => q(sql));
    await asAdmin((q) => q(sql));
    expect(await value(deal)).toEqual(before);
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from pg_constraint where conrelid = 'public.deal_lines'::regclass and conname = 'deal_lines_billing'")).toBe(1);
      expect(await count(q, "select 1 from pg_trigger where tgrelid = 'public.deal_lines'::regclass and tgname = 'deal_lines_billing'")).toBe(1);
    });
  });
});
