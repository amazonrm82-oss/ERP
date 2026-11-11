import { describe, expect, it } from "vitest";

import {
  PREFERENCE_CHANNELS,
  PREFERENCES_CONSENT_VERSION,
  PREFERENCES_CONSENT_WORDING,
  PREFERENCES_TOKEN,
  preferenceChoicesFrom,
  preferenceResultsFrom,
  preferencesPageFrom,
  PREFERENCES_TEXTS,
} from "@/features/preferences/model";
import { redactPublicPath } from "@/lib/request-error-log";
import { isEmbeddablePublicPath } from "@/lib/csp";

import { latestMigrationText } from "./helpers/migrations";

// CNS-09 / CNS-10: the app mirrors the database's draft wording and version word for word, reads only the expected answer,
// and treats the two pages as secret links (redacted in logs, never framed).

describe("preferences (CNS-09, CNS-10)", () => {
  it("the draft wording and its version equal app.preference_consent_wording() / _version()", () => {
    const sql = latestMigrationText("function app.preference_consent_wording()") ?? "";
    expect(sql).toContain(`select '${PREFERENCES_CONSENT_WORDING}'::text`);
    const version = latestMigrationText("function app.preference_consent_version()") ?? "";
    expect(version).toContain(`select '${PREFERENCES_CONSENT_VERSION}'::text`);
  });

  it("the channels are the link's closed list", () => {
    const sql = latestMigrationText("consent_preference_links_channel check") ?? "";
    expect(sql).toContain(`consent_preference_links_channel check (channel in (${PREFERENCE_CHANNELS.map((c) => `'${c}'`).join(", ")}))`);
  });

  it("reads only the expected answer", () => {
    const answer = {
      business: "העסק",
      brand: { logo: null, color: "#112233" },
      built_with: true,
      channel: "email",
      full: true,
      channels: [
        { channel: "email", state: "in", can_turn_on: false },
        { channel: "sms", state: "unknown", can_turn_on: true },
      ],
    };
    expect(preferencesPageFrom(answer)).toEqual({
      business: "העסק",
      logoPath: null,
      color: "#112233",
      builtWith: true,
      channel: "email",
      full: true,
      staffLink: false,
      channels: [
        { channel: "email", state: "in", canTurnOn: false },
        { channel: "sms", state: "unknown", canTurnOn: true },
      ],
    });
    expect(preferencesPageFrom({ ...answer, channel: "phone" })).toBeNull();
    expect(preferencesPageFrom({ ...answer, channels: [{ channel: "sms", state: "maybe", can_turn_on: true }] })).toBeNull();
    expect(preferencesPageFrom(null)).toBeNull();
    // RVW-82: a link copied by staff only removes
    expect(preferencesPageFrom({ ...answer, staff_link: true })?.staffLink).toBe(true);
  });

  it("a form sends one choice per channel, at most three", () => {
    expect(preferenceChoicesFrom([{ channel: "sms", on: true }])).toEqual([{ channel: "sms", on: true }]);
    expect(preferenceChoicesFrom([])).toBeNull();
    expect(preferenceChoicesFrom([{ channel: "sms", on: true }, { channel: "sms", on: false }])).toBeNull();
    expect(preferenceChoicesFrom([{ channel: "phone", on: true }])).toBeNull();
    expect(preferenceChoicesFrom([{ channel: "sms", on: "yes" }])).toBeNull();
    expect(preferenceResultsFrom({ status: "saved", results: [{ channel: "email", result: "refused" }] })).toEqual([{ channel: "email", result: "refused" }]);
    expect(preferenceResultsFrom({ status: "done" })).toBeNull();
  });

  it("the tokens are secret in logs and the pages are never framed", () => {
    const token = "a".repeat(64);
    expect(PREFERENCES_TOKEN.test(token)).toBe(true);
    expect(redactPublicPath(`/f/prefs/${token}`)).toBe("/f/prefs/[token]");
    expect(redactPublicPath(`/f/unsub/${token}`)).toBe("/f/unsub/[token]");
    expect(redactPublicPath(`/api/forms/prefs/${token}`)).toBe("/api/forms/prefs/[token]");
    expect(redactPublicPath(`/api/forms/unsub/${token}`)).toBe("/api/forms/unsub/[token]");
    expect(isEmbeddablePublicPath(`/f/prefs/${token}`)).toBe(false);
    expect(isEmbeddablePublicPath(`/f/unsub/${token}`)).toBe(false);
  });

  it("the unsubscribe question names the channel", () => {
    expect(PREFERENCES_TEXTS.unsubscribeIntro("email")).toBe("להפסיק לקבל מאיתנו הודעות שיווקיות באימייל?");
    expect(PREFERENCES_TEXTS.unsubscribeIntro("sms")).toBe("להפסיק לקבל מאיתנו הודעות שיווקיות ב-SMS?");
  });
});
