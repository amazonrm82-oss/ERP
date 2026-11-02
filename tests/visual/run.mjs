// Screenshot comparison of the main screens and the design gallery at 360px and 1280px (DSN-18).
// LOCAL ONLY (it signs up a sample business on the local Supabase stack, like tests/e2e/screens.mjs).
//
//   node tests/visual/run.mjs compare   photograph, compare with tests/visual/baseline/, exit 1 on a change
//   node tests/visual/run.mjs update    photograph and replace tests/visual/baseline/ with the new shots
//   node tests/visual/run.mjs compare --dry   no browser: list the shots and what would be compared
//
// With no baseline at all, `compare` only hands over the fresh shots (exit 0): the first
// baselines must come from CI, because the runner renders differently from a laptop.
// Output (VISUAL_OUT, default tests/visual/out): actual/ every shot, diff/ red marks on what
// changed, expected/ the baseline of each changed shot, summary.md.
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { comparePngBuffers, DEFAULTS, planComparison, verdict } from "./compare.mjs";
import { MASK, MASK_PATTERNS, STABLE_CSS, stabilizePage } from "./stabilize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(process.env.VISUAL_BASELINE ?? join(HERE, "baseline"));
const OUT = resolve(process.env.VISUAL_OUT ?? join(HERE, "out"));
export const WIDTHS = [360, 1280];

// The sample business's screens (tests/e2e/sample.mjs sampleScreens) and the design gallery.
export const SCREEN_NAMES = [
  "home", "leads", "leads-board", "lead", "deals", "deal", "tasks", "calendar", "contacts", "contact",
  "companies", "setup", "settings", "settings-business", "login", "onboarding", "design-gallery",
];

// Extra things hidden on one screen when masking text is not enough (CSS selectors).
// Add one here, with the reason, rather than raising a threshold.
const HIDE = {};

const mode = process.argv[2];
const dry = process.argv.includes("--dry");
if (mode !== "compare" && mode !== "update") {
  console.error("usage: node tests/visual/run.mjs compare|update [--dry]");
  process.exit(2);
}

async function pngs(dir) {
  return existsSync(dir) ? (await readdir(dir)).filter((n) => n.endsWith(".png")).sort() : [];
}

const shotNames = SCREEN_NAMES.flatMap((s) => WIDTHS.map((w) => `${s}-${w}.png`));

if (dry) {
  const plan = planComparison(await pngs(BASELINE), shotNames);
  console.log(`mode: ${mode}; ${shotNames.length} shots (${SCREEN_NAMES.length} screens x ${WIDTHS.join("/")}px)`);
  console.log(`baseline: ${BASELINE}`);
  if (plan.seed) console.log("no baseline yet: compare would only hand over fresh shots");
  console.log(`compare: ${plan.pairs.length}, new: ${plan.added.length}, gone: ${plan.removed.length}`);
  console.log(`threshold: a channel moves > ${DEFAULTS.channelTolerance}/255; fail above ${(DEFAULTS.maxDiffRatio * 100).toFixed(2)}% of pixels`);
  process.exit(0);
}

const { chromium } = await import("playwright");
const { APP, createSample, createStaff, refuseRemote, sampleScreens, signIn } = await import("../e2e/sample.mjs");
refuseRemote("the screenshot comparison");

await rm(OUT, { recursive: true, force: true });
for (const d of ["actual", "diff", "expected"]) await mkdir(join(OUT, d), { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
  env: { ...process.env, LANG: process.env.LANG || "C.UTF-8" },
  // the same rendering on every run: no GPU, sRGB, no font hinting differences between runs
  args: ["--disable-gpu", "--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text"],
});

async function newPage(width) {
  const context = await browser.newContext({
    viewport: { width, height: 800 },
    deviceScaleFactor: 1,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  return context.newPage();
}

async function photograph(page, name, width) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.evaluate(stabilizePage, { css: STABLE_CSS, patterns: MASK_PATTERNS, mask: MASK, hide: HIDE[name] ?? [] });
  // two frames: the masked text is laid out before the picture is taken
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const file = join(OUT, "actual", `${name}-${width}.png`);
  // caret: "initial": the caret is already hidden by STABLE_CSS, injected after hydration
  await page.screenshot({ path: file, fullPage: true, animations: "disabled", caret: "initial" });
  return file;
}

// Each screen as a function that opens it on a page of the given width and photographs it,
// so a shot that differs can be taken again once (a late request, not a real change).
const takers = new Map();
const setup = await newPage(1280);
const sample = await createSample(setup);
await setup.context().close();
const staffSetup = await newPage(1280);
await createStaff(staffSetup);
const staffCookies = await staffSetup.context().cookies();
await staffSetup.context().close();
const paths = await sampleScreens(sample.orgId);
const listed = [...Object.keys(paths), "design-gallery"].sort().join(",");
if (listed !== [...SCREEN_NAMES].sort().join(",")) throw new Error(`SCREEN_NAMES is out of step with sampleScreens(): ${listed}`);

for (const width of WIDTHS) {
  const owner = await newPage(width);
  await signIn(owner, sample.email);
  const staff = await newPage(width);
  await staff.context().addCookies(staffCookies);
  for (const name of SCREEN_NAMES) {
    const take = async () => {
      if (name === "design-gallery") {
        await staff.goto(`${APP}/admin/design`);
        await staff.getByText("כל הרכיבים המשותפים").first().waitFor();
        return photograph(staff, name, width);
      }
      const path = paths[name];
      if (!path) throw new Error(`no path for screen ${name}`);
      if (name === "login") await owner.context().clearCookies();
      await owner.goto(`${APP}${path}`);
      const file = await photograph(owner, name, width);
      if (name === "login") await signIn(owner, sample.email);
      return file;
    };
    await take();
    takers.set(`${name}-${width}.png`, take);
  }
}

const summary = [];
let exitCode = 0;
if (mode === "update") {
  await mkdir(BASELINE, { recursive: true });
  const plan = planComparison(await pngs(BASELINE), shotNames);
  for (const gone of plan.removed) await rm(join(BASELINE, gone));
  for (const name of shotNames) await copyFile(join(OUT, "actual", name), join(BASELINE, name));
  summary.push(`## Screenshots: baselines refreshed`, "", `${shotNames.length} shots written to \`${BASELINE}\` and \`${join(OUT, "actual")}\`.`);
  if (plan.removed.length) summary.push("", `Removed: ${plan.removed.join(", ")}`);
} else {
  const plan = planComparison(await pngs(BASELINE), shotNames);
  if (plan.seed) {
    summary.push(
      "## Screenshots: no baseline yet",
      "",
      `Nothing was compared. The ${shotNames.length} fresh shots are in the artifact (\`actual/\`):`,
      "copy them into `tests/visual/baseline/` and commit (tests/visual/README.md).",
    );
    console.log(`::warning::no screenshot baseline in tests/visual/baseline: nothing compared; fresh shots handed over`);
  } else {
    const results = [];
    for (const name of plan.pairs) {
      const expected = await readFile(join(BASELINE, name));
      let result = comparePngBuffers(expected, await readFile(join(OUT, "actual", name)));
      if (!result.ok) {
        // once more: a late font, image or request is not a change in appearance
        await takers.get(name)();
        result = comparePngBuffers(expected, await readFile(join(OUT, "actual", name)));
      }
      results.push({ name, ...result });
      if (!result.ok) {
        if (result.diffPng) await writeFile(join(OUT, "diff", name), result.diffPng);
        await copyFile(join(BASELINE, name), join(OUT, "expected", name));
      }
    }
    const { ok, failed } = verdict(plan, results);
    summary.push(`## Screenshots: ${ok ? "no change" : `${failed.length} changed`}`, "");
    summary.push("| shot | differing pixels | size |", "| --- | --- | --- |");
    for (const r of results) {
      const size = r.sizeMismatch ? `${r.baselineSize} -> ${r.actualSize}` : r.actualSize;
      summary.push(`| ${r.ok ? "" : "**"}${r.name}${r.ok ? "" : "**"} | ${(r.ratio * 100).toFixed(3)}% (${r.diffPixels}) | ${size} |`);
    }
    for (const n of plan.added) {
      summary.push(`| ${n} | new, no baseline | |`);
      console.log(`::warning::${n} has no baseline yet; refresh the baselines (tests/visual/README.md)`);
    }
    for (const n of plan.removed) console.log(`::warning::baseline ${n} has no screen any more; refresh the baselines`);
    if (!ok) {
      exitCode = 1;
      summary.push(
        "",
        "An unexpected change in appearance. The artifact holds `actual/`, `expected/` and `diff/` (red = changed).",
        "If the change is intended, refresh the baselines (tests/visual/README.md).",
      );
      for (const r of failed) {
        const why = r.sizeMismatch ? `size ${r.baselineSize} -> ${r.actualSize}` : `${(r.ratio * 100).toFixed(3)}% of pixels`;
        console.log(`::error::screenshot ${r.name} changed: ${why}`);
      }
    }
  }
}

await browser.close();
const text = summary.join("\n") + "\n";
await writeFile(join(OUT, "summary.md"), text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
console.log(text);
process.exitCode = exitCode;
