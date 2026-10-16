import { describe, expect, it } from "vitest";

import { parseTarget, qrCodeSchema } from "@/features/qr-codes/model";
import { isQrToken, qrRedirectPath } from "@/features/qr-codes/redirect";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ID = "00000000-0000-4000-8000-000000000001";

describe("QR code redirect (BIZ-03)", () => {
  it("leads to the stored form or booking page, tagged as a QR visit with the code's name", () => {
    expect(qrRedirectPath({ path: `/f/${TOKEN}`, campaign: "שלט בחנות" })).toBe(
      `/f/${TOKEN}?utm_source=qr&utm_campaign=${encodeURIComponent("שלט בחנות").replace(/%20/g, "+")}`,
    );
    expect(qrRedirectPath({ path: `/f/book/${TOKEN}`, campaign: "" })).toBe(`/f/book/${TOKEN}?utm_source=qr`);
    // the campaign is encoded, never read as more parameters
    expect(qrRedirectPath({ path: `/f/${TOKEN}`, campaign: "a&utm_source=evil" })).toBe(`/f/${TOKEN}?utm_source=qr&utm_campaign=a%26utm_source%3Devil`);
  });

  it("never leads anywhere but this app's form and booking pages", () => {
    for (const path of [
      "https://evil.example/",
      "//evil.example/f/" + TOKEN,
      `/f/${TOKEN}/../../admin`,
      `/f/card/${TOKEN}`,
      `/o/${TOKEN}`,
      `/f/${TOKEN.toUpperCase()}`,
      `/f/${TOKEN}?x=1`,
      "",
    ]) {
      expect(qrRedirectPath({ path, campaign: "x" }), path).toBeNull();
    }
    for (const answer of [null, undefined, "x", [], { campaign: "x" }, { path: 5 }]) expect(qrRedirectPath(answer)).toBeNull();
  });

  it("looks up only tokens of the printed shape", () => {
    expect(isQrToken(TOKEN)).toBe(true);
    for (const token of ["", "x", TOKEN.toUpperCase(), `${TOKEN}0`, `${TOKEN.slice(1)}g`]) expect(isQrToken(token), token).toBe(false);
  });

  it("the form: a name and a form or booking page as the target", () => {
    expect(parseTarget(`form:${ID}`)).toEqual({ kind: "form", id: ID });
    expect(parseTarget(`booking:${ID}`)).toEqual({ kind: "booking", id: ID });
    expect(parseTarget(`card:${ID}`)).toBeNull();
    expect(parseTarget(`url:https://x`)).toBeNull();
    expect(qrCodeSchema.safeParse({ name: "  פלייר  ", target: `form:${ID}` }).data).toEqual({ name: "פלייר", target: `form:${ID}` });
    expect(qrCodeSchema.safeParse({ name: "", target: `form:${ID}` }).success).toBe(false);
    expect(qrCodeSchema.safeParse({ name: "x".repeat(81), target: `form:${ID}` }).success).toBe(false);
    expect(qrCodeSchema.safeParse({ name: "x", target: "" }).success).toBe(false);
  });
});
