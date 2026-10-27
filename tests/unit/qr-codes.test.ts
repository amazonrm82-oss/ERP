import { describe, expect, it } from "vitest";

import { parseTarget, qrCodeSchema, targetColumns } from "@/features/qr-codes/model";
import { isQrToken, qrRedirectLocation as qrRedirectPath, withQrTags } from "@/features/qr-codes/redirect";
import { normalizeQrTargetUrl, qrTargetUrlOk } from "@/features/qr-codes/target-url";

import cases from "./fixtures/qr-target-urls.json";

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
      `/f/card/${TOKEN}/x`,
      `/f/q/${TOKEN}`,
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
    expect(parseTarget(`card:${ID}`)).toEqual({ kind: "card", id: ID });
    expect(parseTarget(`url:https://x`)).toBeNull();
    expect(parseTarget(`page:${ID}`)).toBeNull();
    expect(qrCodeSchema.safeParse({ name: "  פלייר  ", kind: "form", target: `form:${ID}`, url: null }).data).toMatchObject({
      name: "פלייר",
      kind: "form",
      target: `form:${ID}`,
    });
    expect(qrCodeSchema.safeParse({ name: "", kind: "form", target: `form:${ID}` }).success).toBe(false);
    expect(qrCodeSchema.safeParse({ name: "x".repeat(81), kind: "form", target: `form:${ID}` }).success).toBe(false);
    expect(qrCodeSchema.safeParse({ name: "x", kind: "form", target: "" }).success).toBe(false);
    // the picked target must be of the picked kind
    expect(qrCodeSchema.safeParse({ name: "x", kind: "card", target: `form:${ID}` }).success).toBe(false);
    expect(qrCodeSchema.safeParse({ name: "x", kind: "card", target: `card:${ID}` }).success).toBe(true);
    expect(qrCodeSchema.safeParse({ name: "x", kind: "url", target: null, url: "https://a.io" }).success).toBe(true);
    expect(qrCodeSchema.safeParse({ name: "x", kind: "page", target: `form:${ID}` }).success).toBe(false);
  });

  it("writes exactly one target column, by the kind", () => {
    expect(targetColumns("card", ID, null)).toEqual({
      target_kind: "card",
      form_id: null,
      booking_page_id: null,
      business_card_id: ID,
      target_url: null,
    });
    expect(targetColumns("url", null, "https://a.io/")).toEqual({
      target_kind: "url",
      form_id: null,
      booking_page_id: null,
      business_card_id: null,
      target_url: "https://a.io/",
    });
  });
});

describe("QR code links (BIZ-03, owner 18 October 2026)", () => {
  it("the link rule reads the same cases as app.qr_target_url_ok", () => {
    for (const url of cases.ok) expect(qrTargetUrlOk(url), url).toBe(true);
    for (const url of cases.bad) expect(qrTargetUrlOk(url), JSON.stringify(url)).toBe(false);
    expect(qrTargetUrlOk(`https://a.io/${"x".repeat(2000 - 13)}`)).toBe(true);
    expect(qrTargetUrlOk(`https://a.io/${"x".repeat(2001 - 13)}`)).toBe(false);
    expect(qrTargetUrlOk(`https://${"a".repeat(64)}.com`)).toBe(false);
  });

  it("normalizes what a person typed, then applies the rule", () => {
    expect(normalizeQrTargetUrl("  www.example.co.il/ביקורת ")).toEqual({ ok: true, url: "https://www.example.co.il/%D7%91%D7%99%D7%A7%D7%95%D7%A8%D7%AA" });
    expect(normalizeQrTargetUrl("HTTPS://Example.com")).toEqual({ ok: true, url: "https://example.com/" });
    expect(normalizeQrTargetUrl("https://דוגמה.co.il")).toMatchObject({ ok: true, url: expect.stringMatching(/^https:\/\/xn--/) });
    expect(normalizeQrTargetUrl("")).toEqual({ ok: false, problem: "empty" });
    expect(normalizeQrTargetUrl("http://example.com")).toEqual({ ok: false, problem: "not-https" });
    expect(normalizeQrTargetUrl("javascript:alert(1)")).toEqual({ ok: false, problem: "not-https" });
    expect(normalizeQrTargetUrl("https://me:pw@example.com")).toEqual({ ok: false, problem: "credentials" });
    expect(normalizeQrTargetUrl("https://localhost:3000")).toEqual({ ok: false, problem: "invalid" });
    expect(normalizeQrTargetUrl("https://127.0.0.1")).toEqual({ ok: false, problem: "invalid" });
    expect(normalizeQrTargetUrl(`https://a.io/${"x".repeat(2000)}`)).toEqual({ ok: false, problem: "too-long" });
    // whatever the normalization returns passes the rule
    for (const url of cases.ok) {
      const result = normalizeQrTargetUrl(url);
      if (result.ok) expect(qrTargetUrlOk(result.url), url).toBe(true);
    }
  });

  it("a link answer leads to the stored link, its own query and fragment kept, tagged as a QR visit", () => {
    expect(qrRedirectPath({ url: "https://a.io", campaign: "פלייר" })).toBe(`https://a.io?utm_source=qr&utm_campaign=${encodeURIComponent("פלייר")}`);
    expect(qrRedirectPath({ url: "https://a.io/p?x=1&y=a%20b&z#top", campaign: "" })).toBe("https://a.io/p?x=1&y=a%20b&z&utm_source=qr#top");
    // the link's own campaign tags give way to the code's; other utm keys stay
    expect(withQrTags("https://a.io/?utm_source=old&utm%5Fcampaign=x&utm_medium=print", "שלט")).toBe(
      `https://a.io/?utm_medium=print&utm_source=qr&utm_campaign=${encodeURIComponent("שלט")}`,
    );
    expect(withQrTags("https://a.io/?", "x")).toBe("https://a.io/?utm_source=qr&utm_campaign=x");
    // a bad stored link, or an answer with both a path and a link, is "not found"
    for (const url of cases.bad) expect(qrRedirectPath({ url, campaign: "x" }), JSON.stringify(url)).toBeNull();
    expect(qrRedirectPath({ url: "https://a.io", path: `/f/${TOKEN}`, campaign: "x" })).toBeNull();
    expect(qrRedirectPath({ url: 5, campaign: "x" })).toBeNull();
  });

  it("a card answer leads to the card's page", () => {
    expect(qrRedirectPath({ path: `/f/card/${TOKEN}`, campaign: "כנס" })).toBe(`/f/card/${TOKEN}?utm_source=qr&utm_campaign=${encodeURIComponent("כנס")}`);
  });
});
