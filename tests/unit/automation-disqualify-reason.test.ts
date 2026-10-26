import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { actionsMissingReason, fromDbRule, REASON_REQUIRED, toDbRule } from "@/features/automations/convert";
import type { Lookups } from "@/features/automations/queries";
import { RETIRED_STEP_WARNINGS, STEP_WARNINGS, stepWarningText } from "@/features/automations/describe";
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
  fields: {},
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
    const ok = build({ type: "set_lead_status", status_id: DISQ, reason_id: REASON });
    expect(typeof ok === "object" && ok.actions).toEqual([{ type: "set_lead_status", status_id: DISQ, reason_id: REASON }]);
  });

  it("while the organization has no reasons, the rule saves without one (owner, 13 October 2026)", () => {
    const empty = { ...lookups, reasons: [] };
    const none = build({ type: "set_lead_status", status_id: DISQ }, empty);
    expect(typeof none === "object" && none.actions).toEqual([{ type: "set_lead_status", status_id: DISQ }]);
    // a stale reason sent by an old screen is dropped, not saved
    const stale = build({ type: "set_lead_status", status_id: DISQ, reason_id: REASON }, empty);
    expect(typeof stale === "object" && stale.actions).toEqual([{ type: "set_lead_status", status_id: DISQ }]);
    // once the list has reasons, a new or edited rule needs one again
    expect(build({ type: "set_lead_status", status_id: DISQ })).toBe(REASON_REQUIRED);
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
    // nothing to pick while the list is empty: no reminder
    expect(actionsMissingReason(actions, { ...lookups, reasons: [] })).toEqual([]);
  });
});

describe("run log warnings", () => {
  it("every warning the engine writes has a Hebrew text (the latest app.run_automation_actions)", () => {
    // the newest migration that redefines the engine's action runner (0095, then HEB-03, then HEB-08 and its follow-up)
    const dir = join(process.cwd(), "supabase/migrations");
    const latest = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => readFileSync(join(dir, name), "utf8").includes("create or replace function app.run_automation_actions"))
      .at(-1)!;
    const sql = readFileSync(join(dir, latest), "utf8");
    // a create_quote step gathers its warnings in a list (AUT-02 follow-up): v_warnings := v_warnings || '<key>'::text
    const written = [
      ...[...sql.matchAll(/v_warning := '([^']+)'/g)].map((m) => m[1]),
      ...[...sql.matchAll(/v_warnings := v_warnings \|\| '((?:[^']|'')+)'::text/g)].map((m) => m[1].replaceAll("''", "'")),
    ];
    expect([...new Set(written)].sort()).toEqual([
      "no reason is set",
      "some lines were not copied",
      "some template lines were skipped",
      "the business-day offset is invalid",
      "the customer is on hold",
      "the customer's company is on hold",
      "the owner is away, the lead has no owner",
      "the reason no longer exists",
      "the record owner is not usable, the quote has no owner",
      // AUT-01 part B: a set_field step's relative date
      "the relative date is invalid",
      "the requested owner is away, the lead stays with its owner",
    ]);
    for (const warning of written) {
      expect(STEP_WARNINGS[warning]).toBeTruthy();
    }
    // a retired warning keeps its text for the runs logged before (and the engine must not write it any more)
    for (const retired of RETIRED_STEP_WARNINGS) expect(written).not.toContain(retired);
    expect(
      Object.keys(STEP_WARNINGS)
        .filter((key) => !RETIRED_STEP_WARNINGS.includes(key))
        .sort(),
    ).toEqual([...new Set(written)].sort());
  });

  it("the kept-owner warning names the owner the engine stored (HEB-08, owner's wording)", () => {
    expect(stepWarningText("the requested owner is away, the lead stays with its owner", "דנה כהן")).toBe(
      "האחראי המבוקש נעדר, הליד נשאר אצל דנה כהן",
    );
    // an old entry without a name still reads as a sentence
    expect(stepWarningText("the requested owner is away, the lead stays with its owner")).toBe(
      "האחראי המבוקש נעדר, הליד נשאר אצל האחראי הנוכחי",
    );
    expect(stepWarningText("the owner is away, the lead has no owner", "דנה")).toBe("האחראי נעדר, הליד נכנס בלי אחראי");
    expect(stepWarningText("something new")).toBe("something new");
  });
});
