import { describe, expect, it } from "vitest";

import { ANOMALY_ALERT_DEFAULTS, ANOMALY_BOUNDS, anomalyAlertSettingsSchema, anomalyRuleText, anomalySettingsFromRow } from "@/features/anomaly-alerts/settings";

import { latestMigration } from "./helpers/migrations";

// MNY-04, owner (285) ג: the app's defaults and bounds equal the table's (migration anomaly_alert_settings)
const sql = latestMigration("create table if not exists public.anomaly_alert_settings (")?.sql ?? "";

describe("anomaly alert settings (MNY-04 (285) ג)", () => {
  it("the defaults equal the column defaults and app.anomaly_settings_of", () => {
    expect(sql).not.toBe("");
    const column = (name: string) => sql.match(new RegExp(`\\n  ${name} +\\w+ not null default (\\w+)`))?.[1];
    expect(column("lead_drop_on")).toBe(String(ANOMALY_ALERT_DEFAULTS.leadDropOn));
    expect(column("lead_drop_percent")).toBe(String(ANOMALY_ALERT_DEFAULTS.leadDropPercent));
    expect(column("idle_rep_on")).toBe(String(ANOMALY_ALERT_DEFAULTS.idleRepOn));
    expect(column("idle_rep_days")).toBe(String(ANOMALY_ALERT_DEFAULTS.idleRepDays));
    expect(column("quiet_form_on")).toBe(String(ANOMALY_ALERT_DEFAULTS.quietFormOn));
    expect(column("quiet_form_min_inquiries")).toBe(String(ANOMALY_ALERT_DEFAULTS.quietFormMinInquiries));
    expect(column("campaign_jump_on")).toBe(String(ANOMALY_ALERT_DEFAULTS.campaignJumpOn));
    expect(column("campaign_jump_percent")).toBe(String(ANOMALY_ALERT_DEFAULTS.campaignJumpPercent));
    for (const [name, value] of [
      ["lead_drop_percent", ANOMALY_ALERT_DEFAULTS.leadDropPercent],
      ["idle_rep_days", ANOMALY_ALERT_DEFAULTS.idleRepDays],
      ["quiet_form_min_inquiries", ANOMALY_ALERT_DEFAULTS.quietFormMinInquiries],
      ["campaign_jump_percent", ANOMALY_ALERT_DEFAULTS.campaignJumpPercent],
    ] as const) {
      expect(sql, name).toContain(`v.${name} := ${value};`);
    }
    expect(anomalySettingsFromRow(null)).toEqual(ANOMALY_ALERT_DEFAULTS);
  });

  it("the bounds equal the check constraints", () => {
    for (const [name, { min, max }] of Object.entries(ANOMALY_BOUNDS)) {
      expect(sql, name).toContain(`check (${name} between ${min} and ${max})`);
    }
  });

  it("reads the form: ticked boxes, whole numbers in their bounds", () => {
    const form = {
      lead_drop_on: "on",
      lead_drop_percent: "60",
      idle_rep_on: null,
      idle_rep_days: "2",
      quiet_form_on: "on",
      quiet_form_min_inquiries: "4",
      campaign_jump_on: null,
      campaign_jump_percent: "100",
    };
    expect(anomalyAlertSettingsSchema.parse(form)).toEqual({
      lead_drop_on: true,
      lead_drop_percent: 60,
      idle_rep_on: false,
      idle_rep_days: 2,
      quiet_form_on: true,
      quiet_form_min_inquiries: 4,
      campaign_jump_on: false,
      campaign_jump_percent: 100,
    });
    for (const [key, value] of [
      ["lead_drop_percent", "95"],
      ["idle_rep_days", "0"],
      ["idle_rep_days", "1.5"],
      ["quiet_form_min_inquiries", ""],
      ["campaign_jump_percent", "5"],
    ] as const) {
      expect(anomalyAlertSettingsSchema.safeParse({ ...form, [key]: value }).success, `${key}=${value}`).toBe(false);
    }
  });

  it("says each rule with the business's numbers, and owners and admins are counted (286) ב", () => {
    const s = { ...ANOMALY_ALERT_DEFAULTS, leadDropPercent: 70, idleRepDays: 1 };
    expect(anomalyRuleText("lead_drop", s)).toContain("פחות מ-30%");
    expect(anomalyRuleText("idle_rep", s)).toContain("ביום העבודה האחרון");
    expect(anomalyRuleText("idle_rep", ANOMALY_ALERT_DEFAULTS)).toContain("ב-3 ימי העבודה האחרונים");
    expect(anomalyRuleText("idle_rep", ANOMALY_ALERT_DEFAULTS)).toContain("לשאר הבעלים והמנהלים");
    expect(anomalyRuleText("quiet_form", ANOMALY_ALERT_DEFAULTS)).toContain("לפחות 4 פניות");
    expect(anomalyRuleText("campaign_jump", ANOMALY_ALERT_DEFAULTS)).toContain("לפחות ב-100%");
  });
});
