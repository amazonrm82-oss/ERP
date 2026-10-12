import { describe, expect, it } from "vitest";

import { attributionRows, collectAttribution, parseAttribution } from "@/features/intake/attribution";

describe("intake: where a lead came from (CAP-02, ADS-01)", () => {
  it("keeps the known keys of a body and ignores the rest", () => {
    expect(
      parseAttribution({
        utm_source: " facebook ",
        utm_medium: "cpc",
        utm_campaign: "חורף 2026",
        utm_term: "שיפוצים",
        utm_content: "ad-7",
        gclid: "Cj0KCQjw-abc_123",
        fbclid: "IwAR2xyz",
        ctwa_clid: "ARAkLk.1~x",
        referrer_url: "https://www.google.com/",
        landing_url: "https://example.co.il/offer?utm_source=facebook",
        full_name: "דנה",
        utm_evil: "x",
        meta_lead_id: "123",
      }),
    ).toEqual({
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "חורף 2026",
      utm_term: "שיפוצים",
      utm_content: "ad-7",
      gclid: "Cj0KCQjw-abc_123",
      fbclid: "IwAR2xyz",
      ctwa_clid: "ARAkLk.1~x",
      referrer_url: "https://www.google.com/",
      landing_url: "https://example.co.il/offer?utm_source=facebook",
    });
  });

  it("checks and cuts each value", () => {
    const out = parseAttribution({
      utm_source: "א".repeat(500),
      utm_medium: "a\u0000b\nc",
      utm_campaign: 42,
      utm_term: "   ",
      gclid: "has space",
      fbclid: "x".repeat(501),
      ctwa_clid: "<script>",
      referrer_url: "javascript:alert(1)",
      landing_url: `https://x.co/${"p".repeat(2000)}`,
    });
    expect(out).toEqual({ utm_source: "א".repeat(200), utm_medium: "abc" });
  });

  it("reads the names webhook senders use, the canonical key first", () => {
    expect(parseAttribution({ campaign: "קיץ", referrer: "https://a.co", page_url: "https://b.co/x" })).toEqual({
      utm_campaign: "קיץ",
      referrer_url: "https://a.co",
      landing_url: "https://b.co/x",
    });
    expect(parseAttribution({ utm_campaign: "א", campaign: "ב" }).utm_campaign).toBe("א");
  });

  it("the hosted form sends its own address and the page the visitor came from", () => {
    const href = "https://crm.example/f/abc?utm_source=google&utm_medium=cpc&gclid=G1&other=1";
    expect(collectAttribution(href, "https://www.google.com/")).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      gclid: "G1",
      landing_url: href,
      referrer_url: "https://www.google.com/",
    });
    expect(collectAttribution("https://crm.example/f/abc", "")).toEqual({ landing_url: "https://crm.example/f/abc" });
  });

  it("an embedded form takes the host page from page_url, its own UTMs first", () => {
    const host = "https://shop.co.il/landing?utm_source=facebook&utm_campaign=sale&fbclid=F1";
    const href = `https://crm.example/f/abc?embed=1&utm_campaign=override&page_url=${encodeURIComponent(host)}&ref=${encodeURIComponent("https://l.facebook.com/")}`;
    expect(collectAttribution(href, "https://shop.co.il/")).toEqual({
      utm_source: "facebook",
      utm_campaign: "override",
      fbclid: "F1",
      landing_url: host,
      referrer_url: "https://l.facebook.com/",
    });
    // without page_url: the iframe's referrer is the host page, and where the visitor came from is unknown
    expect(collectAttribution("https://crm.example/f/abc?embed=1", "https://shop.co.il/")).toEqual({ landing_url: "https://shop.co.il/" });
  });

  it("the lead card shows only the lines that have a value", () => {
    const empty = { campaign: null, utm: {}, referrer_url: null, landing_url: null, gclid: null, fbclid: null, ctwa_clid: null, meta_lead_id: null };
    expect(attributionRows(empty)).toEqual([]);
    expect(
      attributionRows({
        ...empty,
        campaign: "חורף",
        utm: { utm_source: "facebook", utm_medium: "cpc", utm_content: "ad-7" },
        landing_url: "https://example.co.il/offer",
        gclid: "G1",
        fbclid: "F1",
      }),
    ).toEqual([
      { label: "קמפיין", value: "חורף" },
      { label: "מקור הפנייה", value: "facebook / cpc" },
      { label: "מודעה", value: "ad-7" },
      { label: "דף הנחיתה", value: "example.co.il/offer", ltr: true },
      { label: "מזהה פרסום", value: "Google Ads, Facebook" },
    ]);
  });
});

describe("a bad value never costs a lead (review of CAP-02)", () => {
  it("drops a URL with a control character, and cuts text between characters", async () => {
    const { parseAttribution, safeText } = await import("@/features/intake/attribution");
    expect(parseAttribution({ referrer: "https://x.example/\u0000", page_url: "https://ok.example/p" })).toEqual({ landing_url: "https://ok.example/p" });
    const cut = safeText("a".repeat(199) + "😀😀", 200);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith("😀")).toBe(true);
    expect(safeText("שלום\ud83d", 50)).toBe("שלום");
    expect(safeText("שורה 1\nשורה 2\u0007", 50)).toBe("שורה 1\nשורה 2");
  });
});
