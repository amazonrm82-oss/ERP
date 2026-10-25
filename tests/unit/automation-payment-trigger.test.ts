import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fromDbRule, shekelsToAgorot, toDbRule } from "@/features/automations/convert";
import { TRIGGERS, triggerOffered } from "@/features/automations/definitions";
import { describeRule } from "@/features/automations/describe";
import type { Lookups } from "@/features/automations/queries";
import { ruleSchema } from "@/features/automations/schema";

// PAY-07 part two: the "payment received" trigger: builder values -> stored setting -> builder values, and the texts.

// the latest migration holding a text (found by its content, so renumbering at merge keeps the test)
const latest = (text: string) =>
  readFileSync(
    `supabase/migrations/${readdirSync("supabase/migrations")
      .sort()
      .filter((file) => readFileSync(`supabase/migrations/${file}`, "utf8").includes(text))
      .at(-1)}`,
    "utf8",
  );
// the latest migration that sets the trigger types
const ENGINE = latest("automations_trigger_type_check check");

const lookups: Lookups = { statuses: [], sources: [], tags: [], pipelines: [], members: [], teams: [], reasons: [], fields: {}, payments: true };

const parse = (trigger: string, extra: Record<string, unknown> = {}) =>
  ruleSchema.parse({ name: "כלל", trigger, conditions: [], actions: [{ type: "notify", to: "owner", title: "התקבל תשלום" }], ...extra });

const store = (trigger: string, extra: Record<string, unknown> = {}, with_ = lookups) => {
  const db = toDbRule(parse(trigger, extra), with_);
  if (typeof db === "string") throw new Error(db);
  return db;
};

describe("payment received trigger (PAY-07)", () => {
  it("every trigger type the builder offers is allowed by the engine's constraint", () => {
    const allowed = ENGINE.match(/automations_trigger_type_check check \(trigger_type = any \(array\[([^\]]*)\]/);
    expect(allowed).not.toBeNull();
    const types = [...allowed![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const trigger of TRIGGERS) expect(types, trigger.key).toContain(trigger.type);
    // the outbox (its latest definition) offers the event to both payment rule types
    const outbox = latest("create or replace function app.process_outbox");
    const offered = outbox.match(/and a\.trigger_type in \(([^)]*)\)/);
    expect(offered).not.toBeNull();
    expect(offered![1]).toContain("'payment_received'");
    expect(offered![1]).toContain("'payment_confirmed'");
  });

  it("is offered for deal and contact rules", () => {
    const payment = TRIGGERS.filter((t) => t.type === "payment_received" || t.type === "payment_confirmed");
    expect(payment.map((t) => [t.key, t.entity, t.type, t.label])).toEqual([
      ["deal:payment", "deal", "payment_received", "התקבל תשלום בעסקה"],
      ["contact:payment", "contact", "payment_received", "התקבל תשלום מאיש קשר"],
      ["deal:payment_confirmed", "deal", "payment_confirmed", "תשלום בעסקה אושר"],
      ["contact:payment_confirmed", "contact", "payment_confirmed", "תשלום של איש קשר אושר"],
    ]);
    expect(payment.every((t) => t.minAmount)).toBe(true);
  });

  it("is offered only with the payments flag, while a saved rule keeps its own", () => {
    const deal = TRIGGERS.find((t) => t.key === "deal:payment")!;
    const created = TRIGGERS.find((t) => t.key === "deal:created")!;
    expect(triggerOffered(deal, { payments: true })).toBe(true);
    expect(triggerOffered(deal, { payments: false })).toBe(false);
    expect(triggerOffered(deal, {})).toBe(false);
    expect(triggerOffered(deal, { payments: false }, "deal:payment")).toBe(true);
    expect(triggerOffered(created, { payments: false })).toBe(true);
    expect(toDbRule(parse("deal:payment"), { ...lookups, payments: false })).toBe("תשלומים אינם כלולים בתוכנית של העסק.");
    const confirmed = TRIGGERS.find((t) => t.key === "contact:payment_confirmed")!;
    expect(triggerOffered(confirmed, { payments: false })).toBe(false);
    expect(triggerOffered(confirmed, { payments: false }, "contact:payment_confirmed")).toBe(true);
    expect(toDbRule(parse("contact:payment_confirmed"), { ...lookups, payments: false })).toBe("תשלומים אינם כלולים בתוכנית של העסק.");
    expect(store("contact:payment_confirmed", { trigger_min: "20" })).toMatchObject({
      entity_type: "contact",
      trigger_type: "payment_confirmed",
      trigger_config: { min_agorot: 2000 },
    });
  });

  it("stores no minimum, or the minimum in agorot, and reads it back in shekels", () => {
    const any = store("deal:payment");
    expect(any).toMatchObject({ entity_type: "deal", trigger_type: "payment_received", trigger_config: {} });
    const min = store("contact:payment", { trigger_min: "1,500.5" });
    expect(min).toMatchObject({ entity_type: "contact", trigger_type: "payment_received", trigger_config: { min_agorot: 150050 } });
    // zero is the same as no minimum
    expect(store("deal:payment", { trigger_min: "0" }).trigger_config).toEqual({});

    const back = (triggerConfig: Record<string, unknown>, entity = "contact") =>
      fromDbRule({ name: "כלל", entity, triggerType: "payment_received", triggerConfig, conditions: [], actions: [] });
    expect(back({ min_agorot: 150050 })).toMatchObject({ trigger: "contact:payment", triggerMin: "1500.5" });
    expect(back({}, "deal")).toMatchObject({ trigger: "deal:payment", triggerMin: "" });
  });

  it("refuses an amount that is not a non-negative number", () => {
    expect(toDbRule(parse("deal:payment", { trigger_min: "abc" }), lookups)).toBe("יש להזין סכום מינימלי תקין.");
    expect(toDbRule(parse("deal:payment", { trigger_min: "-5" }), lookups)).toBe("יש להזין סכום מינימלי תקין.");
    expect(() => parse("deal:payment", { trigger_min: "1".repeat(31) })).toThrow();
    expect(shekelsToAgorot("₪ 99.90")).toBe(9990);
    expect(shekelsToAgorot("  ")).toBeNull();
  });

  it("reads in Hebrew, with the minimum when there is one", () => {
    const rule = (triggerConfig: Record<string, unknown>) => ({ entity: "deal", triggerType: "payment_received", triggerConfig, conditions: [], actions: [] });
    expect(describeRule(rule({}), lookups).when).toBe("התקבל תשלום בעסקה");
    expect(describeRule(rule({ min_agorot: 100000 }), lookups).when).toBe("התקבל תשלום בעסקה (לפחות ₪1,000)");
    expect(describeRule({ ...rule({ min_agorot: 5000 }), triggerType: "payment_confirmed" }, lookups).when).toBe("תשלום בעסקה אושר (לפחות ₪50)");
  });
});
