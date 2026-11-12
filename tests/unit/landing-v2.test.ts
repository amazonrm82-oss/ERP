import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONTACT_BUSINESS_TYPES, CONTACT_CONSENT_VERSION, CONTACT_HONEYPOT_FIELD, CONTACT_STARTED_FIELD, contactBusinessTypeField, contactFormHosts, contactFormToken, contactMessage } from "@/features/landing/contact";
import { HONEYPOT_FIELD, STARTED_AT_FIELD } from "@/features/intake/fields";
import { ROT_SWAP_MS, ROT_WORDS } from "@/features/landing/components/rot-word";
import { comparisonRows, HIGHLIGHTED_PLAN_KEY, planCards, PRICE_UNITS, pricingFootnote, pricingShowsSoon, SOON_LINE } from "@/features/landing/pricing";
import { honeypotFilled, WAITLIST_CONSENT_VERSION } from "@/features/landing/waitlist";
import { PLAN_CAPABILITIES } from "@/features/plans/capabilities";
import type { PublicPlan } from "@/features/plans/public-plans";
import { PLAN_VALUES } from "@/lib/plan-keys";
import { CONTACT_FORM_PATH } from "@/lib/support";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

// the plans as public.plans_public answers them: built, non-core capabilities only
const built = (key: keyof typeof PLAN_VALUES) =>
  PLAN_CAPABILITIES.filter((c) => c.built && c.core !== true && PLAN_VALUES[key].features[c.feature] === true).map((c) => c.feature);
const plan = (key: keyof typeof PLAN_VALUES, name: string): PublicPlan => ({
  key,
  name,
  priceMonthlyAgorot: PLAN_VALUES[key].price_monthly_agorot,
  priceAnnualAgorot: PLAN_VALUES[key].price_annual_agorot,
  priceUnit: PLAN_VALUES[key].price_unit,
  availability: PLAN_VALUES[key].availability === "coming_soon" ? "coming_soon" : "available",
  position: PLAN_VALUES[key].position,
  limits: { max_users: PLAN_VALUES[key].limits.max_users, max_records: PLAN_VALUES[key].limits.max_records, storage_gb: PLAN_VALUES[key].limits.storage_gb },
  features: built(key),
});
const PLANS = [plan("personal", "אישית"), plan("basic", "בסיס"), plan("pro", "מקצועית"), plan("business", "עסקי")];

describe("LND-20 v2 price cards", () => {
  it("both prices come from the plans table (owner (338) ב) and each plan's unit follows its own price_unit", () => {
    const cards = planCards(PLANS);
    for (const card of cards) {
      const p = PLANS.find((x) => x.key === card.key)!;
      expect(card.monthlyAgorot).toBe(p.priceMonthlyAgorot);
      expect(card.annualAgorot).toBe(p.priceAnnualAgorot);
      expect(card.annualYearAgorot).toBe(p.priceAnnualAgorot * 12);
      expect(card.unit).toEqual(p.priceUnit === "org" ? { month: "לחודש", year: "לשנה" } : { month: "למשתמש / חודש", year: "למשתמש לשנה" });
    }
    expect(cards.find((c) => c.key === "personal")?.annualAgorot).toBe(6900);
    expect(cards.find((c) => c.key === "personal")?.unit.month).toBe("לחודש");
    expect(cards.find((c) => c.key === "pro")?.unit.month).toBe("למשתמש / חודש");
    const rows = comparisonRows(PLANS);
    expect(rows[0].key).toBe("price_monthly");
    expect(rows[0].cells[0]).toEqual({ kind: "text", text: "79 ₪ לחודש" });
    expect(rows[0].cells[2]).toEqual({ kind: "text", text: "139 ₪ למשתמש / חודש" });
    expect(rows[1].cells[0]).toEqual({ kind: "text", text: "69 ₪ לחודש" });
    expect(rows[1].cells[2]).toEqual({ kind: "text", text: "119 ₪ למשתמש / חודש" });
    expect(PRICE_UNITS).toEqual({ org: { month: "לחודש", year: "לשנה" }, seat: { month: "למשתמש / חודש", year: "למשתמש לשנה" } });
    // both faces and the annual note read the card's own unit, never a fixed word
    const ui = read("src/features/landing/components/price-cards.tsx");
    expect(ui.match(/plan\.unit\.month/g)?.length).toBe(2);
    expect(ui).toContain("plan.unit.year");
    expect(ui).not.toMatch(/חודשיים חינם|\* 10/);
  });

  it("four highlights each, pro recommended, business coming soon, unbuilt capabilities marked soon from the one flag", () => {
    const cards = planCards(PLANS);
    for (const card of cards) expect(card.highlights.length).toBeLessThanOrEqual(4);
    expect(cards.filter((c) => c.highlighted).map((c) => c.key)).toEqual([HIGHLIGHTED_PLAN_KEY]);
    expect(cards.find((c) => c.key === "business")?.soon).toBe(true);
    const unbuilt = new Set(PLAN_CAPABILITIES.filter((c) => !c.built).map((c) => c.label));
    for (const card of cards) for (const line of card.full) if (!line.intro) expect(line.soon, line.label).toBe(unbuilt.has(line.label));
    // owner (339) ב: a built capability waiting for its provider is marked too
    const waited = planCards(PLANS, new Set(["sms"]));
    const smsLabel = PLAN_CAPABILITIES.find((c) => c.feature === "sms")!.label;
    expect(waited.flatMap((c) => c.full).filter((l) => l.label === smsLabel).every((l) => l.soon)).toBe(true);
    expect(comparisonRows(PLANS, new Set(["sms"])).find((r) => r.key === "sms")?.soon).toBe(true);
    expect(cards[1].full[0]).toMatchObject({ label: "כל מה שבאישית, ועוד:", intro: true });
  });

  it("the comparison table has a cell per plan, the SMS row carries the month quota, and the footnote keeps the owner's lines", () => {
    const rows = comparisonRows(PLANS);
    for (const row of rows) expect(row.cells).toHaveLength(PLANS.length);
    const sms = rows.find((r) => r.key === "sms");
    if (sms) expect(sms.cells.some((c) => c.kind === "text")).toBe(true);
    expect(pricingFootnote().startsWith(SOON_LINE)).toBe(true);
    expect(pricingShowsSoon(planCards(PLANS), comparisonRows(PLANS))).toBe(PLAN_CAPABILITIES.some((c) => !c.built && c.core !== true));
    expect(pricingShowsSoon(planCards(PLANS, new Set(["sms"])), comparisonRows(PLANS, new Set(["sms"])))).toBe(true);
    expect(SOON_LINE).toBe('"בקרוב" = נפתח בשבועות הקרובים, בלי תוספת מחיר.');
  });
});

describe("LND-20 v2 page", () => {
  it("follows the prototype's order, with no invented numbers strip", () => {
    const page = read("src/app/page.tsx");
    const order = ["<LandingNav />", "<Hero />", "<Marquee />", "<FlowSection />", "<Steps />", "<ProductBlocks />", "<PricingSection plans={plans} waiting={waiting} />", "<Quote />", "<Faq />", "<ContactSection", "<Cta />", "<LandingFooter />"];
    const at = order.map((part) => page.indexOf(part));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(page).not.toMatch(/landing_stats|StatsStrip/);
    const hero = read("src/features/landing/components/sections.tsx");
    expect(hero).toContain("ליד נכנס.");
    expect(hero).toContain("בלי כרטיס אשראי");
  });

  it("the word swap makes one pass within 5 seconds; nothing loops without the pause control", () => {
    expect(ROT_WORDS).toEqual(["לידים", "לקוחות", "עסקאות", "כסף"]);
    expect(ROT_SWAP_MS * (ROT_WORDS.length - 1)).toBeLessThan(5000);
    expect(read("src/features/landing/components/rot-word.tsx")).not.toContain("setInterval");
    const pause = read("src/features/landing/components/pause-button.tsx");
    expect(pause).toContain("pauseAnimations");
    expect(pause).toContain("aria-pressed={paused}");
    const canvas = read("src/features/landing/components/hero-canvas.tsx");
    expect(canvas).toContain("IntersectionObserver");
    expect(canvas).toContain("visibilitychange");
    expect(canvas).toContain("prefers-reduced-motion: reduce");
    expect(canvas).not.toMatch(/getContext\("webgl|from "three"/);
  });

  it("the landing CSS has no colour of its own and stops every animation under reduced motion and the pause", () => {
    const css = read("src/features/landing/components/landing.module.css");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).toMatch(/\.page\[data-paused="true"\] \*/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
  });

  it("the contact form goes to Mexuz's own lead form through the ordinary intake, with Turnstile and a stored consent version", () => {
    expect(contactFormToken(CONTACT_FORM_PATH)).toMatch(/^[0-9a-f]{32}$/);
    expect(contactFormToken("https://x.example/f/abc")).toBeNull();
    const t = "32bd5218d280423fa83fa0f553c62588";
    const hosts = contactFormHosts("https://staging.example.com/");
    expect(hosts).toEqual(["mexuzsystem.com", "erp-3yft.vercel.app", "staging.example.com"]);
    expect(contactFormToken(`https://mexuzsystem.com/f/${t}`, hosts)).toBe(t);
    expect(contactFormToken(`https://staging.example.com/f/${t}`, hosts)).toBe(t);
    for (const bad of [`https://evil.example/f/${t}`, `http://mexuzsystem.com/f/${t}`, `https://u@mexuzsystem.com/f/${t}`,
      `https://mexuzsystem.com:444/f/${t}`, `https://mexuzsystem.com/f/${t}?x=1`, `https://mexuzsystem.com/f/${t}#a`,
      `//mexuzsystem.com/f/${t}`, `/f/${t}/qr`, `/f/${t.toUpperCase()}`, "not a url"]) {
      expect(contactFormToken(bad, hosts)).toBeNull();
    }
    expect(contactBusinessTypeField(undefined)).toBeNull();
    expect(contactBusinessTypeField(" business_type ")).toBe("business_type");
    for (const bad of ["", "Business", "1type", "cf:type", "a-b", "x".repeat(41)]) expect(contactBusinessTypeField(bad)).toBeNull();
    expect(contactMessage(null, CONTACT_CONSENT_VERSION)).not.toContain("סוג העסק");
    expect(read("src/features/landing/contact-server.ts")).toMatch(/\[`cf_\$\{typeField\}`\]: type/);
    expect(CONTACT_BUSINESS_TYPES).toEqual(["שירותים מקצועיים", "קליניקה או טיפולים", "קבלנות ושיפוצים", "מסחר וחנות", "סטודיו, יופי ובריאות", "אחר"]);
    const section = read("src/features/landing/components/contact-section.tsx");
    expect(section).toContain("contactFormToken(SUPPORT.formUrl)");
    expect(CONTACT_BUSINESS_TYPES).toHaveLength(6);
    expect([CONTACT_HONEYPOT_FIELD, CONTACT_STARTED_FIELD]).toEqual([HONEYPOT_FIELD, STARTED_AT_FIELD]);
    expect(contactMessage("אחר", CONTACT_CONSENT_VERSION)).toContain(`נוסח ${CONTACT_CONSENT_VERSION}`);
    const server = read("src/features/landing/contact-server.ts");
    expect(server).toContain("verifyTurnstileToken");
    expect(server).toContain("handleIntake(");
    expect(server).not.toMatch(/supabase\/service|createServiceClient|\.rpc\(/);
    expect(server).toContain("contactFormToken(SUPPORT.formUrl)");
    expect(server).not.toContain("CONTACT_FORM_PATH");
  });

  it("a honeypot holding anything but nothing is a bot", () => {
    for (const filled of ["x", " ", 0, 1, true, false, [], {}, ["a"]]) expect(honeypotFilled(filled)).toBe(true);
    for (const empty of [undefined, null, ""]) expect(honeypotFilled(empty)).toBe(false);
  });

  it("the waitlist route hashes the sender by its /64 and refuses without a hash", () => {
    const route = read("src/features/landing/waitlist-server.ts");
    expect(route).toContain('keyedIpHash(publicSenderAddress(clientIp(request.headers)), "waitlist")');
    expect(route).toMatch(/if \(!ipHash\) return rateLimitedJson/);
    expect(route.indexOf("honeypotFilled(")).toBeLessThan(route.indexOf("createServiceClient()"));
  });

  it("the waitlist's wording version is one the database accepts", () => {
    expect(read(`supabase/migrations/${readdirSync(path.join(process.cwd(), "supabase/migrations")).find((f) => f.endsWith("_landing_waitlist.sql"))}`)).toContain(`'${WAITLIST_CONSENT_VERSION}'`);
    expect(read("eslint.config.mjs")).toContain('"src/features/landing/waitlist-server.ts"');
  });

  it("links to /features, a public static page in the sitemap", () => {
    expect(read("src/features/landing/components/sections.tsx")).toContain("paths.features");
    expect(read("src/app/features/page.tsx")).toContain("LIVE_FEATURES");
    expect(read("src/app/sitemap.ts")).toContain("paths.features");
    expect(read("src/lib/supabase/proxy.ts")).toMatch(/PUBLIC_EXACT = \[[^\]]*"\/features"/);
  });
});
