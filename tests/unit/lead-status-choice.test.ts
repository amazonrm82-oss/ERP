import { describe, expect, it } from "vitest";

import { checkStatusChoice } from "@/features/leads/status";
import { mergePicks } from "@/features/merge/fields";

// RVW-9: the same rules for a status change and a new lead; the reason never outlives its status.
describe("checkStatusChoice", () => {
  it("refuses a missing status and the converted one", () => {
    expect(checkStatusChoice(null, null, [])).toMatchObject({ ok: false });
    expect(checkStatusChoice("converted", null, [])).toMatchObject({ ok: false });
  });

  it("an open status keeps no reason", () => {
    expect(checkStatusChoice("open", "יקר מדי", ["יקר מדי"])).toEqual({ ok: true, reason: null });
  });

  it("not relevant needs a reason, from the list when there is one", () => {
    expect(checkStatusChoice("disqualified", null, [])).toMatchObject({ ok: false, needsReason: true });
    expect(checkStatusChoice("disqualified", "   ", [])).toMatchObject({ ok: false, needsReason: true });
    expect(checkStatusChoice("disqualified", " סיבה חופשית ", [])).toEqual({ ok: true, reason: "סיבה חופשית" });
    expect(checkStatusChoice("disqualified", "סיבה חופשית", ["יקר מדי"])).toMatchObject({ ok: false, needsReason: true });
    expect(checkStatusChoice("disqualified", "יקר מדי", ["יקר מדי"])).toEqual({ ok: true, reason: "יקר מדי" });
  });
});

describe("mergePicks", () => {
  it("the reason travels with a picked lead status, and never alone", () => {
    expect(mergePicks("lead", (key) => key === "status_id")).toEqual({ status_id: "merge", disqualify_reason: "merge" });
    expect(mergePicks("lead", (key) => key === "full_name" || key === "disqualify_reason")).toEqual({ full_name: "merge" });
    expect(mergePicks("contact", (key) => key === "city")).toEqual({ city: "merge" });
  });
});
