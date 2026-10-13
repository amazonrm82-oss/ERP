import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals, type DocumentTotals, type TotalsLine, type TotalsOptions, type TotalsResult } from "@/features/tax/calc";

import { addMember, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

/** The database's answer in the shape of documentTotals(). */
type SqlTotals = Record<string, unknown> & { lines: Record<string, unknown>[] };

function fromSql(row: SqlTotals): DocumentTotals {
  const n = (value: unknown) => Number(value);
  return {
    lines: row.lines.map((line) => ({
      amountAgorot: n(line.amount_agorot),
      discountAgorot: n(line.discount_agorot),
      totalAgorot: n(line.total_agorot),
      netAgorot: n(line.net_agorot),
      vatExempt: line.vat_exempt as boolean,
    })),
    subtotalAgorot: n(row.subtotal_agorot),
    documentDiscountAgorot: n(row.document_discount_agorot),
    netSubtotalAgorot: n(row.net_subtotal_agorot),
    netDiscountAgorot: n(row.net_discount_agorot),
    taxableAgorot: n(row.taxable_agorot),
    exemptAgorot: n(row.exempt_agorot),
    netTotalAgorot: n(row.net_total_agorot),
    vatAgorot: n(row.vat_agorot),
    totalBeforeRoundingAgorot: n(row.total_before_rounding_agorot),
    roundingAgorot: n(row.rounding_agorot),
    totalAgorot: n(row.total_agorot),
    rateBp: n(row.rate_bp),
    pricesIncludeVat: row.prices_include_vat as boolean,
  };
}

function toSqlLines(lines: TotalsLine[]) {
  return lines.map((line) => ({
    quantity: line.quantity,
    unit_price_agorot: line.unitPriceAgorot,
    ...(line.discountBp !== undefined ? { discount_bp: line.discountBp } : {}),
    ...(line.discountAgorot !== undefined ? { discount_agorot: line.discountAgorot } : {}),
    ...(line.vatExempt !== undefined ? { vat_exempt: line.vatExempt } : {}),
  }));
}

/** What app.document_totals() answers, as a TotalsResult. */
async function sqlTotals(q: Query, lines: TotalsLine[], options: TotalsOptions): Promise<TotalsResult> {
  await q("savepoint totals");
  try {
    const res = await q<{ t: SqlTotals }>("select app.document_totals($1::jsonb, $2, $3, $4, $5, $6) as t", [
      JSON.stringify(toSqlLines(lines)),
      options.rateBp,
      options.pricesIncludeVat,
      options.discountBp ?? null,
      options.discountAgorot ?? null,
      options.roundToShekel ?? false,
    ]);
    await q("release savepoint totals");
    return { ok: true, totals: fromSql(res.rows[0].t) };
  } catch (error) {
    await q("rollback to savepoint totals");
    const e = error as { code?: string; hint?: string; message: string };
    const match = /^invalid document totals: (\w+)(?: at line (\d+))?$/.exec(e.message);
    if (e.code !== "22023" || e.hint !== "totals:invalid" || !match) throw error;
    return { ok: false, error: match[1] as never, line: match[2] === undefined ? null : Number(match[2]) };
  }
}

/** A small seeded generator, so a failure can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(next: () => number): [TotalsLine[], TotalsOptions] {
  const int = (max: number) => Math.floor(next() * (max + 1));
  const pick = <T,>(items: T[]) => items[int(items.length - 1)];
  const lines: TotalsLine[] = [];
  const count = pick([0, 1, 1, 2, 3, 4, 7, 12]);
  for (let i = 0; i < count; i++) {
    const line: TotalsLine = {
      quantity: pick([1, 1, 2, 3, 0.5, 1.5, 0.333, 2.675, 10, 125.125, int(50) + 1]),
      unitPriceAgorot: pick([0, 1, 5, 10, 99, 100, 118, 125, 999, 1001, 9999, 11800, 117000, int(2_000_000), int(100_000_000)]),
    };
    const kind = int(5);
    if (kind === 1) line.discountBp = pick([0, 500, 1000, 1250, 3333, 10000, int(10000)]);
    if (kind === 2) line.discountAgorot = int(Math.max(0, Math.round(line.unitPriceAgorot * line.quantity)));
    if (int(3) === 0) line.vatExempt = true;
    lines.push(line);
  }
  const options: TotalsOptions = {
    rateBp: pick([0, 1700, 1800, 1800, 1800, 1650, 10000]),
    pricesIncludeVat: next() < 0.5,
    roundToShekel: next() < 0.3,
  };
  const docKind = int(4);
  if (docKind === 1) options.discountBp = pick([500, 1000, 1500, 3333, int(10000)]);
  if (docKind === 2) options.discountAgorot = int(5_000_000);
  return [lines, options];
}

/** TAX-05: app.document_totals() and documentTotals() give the same answer. */
describe("document totals: database and app agree", () => {
  let user: { id: string };

  beforeAll(async () => {
    user = await createUser("totals-user");
    await createOrg(user.id);
  });

  it("the worked example of SPEC 4.6", async () => {
    const result = await asUser(user.id, (q) => sqlTotals(q, [{ quantity: 3, unitPriceAgorot: 10000, discountBp: 1000 }], { rateBp: 1800, pricesIncludeVat: false }));
    expect(result.ok && [result.totals.netTotalAgorot, result.totals.vatAgorot, result.totals.totalAgorot]).toEqual([27000, 4860, 31860]);
  });

  it("600 random documents, including refused ones", async () => {
    const next = rng(20261013);
    let refused = 0;
    await asUser(user.id, async (q) => {
      for (let i = 0; i < 600; i++) {
        const [lines, options] = randomCase(next);
        const app = documentTotals(lines, options);
        const db = await sqlTotals(q, lines, options);
        expect(db, `case ${i}: ${JSON.stringify({ lines, options })}`).toEqual(app);
        if (!app.ok) refused++;
        else {
          // the totals reconcile in both modes
          const t = app.totals;
          expect(t.netSubtotalAgorot - t.netDiscountAgorot).toBe(t.netTotalAgorot);
          expect(t.lines.reduce((sum, line) => sum + line.netAgorot, 0)).toBe(t.netSubtotalAgorot);
          expect(t.netTotalAgorot + t.vatAgorot + t.roundingAgorot).toBe(t.totalAgorot);
          if (t.pricesIncludeVat) expect(t.totalBeforeRoundingAgorot).toBe(t.subtotalAgorot - t.documentDiscountAgorot);
        }
      }
    });
    // the generator makes some too-large fixed document discounts
    expect(refused).toBeGreaterThan(0);
  });

  it("hand-picked edges agree, errors included", async () => {
    const cases: [TotalsLine[], TotalsOptions][] = [
      [[], { rateBp: 1800, pricesIncludeVat: true, discountBp: 1000, roundToShekel: true }],
      [[1, 2, 3].map(() => ({ quantity: 1, unitPriceAgorot: 100 })), { rateBp: 1800, pricesIncludeVat: true }],
      [[{ quantity: 1, unitPriceAgorot: 50 }, { quantity: 1, unitPriceAgorot: 30 }], { rateBp: 1800, pricesIncludeVat: true }],
      [[{ quantity: 1, unitPriceAgorot: 125 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 1, unitPriceAgorot: 10050 }], { rateBp: 0, pricesIncludeVat: false, roundToShekel: true }],
      [[{ quantity: 1000000, unitPriceAgorot: 1000000 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 1000000, unitPriceAgorot: 1000001 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 1, unitPriceAgorot: 100 }, { quantity: 0.0005, unitPriceAgorot: 1 }], { rateBp: 1800, pricesIncludeVat: false }],
      // more than 3 decimals, however close: refused on both sides, no float tolerance
      [[{ quantity: 1.0000000001, unitPriceAgorot: 100 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 2.0000000004, unitPriceAgorot: 100 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 2.675, unitPriceAgorot: 333 }, { quantity: 0.001, unitPriceAgorot: 99999 }], { rateBp: 1800, pricesIncludeVat: true }],
      [[{ quantity: 1, unitPriceAgorot: 100, discountBp: 10, discountAgorot: 1 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 1, unitPriceAgorot: 100, discountAgorot: 101 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 1, unitPriceAgorot: 100 }], { rateBp: 1800, pricesIncludeVat: false, discountAgorot: 101 }],
      [[{ quantity: 1, unitPriceAgorot: 100 }], { rateBp: 1800, pricesIncludeVat: false, discountAgorot: 1, discountBp: 1 }],
      [[{ quantity: 1, unitPriceAgorot: 100 }], { rateBp: 10001, pricesIncludeVat: false }],
      [[{ quantity: -1, unitPriceAgorot: 100 }], { rateBp: 1800, pricesIncludeVat: false }],
      [[{ quantity: 1, unitPriceAgorot: -100 }], { rateBp: 1800, pricesIncludeVat: false }],
    ];
    await asUser(user.id, async (q) => {
      for (const [lines, options] of cases) {
        expect(await sqlTotals(q, lines, options), JSON.stringify({ lines, options })).toEqual(documentTotals(lines, options));
      }
    });
  });

  it("refuses malformed lines the app's types would not let through", async () => {
    const call = (lines: unknown) =>
      pgError(asUser(user.id, (q) => q("select app.document_totals($1::jsonb, 1800, false)", [JSON.stringify(lines)])));
    for (const [lines, code] of [
      [{ quantity: 1 }, "lines"],
      [[1], "lines at line 0"],
      [[{ quantity: "1", unit_price_agorot: 100 }], "quantity at line 0"],
      [[{ quantity: 1, unit_price_agorot: "100" }], "price at line 0"],
      [[{ quantity: 1, unit_price_agorot: 100.5 }], "price at line 0"],
      [[{ quantity: 1, unit_price_agorot: 100, vat_exempt: "yes" }], "lines at line 0"],
      [[{ quantity: 1, unit_price_agorot: 100, discount_bp: 10.5 }], "discount at line 0"],
      [[{ quantity: 1, unit_price_agorot: 100, discount_bp: "10" }], "discount at line 0"],
      [Array.from({ length: 501 }, () => ({ quantity: 1, unit_price_agorot: 1 })), "lines"],
    ] as const) {
      const error = await call(lines);
      expect(error.hint).toBe("totals:invalid");
      expect(error.message).toBe(`invalid document totals: ${code}`);
    }
    // a null rate is refused too, never taken as 0
    const noRate = await pgError(asUser(user.id, (q) => q("select app.document_totals('[]'::jsonb, null, false)")));
    expect(noRate.message).toBe("invalid document totals: rate");
  });
});

/** TAX-05 with TAX-01 and TAX-03: the rate a document of a business and a day uses. */
describe("the document VAT rate of a business", () => {
  let owner: { id: string };
  let member: { id: string };
  let org: string;
  const rate = (userId: string, day: string) =>
    asUser(userId, async (q) => (await q<{ r: number | null }>("select app.org_document_vat_rate($1, $2::date) as r", [org, day])).rows[0].r);

  beforeAll(async () => {
    owner = await createUser("rate-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "rate-member");
  });

  it("null while the VAT status is not set: the document asks, never guesses", async () => {
    expect(await rate(owner.id, "2026-10-13")).toBeNull();
  });

  it("the rate of the document's own day for a business that charges VAT; 17% before 2025, 18% after", async () => {
    await asUser(owner.id, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    expect(await rate(member.id, "2024-12-31")).toBe(1700);
    expect(await rate(member.id, "2025-01-01")).toBe(1800);
    const early = await pgError(rate(member.id, "2015-09-30"));
    expect(early.hint).toBe("vat:before_table");
  });

  it("0 for a business that charges no VAT, whatever the day", async () => {
    await asUser(owner.id, (q) => q("update public.org_document_settings set vat_status = 'exempt' where organization_id = $1", [org]));
    expect(await rate(member.id, "2026-10-13")).toBe(0);
    const totals = await asUser(member.id, async (q) =>
      (
        await q<{ t: SqlTotals }>(
          "select app.document_totals('[{\"quantity\": 3, \"unit_price_agorot\": 10000}]'::jsonb, app.org_document_vat_rate($1, '2026-10-13'), false) as t",
          [org],
        )
      ).rows[0].t,
    );
    expect([Number(totals.vat_agorot), Number(totals.total_agorot)]).toEqual([0, 30000]);
  });

  it("someone outside the business gets no answer (RLS: the status is not visible)", async () => {
    const stranger = await createUser("rate-stranger");
    expect(await rate(stranger.id, "2026-10-13")).toBeNull();
  });
});
