import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INVOICE_PROVIDER_EVENT_KINDS,
  invoiceProviderEventText,
  isConnectionAuthCode,
  isUnreachableCode,
  providerFailureCode,
} from "@/features/invoicing/provider-events";
import { AUTH_REASON, issueEndedText } from "@/features/invoicing/issue";
import { notificationHref } from "@/features/notifications/links";

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/20261006021319_invoice_provider_events.sql"), "utf8");

// DOC-16: the invoice provider connection's sync log lines and the rule that tells a fallen connection from a refused document.
describe("invoice provider sync log (DOC-16)", () => {
  it("the kinds are the table's closed list", () => {
    const listed = MIGRATION.match(/constraint invoice_provider_events_kind check \(kind in \(([^)]*)\)\)/);
    expect(listed).not.toBeNull();
    const kinds = [...(listed?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual([...INVOICE_PROVIDER_EVENT_KINDS]);
  });

  it("mirrors the database's auth and unreachable rules (the same patterns as the migration)", () => {
    expect(MIGRATION).toContain("p_code ~ '^((customer|product)_)?auth(:|$)'");
    expect(MIGRATION).toContain("p_code ~ '^((customer|product)_)?(unreachable|timeout)$'");
    expect(["auth:x", "auth", "product_auth:y"].map(isConnectionAuthCode)).toEqual([true, true, true]);
    expect(["author", "bad_tax_id", null].map(isConnectionAuthCode)).toEqual([false, false, false]);
    expect(["timeout", "customer_unreachable", "unreachable_x", null].map(isUnreachableCode)).toEqual([true, true, false, false]);
  });

  it("only falls while issuing send the notice; a failed check is a line only (owner (425) ג)", () => {
    const calls = [...MIGRATION.matchAll(/perform app\.invoice_provider_connection_failure\([^,]+, '([a-z]+)'\)/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(["auth", "auth", "unreachable"]);
    const settingsTrigger = MIGRATION.slice(MIGRATION.indexOf("function app.invoice_provider_settings_events()"), MIGRATION.indexOf("create or replace trigger invoice_provider_settings_events"));
    expect(settingsTrigger).toContain("'check_failed'");
    expect(settingsTrigger).not.toContain("invoice_provider_connection_failure");
  });

  it("the worker sends an auth failure as auth:<code>, any other failure as the provider's code", () => {
    expect(providerFailureCode({ kind: "auth", code: "key_refused" })).toBe("auth:key_refused");
    expect(providerFailureCode({ kind: "refused", code: "bad_tax_id" })).toBe("bad_tax_id");
    expect(providerFailureCode({ kind: "retry", code: "throttled" })).toBe("throttled");
    expect(providerFailureCode({ kind: "auth", code: "x".repeat(80) })).toHaveLength(64);
  });

  it("writes a Hebrew line per kind, with the reason and the day's count", () => {
    for (const kind of INVOICE_PROVIDER_EVENT_KINDS) expect(invoiceProviderEventText(kind, null, 1).text).toMatch(/[א-ת]/);
    expect(invoiceProviderEventText("issued", "tax_invoice", 3).text).toBe("מסמכים הופקו ונרשמו: חשבונית מס (3)");
    expect(invoiceProviderEventText("retry", "timeout", 1)).toEqual({ text: "הספק לא ענה, ננסה שוב: הספק לא ענה בזמן", tone: "warning" });
    expect(invoiceProviderEventText("failed", "auth:key_refused", 1)).toEqual({ text: "הספק סירב להפיק מסמך: הספק לא קיבל את פרטי החיבור", tone: "danger" });
    expect(invoiceProviderEventText("failed", "bad_tax_id", 1)).toEqual({ text: "הספק סירב להפיק מסמך", tone: "warning" });
    expect(invoiceProviderEventText("something", null, 1).text).toBe("אירוע בחיבור");
  });

  it("an ended request refused for the connection's key says so in the sync log's words", () => {
    for (const code of ["auth:key_refused", "customer_auth:x", "product_auth"]) {
      expect(issueEndedText("failed", code, null)).toBe(`המסמך לא הופק: ${AUTH_REASON}. אפשר לתקן ולהפיק שוב.`);
    }
    expect(issueEndedText("unrecorded", "auth:key_refused", null)).toContain(`: ${AUTH_REASON}.`);
    expect(invoiceProviderEventText("failed", "customer_auth:x", 1).text).toContain(AUTH_REASON);
    expect(issueEndedText("failed", "author", null)).toBe("המסמך לא הופק, הספק סירב להפיק אותו. אפשר לתקן ולהפיק שוב.");
  });

  it("the connection notice opens the invoice provider settings", () => {
    expect(notificationHref("org-1", "invoice_provider", "org-1")).toBe("/o/org-1/settings/invoicing");
  });
});
