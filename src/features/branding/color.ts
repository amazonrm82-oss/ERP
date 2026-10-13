// FLD-04 / DSN-17: the business's own colour on the pages its customers see.
// The colour as picked is stored; where it is shown it becomes a palette of the
// design system's accent roles, each shade moved (lightness only, same hue and
// saturation) to the nearest one that meets WCAG AA 4.5:1 against every
// background and text it meets on the page. Pure: used on the server for the
// public pages, in the browser for the settings preview, and later for emails
// and PDF documents (brandPalette(color, "light")).

import { contrast } from "@/lib/contrast";

export const MIN_CONTRAST = 4.5;

const HEX = /^#[0-9a-f]{6}$/;

/** "#1E56D6", "1e56d6", "#abc" -> "#1e56d6" / "#aabbcc"; anything else -> null. */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (!value.startsWith("#")) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) value = `#${[...value.slice(1)].map((c) => c + c).join("")}`;
  return HEX.test(value) ? value : null;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

type Hsl = { h: number; s: number; l: number };

function toHsl(hex: string): Hsl {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h / 6, s, l };
}

function toHex({ h, s, l }: Hsl): string {
  const channel = (t: number) => {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const values = s === 0 ? [l, l, l] : [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
  return `#${values.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function withLightness(hex: string, l: number): string {
  return toHex({ ...toHsl(hex), l: Math.min(1, Math.max(0, l)) });
}

function passes(hex: string, others: readonly string[], min: number): boolean {
  return others.every((other) => contrast(hex, other) >= min);
}

/**
 * The shade of `hex` nearest to it (same hue and saturation, lightness moved
 * one way only) that has `min` contrast with every colour in `others`.
 * "darker" for light pages, "lighter" for dark ones. A colour that already
 * passes comes back unchanged.
 */
export function nearestPassing(
  hex: string,
  others: readonly string[],
  direction: "darker" | "lighter",
  min: number = MIN_CONTRAST,
): string {
  if (passes(hex, others, min)) return hex;
  const start = toHsl(hex).l;
  // lightness moves every channel the same way, so contrast with a fixed
  // colour changes monotonically along the search: a binary search finds the edge
  let pass = direction === "darker" ? 0 : 1;
  let fail = start;
  for (let i = 0; i < 24; i++) {
    const mid = (pass + fail) / 2;
    if (passes(withLightness(hex, mid), others, min)) pass = mid;
    else fail = mid;
  }
  let result = withLightness(hex, pass);
  // rounding to whole channels can land just under the line: step on until it passes
  for (let step = 1; !passes(result, others, min) && step <= 100; step++) {
    result = withLightness(hex, direction === "darker" ? pass - step / 255 : pass + step / 255);
  }
  return result;
}

/** Where the colour picker starts when no colour is set: the design system's accent (--mx-blue-600). */
export const DEFAULT_PICKER_COLOR = "#1e56d6";

export type BrandTheme = "light" | "dark";

/**
 * The page colours the accent meets, per theme. They mirror the design tokens
 * in src/app/globals.css (surface, canvas, on-accent); tests/unit/brand-color.test.ts
 * reads that file and fails when the two drift apart.
 */
export const BRAND_THEMES: Record<BrandTheme, { surface: string; canvas: string; onAccent: string }> = {
  light: { surface: "#ffffff", canvas: "#f4f6f8", onAccent: "#ffffff" },
  dark: { surface: "#161d26", canvas: "#0e131a", onAccent: "#0e131a" },
};

export type BrandPalette = {
  /** the colour as picked */
  picked: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  onAccent: string;
  /** true when accent is not the picked colour (it was moved to pass contrast) */
  corrected: boolean;
};

/**
 * The design system's accent roles in the business's colour, every pair the
 * screens use at 4.5:1 or more (the same pairs as tests/unit/design-tokens.test.ts):
 * accent and accent-strong on surface, canvas and accent-soft, and on-accent on both.
 */
export function brandPalette(color: string, theme: BrandTheme = "light"): BrandPalette {
  const picked = normalizeHex(color);
  if (!picked) throw new Error(`not a colour: ${color}`);
  const page = BRAND_THEMES[theme];
  const { h, s } = toHsl(picked);
  const light = theme === "light";
  // a pale (or, in dark mode, deep) tint of the same hue, like accent-soft in the tokens
  const accentSoft = toHex({ h, s: light ? Math.min(s, 0.85) : Math.min(s, 0.45), l: light ? 0.95 : 0.19 });
  const others = [page.surface, page.canvas, accentSoft, page.onAccent];
  const direction = light ? "darker" : "lighter";
  const accent = nearestPassing(picked, others, direction);
  const step = light ? -0.1 : 0.1;
  const accentStrong = nearestPassing(withLightness(accent, toHsl(accent).l + step), others, direction);
  return { picked, accent, accentStrong, accentSoft, onAccent: page.onAccent, corrected: accent !== picked };
}

/** CSS custom properties that put the palette in place of the accent roles. */
export function brandVars(palette: BrandPalette): Record<string, string> {
  return {
    "--color-accent": palette.accent,
    "--color-accent-strong": palette.accentStrong,
    "--color-accent-soft": palette.accentSoft,
    "--color-on-accent": palette.onAccent,
  };
}

/**
 * The class a branded part of a page carries. It is named after the colour, so
 * two parts in different colours on one page (the design gallery) never clash,
 * and two in the same colour share the same rules.
 */
export function brandScopeClass(color: string): string {
  const hex = normalizeHex(color);
  if (!hex) throw new Error(`not a colour: ${color}`);
  return `mx-brand-${hex.slice(1)}`;
}

/**
 * A style sheet for one branded part of a page: the light palette on its class,
 * the dark one when the element or a parent carries data-theme="dark". Only a
 * validated "#rrggbb" reaches the output, so it is safe to put in a <style>.
 */
export function brandCss(color: string): string {
  const block = (theme: BrandTheme) =>
    Object.entries(brandVars(brandPalette(color, theme)))
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
  const c = brandScopeClass(color);
  return `.${c}{${block("light")}}[data-theme=dark] .${c},.${c}[data-theme=dark]{${block("dark")}}`;
}
