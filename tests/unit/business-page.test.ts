import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { hoursLines, publicBusinessPageFrom, websiteHref, websiteLabel } from "@/features/business-page/public";

// BIZ-01: what the public business page draws from public.business_page_public()'s answer.
describe("business page answer (BIZ-01)", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";

  it("reads the public fields and drops anything malformed", () => {
    const page = publicBusinessPageFrom({
      business: "סטודיו",
      brand: { logo: "org/logo", color: "#123456" },
      built_with: true,
      about: "כמה מילים",
      phone: "03-5551234",
      whatsapp: "97235551234",
      website: "studio.example.co.il",
      hours: { sun: [{ start: "08:00", end: "13:00" }, { start: "16:00", end: "23:59" }] },
      booking: [{ title: "ייעוץ", token: TOKEN }, { title: "רע", token: "javascript:alert(1)" }, { title: "", token: TOKEN }, null],
      form: true,
    });
    expect(page).toMatchObject({
      business: "סטודיו",
      brand: { logoPath: "org/logo", color: "#123456" },
      builtWith: true,
      whatsapp: "97235551234",
      website: "https://studio.example.co.il",
      booking: [{ title: "ייעוץ", token: TOKEN }],
      form: true,
    });
    expect(page?.hours?.[0]).toEqual({ day: "ראשון", ranges: ["08:00–13:00", "16:00–24:00"] });
    expect(page?.hours?.[1]).toEqual({ day: "שני", ranges: [] });
    expect(publicBusinessPageFrom({ business: "" })).toBeNull();
    expect(publicBusinessPageFrom([])).toBeNull();
    expect(publicBusinessPageFrom({ business: "x", whatsapp: "+97235551234" })?.whatsapp).toBeNull();
  });

  it("a website becomes a link only when it is http(s) or a plain host", () => {
    expect(websiteHref("https://example.co.il/about")).toBe("https://example.co.il/about");
    expect(websiteHref("example.co.il")).toBe("https://example.co.il");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "not a site", "ftp://example.com", ""]) {
      expect(websiteHref(bad), bad).toBeNull();
    }
    expect(websiteLabel("https://example.co.il/")).toBe("example.co.il");
  });

  it("hours: no hours or an unreadable shape show nothing", () => {
    expect(hoursLines(null)).toBeNull();
    expect(hoursLines({})).toBeNull();
    expect(hoursLines({ sun: { start: "10:00", end: "09:00" } })).toBeNull();
    // the first shape (one range per day) still reads
    expect(hoursLines({ mon: { start: "09:00", end: "17:00" } })?.[1]).toEqual({ day: "שני", ranges: ["09:00–17:00"] });
  });

  it("the server file calls only the two page functions", () => {
    const source = readFileSync("src/features/business-page/public-server.ts", "utf8");
    expect([...source.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["business_page_public", "business_page_submit"]);
    expect(source).not.toMatch(/\.from\(/);
  });
});
