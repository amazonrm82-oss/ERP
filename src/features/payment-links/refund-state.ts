// LNK-07: the card's view of a payment's provider refund requests. Pure, unit tested.

/** LNK-07: a refund request of a link's payment, as the card shows it (amounts and codes only). */
export type ProviderRefundRequest = { id: string; amountAgorot: number; status: "pending" | "refunded" | "failed" | "unrecorded" | "released"; createdAt: string };

export type ProviderRefundState = {
  // a request still waiting for the provider (its amount), or null
  pending: number | null;
  // review 4: requests nobody knows the outcome of (closed by hand after checking at the provider), and recent failures
  unclear: ProviderRefundRequest[];
  failed: ProviderRefundRequest[];
};

const REQUEST_STATUSES = new Set(["pending", "refunded", "failed", "unrecorded", "released"]);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The card's view of one payment's provider refund requests, from public.payment_link_refund_state's answer. */
export function providerRefundState(data: unknown, now: Date = new Date()): ProviderRefundState {
  const rows = Array.isArray(data) ? data : [];
  const requests: ProviderRefundRequest[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.amount_agorot !== "number" || typeof r.status !== "string" || !REQUEST_STATUSES.has(r.status)) continue;
    requests.push({ id: r.id, amountAgorot: r.amount_agorot, status: r.status as ProviderRefundRequest["status"], createdAt: typeof r.created_at === "string" ? r.created_at : "" });
  }
  const pending = requests.find((r) => r.status === "pending");
  return {
    pending: pending ? pending.amountAgorot : null,
    unclear: requests.filter((r) => r.status === "unrecorded"),
    failed: requests.filter((r) => r.status === "failed" && now.getTime() - Date.parse(r.createdAt) < WEEK_MS),
  };
}
