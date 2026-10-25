import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fromDbRule, toDbRule } from "@/features/automations/convert";
import { FEATURE_MISSING, TRIGGERS, triggerFlags, triggerOffered } from "@/features/automations/definitions";
import { describeRule } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";

// AUT-04 follow-up: "חוב עבר את מועדו" in the builder: both plan flags, days after the due date, and the engine's lists.

const ENGINE = readFileSync(
  `supabase/migrations/${readdirSync("supabase/migrations").find((file) => file.endsWith("_debt_overdue_trigger.sql"))}`,
  "utf8",
);

const lookups: Lookups = { statuses: [], sources: [], tags: [], pipelines: [], members: [], teams: [], reasons: [], fields: {}, payments: true, quotes: true, documents: true };
const store = (trigger: string, extra: Record<string, unknown> = {}, with_: Lookups = lookups) =>
  toDbRule(ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions: [{ type: "notify", to: "owner", title: "x" }], ...extra }), with_);

describe("debt overdue trigger (AUT-04 follow-up)", () => {
  it("is in the engine's constraint, for deals and contacts, and needs documents and payments as app.automation_trigger_flags", () => {
    expect(ENGINE.match(/automations_trigger_type_check check \(trigger_type = any \(array\[([^\]]*)\]/)![1]).toContain("'debt_overdue'");
    expect(ENGINE).toContain("when p_trigger = 'debt_overdue' then array['documents', 'payments']");
    expect(TRIGGERS.filter((t) => t.type === "debt_overdue").map((t) => [t.key, t.entity, t.label])).toEqual([
      ["deal:debt_overdue", "deal", "חוב בעסקה עבר את מועדו"],
      ["contact:debt_overdue", "contact", "חוב של איש קשר עבר את מועדו"],
    ]);
    expect(triggerFlags("debt_overdue")).toEqual(["documents", "payments"]);
    expect(triggerFlags("quote_viewed")).toEqual(["quotes"]);
    expect(triggerFlags("created")).toEqual([]);
  });

  it("is offered and saved only with both flags", () => {
    const debt = TRIGGERS.find((t) => t.key === "deal:debt_overdue")!;
    expect(triggerOffered(debt, { documents: true, payments: true })).toBe(true);
    expect(triggerOffered(debt, { documents: true, payments: false })).toBe(false);
    expect(triggerOffered(debt, { documents: false, payments: true })).toBe(false);
    expect(triggerOffered(debt, {}, "deal:debt_overdue")).toBe(true);
    expect(store("deal:debt_overdue", {}, { ...lookups, payments: false })).toBe(FEATURE_MISSING.payments);
    expect(store("deal:debt_overdue", {}, { ...lookups, documents: false })).toBe(FEATURE_MISSING.documents);
  });

  it("stores the days after the due date (0 by default) and reads them back", () => {
    expect(store("deal:debt_overdue")).toMatchObject({ trigger_type: "debt_overdue", trigger_config: { days_overdue: 0 } });
    const db = store("contact:debt_overdue", { trigger_days: "7" });
    expect(db).toMatchObject({ entity_type: "contact", trigger_config: { days_overdue: 7 } });
    expect(() => store("deal:debt_overdue", { trigger_days: "366" })).toThrow();
    expect(fromDbRule({ name: "כלל", entity: "contact", triggerType: "debt_overdue", triggerConfig: { days_overdue: 7 }, conditions: [], actions: [] })).toMatchObject({
      trigger: "contact:debt_overdue",
      triggerDays: "7",
    });
  });

  it("reads in Hebrew", () => {
    const when = (config: Record<string, unknown>) => describeRule({ entity: "deal", triggerType: "debt_overdue", triggerConfig: config, conditions: [], actions: [] }, lookups).when;
    expect(when({ days_overdue: 0 })).toBe("חוב בעסקה עבר את מועדו");
    expect(when({ days_overdue: 10 })).toBe("חוב בעסקה עבר את מועדו (10 ימים אחרי המועד)");
  });
});
