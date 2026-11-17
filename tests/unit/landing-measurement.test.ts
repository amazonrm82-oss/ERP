import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { carriedSource, isCrawler, isNewSignupAccount, landingSource, notAVisit, signupClickHref, signupHrefWithSource } from "@/features/landing/measure";
import { parseLandingMeasurement, rateText, shownSource, sourceLabel, summarizeLanding } from "@/features/platform/landing-measurement";

import fixture from "./fixtures/landing-sources.json";

// LND-14 (owner (388) א): cookieless counters on the landing page. The source is utm_source only, in a closed shape; a
// prefetch or a link-preview fetcher is never counted; nothing on the landing page sets a cookie or browser storage.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("LND-14 source", () => {
  it("folds utm_source to [a-z0-9_.-]{1,40}, empty = direct, anything else = other", () => {
    expect(landingSource(undefined)).toBe("direct");
    expect(landingSource("")).toBe("direct");
    expect(landingSource("   ")).toBe("direct");
    expect(landingSource(" Facebook ")).toBe("facebook");
    expect(landingSource("google.ads_2026-q4")).toBe("google.ads_2026-q4");
    expect(landingSource(["Insta", "x"])).toBe("insta");
    expect(landingSource("פייסבוק")).toBe("other");
    expect(landingSource("a b")).toBe("other");
    expect(landingSource("x".repeat(41))).toBe("other");
    expect(landingSource("x".repeat(40))).toBe("x".repeat(40));
    expect(landingSource("<script>")).toBe("other");
    expect(landingSource(42)).toBe("direct");
  });

  it("a carried source is taken only in its folded shape", () => {
    expect(carriedSource("facebook")).toBe("facebook");
    expect(carriedSource("Facebook")).toBeNull();
    expect(carriedSource("")).toBeNull();
    expect(carriedSource(null)).toBeNull();
    expect(signupClickHref("google.ads")).toBe("/go/signup?src=google.ads");
    expect(signupHrefWithSource("direct")).toBe("/signup?src=direct");
    expect(signupHrefWithSource(null)).toBe("/signup");
  });

  it("the TS fold runs the shared fixture (test 376 runs it against app.landing_event_source)", () => {
    for (const c of fixture as Array<{ input: string | null; source: string }>) {
      expect(landingSource(c.input ?? undefined), JSON.stringify(c.input)).toBe(c.source);
    }
    const sql = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith("_landing_measurement.sql"))
      .map((f) => read(join("supabase/migrations", f)))
      .join("\n");
    expect(sql).toContain("when btrim(p_source) ~ '^[A-Za-z0-9_.-]{1,40}$' then lower(btrim(p_source))");
  });
});

describe("LND-14 not a visit", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("skips prefetches and preview bots", () => {
    expect(notAVisit(h({ "next-router-prefetch": "1" }))).toBe(true);
    expect(notAVisit(h({ "next-router-segment-prefetch": "/_tree" }))).toBe(true);
    expect(notAVisit(h({ purpose: "prefetch" }))).toBe(true);
    expect(notAVisit(h({ "sec-purpose": "prefetch;prerender" }))).toBe(true);
    expect(notAVisit(h({ "x-moz": "prefetch" }))).toBe(true);
    expect(notAVisit(h({ "user-agent": "WhatsApp/2.23.20.0 A" }))).toBe(true);
    expect(notAVisit(h({ "user-agent": "facebookexternalhit/1.1" }))).toBe(true);
  });
  it("skips crawlers and uptime monitors", () => {
    const agents = [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)",
      "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
      "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
      "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
      "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
      "Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)",
      "Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot)",
      "Mozilla/5.0 (compatible;PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
      "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
      "Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0 Safari/537.36 StatusCake",
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)",
      "AdsBot-Google (+http://www.google.com/adsbot.html)",
      "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
      "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)",
      "Mozilla/5.0 (compatible; GoogleOther)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
      "curl/8.4.0",
      "Wget/1.21.4",
      "python-requests/2.31.0",
      "Go-http-client/1.1",
      "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
      "node-fetch",
      "axios/1.6.2",
      "SomeNewCrawler crawler",
      "example spider 1.0",
    ];
    for (const ua of agents) {
      expect(isCrawler(ua), ua).toBe(true);
      expect(notAVisit(h({ "user-agent": ua })), ua).toBe(true);
    }
  });
  it("a User-Agent over 1,000 characters is never a visit", () => {
    const long = `Mozilla/5.0 ${"x".repeat(1000)}`;
    expect(isCrawler(long)).toBe(true);
    expect(notAVisit(h({ "user-agent": long }))).toBe(true);
    expect(isCrawler(`Mozilla/5.0 ${"x".repeat(900)}`)).toBe(false);
  });
  it("counts an ordinary browser and a client navigation", () => {
    expect(isCrawler("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")).toBe(false);
    expect(isCrawler("Mozilla/5.0 (Linux; Android 10; CUBOT X20) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36")).toBe(false);
    expect(isCrawler("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")).toBe(false);
    expect(notAVisit(h({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" }))).toBe(false);
    expect(notAVisit(h({ rsc: "1", "user-agent": "Mozilla/5.0" }))).toBe(false);
    expect(notAVisit(h({}))).toBe(false);
  });
});

describe("LND-14 no cookie, no storage, no client script", () => {
  it("the landing measurement files and the link never touch cookies or browser storage", () => {
    for (const file of ["src/features/landing/measure.ts", "src/features/landing/measure-server.ts", "src/app/go/signup/route.ts", "src/app/page.tsx"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/cookies\(|set-cookie|document\.cookie|localStorage|sessionStorage|indexedDB/i);
      expect(text, file).not.toMatch(/^"use client"/m);
    }
  });
  it("the counting link is a plain <a>, never a prefetching <Link>", () => {
    const sections = read("src/features/landing/components/sections.tsx");
    expect(sections).toMatch(/if \(href\.startsWith\(SIGNUP_CLICK_PATH\)\) \{\s*return \(\s*<a href=\{href\} rel="nofollow"/);
    const nofollow = '<a href={signupHref} rel={signupHref.startsWith(SIGNUP_CLICK_PATH) ? "nofollow" : undefined}';
    // WEB-02: a price card's link carries its plan; still a plain <a> with nofollow on the counting link
    expect(read("src/features/landing/components/price-cards.tsx")).toContain(
      '<a href={signupHrefWithPlan(signupHref, plan.key)} rel={signupHref.startsWith(SIGNUP_CLICK_PATH) ? "nofollow" : undefined}',
    );
    expect(read("src/features/landing/components/pricing-section.tsx")).toContain(nofollow);
    expect(read("src/app/robots.ts")).toContain('"/go/"');
  });
  it("the counter file is in the service-key allow-list", () => {
    expect(read("eslint.config.mjs")).toContain('"src/features/landing/measure-server.ts"');
  });
});

describe("LND-14 a new account only", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  it("counts a user made within 60 seconds with an identity", () => {
    expect(isNewSignupAccount({ created_at: "2026-11-16T09:59:30Z", identities: [{}] }, now)).toBe(true);
    expect(isNewSignupAccount({ created_at: "2026-11-16T10:00:20Z", identities: [{}] }, now)).toBe(true);
  });
  it("never a repeat sign-up, an existing address or a malformed answer", () => {
    // a repeat sign-up of an unconfirmed address answers the account made earlier
    expect(isNewSignupAccount({ created_at: "2026-11-15T10:00:00Z", identities: [{}] }, now)).toBe(false);
    expect(isNewSignupAccount({ created_at: "2026-11-16T09:58:59Z", identities: [{}] }, now)).toBe(false);
    expect(isNewSignupAccount({ created_at: "2026-11-16T10:00:00Z", identities: [] }, now)).toBe(false);
    expect(isNewSignupAccount({ created_at: "2026-11-16T10:00:00Z", identities: null }, now)).toBe(false);
    expect(isNewSignupAccount({ created_at: "not a date", identities: [{}] }, now)).toBe(false);
    expect(isNewSignupAccount({ identities: [{}] }, now)).toBe(false);
    expect(isNewSignupAccount(null, now)).toBe(false);
  });
  it("the sign-up action asks it", () => {
    expect(read("src/features/auth/actions.ts")).toContain("if (landingSource && isNewSignupAccount(data.user)) await recordLandingEvent(");
  });
});

describe("LND-14 platform card", () => {
  it("parses strictly and sums per source and per day, zeros for empty days", () => {
    const m = parseLandingMeasurement({
      from: "2026-11-14",
      to: "2026-11-16",
      rows: [
        { day: "2026-11-16", source: "direct", visits: 10, signup_clicks: 3, signups: 1 },
        { day: "2026-11-14", source: "facebook", visits: 5, signup_clicks: 2, signups: null },
        { day: "bad", source: "x", visits: 1 },
        { day: "2026-11-14", source: "direct", visits: -4, signup_clicks: 1.5, signups: 1 },
      ],
    });
    expect(m.rows).toHaveLength(3);
    const s = summarizeLanding(m);
    expect(s.total).toEqual({ visits: 15, signupClicks: 5, signups: 2 });
    expect(s.bySource.map((r) => r.source)).toEqual(["direct", "facebook"]);
    expect(s.byDay.map((r) => r.day)).toEqual(["2026-11-16", "2026-11-15", "2026-11-14"]);
    expect(s.byDay[1]).toEqual({ day: "2026-11-15", visits: 0, signupClicks: 0, signups: 0 });
    expect(parseLandingMeasurement(null)).toEqual({ from: null, to: null, rows: [] });
  });
  it("names a source only on a day it had a visit; otherwise it shows as other", () => {
    expect(shownSource({ day: "2026-11-16", source: "spam-name", visits: 0, signupClicks: 4, signups: 0 })).toBe("other");
    expect(shownSource({ day: "2026-11-16", source: "facebook", visits: 1, signupClicks: 4, signups: 0 })).toBe("facebook");
    expect(shownSource({ day: "2026-11-16", source: "direct", visits: 0, signupClicks: 1, signups: 0 })).toBe("direct");
    const s = summarizeLanding(
      parseLandingMeasurement({
        from: "2026-11-16",
        to: "2026-11-16",
        rows: [
          { day: "2026-11-16", source: "spam-name", visits: 0, signup_clicks: 4, signups: 0 },
          { day: "2026-11-16", source: "other", visits: 2, signup_clicks: 1, signups: 0 },
        ],
      }),
    );
    expect(s.bySource).toEqual([{ source: "other", visits: 2, signupClicks: 5, signups: 0 }]);
  });
  it("rates and labels", () => {
    expect(rateText(1, 3)).toBe("33%");
    expect(rateText(0, 0)).toBe("—");
    expect(sourceLabel("direct")).toBe("ישיר (בלי מקור)");
    expect(sourceLabel("other")).toBe("אחר");
    expect(sourceLabel("facebook")).toBe("facebook");
  });
});
