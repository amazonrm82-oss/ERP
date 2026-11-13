import { describe, expect, it } from "vitest";

import { emailKeyRefusedText, parseEmailHealth } from "@/features/platform/email-health";

// EML-01, owner's answer (7) ב: the platform dashboard's warning about emails stopped by a refused Resend key.
describe("EML-01 (7) ב: the dashboard's email warning", () => {
  it("reads the counts strictly", () => {
    expect(parseEmailHealth({ key_refused_24h: 3, last_key_refused_at: "2026-11-13T10:00:00Z" })).toEqual({ keyRefused24h: 3, lastKeyRefusedAt: "2026-11-13T10:00:00Z" });
    expect(parseEmailHealth({ key_refused_24h: 0, last_key_refused_at: null })).toEqual({ keyRefused24h: 0, lastKeyRefusedAt: null });
    expect(parseEmailHealth(null)).toEqual({ keyRefused24h: 0, lastKeyRefusedAt: null });
    expect(parseEmailHealth({ key_refused_24h: "x" }).keyRefused24h).toBe(0);
    expect(parseEmailHealth({ key_refused_24h: -2 }).keyRefused24h).toBe(0);
  });

  it("shows the warning only when emails were stopped", () => {
    expect(emailKeyRefusedText({ keyRefused24h: 0, lastKeyRefusedAt: null })).toBeNull();
    expect(emailKeyRefusedText({ keyRefused24h: 1, lastKeyRefusedAt: null })).toBe(
      "Resend דחה את מפתח השליחה: מייל אחד לא נשלח ב-24 השעות האחרונות. בדקו את מפתח ה-API של Resend בהגדרות הסביבה ב-Vercel.",
    );
    expect(emailKeyRefusedText({ keyRefused24h: 12, lastKeyRefusedAt: null })).toBe(
      "Resend דחה את מפתח השליחה: 12 מיילים לא נשלחו ב-24 השעות האחרונות. בדקו את מפתח ה-API של Resend בהגדרות הסביבה ב-Vercel.",
    );
  });
});
