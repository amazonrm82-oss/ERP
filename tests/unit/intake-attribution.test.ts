import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  attributionRows,
  collectAttribution,
  EXTRA_CLICK_ID_KEYS,
  EXTRA_UTM_KEYS,
  parseAttribution,
  siteAndPathUrl,
} from "@/features/intake/attribution";

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

  it("keeps the extra parameters of the closed list (CAP-02): UTM values by the UTM rule, click ids by the click id rule", () => {
    expect(
      parseAttribution({
        utm_id: " 123 ",
        utm_source_platform: "Search Ads 360",
        utm_creative_format: "x".repeat(300),
        utm_marketing_tactic: "a\u0001b",
        msclkid: "ms-1_a",
        ttclid: "E.C.P~1",
        li_fat_id: "li-1",
        gbraid: "0AAA-gb",
        wbraid: "Cjk_wb",
        dclid: "D1",
        utm_campaign_id: "x",
        extra: { evil: "x" },
      }),
    ).toEqual({
      utm_id: "123",
      utm_source_platform: "Search Ads 360",
      utm_creative_format: "x".repeat(200),
      utm_marketing_tactic: "ab",
      msclkid: "ms-1_a",
      ttclid: "E.C.P~1",
      li_fat_id: "li-1",
      gbraid: "0AAA-gb",
      wbraid: "Cjk_wb",
    });
    expect(parseAttribution({ msclkid: "has space", ttclid: "t".repeat(501), li_fat_id: "<x>", gbraid: "", wbraid: 7, utm_id: "  " })).toEqual({});
  });

  it("the hosted form passes the extra parameters from its own address (CAP-02)", () => {
    expect(collectAttribution("https://crm.example/f/abc?msclkid=M1&utm_id=9&dclid=D", "")).toEqual({
      msclkid: "M1",
      utm_id: "9",
      landing_url: "https://crm.example/f/abc?msclkid=M1&utm_id=9",
    });
  });

  it("reads the names webhook senders use, the canonical key first", () => {
    expect(parseAttribution({ campaign: "קיץ", referrer: "https://a.co", page_url: "https://b.co/x" })).toEqual({
      utm_campaign: "קיץ",
      referrer_url: "https://a.co",
      landing_url: "https://b.co/x",
    });
    expect(parseAttribution({ utm_campaign: "א", campaign: "ב" }).utm_campaign).toBe("א");
  });

  it("the landing page address keeps only its campaign parameters, before it is sent and when it is received (CAP-02)", () => {
    expect(
      parseAttribution({
        landing_url: " https://shop.co.il/sale?token=secret&utm_source=fb&email=a%40b.co&fbclid=F1#form ",
        referrer_url: "https://l.facebook.com/?u=1",
      }),
    ).toEqual({ landing_url: "https://shop.co.il/sale?utm_source=fb&fbclid=F1", referrer_url: "https://l.facebook.com/" });
    // the old name webhook senders use goes through the same rule
    expect(parseAttribution({ page_url: "https://a.co/p?x=1#y" })).toEqual({ landing_url: "https://a.co/p" });
    expect(parseAttribution({ landing_url: "https://user:pass@a.co/p?utm_source=x" })).toEqual({ landing_url: "https://a.co/p?utm_source=x" });
    // a long address made short by the stripping is kept; a bad one is still dropped
    expect(parseAttribution({ landing_url: `https://a.co/p?utm_source=x&junk=${"j".repeat(3000)}` })).toEqual({ landing_url: "https://a.co/p?utm_source=x" });
    expect(parseAttribution({ landing_url: "javascript:alert(1)?utm_source=x" })).toEqual({});
    // an embedded form: the page address from the embed code is stripped too
    const host = "https://shop.co.il/landing?utm_source=facebook&session=abc#top";
    expect(collectAttribution(`https://crm.example/f/abc?embed=1&page_url=${encodeURIComponent(host)}`, "").landing_url).toBe(
      "https://shop.co.il/landing?utm_source=facebook",
    );
  });

  it("the referrer keeps only site and path, before it is sent and when it is received (CAP-02)", () => {
    expect(parseAttribution({ referrer_url: " https://user:pass@www.google.com/search?q=secret&email=a%40b.co#top " })).toEqual({
      referrer_url: "https://www.google.com/search",
    });
    // the other names webhook senders use go through the same rule; a bad address is still dropped
    expect(parseAttribution({ referer: "https://a.co/p?x=1" })).toEqual({ referrer_url: "https://a.co/p" });
    expect(parseAttribution({ referrer_url: "javascript:alert(1)?x=https://a.co" })).toEqual({});
    // the hosted form, opened directly and embedded
    expect(collectAttribution("https://crm.example/f/abc", "https://www.google.com/search?q=x").referrer_url).toBe("https://www.google.com/search");
    expect(collectAttribution(`https://crm.example/f/abc?embed=1&ref=${encodeURIComponent("https://l.facebook.com/l.php?u=1")}`, "").referrer_url).toBe(
      "https://l.facebook.com/l.php",
    );
  });

  it("siteAndPathUrl() follows the same rules as app.site_and_path_url()", () => {
    // the same cases as tests/db/50-intake-attribution.test.ts
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      ["https://a.co", "https://a.co"],
      ["https://a.co/", "https://a.co/"],
      ["https://www.google.com/search?q=%D7%A9%D7%99%D7%A4%D7%95%D7%A6%D7%99%D7%9D&hl=he", "https://www.google.com/search"],
      ["https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.co.il&h=AT1#x", "https://l.facebook.com/l.php"],
      ["https://a.co/p#h?x=1", "https://a.co/p"],
      ["https://a.co/p?x=1#h", "https://a.co/p"],
      ["https://a.co/p?", "https://a.co/p"],
      ["https://a.co/p?utm_source=a&gclid=G", "https://a.co/p"],
      ["https://user:pass@a.co/p?x=1", "https://a.co/p"],
      ["https://a@b@a.co:8443/p/q", "https://a.co:8443/p/q"],
      ["https://a.co/@x/y?next=https://u:p@b.co", "https://a.co/@x/y"],
      ["https://a.co?next=https://u:p@b.co", "https://a.co"],
      ["https://a.co#u:p@b.co", "https://a.co"],
    ];
    for (const [input, expected] of cases) {
      expect(siteAndPathUrl(input), String(input)).toBe(expected);
    }
  });

  it("the hosted form sends its own address and the page the visitor came from", () => {
    const href = "https://crm.example/f/abc?utm_source=google&utm_medium=cpc&gclid=G1&other=1";
    expect(collectAttribution(href, "https://www.google.com/")).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      gclid: "G1",
      // CAP-02: only the campaign parameters stay on the landing page address
      landing_url: "https://crm.example/f/abc?utm_source=google&utm_medium=cpc&gclid=G1",
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
    // CAP-02: the extra parameters, kept in utm.extra, on one generic line
    expect(
      attributionRows({ ...empty, utm: { extra: { utm_id: "77", utm_source_platform: "SA360", msclkid: "M1", wbraid: "W1", odd: "x", ttclid: 5 } } }),
    ).toEqual([
      { label: "פרמטרי קמפיין נוספים", value: "utm_id=77, utm_source_platform=SA360", ltr: true },
      { label: "מזהי פרסום נוספים", value: "Microsoft Ads, Google Ads (wbraid)", ltr: true },
    ]);
    // only one of the two, and a long value cut for the card
    expect(attributionRows({ ...empty, utm: { extra: { ttclid: "T" } } })).toEqual([{ label: "מזהי פרסום נוספים", value: "TikTok", ltr: true }]);
    expect(attributionRows({ ...empty, utm: { extra: { utm_marketing_tactic: "ט".repeat(200) } } })).toEqual([
      { label: "פרמטרי קמפיין נוספים", value: `utm_marketing_tactic=${"ט".repeat(39)}…`, ltr: true },
    ]);
    expect(attributionRows({ ...empty, utm: { extra: "x" } })).toEqual([]);
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

describe("the closed list of extra parameters is the same in the app and the database (CAP-02)", () => {
  it("EXTRA_UTM_KEYS and EXTRA_CLICK_ID_KEYS equal the lists of migration more_campaign_params", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261006009800_more_campaign_params.sql"), "utf8");
    const body = sql.slice(sql.indexOf("create or replace function app.intake_attribution"));
    const arrays = [...body.matchAll(/foreach v_key in array array\[([^\]]*)\]/g)].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((k) => k[1]));
    // classic UTMs, classic click ids, extra UTMs, extra click ids, page addresses: in that order
    expect(arrays).toHaveLength(5);
    expect(arrays[2]).toEqual([...EXTRA_UTM_KEYS]);
    expect(arrays[3]).toEqual([...EXTRA_CLICK_ID_KEYS]);
    // and app.campaign_only_url() keeps the classic and the extra keys
    const only = sql.slice(sql.indexOf("create or replace function app.campaign_only_url"), sql.indexOf("create or replace function app.intake_attribution"));
    const kept = [...(only.match(/= any \(array\[([^\]]*)\]/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((k) => k[1]);
    expect(kept).toEqual([...arrays[0], ...arrays[1], ...EXTRA_UTM_KEYS, ...EXTRA_CLICK_ID_KEYS]);
  });
});
