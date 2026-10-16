import { createHash, createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";

// FXS-11: one keyed hash for every public page.
describe("keyed IP hash (FXS-11)", () => {
  const original = process.env.INTAKE_IP_HASH_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.INTAKE_IP_HASH_SECRET;
    else process.env.INTAKE_IP_HASH_SECRET = original;
    vi.restoreAllMocks();
  });

  it("is an HMAC with the server's secret, never the plain or token-salted hash", () => {
    process.env.INTAKE_IP_HASH_SECRET = "s3cret";
    const hash = keyedIpHash("203.0.113.5", "intake", "abc");
    expect(hash).toBe(createHmac("sha256", "s3cret").update("intake:abc:203.0.113.5").digest("hex"));
    expect(hash).not.toBe(createHash("sha256").update("abc:203.0.113.5").digest("hex"));
    expect(keyedIpHash("203.0.113.5", "intake", "abc")).toBe(hash);
    process.env.INTAKE_IP_HASH_SECRET = "other";
    expect(keyedIpHash("203.0.113.5", "intake", "abc")).not.toBe(hash);
  });

  it("keeps the booking and card values the pages already used", () => {
    process.env.INTAKE_IP_HASH_SECRET = "s3cret";
    expect(keyedIpHash("1.2.3.4", "booking")).toBe(createHmac("sha256", "s3cret").update("booking:1.2.3.4").digest("hex"));
    expect(keyedIpHash("1.2.3.4", "card")).toBe(createHmac("sha256", "s3cret").update("card:1.2.3.4").digest("hex"));
  });

  it("one visitor is a different value per scope and per form", () => {
    process.env.INTAKE_IP_HASH_SECRET = "s3cret";
    const values = [keyedIpHash("1.2.3.4", "intake", "f1"), keyedIpHash("1.2.3.4", "intake", "f2"), keyedIpHash("1.2.3.4", "booking"), keyedIpHash("1.2.3.4", "card")];
    expect(new Set(values).size).toBe(4);
  });

  it("without the secret: no hash at all, and one clear error per scope", () => {
    delete process.env.INTAKE_IP_HASH_SECRET;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(keyedIpHash("1.2.3.4", "waitlist")).toBeNull();
    expect(keyedIpHash("5.6.7.8", "waitlist")).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("INTAKE_IP_HASH_SECRET");
    expect(keyedIpHash(null, "intake")).toBeNull();
  });

  it("reads the first forwarded address, else the real IP", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe("203.0.113.5");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBeNull();
  });
});
