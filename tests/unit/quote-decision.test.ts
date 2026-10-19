import { describe, expect, it } from "vitest";

import { ACCEPT_WORDING_VERSION, DECISION_MESSAGES, decisionBodySchema, isDecisionStatus, publicVersionFingerprint } from "@/features/quotes/decision";

// QUO-09: what the customer's page may post, and the answers it shows.
const fp = "a".repeat(64);
const png = "data:image/png;base64,iVBORw0KGgo=";

describe("decisionBodySchema", () => {
  it("accepts a drawn and a typed signature", () => {
    const drawn = { decision: "accepted", fingerprint: fp, signerName: "דנה כהן", idNumber: null, signatureKind: "drawn", signatureImage: png, agreed: true };
    expect(decisionBodySchema.safeParse(drawn).success).toBe(true);
    expect(decisionBodySchema.safeParse({ ...drawn, signatureKind: "typed", signatureImage: null }).success).toBe(true);
  });

  it("refuses an acceptance without the checkbox, a name, or a PNG", () => {
    const base = { decision: "accepted", fingerprint: fp, signerName: "דנה כהן", idNumber: null, signatureKind: "drawn", signatureImage: png, agreed: true };
    expect(decisionBodySchema.safeParse({ ...base, agreed: false }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...base, signerName: " א " }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...base, signatureImage: "data:image/svg+xml;base64,PHN2Zz4=" }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...base, signatureImage: `data:image/png;base64,${"A".repeat(300_001)}` }).success).toBe(false);
    expect(decisionBodySchema.safeParse({ ...base, fingerprint: "xyz" }).success).toBe(false);
  });

  it("takes a decline with or without a reason, up to 1,000 characters", () => {
    expect(decisionBodySchema.safeParse({ decision: "rejected", fingerprint: fp, reason: null }).success).toBe(true);
    expect(decisionBodySchema.safeParse({ decision: "rejected", fingerprint: fp, reason: "יקר מדי" }).success).toBe(true);
    expect(decisionBodySchema.safeParse({ decision: "rejected", fingerprint: fp, reason: "א".repeat(1001) }).success).toBe(false);
  });
});

describe("decision statuses", () => {
  it("has a Hebrew answer for every status the database returns", () => {
    for (const status of ["accepted", "rejected", "already_decided", "changed", "invalid", "rate_limited"]) {
      expect(isDecisionStatus(status)).toBe(true);
      expect(DECISION_MESSAGES[status as keyof typeof DECISION_MESSAGES]).toMatch(/[א-ת]/);
    }
    expect(isDecisionStatus("toString")).toBe(false);
    expect(isDecisionStatus("not_found")).toBe(false);
  });

  it("keeps a wording version the database accepts", () => {
    expect(ACCEPT_WORDING_VERSION).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(ACCEPT_WORDING_VERSION.startsWith("draft-")).toBe(true);
  });
});


describe("publicVersionFingerprint", () => {
  it("gives the fingerprint only for the version the page drew", () => {
    expect(publicVersionFingerprint({ number: "QT-7", fingerprint: fp }, "QT-7")).toBe(fp);
    // a newer version arrived between the two reads: no decision until the page is reloaded
    expect(publicVersionFingerprint({ number: "QT-8", fingerprint: fp }, "QT-7")).toBeNull();
    // answered or closed
    expect(publicVersionFingerprint({ number: "QT-7", fingerprint: null }, "QT-7")).toBeNull();
    expect(publicVersionFingerprint({ number: "QT-7", fingerprint: fp }, null)).toBeNull();
    expect(publicVersionFingerprint({ rate_limited: true }, "QT-7")).toBeNull();
    expect(publicVersionFingerprint({ number: "QT-7", fingerprint: "xyz" }, "QT-7")).toBeNull();
    expect(publicVersionFingerprint(null, "QT-7")).toBeNull();
  });
});
