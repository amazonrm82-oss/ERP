import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { PUBLIC_HELP_ARTICLES } from "@/features/help/articles";
import { industryMetadata } from "@/features/landing/industry-metadata";
import { INDUSTRY_PAGE_KEYS } from "@/features/landing/industries";
import { LEGAL_DOCUMENTS } from "@/features/legal/documents";
import { jsonLdText, landingJsonLd } from "@/features/seo/json-ld";
import { publicPageMetadata, SITE_SHARE_IMAGE } from "@/features/seo/page-metadata";

// WEB-03: titles, descriptions, canonical addresses, sitemap and robots for the public marketing pages.

const SITE = "https://mexuzsystem.com";
const read = (path: string) => readFileSync(path, "utf8");

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = saved;
});

describe("sitemap", () => {
  it("lists exactly the public marketing pages, on NEXT_PUBLIC_SITE_URL", () => {
    const urls = sitemap().map((entry) => entry.url);
    const expected = [
      `${SITE}/`,
      `${SITE}/features`,
      ...INDUSTRY_PAGE_KEYS.map((key) => `${SITE}/industries/${key}`),
      `${SITE}/help`,
      `${SITE}/help/roadmap`,
      ...PUBLIC_HELP_ARTICLES.map((article) => `${SITE}/help/${article.slug}`),
      ...LEGAL_DOCUMENTS.filter((doc) => !doc.interim).map((doc) => `${SITE}/legal/${doc.slug}`),
    ];
    expect([...urls].sort()).toEqual([...expected].sort());
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("holds no app, customer link, API, sign-in or admin address", () => {
    for (const url of sitemap().map((entry) => entry.url)) {
      expect(url.startsWith(`${SITE}/`)).toBe(true);
      const path = new URL(url).pathname;
      expect(path).not.toMatch(/^\/(o|f|app|api|go|admin|login|signup|invite|onboarding|auth|agreement)(\/|$)/);
    }
  });

  it("leaves out legal texts that are still interim (they are noindex)", () => {
    const paths = sitemap().map((entry) => new URL(entry.url).pathname);
    for (const doc of LEGAL_DOCUMENTS.filter((d) => d.interim)) expect(paths).not.toContain(`/legal/${doc.slug}`);
  });

  it("is empty without a known address", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    try {
      expect(sitemap()).toEqual([]);
    } finally {
      if (vercel !== undefined) process.env.VERCEL_PROJECT_PRODUCTION_URL = vercel;
    }
  });
});

describe("robots", () => {
  it("keeps the app, customer links, API, redirects and admin out, and names the sitemap", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = [rules.disallow ?? []].flat();
    for (const path of ["/o/", "/app", "/api/", "/f/", "/go/", "/admin", "/login", "/signup"]) expect(disallow).toContain(path);
    const allow = [rules.allow ?? []].flat();
    for (const path of allow) expect(disallow.some((d) => path.startsWith(d))).toBe(false);
    expect(result.sitemap).toBe(`${SITE}/sitemap.xml`);
  });
});

// Every public marketing page names its title and description through the shared helper (or the industry one).
const PUBLIC_PAGES: Array<{ file: string; path: string | null; indexed: boolean }> = [
  { file: "src/app/page.tsx", path: "paths.landing", indexed: true },
  { file: "src/app/features/page.tsx", path: "paths.features", indexed: true },
  { file: "src/app/help/page.tsx", path: "paths.help", indexed: true },
  { file: "src/app/help/roadmap/page.tsx", path: "paths.roadmap", indexed: true },
  { file: "src/app/help/[slug]/page.tsx", path: null, indexed: true },
  { file: "src/app/legal/[doc]/page.tsx", path: "paths.legal(doc.slug)", indexed: false },
  { file: "src/app/legal/subprocessors/page.tsx", path: "paths.legal(doc.slug)", indexed: false },
  { file: "src/app/(auth)/login/page.tsx", path: "paths.login", indexed: false },
  { file: "src/app/(auth)/signup/page.tsx", path: "paths.signup", indexed: false },
];

describe("public page metadata", () => {
  it.each(PUBLIC_PAGES)("$file has a title, a description and a canonical address", ({ file, path }) => {
    const source = read(file);
    expect(source).toContain("publicPageMetadata({");
    expect(source).toMatch(/title:/);
    expect(source).toMatch(/description:/);
    if (path) expect(source).toContain(`path: ${path}`);
  });

  it("the sign-in screens stay noindex", () => {
    for (const file of ["src/app/(auth)/login/page.tsx", "src/app/(auth)/signup/page.tsx"]) expect(read(file)).toContain("index: false");
  });

  it("every industry page has a title, description and canonical", () => {
    for (const key of INDUSTRY_PAGE_KEYS) {
      const meta = industryMetadata(key);
      expect(meta.title).toBeTruthy();
      expect(String(meta.description ?? "").length).toBeGreaterThan(20);
      expect(meta.alternates?.canonical).toBe(`/industries/${key}`);
    }
  });

  it("the helper sets canonical, robots, Open Graph and Twitter, with no price in the texts", () => {
    const meta = publicPageMetadata({ title: "מרכז עזרה", description: "מדריכים קצרים", path: "/help", index: true });
    expect(meta.title).toBe("מרכז עזרה");
    expect(meta.alternates?.canonical).toBe("/help");
    expect(meta.robots).toEqual({ index: true, follow: true });
    expect(meta.openGraph).toMatchObject({ url: "/help", locale: "he_IL", siteName: "Mexuz", title: "מרכז עזרה | Mexuz" });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
    const closed = publicPageMetadata({ title: "כניסה", description: "x", path: "/login", index: false });
    expect(closed.robots).toEqual({ index: false, follow: false });
    const absolute = publicPageMetadata({ title: "Mexuz | הכול", description: "x", path: "/", index: true, absoluteTitle: true });
    expect(absolute.title).toEqual({ absolute: "Mexuz | הכול" });
  });

  it("the public pages' descriptions carry no price", () => {
    for (const { file } of PUBLIC_PAGES) {
      const descriptions = read(file).match(/description: [^\n]*/g) ?? [];
      for (const line of descriptions) expect(line).not.toMatch(/₪|ש"ח|\d+\s*(?:₪|שקל)/);
    }
  });

  it("every page names the site's share image (a page's openGraph would drop the file-based one)", () => {
    const png = readFileSync("src/app/opengraph-image.png");
    expect(png.readUInt32BE(16)).toBe(SITE_SHARE_IMAGE.width);
    expect(png.readUInt32BE(20)).toBe(SITE_SHARE_IMAGE.height);
    expect(read("src/app/opengraph-image.alt.txt").trim()).toBe(SITE_SHARE_IMAGE.alt);
    const meta = publicPageMetadata({ title: "a", description: "b", path: "/help", index: true });
    expect(meta.openGraph?.images).toEqual([SITE_SHARE_IMAGE]);
    for (const key of INDUSTRY_PAGE_KEYS) expect(industryMetadata(key).openGraph?.images).toEqual([SITE_SHARE_IMAGE]);
    expect(read("src/app/layout.tsx")).toContain("metadataBase: configuredSiteUrl()");
    expect(read("src/app/layout.tsx")).toContain('lang="he" dir="rtl"');
  });
});

describe("landing JSON-LD", () => {
  it("names the organization and the application, with no price, offer or rating", () => {
    const data = landingJsonLd(new URL(SITE));
    const text = JSON.stringify(data);
    const graph = data["@graph"] as Array<Record<string, unknown>>;
    expect(graph.map((node) => node["@type"])).toEqual(["Organization", "SoftwareApplication"]);
    expect(graph[0]).toMatchObject({ name: "Mexuz", url: `${SITE}/`, logo: `${SITE}/icons/apple-touch-icon.png` });
    expect(graph[1]).toMatchObject({ name: "Mexuz", inLanguage: "he", url: `${SITE}/` });
    expect(text).not.toMatch(/offers|price|aggregateRating|review/i);
  });

  it("without a known address it carries no address", () => {
    expect(JSON.stringify(landingJsonLd(undefined))).not.toMatch(/https?:\/\/(?!schema\.org)/);
  });

  it("escapes < so no text can close the script tag", () => {
    expect(jsonLdText({ a: "</script><script>x" })).not.toContain("<");
  });

  it("is rendered on the landing page", () => {
    const source = read("src/app/page.tsx");
    expect(source).toContain('type="application/ld+json"');
    expect(source).toContain("landingJsonLd(configuredSiteUrl())");
  });
});
