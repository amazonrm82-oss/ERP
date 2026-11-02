// Screenshots of the main screens with sample data, at 360px and 1280px, for the
// design pass (DSN-14: "before" and "after" of every screen). LOCAL ONLY.
//   node tests/e2e/screens.mjs <out-dir> [screen ...]
// E2E_SHOTS_VIEWPORT=1 photographs only the first screen (for the landing page, LND-02).
// The first run signs up a sample business and fills it with data (tests/e2e/sample.mjs); its
// address is kept in <out-dir>/../screens-state.json, so later runs photograph the same data.
// The comparison of these screens on every push is tests/visual/run.mjs (DSN-18).
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { chromium } from "playwright";

import { APP, createSample, refuseRemote, sampleScreens, signIn, sql } from "./sample.mjs";

refuseRemote("this script");

const [outDir, ...only] = process.argv.slice(2);
if (!outDir) throw new Error("usage: node tests/e2e/screens.mjs <out-dir> [screen ...]");
const stateFile = join(dirname(outDir), "screens-state.json");

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined });

async function newPage(width) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, locale: "he-IL" });
  return context.newPage();
}

await mkdir(outDir, { recursive: true });
let state = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : null;
if (state) {
  const [row] = await sql("select 1 from public.organizations where id = $1", [state.orgId]);
  if (!row) state = null;
}
if (!state) {
  const page = await newPage(1280);
  state = await createSample(page);
  await page.context().close();
  await writeFile(stateFile, JSON.stringify(state));
}

const SCREENS = await sampleScreens(state.orgId);
const names = only.length ? only : Object.keys(SCREENS);
for (const width of [360, 1280]) {
  const page = await newPage(width);
  await signIn(page, state.email);
  for (const name of names) {
    const path = SCREENS[name];
    if (!path) throw new Error(`unknown screen ${name}`);
    if (name === "login") await page.context().clearCookies();
    await page.goto(`${APP}${path}`);
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: join(outDir, `${name}-${width}.png`), fullPage: !process.env.E2E_SHOTS_VIEWPORT, caret: "initial" });
    if (name === "login") await signIn(page, state.email);
  }
  await page.context().close();
}
await browser.close();
console.log(`screens: ${names.length} x 2 widths -> ${outDir}`);
