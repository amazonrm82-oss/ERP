import { describe, expect, it } from "vitest";

import { parseTrialEndNotice, trialEndBannerText } from "@/features/trial-end/notice";

// BIL-08 partial: what public.trial_end_notice() answers, and the line the business sees.
describe("trial end notice", () => {
  it("nothing to say: null, or anything that is not a known phase with its dates", () => {
    expect(parseTrialEndNotice(null)).toBeNull();
    expect(parseTrialEndNotice([])).toBeNull();
    expect(parseTrialEndNotice({ phase: "free", read_only_on: "2026-11-01", closes_on: "2026-11-08" })).toBeNull();
    expect(parseTrialEndNotice({ phase: "grace", read_only_on: null, closes_on: "2026-11-08" })).toBeNull();
    expect(parseTrialEndNotice({ phase: "grace", read_only_on: "2026-11-01T00:00:00Z", closes_on: "2026-11-08" })).toBeNull();
  });

  it("grace names the read-only day; read-only names the closing day", () => {
    const grace = parseTrialEndNotice({ phase: "grace", read_only_on: "2026-10-28", closes_on: "2026-11-04" });
    expect(grace).toEqual({ phase: "grace", readOnlyOn: "2026-10-28", closesOn: "2026-11-04" });
    const graceText = trialEndBannerText(grace!);
    // the day itself, not the day before (an instant at local midnight would show the 27th in UTC)
    expect(graceText).toContain("28");
    expect(graceText).toContain("קריאה בלבד");
    expect(graceText).not.toContain("חינם");
    const ro = trialEndBannerText({ phase: "read_only", readOnlyOn: "2026-10-28", closesOn: "2026-11-04" });
    expect(ro).toContain("קריאה בלבד");
    expect(ro).toContain("הגישה לעסק תיסגר עד לתשלום");
    expect(ro).toContain("4");
  });
});
