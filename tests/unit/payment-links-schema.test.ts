import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fakePaymentLinkId } from "@/features/payment-links/providers/fake";
import { isPaymentProviderCode, PAYMENT_PROVIDER_CODES } from "@/features/payment-links/providers/types";
import { addDays, effectiveLinkStatus, PAYMENT_LINK_STATUSES, paymentLinkSchema } from "@/features/payment-links/schema";

const root = join(__dirname, "..", "..");
const migration = () =>
  readFileSync(
    join(root, "supabase", "migrations", readdirSync(join(root, "supabase", "migrations")).find((f) => f.endsWith("_payment_links.sql"))!),
    "utf8",
  );

const LINK = "11111111-1111-4111-8111-111111111111";

describe("LNK-02: the table and the provider layer agree", () => {
  it("knows exactly the codes the database's provider check accepts", () => {
    const check = /provider\s+text not null check \(provider in \(([^)]*)\)\)/.exec(migration());
    expect(check).not.toBeNull();
    const codes = check![1].split(",").map((c) => c.trim().replace(/'/g, ""));
    expect(codes).toEqual([...PAYMENT_PROVIDER_CODES]);
    expect(isPaymentProviderCode("fake")).toBe(true);
    expect(isPaymentProviderCode("cardcom")).toBe(false);
  });

  it("names a fake link as the database does ('fake_' || id)", () => {
    expect(fakePaymentLinkId(LINK)).toBe(`fake_${LINK}`);
    expect(migration()).toContain("when new.provider = 'fake' then 'fake_' || new.id::text");
  });

  it("LNK-03: has no card column in the table", () => {
    expect(/card_?number|cvv|cvc|security_code/i.test(migration().replace(/^--.*$/gm, ""))).toBe(false);
  });
});

describe("LNK-02: the form and the states", () => {
  it("shows a pending link past its last day as expired", () => {
    const now = new Date("2026-11-16T10:00:00Z");
    expect(effectiveLinkStatus("pending", "2026-11-16T09:59:59Z", now)).toBe("expired");
    expect(effectiveLinkStatus("pending", "2026-11-17T00:00:00Z", now)).toBe("pending");
    expect(effectiveLinkStatus("paid", "2026-11-01T00:00:00Z", now)).toBe("paid");
    expect(effectiveLinkStatus("weird", "2026-12-01T00:00:00Z", now)).toBe("expired");
  });

  it("has the database's statuses", () => {
    expect(migration()).toContain(`check (status in (${PAYMENT_LINK_STATUSES.map((s) => `'${s}'`).join(", ")}))`);
  });

  it("adds whole days across months and years", () => {
    expect(addDays("2026-11-16", 14)).toBe("2026-11-30");
    expect(addDays("2026-12-25", 90)).toBe("2027-03-25");
  });

  it("checks amount, instalments and the last day as the database does", () => {
    const schema = paymentLinkSchema("2026-11-16");
    expect(schema.safeParse({ amount: "1,170", max_installments: "", expires_on: "2026-11-16" }).data).toEqual({
      amount: 117_000,
      max_installments: 1,
      expires_on: "2026-11-16",
    });
    expect(schema.safeParse({ amount: "0", max_installments: "1", expires_on: "2026-11-20" }).success).toBe(false);
    expect(schema.safeParse({ amount: "10", max_installments: "37", expires_on: "2026-11-20" }).success).toBe(false);
    expect(schema.safeParse({ amount: "10", max_installments: "2.5", expires_on: "2026-11-20" }).success).toBe(false);
    expect(schema.safeParse({ amount: "10", max_installments: "36", expires_on: "2026-11-15" }).success).toBe(false);
    expect(schema.safeParse({ amount: "10", max_installments: "36", expires_on: "2027-02-14" }).success).toBe(true);
    expect(schema.safeParse({ amount: "10", max_installments: "36", expires_on: "2027-02-15" }).success).toBe(false);
  });
});
