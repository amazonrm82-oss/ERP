import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isQuietReason,
  meetingOrderDraftModeOf,
  meetingOrderDraftReasonText,
  MEETING_ORDER_DRAFT_MODES,
  MEETING_ORDER_DRAFT_REASONS,
  parseDraftAnswer,
  parseDraftStates,
} from "@/features/meeting-order-draft/rules";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261006021186_meeting_order_draft.sql"), "utf8");

describe("CAL-13 draft order from a held meeting: the app's words for the database's answers", () => {
  it("knows every reason the migration answers, each with its own Hebrew line", () => {
    const fromSql = new Set([...migration.matchAll(/return '([a-z_]+)';/g)].map((m) => m[1]));
    fromSql.add("not_permitted");
    expect([...fromSql].sort()).toEqual([...MEETING_ORDER_DRAFT_REASONS].sort());
    const texts = MEETING_ORDER_DRAFT_REASONS.map(meetingOrderDraftReasonText);
    expect(new Set(texts).size).toBe(texts.length);
    for (const text of texts) expect(text).toMatch(/[֐-׿]/);
    // an unknown code never shows the code itself
    expect(meetingOrderDraftReasonText("boom")).not.toContain("boom");
  });

  it("the setting's values are the check constraint's, default button", () => {
    expect(migration).toContain("check (meeting_order_draft in ('button', 'auto'))");
    expect(migration).toContain("meeting_order_draft text not null default 'button'");
    expect([...MEETING_ORDER_DRAFT_MODES]).toEqual(["button", "auto"]);
    expect(meetingOrderDraftModeOf("auto")).toBe("auto");
    expect(meetingOrderDraftModeOf(null)).toBe("button");
    expect(meetingOrderDraftModeOf("always")).toBe("button");
  });

  it("the card keeps quiet when the whole feature is off", () => {
    expect(isQuietReason("feature_orders")).toBe(true);
    expect(isQuietReason("module_off")).toBe(true);
    expect(isQuietReason("feature_products")).toBe(true);
    expect(isQuietReason("no_product")).toBe(false);
    expect(isQuietReason(null)).toBe(false);
  });

  it("reads the states and the button's answer, leaving out anything malformed", () => {
    const states = parseDraftStates({
      a: { reason: null, order_id: null },
      b: { reason: "exists", order_id: "o1" },
      c: "nonsense",
      d: { reason: 5, order_id: 7 },
    });
    expect(states.get("a")).toEqual({ reason: null, orderId: null });
    expect(states.get("b")).toEqual({ reason: "exists", orderId: "o1" });
    expect(states.has("c")).toBe(false);
    expect(states.get("d")).toEqual({ reason: null, orderId: null });
    expect(parseDraftStates(null).size).toBe(0);
    expect(parseDraftStates([1]).size).toBe(0);

    expect(parseDraftAnswer({ ok: true, order_id: "o2" })).toEqual({ ok: true, orderId: "o2" });
    expect(parseDraftAnswer({ ok: false, reason: "punch_card" })).toEqual({ ok: false, reason: "punch_card", orderId: null });
    expect(parseDraftAnswer({ ok: true })).toEqual({ ok: false, reason: "unknown", orderId: null });
    expect(parseDraftAnswer("x")).toEqual({ ok: false, reason: "unknown", orderId: null });
  });
});
