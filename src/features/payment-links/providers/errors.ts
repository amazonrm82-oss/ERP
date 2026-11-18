// LNK-01: an adapter throws this when the provider answered a clear refusal. `final` says whether asking again with the same
// idempotency key could help (a throttle) or never will (a refused request). Any other throw counts as "no answer", tried
// again by the queue. The code is a short code, never a message from the provider.
export class PaymentProviderRefusal extends Error {
  readonly code: string;
  readonly final: boolean;
  constructor(code: string, final = true) {
    super(`payment provider refused: ${code}`);
    const clean = code.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
    this.code = clean === "" ? "provider_error" : clean;
    this.final = final;
  }
}
