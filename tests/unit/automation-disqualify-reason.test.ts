import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { actionsMissingReason, fromDbRule, NO_REASONS_IN_LIST, REASON_REQUIRED, toDbRule } from "@/features/automations/convert";
import type { Lookups } from "@/features/automations/queries";
import { STEP_WARNINGS } from "@/features/automations/describe";
import { ruleSchema } from "@/features/automations/schema";

// RVW-9 (owner, 12 October 2026): an automation that makes a lead "not relevant" gives a reason from the list.
const OPEN = "11111111-1111-4111-8111-111111111111";
const DISQ = "22222222-2222-4222-8222-222222222222";
const REASON = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

const lookups: Lookups = {
  statuses: [
    { id: OPEN, name: "בטיפול", kind: "open" },
    { id: DISQ, name: "לא רלוונטי", kind: "disqualified" },
  ],
  sources: [],
  tags: [],
  pipelines: [],
  members: [],
  teams: [],
  reasons: [{ id: REASON, name: "יקר מדי" }],
};

const rule = (action: Record<string, unknown>) => ({ name: "בדיקה", trigger: "lead:created", conditions: [], actions: [action] });
const build = (action: Record<string, unknown>, l: Lookups = lookups) => {
  const parsed = ruleSchema.safeParse(rule(action));
  if (!parsed.success) return `schema: ${parsed.error.issues[0]?.message}`;
  return toDbRule(parsed.data, l);
};

describe("set_lead_status and the not-relevant reason", () => {
  it("the schema takes an optional reason id and refuses one that is not an id", () => {
    expect(ruleSchema.safeParse(rule({ type: "set_lead_status", status_id: DISQ })).success).toBe(true);
    expect(ruleSchema.safeParse(rule({ type: "set_lead_status", status_id: DISQ, reason_id: REASON })).success).toBe(true);
    expect(ruleSchema.safeParse(rule({ type: "set_lead_status", status_id: DISQ, reason_id: "יקר מדי" })).success).toBe(false);
  });

  it("a not-relevant status needs a reason from the active list", () => {
    expect(build({ type: "set_lead_status", status_id: DISQ })).toBe(REASON_REQUIRED);
    expect(build({ type: "set_lead_status", status_id: DISQ, reason_id: OTHER })).toMatch(/כבר לא ברשימה/);
    expect(build({ type: "set_lead_status", status_id: DISQ, reason_id: REASON }, { ...lookups, reasons: [] })).toBe(NO_REASONS_IN_LIST);
    const ok = build({ type: "set_lead_status", status_id: DISQ, reason_id: REASON });
    expect(typeof ok === "object" && ok.actions).toEqual([{ type: "set_lead_status", status_id: DISQ, reason_id: REASON }]);
  });

  it("another status needs no reason and drops one that was sent", () => {
    const ok = build({ type: "set_lead_status", status_id: OPEN, reason_id: REASON });
    expect(typeof ok === "object" && ok.actions).toEqual([{ type: "set_lead_status", status_id: OPEN }]);
  });

  it("editing a saved rule brings its reason back into the builder", () => {
    const initial = fromDbRule({
      name: "x",
      entity: "lead",
      triggerType: "created",
      triggerConfig: {},
      conditions: [],
      actions: [{ type: "set_lead_status", status_id: DISQ, reason_id: REASON }],
    });
    expect(initial?.actions[0]).toEqual({ type: "set_lead_status", status_id: DISQ, reason_id: REASON });
  });

  it("finds the saved actions that still need a reason (the reminder)", () => {
    const actions = [
      { type: "set_lead_status", status_id: DISQ },
      { type: "set_lead_status", status_id: DISQ, reason_id: REASON },
      { type: "set_lead_status", status_id: DISQ, reason_id: OTHER },
      { type: "set_lead_status", status_id: OPEN },
      { type: "notify", to: "owner", title: "x" },
    ];
    expect(actionsMissingReason(actions, lookups)).toEqual([0, 2]);
  });
});

describe("run log warnings", () => {
  it("every warning the engine writes (migration 0098) has a Hebrew text", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261006009500_automation_disqualify_reason.sql"), "utf8");
    const written = [...sql.matchAll(/v_warning := '([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(written)].sort()).toEqual(["no reason is set", "the reason no longer exists"]);
    for (const warning of written) {
      expect(STEP_WARNINGS[warning]).toBeTruthy();
    }
    expect(Object.keys(STEP_WARNINGS).sort()).toEqual([...new Set(written)].sort());
  });
});
