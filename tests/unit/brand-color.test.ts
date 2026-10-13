import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BRAND_THEMES,
  brandCss,
  brandScopeClass,
  brandPalette,
  DEFAULT_PICKER_COLOR,
  isHexColor,
  MIN_CONTRAST,
  nearestPassing,
  normalizeHex,
} from "@/features/branding/color";
import { isOrgLogoPath, logoFileProblem, logoPublicUrl } from "@/features/branding/logo";
import { contrast } from "@/lib/contrast";

// FLD-04 / DSN-17: a business's colour is moved to the nearest shade that passes 4.5:1.

const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
function token(name: string, scope: string): string {
  const start = css.indexOf(`${scope} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1].trim() ?? "";
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? token(ref[1], ":root") : value;
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
}

const SAMPLES = [
  "#1e56d6", "#ffd400", "#ffffff", "#000000", "#00ff00", "#ff0000", "#e91e63", "#00bcd4", "#8bc34a",
  "#795548", "#9e9e9e", "#f4f6f8", "#161d26", "#0e131a", "#ff9800", "#673ab7", "#fefefe", "#010101", "#3f51b5", "#c0ffee",
];

describe("business colour", () => {
  it("reads #rgb and #rrggbb in any case, with or without #", () => {
    expect(normalizeHex("#1E56D6")).toBe("#1e56d6");
    expect(normalizeHex(" 1e56d6 ")).toBe("#1e56d6");
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    for (const bad of ["", "#12345", "#1234567", "red", "#ggg000", "rgb(0,0,0)", null, 5]) expect(normalizeHex(bad)).toBeNull();
    expect(isHexColor("#1e56d6")).toBe(true);
    expect(isHexColor("#1E56D6")).toBe(false);
  });

  it("the page colours it is checked against are the design tokens", () => {
    expect(BRAND_THEMES.light).toEqual({
      surface: token("--color-surface", "@theme"),
      canvas: token("--color-canvas", "@theme"),
      onAccent: token("--color-on-accent", "@theme"),
    });
    expect(BRAND_THEMES.dark).toEqual({
      surface: token("--color-surface", '[data-theme="dark"]'),
      canvas: token("--color-canvas", '[data-theme="dark"]'),
      onAccent: token("--color-on-accent", '[data-theme="dark"]'),
    });
    expect(DEFAULT_PICKER_COLOR).toBe(token("--color-accent", "@theme"));
  });

  describe.each(["light", "dark"] as const)("%s pages", (theme) => {
    const page = BRAND_THEMES[theme];
    it.each(SAMPLES)("%s: every pair the screens use passes 4.5:1", (color) => {
      const p = brandPalette(color, theme);
      const pairs: Array<[string, string]> = [
        [p.accent, page.surface],
        [p.accent, page.canvas],
        [p.accent, p.accentSoft],
        [p.accentStrong, page.surface],
        [p.accentStrong, page.canvas],
        [p.accentStrong, p.accentSoft],
        [p.onAccent, p.accent],
        [p.onAccent, p.accentStrong],
      ];
      for (const [a, b] of pairs) expect(contrast(a, b)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  });

  it("a colour that already passes is kept as it is", () => {
    const p = brandPalette("#1e56d6", "light");
    expect(p.accent).toBe("#1e56d6");
    expect(p.corrected).toBe(false);
    expect(brandPalette("#173f9e").accent).toBe("#173f9e");
  });

  it("a colour that fails moves to the nearest passing shade of the same hue", () => {
    const p = brandPalette("#ffd400", "light");
    expect(p.corrected).toBe(true);
    expect(Math.abs(hue(p.accent) - hue("#ffd400"))).toBeLessThan(0.05);
    // nearest: a slightly lighter shade of the result no longer passes against the page
    const others = [BRAND_THEMES.light.surface, BRAND_THEMES.light.canvas, p.accentSoft, BRAND_THEMES.light.onAccent];
    expect(nearestPassing("#ffd400", others, "darker")).toBe(p.accent);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(p.accent.slice(i, i + 2), 16));
    const lighter = `#${[r, g, b].map((v) => Math.min(255, v + 6).toString(16).padStart(2, "0")).join("")}`;
    expect(others.every((o) => contrast(lighter, o) >= MIN_CONTRAST)).toBe(false);
    // in dark mode the same colour passes as it is
    expect(brandPalette("#ffd400", "dark").accent).toBe("#ffd400");
  });

  it("the style sheet holds only the validated colours and the scope class", () => {
    const sheet = brandCss("#ffd400");
    expect(sheet).toMatch(/^\.mx-brand-ffd400\{--color-accent:#[0-9a-f]{6};/);
    expect(sheet).toContain("[data-theme=dark] .mx-brand-ffd400,.mx-brand-ffd400[data-theme=dark]{");
    expect(brandScopeClass("#FFD400")).toBe("mx-brand-ffd400");
    expect(sheet).toMatch(/^[a-z0-9#.:;,{}=[\]\- ]+$/);
    expect(() => brandCss("red;}body{display:none")).toThrow();
  });
});

describe("business logo", () => {
  const org = "11111111-2222-4333-8444-555555555555";
  const other = "99999999-2222-4333-8444-555555555555";
  const file = "66666666-7777-4888-8999-aaaaaaaaaaaa";

  it("a logo path is <organization>/<uuid> in the organization's own folder", () => {
    expect(isOrgLogoPath(`${org}/${file}`, org)).toBe(true);
    expect(isOrgLogoPath(`${other}/${file}`, org)).toBe(false);
    expect(isOrgLogoPath(`${org}/logo.png`, org)).toBe(false);
    expect(isOrgLogoPath(`${org}/${file}/x`, org)).toBe(false);
    expect(isOrgLogoPath(null, org)).toBe(false);
  });

  it("PNG, JPG or WebP, up to 1 MB, not empty; no SVG", () => {
    expect(logoFileProblem({ type: "image/png", size: 1024 })).toBeNull();
    expect(logoFileProblem({ type: "image/svg+xml", size: 1024 })).not.toBeNull();
    expect(logoFileProblem({ type: "image/webp", size: 1024 * 1024 + 1 })).not.toBeNull();
    expect(logoFileProblem({ type: "image/jpeg", size: 0 })).not.toBeNull();
  });

  it("the public address is built only from a valid path", () => {
    expect(logoPublicUrl(`${org}/${file}`, "https://x.supabase.co/")).toBe(`https://x.supabase.co/storage/v1/object/public/org-logos/${org}/${file}`);
    expect(logoPublicUrl("../../secret", "https://x.supabase.co")).toBeNull();
    expect(logoPublicUrl(null, "https://x.supabase.co")).toBeNull();
    expect(logoPublicUrl(`${org}/${file}`, null)).toBeNull();
  });
});
