import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { utmChanges } from "@/features/audit/queries";
import { FIELD_LABELS } from "@/features/audit/labels";
import { UTM_KEYS } from "@/features/intake/attribution";
import {
  budgetInputValue,
  campaignInsert,
  campaignUpdate,
  LEAD_UTM_KEYS,
  leadCampaignSchema,
  utmValues,
} from "@/features/leads/schema";

const empty = { campaign: "", budget: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "", utm_content: "" };

describe("lead campaign fields (LEAD-01)", () => {
  it("the editable keys are the intake's five classic UTM keys, and the trigger allows exactly those", () => {
    expect([...LEAD_UTM_KEYS]).toEqual([...UTM_KEYS]);
    const sql = readFileSync(new URL("../../supabase/migrations/20261006011500_lead_campaign_fields.sql", import.meta.url), "utf8");
    const list = sql.match(/v_classic constant text\[\] := array\[([^\]]*)\]/)?.[1] ?? "";
    expect(list.split(",").map((part) => part.trim().replace(/'/g, ""))).toEqual([...LEAD_UTM_KEYS]);
  });

  it("parses budget in shekels to agorot; empty stays empty; a bad amount is an error", () => {
    expect(leadCampaignSchema.parse({ ...empty, budget: "12,500.5" }).budget).toBe(1250050);
    expect(leadCampaignSchema.parse(empty).budget).toBeNull();
    expect(leadCampaignSchema.safeParse({ ...empty, budget: "abc" }).success).toBe(false);
    expect(leadCampaignSchema.safeParse({ ...empty, utm_source: "x".repeat(201) }).success).toBe(false);
    // code points, like the database: 200 emoji (400 UTF-16 units) still fit
    expect(leadCampaignSchema.safeParse({ ...empty, utm_source: "😀".repeat(200) }).success).toBe(true);
    expect(leadCampaignSchema.safeParse({ ...empty, utm_source: "😀".repeat(201) }).success).toBe(false);
  });

  it("a new lead stores only the UTM values given", () => {
    const data = leadCampaignSchema.parse({ ...empty, campaign: " חורף ", utm_source: "google", budget: "100" });
    expect(campaignInsert(data)).toEqual({ campaign: "חורף", budget_agorot: 10000, utm: { utm_source: "google" } });
  });

  it("an edit sends a merge patch of the five keys (never the whole object, so utm.extra stays)", () => {
    const data = leadCampaignSchema.parse({ ...empty, utm_medium: "cpc" });
    expect(campaignUpdate(data)).toEqual({
      campaign: null,
      budget_agorot: null,
      utm: { $merge: { utm_source: null, utm_medium: "cpc", utm_campaign: null, utm_term: null, utm_content: null } },
    });
  });

  it("budget input and stored UTM values round-trip for the form", () => {
    expect(budgetInputValue(null)).toBe("");
    expect(budgetInputValue(1250000)).toBe("12500");
    expect(budgetInputValue(1250050)).toBe("12500.50");
    expect(budgetInputValue(5)).toBe("0.05");
    expect(utmValues({ utm_source: "g", utm_term: 3, extra: { utm_id: "1" } })).toEqual({ utm_source: "g" });
    expect(utmValues(null)).toEqual({});
  });

  it("the audit history lists a utm change key by key, with a Hebrew label for each", () => {
    const changes = utmChanges({ utm_source: "a", extra: { utm_id: "1" } }, { utm_source: "b", utm_term: "t", extra: { utm_id: "1" } });
    expect(changes).toEqual([
      { field: "utm.utm_source", old: "a", new: "b" },
      { field: "utm.utm_term", old: null, new: "t" },
    ]);
    for (const key of LEAD_UTM_KEYS) expect(FIELD_LABELS[`utm.${key}`]).toBeTruthy();
    expect(FIELD_LABELS.budget_agorot).toBe("תקציב");
  });
});
