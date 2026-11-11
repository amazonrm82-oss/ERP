import { describe, expect, it } from "vitest";

import { notificationHref } from "@/features/notifications/links";
import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";

// MNY-04: each anomaly notice (the id is the business) opens the page where the business sees which target it counts
describe("anomaly alerts (MNY-04)", () => {
  it("opens the page behind each kind", () => {
    expect(notificationHref("org-1", "anomaly_lead_drop", "org-1")).toBe("/o/org-1/reports/sources");
    expect(notificationHref("org-1", "anomaly_idle_rep", "org-1")).toBe("/o/org-1/reports/activity");
    expect(notificationHref("org-1", "anomaly_quiet_form", "org-1")).toBe("/o/org-1/settings/intake");
    expect(notificationHref("org-1", "anomaly_campaign_jump", "org-1")).toBe("/o/org-1/reports/campaign_roi");
  });

  it("is open in every plan (owner (273))", () => {
    const entry = PLAN_CAPABILITIES.find((c) => c.feature === "anomaly_alerts");
    expect(entry).toMatchObject({ built: true, core: true });
  });
});
