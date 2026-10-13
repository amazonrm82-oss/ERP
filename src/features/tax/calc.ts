/**
 * Document totals (TAX-05): one pure function for quotes, orders and documents.
 * Mirrored exactly by app.document_totals() (migration tax_calc); test
 * 94-document-totals compares the two on many cases, so change both together.
 *
 * Rules (SPEC-ADDITIONS 4.1, 16.1):
 * - Every amount is an integer number of agorot; a rate or a percentage is an
 *   integer number of basis points (1800 = 18%, 1000 = 10%). Arithmetic is
 *   exact (BigInt); every rounding is half up to the agora.
 * - A line: amount = unit price x quantity (quantity up to 3 decimals), rounded
 *   once; then its own discount (a percentage OR a fixed amount, not both).
 * - Then a document discount (percentage OR amount) on the sum of the lines.
 *   It is split between taxable and exempt lines in proportion to their sums
 *   (the taxable share rounded, the exempt share gets the rest).
 * - Discounts always come before VAT.
 * - VAT is computed ONCE, on the taxable sum after every discount, and rounded
 *   to the agora at document level (never per line).
 * - A line may be VAT exempt (vatExempt: the product's own "exempt" or "zero
 *   rate", SPEC 4.2): it carries no VAT. There is no whole-document exemption
 *   here; a business that charges no VAT at all (TAX-01) passes rateBp = 0
 *   (documentVatRateBp()) and shows no VAT line.
 * - Optional rounding line to a whole shekel, after VAT, outside VAT.
 *
 * Two modes (TAX-04, prices_include_vat):
 * - before VAT (false): prices are net. taxable = taxable lines - their share
 *   of the document discount; VAT = round(taxable x rate / 10000).
 * - including VAT (true): prices of taxable lines already include VAT, so the
 *   discounts are taken off those gross prices, and the customer pays exactly
 *   the gross sum G that results. The net is taken out of G once:
 *   taxable = round(G x 10000 / (10000 + rate)), VAT = G - taxable. So the
 *   total is never off by an agora from what was typed. Each taxable line's
 *   net (before the document discount) is its gross x 10000 / (10000 + rate),
 *   rounded down, and the agorot that are left (so that the lines add up to
 *   round(sum of gross x 10000 / (10000 + rate))) go one each to the lines
 *   with the largest remainders, the earlier line first on a tie. Exempt
 *   lines carry no VAT, so their price is their net in both modes.
 */

export type TotalsLine = {
  /** > 0, at most 3 decimals, at most 1,000,000 */
  quantity: number;
  /** integer agorot, >= 0; before VAT or including VAT by the document's mode */
  unitPriceAgorot: number;
  /** line discount as a percentage in basis points (0..10000), or */
  discountBp?: number | null;
  /** line discount as a fixed amount in agorot (in the document's mode); not both */
  discountAgorot?: number | null;
  /** the line carries no VAT (product exempt or zero rate) */
  vatExempt?: boolean | null;
};

export type TotalsOptions = {
  /** VAT rate in basis points (0..10000); 0 for a business that charges no VAT */
  rateBp: number;
  /** TAX-04: prices include VAT */
  pricesIncludeVat: boolean;
  /** document discount as a percentage in basis points, or */
  discountBp?: number | null;
  /** document discount as a fixed amount in agorot (in the document's mode); not both */
  discountAgorot?: number | null;
  /** add a rounding line to a whole shekel */
  roundToShekel?: boolean;
};

export type LineTotals = {
  /** price x quantity, rounded, as typed (net or gross by the mode) */
  amountAgorot: number;
  /** the line's own discount, as typed */
  discountAgorot: number;
  /** amount - discount, as typed */
  totalAgorot: number;
  /** the line before VAT, before the document discount (= total in the before-VAT mode and for an exempt line) */
  netAgorot: number;
  vatExempt: boolean;
};

export type DocumentTotals = {
  lines: LineTotals[];
  /** sum of the lines' totals, as typed */
  subtotalAgorot: number;
  /** the document discount, as typed */
  documentDiscountAgorot: number;
  /** sum of the lines' nets: "לפני מע"מ" before the document discount */
  netSubtotalAgorot: number;
  /** the document discount before VAT */
  netDiscountAgorot: number;
  /** taxable sum after every discount, before VAT */
  taxableAgorot: number;
  /** exempt sum after every discount */
  exemptAgorot: number;
  /** taxable + exempt: the document before VAT, after discounts */
  netTotalAgorot: number;
  vatAgorot: number;
  totalBeforeRoundingAgorot: number;
  /** the rounding line (may be negative); 0 without rounding */
  roundingAgorot: number;
  /** what the customer pays */
  totalAgorot: number;
  rateBp: number;
  pricesIncludeVat: boolean;
};

/** Why totals cannot be computed. `line` is the 0-based index of the line, or null for the document. */
export type TotalsError = "rate" | "lines" | "quantity" | "price" | "amount" | "discount" | "discount_too_large";

export type TotalsResult = { ok: true; totals: DocumentTotals } | { ok: false; error: TotalsError; line: number | null };

export const TOTALS_MAX_LINES = 500;
export const TOTALS_MAX_QUANTITY = 1_000_000;
/** 10 billion shekels: a line amount above it is refused, so every sum stays an exact JS number */
export const TOTALS_MAX_AMOUNT = 1_000_000_000_000;
// BigInt(...) rather than literals: the project's TypeScript target is below ES2020
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const THOUSAND = BigInt(1000);
const BP = BigInt(10_000);

/** n / d rounded half up; n >= 0, d > 0. */
function divRound(n: bigint, d: bigint): bigint {
  return (TWO * n + d) / (TWO * d);
}

function isBp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function isAgorot(value: unknown, max = TOTALS_MAX_AMOUNT): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** Quantity in thousandths, or null when it is not a positive number with at most 3 decimals. */
function quantityMilli(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > TOTALS_MAX_QUANTITY) return null;
  // exact, no tolerance: the number must be the double nearest to milli / 1000 (division is
  // correctly rounded), i.e. a decimal with at most 3 places, as its JSON text shows the database
  const milli = Math.round(value * 1000);
  if (milli <= 0 || milli / 1000 !== value) return null;
  return BigInt(milli);
}

const isNone = (value: unknown) => value === null || value === undefined;

/** A discount (percentage or fixed) of `base`, or an error. */
function discountOf(bp: unknown, agorot: unknown, base: bigint): bigint | "discount" | "discount_too_large" {
  if (!isNone(bp) && !isNone(agorot)) return "discount";
  if (!isNone(bp)) return isBp(bp) ? divRound(base * BigInt(bp), BP) : "discount";
  if (!isNone(agorot)) {
    if (!isAgorot(agorot)) return "discount";
    return BigInt(agorot) > base ? "discount_too_large" : BigInt(agorot);
  }
  return ZERO;
}

export function documentTotals(lines: readonly TotalsLine[], options: TotalsOptions): TotalsResult {
  const fail = (error: TotalsError, line: number | null = null): TotalsResult => ({ ok: false, error, line });

  if (!isBp(options.rateBp)) return fail("rate");
  if (!Array.isArray(lines) || lines.length > TOTALS_MAX_LINES) return fail("lines");
  const rate = BigInt(options.rateBp);
  const gross = options.pricesIncludeVat === true;

  type Work = { amount: bigint; discount: bigint; total: bigint; net: bigint; exempt: boolean };
  const work: Work[] = [];
  for (const [index, line] of lines.entries()) {
    if (typeof line !== "object" || line === null) return fail("lines", index);
    if (!isNone(line.vatExempt) && typeof line.vatExempt !== "boolean") return fail("lines", index);
    const qty = quantityMilli(line.quantity);
    if (qty === null) return fail("quantity", index);
    if (!isAgorot(line.unitPriceAgorot, Number.MAX_SAFE_INTEGER)) return fail("price", index);
    const amount = divRound(BigInt(line.unitPriceAgorot) * qty, THOUSAND);
    if (amount > BigInt(TOTALS_MAX_AMOUNT)) return fail("amount", index);
    const discount = discountOf(line.discountBp, line.discountAgorot, amount);
    if (typeof discount === "string") return fail(discount, index);
    const total = amount - discount;
    work.push({ amount, discount, total, net: total, exempt: line.vatExempt === true });
  }

  let taxableSum = ZERO;
  let exemptSum = ZERO;
  for (const line of work) {
    if (line.exempt) exemptSum += line.total;
    else taxableSum += line.total;
  }
  const subtotal = taxableSum + exemptSum;

  const docDiscount = discountOf(options.discountBp, options.discountAgorot, subtotal);
  if (typeof docDiscount === "string") return fail(docDiscount);
  const discountTaxable = subtotal > ZERO ? divRound(docDiscount * taxableSum, subtotal) : ZERO;
  const discountExempt = docDiscount - discountTaxable;
  const taxableAfter = taxableSum - discountTaxable;
  const exempt = exemptSum - discountExempt;

  let taxable: bigint;
  let vat: bigint;
  let netTaxableBefore: bigint;
  if (gross) {
    const den = BP + rate;
    taxable = divRound(taxableAfter * BP, den);
    vat = taxableAfter - taxable;
    netTaxableBefore = divRound(taxableSum * BP, den);
    // each taxable line: floor of its net, then the agorot left go to the largest remainders
    const shares = work
      .map((line, index) => ({ line, index, num: line.total * BP }))
      .filter((item) => !item.line.exempt)
      .map((item) => ({ ...item, floor: item.num / den, rem: item.num % den }));
    let left = netTaxableBefore - shares.reduce((sum, item) => sum + item.floor, ZERO);
    for (const item of shares) item.line.net = item.floor;
    const order = [...shares].sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
    for (const item of order) {
      if (left <= ZERO) break;
      item.line.net += ONE;
      left -= ONE;
    }
  } else {
    taxable = taxableAfter;
    vat = divRound(taxable * rate, BP);
    netTaxableBefore = taxableSum;
  }

  const netTotal = taxable + exempt;
  const totalBefore = netTotal + vat;
  const total = options.roundToShekel === true ? divRound(totalBefore, HUNDRED) * HUNDRED : totalBefore;

  return {
    ok: true,
    totals: {
      lines: work.map((line) => ({
        amountAgorot: Number(line.amount),
        discountAgorot: Number(line.discount),
        totalAgorot: Number(line.total),
        netAgorot: Number(line.net),
        vatExempt: line.exempt,
      })),
      subtotalAgorot: Number(subtotal),
      documentDiscountAgorot: Number(docDiscount),
      netSubtotalAgorot: Number(netTaxableBefore + exemptSum),
      netDiscountAgorot: Number(netTaxableBefore - taxable + discountExempt),
      taxableAgorot: Number(taxable),
      exemptAgorot: Number(exempt),
      netTotalAgorot: Number(netTotal),
      vatAgorot: Number(vat),
      totalBeforeRoundingAgorot: Number(totalBefore),
      roundingAgorot: Number(total - totalBefore),
      totalAgorot: Number(total),
      rateBp: options.rateBp,
      pricesIncludeVat: gross,
    },
  };
}

/**
 * The rate a document's totals use, from documentVat() (rates.ts): 0 when the
 * business charges no VAT (TAX-01), the rate of the document's day, or null
 * when the status or the rate is not known yet (ask, never guess).
 * Mirrors app.org_document_vat_rate().
 */
export function documentVatRateBp(vat: { kind: "none" } | { kind: "unknown" } | { kind: "rate"; rateBp: number }): number | null {
  if (vat.kind === "none") return 0;
  return vat.kind === "rate" ? vat.rateBp : null;
}

/** Hebrew text for a totals error (also for the database hint totals:invalid). */
export function totalsErrorMessage(error: TotalsError): string {
  switch (error) {
    case "quantity":
      return "הכמות צריכה להיות גדולה מאפס, עם עד שלוש ספרות אחרי הנקודה.";
    case "price":
      return "המחיר צריך להיות סכום חיובי.";
    case "amount":
      return "סכום השורה גדול מדי.";
    case "discount":
      return "ההנחה לא תקינה. בוחרים אחוז או סכום, לא את שניהם.";
    case "discount_too_large":
      return "ההנחה גדולה מהסכום.";
    case "lines":
      return `אפשר עד ${TOTALS_MAX_LINES} שורות במסמך.`;
    case "rate":
      return 'שיעור המע"מ לא תקין.';
  }
}
