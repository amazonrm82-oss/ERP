import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { contrast } from "@/lib/contrast";

// DSN-04 / DSN-05: every text-on-background pair the screens use meets 4.5:1,
// in light and in dark, read from the one place the values live (globals.css).
const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const base = block(":root");
const light = block("@theme");
const dark = { ...light, ...block('[data-theme="dark"]') };

function resolve(vars: Record<string, string>, name: string): string {
  let value = vars[name] ?? base[name];
  for (let i = 0; value?.startsWith("var("); i++) value = base[value.slice(4, -1)] ?? vars[value.slice(4, -1)];
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name}: not a colour (${value})`);
  return value;
}

// [text, background]
const TEXT_PAIRS: Array<[string, string]> = [
  ["ink", "surface"],
  ["ink", "canvas"],
  ["ink-soft", "surface"],
  ["ink-soft", "canvas"],
  ["accent", "surface"],
  ["accent", "canvas"],
  ["accent-strong", "accent-soft"],
  // empty-state drawings (DSN-10)
  ["accent", "accent-soft"],
  ["accent-strong", "surface"],
  ["on-accent", "accent"],
  ["on-accent", "accent-strong"],
  ["on-accent", "danger"],
  ["on-accent", "danger-strong"],
  ["danger", "surface"],
  ["danger", "danger-soft"],
  ["warning", "warning-soft"],
  // warning text on a card or the page (waiting clock, notices)
  ["warning", "surface"],
  ["warning", "canvas"],
  ["success", "success-soft"],
  ["on-brand", "brand"],
];

// DSN-13: chart marks against what they sit on (3:1, WCAG 1.4.11 non-text contrast): their track, a card, the page
const CHART_MARKS = ["chart-bar", "chart-done", "chart-alert"];
const CHART_GROUNDS = ["chart-track", "surface", "canvas"];
const MARK_PAIRS: Array<[string, string]> = CHART_MARKS.flatMap((mark) => CHART_GROUNDS.map((ground) => [mark, ground] as [string, string]));

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("design tokens, %s", (_theme, vars) => {
  it.each(TEXT_PAIRS)("%s on %s: 4.5:1 or more", (text, background) => {
    const ratio = contrast(resolve(vars, `--color-${text}`), resolve(vars, `--color-${background}`));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARK_PAIRS)("chart mark %s on %s: 3:1 or more", (mark, ground) => {
    expect(contrast(resolve(vars, `--color-${mark}`), resolve(vars, `--color-${ground}`))).toBeGreaterThanOrEqual(3);
  });

  it("control borders stand out from the surface (3:1, WCAG 1.4.11)", () => {
    expect(contrast(resolve(vars, "--color-line-control"), resolve(vars, "--color-surface"))).toBeGreaterThanOrEqual(3);
  });
});

// Owner's answers 240 and 251: the logo is two SVGs (src/assets/mexuz-logo.svg, -dark.svg), the dark one shown under
// data-theme="dark". Every fill stands out 3:1 (non-text) from the card and the page of its theme, and the dark file's
// light part is the dark ink.
const svgFills = (file: string) =>
  [...readFileSync(new URL(`../../src/assets/${file}`, import.meta.url), "utf8").matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1]);
describe("logo", () => {
  it.each([
    ["mexuz-logo.svg", light],
    ["mexuz-logo-dark.svg", dark],
  ] as const)("%s: every fill 3:1 against surface and canvas", (file, vars) => {
    const fills = svgFills(file);
    expect(fills.length).toBeGreaterThanOrEqual(1);
    for (const fill of fills)
      for (const ground of ["surface", "canvas"]) expect(contrast(fill, resolve(vars, `--color-${ground}`))).toBeGreaterThanOrEqual(3);
  });
  it("the dark logo's light part is the dark ink", () => {
    expect(svgFills("mexuz-logo-dark.svg")).toContain(resolve(dark, "--color-ink"));
  });
});

it("contrast is computed as WCAG defines it", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
});
