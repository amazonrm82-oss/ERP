import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHANNEL_LABELS,
  CONSENT_CHANNELS,
  CONSENT_SOURCES,
  CONSENT_STATES,
  LIFT_METHOD_LABELS,
  LIFT_METHODS,
  SOURCE_LABELS,
  STATE_LABELS,
  channelNeeds,
  isConsentChannel,
  isConsentState,
} from "@/features/consents/model";
import { manualConsentSchema } from "@/features/consents/schema";

// the migration that creates public.consents
function consentsSql(): string {
  const dir = join(process.cwd(), "supabase/migrations");
  const sql = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .filter((text) => text.includes("create table if not exists public.consents"))
    .at(-1);
  expect(sql, "a migration creates public.consents").toBeDefined();
  return sql ?? "";
}

function checkList(sql: string, constraint: string, column: string): string[] {
  const list = new RegExp(`${constraint} check \\(${column} in \\(([^)]*)\\)\\)`).exec(sql)?.[1] ?? "";
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

describe("consents (CNS-01, CNS-03)", () => {
  it("the app's closed lists are the database's", () => {
    const sql = consentsSql();
    expect(checkList(sql, "consents_channel", "channel")).toEqual([...CONSENT_CHANNELS]);
    expect(checkList(sql, "consents_state", "state")).toEqual([...CONSENT_STATES]);
    expect(checkList(sql, "consents_source", "source")).toEqual([...CONSENT_SOURCES]);
    expect(checkList(sql, "consents_lift_method", "lift_method")).toEqual([...LIFT_METHODS]);
    for (const m of LIFT_METHODS) expect(LIFT_METHOD_LABELS[m]).toBeTruthy();
  });

  it("every value has a Hebrew label", () => {
    for (const c of CONSENT_CHANNELS) expect(CHANNEL_LABELS[c]).toBeTruthy();
    for (const s of CONSENT_STATES) expect(STATE_LABELS[s]).toBeTruthy();
    for (const s of CONSENT_SOURCES) expect(SOURCE_LABELS[s]).toBeTruthy();
  });

  it("email needs an email, the other channels a phone (as app.consent_address_kind)", () => {
    expect(CONSENT_CHANNELS.map(channelNeeds)).toEqual(["email", "phone", "phone", "phone"]);
    expect(isConsentChannel("fax")).toBe(false);
    expect(isConsentState("granted")).toBe(true);
  });

  it("a manual entry needs how it was given; the wording is optional", () => {
    const base = { channel: "sms", state: "granted", method: "בשיחה", wording: "", lift_method: "", lift_note: "" };
    expect(manualConsentSchema.safeParse(base).data).toEqual({ ...base, wording: null, lift_method: null, lift_note: null });
    expect(manualConsentSchema.safeParse({ ...base, method: "   " }).success).toBe(false);
    expect(manualConsentSchema.safeParse({ ...base, method: "x".repeat(501) }).success).toBe(false);
    expect(manualConsentSchema.safeParse({ ...base, wording: "x".repeat(2001) }).success).toBe(false);
    // "unknown" is what no entry means; a person does not record it
    expect(manualConsentSchema.safeParse({ ...base, state: "unknown" }).success).toBe(false);
    expect(manualConsentSchema.safeParse({ ...base, channel: "fax" }).success).toBe(false);
  });

  it("a lift of an opt-out needs its method and a note, and is only a consent", () => {
    const base = { channel: "sms", state: "granted", method: "בשיחה", wording: "", lift_method: "signed_form", lift_note: "חתם בכנס" };
    expect(manualConsentSchema.safeParse(base).success).toBe(true);
    expect(manualConsentSchema.safeParse({ ...base, lift_note: " " }).success).toBe(false);
    expect(manualConsentSchema.safeParse({ ...base, lift_method: "" }).success).toBe(false);
    expect(manualConsentSchema.safeParse({ ...base, lift_method: "phone_call" }).success).toBe(false);
    expect(manualConsentSchema.safeParse({ ...base, state: "withdrawn" }).success).toBe(false);
  });
});
