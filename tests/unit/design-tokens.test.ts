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
  ["success", "success-soft"],
  ["on-brand", "brand"],
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("design tokens, %s", (_theme, vars) => {
  it.each(TEXT_PAIRS)("%s on %s: 4.5:1 or more", (text, background) => {
    const ratio = contrast(resolve(vars, `--color-${text}`), resolve(vars, `--color-${background}`));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("control borders stand out from the surface (3:1, WCAG 1.4.11)", () => {
    expect(contrast(resolve(vars, "--color-line-control"), resolve(vars, "--color-surface"))).toBeGreaterThanOrEqual(3);
  });
});

it("contrast is computed as WCAG defines it", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
});
