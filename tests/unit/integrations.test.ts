import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INTEGRATIONS_CATALOG } from "@/features/integrations/catalog";
import { INTEGRATION_EVENT_KINDS, integrationEventText } from "@/features/integrations/event-text";
import { connectionTestMessage } from "@/features/integrations/test-messages";

const migrations = join(process.cwd(), "supabase/migrations");
const migration = readFileSync(join(migrations, readdirSync(migrations).find((f) => f.endsWith("_integration_events.sql"))!), "utf8");

describe("integrations catalog (INT-01)", () => {
  it("only Meta Lead Ads is a business's own connection; SMS is the platform's; email and payments are coming", () => {
    const items = INTEGRATIONS_CATALOG.flatMap((c) => c.items);
    expect(items.filter((i) => i.availability === "available").map((i) => i.provider)).toEqual(["meta_lead_ads"]);
    expect(INTEGRATIONS_CATALOG.find((c) => c.key === "sms")!.items.every((i) => i.availability === "platform")).toBe(true);
    for (const key of ["email", "payments"]) {
      expect(INTEGRATIONS_CATALOG.find((c) => c.key === key)!.items.every((i) => i.availability === "coming_soon"), key).toBe(true);
    }
    // keys are unique
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

describe("sync log lines (INT-03)", () => {
  it("the kinds are exactly the table's closed list", () => {
    const listed = /constraint integration_events_kind check \(kind in \(([^)]*)\)\)/.exec(migration)![1];
    const sqlKinds = [...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...sqlKinds].sort()).toEqual([...INTEGRATION_EVENT_KINDS].sort());
  });

  it("every kind has a Hebrew line; a known code adds its reason; a folded day line shows its count", () => {
    for (const kind of INTEGRATION_EVENT_KINDS) expect(integrationEventText(kind, null, 1).text).toMatch(/[א-ת]/);
    expect(integrationEventText("fetch_ok", null, 12).text).toBe("לידים נקלטו (12)");
    expect(integrationEventText("lead_refused", "form_off", 1).text).toBe("לידים לא נקלטו: הטופס כבוי");
    expect(integrationEventText("fetch_failed", "graph_unavailable", 3)).toEqual({ text: "משיכת ליד נכשלה ותנוסה שוב: פייסבוק לא ענתה (3)", tone: "warning" });
    // an unknown code or kind never shows raw text
    expect(integrationEventText("error", "weird_code", 1).text).toBe("תקלה בחיבור");
    expect(integrationEventText("nonsense", null, 1).text).toBe("אירוע בחיבור");
    expect(integrationEventText("token_invalid", null, 1).tone).toBe("danger");
    expect(integrationEventText("test_failed", "not_found", 1).text).toBe("בדיקת חיבור נכשלה: הטוקן לא של הדף הזה");
    expect(integrationEventText("test_ok", null, 1)).toEqual({ text: "בדיקת חיבור: תקין", tone: "success" });
  });
});

describe("test connection messages (INT-01, owner (227) ב)", () => {
  it("answers every outcome in Hebrew; only ok is a success; the rate refusal names the minutes", () => {
    expect(connectionTestMessage("ok").ok).toBe(true);
    for (const outcome of ["page_taken", "token_invalid", "expired", "error", "refused_not_found", "no_key"] as const) {
      const m = connectionTestMessage(outcome);
      expect(m.ok, outcome).toBe(false);
      expect(m.text, outcome).toMatch(/[א-ת]/);
    }
    expect(connectionTestMessage("refused_rate", 125).text).toContain("3 דקות");
    expect(connectionTestMessage("busy")).toEqual({ ok: false, text: "החיבור עסוק כרגע. נסו שוב בעוד רגע." });
  });
});
