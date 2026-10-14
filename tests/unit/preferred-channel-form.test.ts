import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CHANNEL_SOURCES, CONTACT_CHANNELS, channelDetail } from "@/features/contacts/preferences";
import { channelInput, CHANNEL_INPUT, PUBLIC_CHANNEL_OPTIONS } from "@/features/intake/channel";
import { publicFormFrom } from "@/features/intake/public-form";
import { leadChannelFromForm } from "@/features/leads/schema";

// CON-10 follow-up: the lead's channel and the source of a channel mirror the migration's constraints,
// and intake_submit reads the same four values from the payload key the hosted form sends
const sql = readFileSync(new URL("../../supabase/migrations/20261006018810_preferred_channel_form.sql", import.meta.url), "utf8");

function quoted(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("preferred channel from a public form (CON-10)", () => {
  it("the lead's channels equal the database constraint and the contacts' list", () => {
    expect(quoted(/leads_preferred_channel_check\s+check \(preferred_channel in \(([^)]*)\)\)/.exec(sql)?.[1])).toEqual([...CONTACT_CHANNELS]);
  });

  it("the sources equal the database constraints", () => {
    const checks = [...sql.matchAll(/preferred_channel_source in \(([^)]*)\)/g)].map((m) => quoted(m[1]));
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const values of checks) expect(values).toEqual([...CHANNEL_SOURCES]);
  });

  it("intake_submit reads the same payload key and the same four values", () => {
    expect(sql).toContain(`p_payload ->> '${CHANNEL_INPUT}' in (${CONTACT_CHANNELS.map((c) => `'${c}'`).join(", ")})`);
    expect(PUBLIC_CHANNEL_OPTIONS.map((o) => o.value)).toEqual([...CONTACT_CHANNELS]);
  });

  it("a sent value counts only when it is one of the four", () => {
    expect(channelInput("whatsapp")).toBe("whatsapp");
    expect(channelInput(" sms ")).toBe("sms");
    expect(channelInput("fax")).toBeNull();
    expect(channelInput("")).toBeNull();
    expect(channelInput(null)).toBeNull();
  });

  it("the card marks a channel that came from a form", () => {
    expect(channelDetail("whatsapp", "form")).toBe("וואטסאפ (מטופס)");
    expect(channelDetail("whatsapp", "manual")).toBe("וואטסאפ");
    expect(channelDetail("phone", null)).toBe("טלפון");
    expect(channelDetail(null, "form")).toBeNull();
    expect(channelDetail("fax", "form")).toBeNull();
  });

  it("the lead form writes the channel only when it has the field", () => {
    const form = (entries: Record<string, string>) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
      return data;
    };
    expect(leadChannelFromForm(form({ full_name: "דנה" }))).toEqual({ ok: true, patch: {} });
    expect(leadChannelFromForm(form({ preferred_channel: "email" }))).toEqual({ ok: true, patch: { preferred_channel: "email" } });
    expect(leadChannelFromForm(form({ preferred_channel: "" }))).toEqual({ ok: true, patch: { preferred_channel: null } });
    expect(leadChannelFromForm(form({ preferred_channel: "fax" })).ok).toBe(false);
  });

  it("the hosted form asks only when intake_form() says so", () => {
    const base = { title: "צור קשר", fields: [], brand: {}, thanks: {} };
    expect(publicFormFrom({ ...base, channel_choice: true })?.channelChoice).toBe(true);
    expect(publicFormFrom({ ...base, channel_choice: false })?.channelChoice).toBe(false);
    expect(publicFormFrom(base)?.channelChoice).toBe(false);
  });
});
