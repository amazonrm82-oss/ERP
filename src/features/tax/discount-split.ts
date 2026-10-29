// DSC-01 (the document part): a document discount split between the document's lines, for reports only.
//
// The rule (lead's decision, 29 October 2026): each line's share is proportional to its total after its own line
// discount (the stored line total, in the document's VAT mode: the base app.document_totals takes the document
// discount off). Every line first gets the floor of its exact share; the agorot left go one each to the lines with the
// largest remainder, a tie to the earlier line (the order the caller passes: line position, then id). So the shares
// add up to the discount exactly, and no share is larger than its line's total.
//
// Mirrors app.discount_split(bigint[], bigint) exactly; tests/unit/fixtures/discount-split.json is run by both the unit
// test and the database test. Change both together.
//
// Answers null for input the rule does not take: a missing, negative or non-integer value, or a discount larger than
// the sum of the lines. A report then leaves the lines as stored.

export function discountSplit(totals: readonly number[], discount: number): number[] | null {
  if (!Number.isSafeInteger(discount) || discount < 0) return null;
  if (totals.some((t) => !Number.isSafeInteger(t) || t < 0)) return null;
  const big = totals.map((t) => BigInt(t));
  const sum = big.reduce((a, b) => a + b, BigInt(0));
  const d = BigInt(discount);
  if (d > sum) return null;
  if (d === BigInt(0) || sum === BigInt(0)) return totals.map(() => 0);

  const shares = big.map((t) => (d * t) / sum);
  const remainders = big.map((t, i) => ({ i, r: (d * t) % sum }));
  let left = d - shares.reduce((a, b) => a + b, BigInt(0));
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left <= BigInt(0)) break;
    shares[i] += BigInt(1);
    left -= BigInt(1);
  }
  return shares.map((s) => Number(s));
}
