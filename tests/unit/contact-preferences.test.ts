import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contactSchema } from "@/features/contacts/schema";
import {
  CONTACT_CHANNEL_LABELS,
  CONTACT_CHANNELS,
  CONTACT_LOCALE_LABELS,
  CONTACT_LOCALES,
  channelLabel,
  localeLabel,
  preferredContactChannel,
} from "@/features/contacts/preferences";

// CON-10: the closed lists mirror the check constraints of the migration
const sql = readFileSync(new URL("../../supabase/migrations/20261006018300_contact_preferences.sql", import.meta.url), "utf8");

function checkValues(column: string): string[] {
  const match = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(sql);
  return [...(match?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("contact preferences (CON-10)", () => {
  it("the languages equal the database constraint", () => {
    expect(checkValues("preferred_locale")).toEqual([...CONTACT_LOCALES]);
  });

  it("the channels equal the database constraint", () => {
    expect(checkValues("preferred_channel")).toEqual([...CONTACT_CHANNELS]);
  });

  it("every value has a Hebrew label, and unknown values have none", () => {
    expect(Object.keys(CONTACT_LOCALE_LABELS)).toEqual([...CONTACT_LOCALES]);
    expect(Object.keys(CONTACT_CHANNEL_LABELS)).toEqual([...CONTACT_CHANNELS]);
    expect(localeLabel("he")).toBe("עברית");
    expect(localeLabel("am")).toBe("אמהרית");
    expect(localeLabel("de")).toBeNull();
    expect(localeLabel(null)).toBeNull();
    expect(channelLabel("whatsapp")).toBe("וואטסאפ");
    expect(channelLabel("sms")).toBe("SMS");
    expect(channelLabel("fax")).toBeNull();
    expect(preferredContactChannel("email")).toEqual({ channel: "email", label: "אימייל" });
    expect(preferredContactChannel("")).toBeNull();
  });

  it("the form accepts a listed value or none, and refuses another", () => {
    const base = { first_name: "דנה" };
    const ok = contactSchema.safeParse({ ...base, preferred_locale: "ru", preferred_channel: "whatsapp" });
    expect(ok.success && ok.data.preferred_locale).toBe("ru");
    expect(ok.success && ok.data.preferred_channel).toBe("whatsapp");
    const none = contactSchema.safeParse({ ...base, preferred_locale: "", preferred_channel: null });
    expect(none.success && none.data.preferred_locale).toBeNull();
    expect(none.success && none.data.preferred_channel).toBeNull();
    expect(contactSchema.safeParse({ ...base, preferred_locale: "de" }).success).toBe(false);
    expect(contactSchema.safeParse({ ...base, preferred_channel: "fax" }).success).toBe(false);
  });
});
