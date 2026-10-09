// End-to-end check of the main path, in a real browser, against a LOCAL stack:
//   npx supabase start                      (Docker; uses supabase/config.toml)
//   npm run dev with the local URL and publishable key in .env.local
//   npm run test:e2e
// sign up -> confirm email (read from the local Mailpit inbox) -> create the
// business -> lead -> note -> convert -> deal board -> settings -> invite a
// second user -> they sign up from the link and join -> roles, teams, suspend.
// It refuses to run against anything that is not on this machine.
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import pg from "pg";
import { chromium } from "playwright";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3000";
const MAIL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
// the local Supabase database: used only to make a test user platform staff
const DB = process.env.E2E_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
for (const url of [APP, MAIL, DB.replace(/^postgresql:/, "http:")]) {
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error(`Refusing to run against ${url}: the end-to-end test creates accounts and only runs locally.`);
  }
}
const SHOTS = process.env.E2E_SHOTS_DIR ?? "";
const run = Date.now().toString(36);
const ownerEmail = `owner-${run}@example.test`;
const inviteeEmail = `dana-${run}@example.test`;
const PASSWORD = "Test-pass-12345";
const errors = [];

// E2E_CHROMIUM_PATH: use an already installed Chromium instead of `npx playwright install`
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined });

function step(name) {
  console.log(`\n== ${name}`);
}

// RFC 6238 code from a base32 secret, as an authenticator app computes it
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// a TOTP code from a time step not used before in this run (servers refuse a code twice)
let lastTotpStep = 0;
async function freshTotp(secret) {
  while (Math.floor(Date.now() / 30000) <= lastTotpStep) await new Promise((r) => setTimeout(r, 1000));
  lastTotpStep = Math.floor(Date.now() / 30000);
  return totp(secret);
}

// the link in the newest email to the address whose subject contains `subject`
async function mailLink(email, subject) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:${subject}`)}`);
    const list = await res.json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${list.messages[0].ID}`)).json();
      const match = (msg.Text ?? msg.HTML).match(/https?:\/\/[^\s"<>)]+verify[^\s"<>)]+/);
      if (match) return match[0].replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no "${subject}" email for ${email}`);
}

async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

// screenshots only when E2E_SHOTS_DIR is set
async function shot(page, name) {
  // caret: "initial": the default ("hide") injects a style into inputs, which React
  // reports as a hydration mismatch when the shot is taken before hydration ends
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, caret: "initial" });
}

async function confirmationLink(email) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const list = await res.json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${list.messages[0].ID}`)).json();
      const match = (msg.Text ?? msg.HTML).match(/https?:\/\/[^\s"<>)]+verify[^\s"<>)]+/);
      if (match) return match[0].replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no confirmation email for ${email}`);
}

async function newPage(width) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, locale: "he-IL" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  return page;
}

async function expectText(page, text) {
  // visible only: the same text may also sit in a collapsed change history
  await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 15000 });
}

async function signUp(page, name, email, startUrl) {
  await page.goto(startUrl);
  if (!page.url().includes("/signup")) {
    await page.getByRole("link", { name: "הרשמה" }).click();
    await page.waitForURL(/\/signup/);
  }
  await page.getByLabel("שם מלא").fill(name);
  await page.getByLabel("אימייל").fill(email);
  await page.getByLabel("סיסמה").fill(PASSWORD);
  await page.getByRole("button", { name: "יצירת חשבון" }).click();
  await expectText(page, "שלחנו הודעת אימות");
  const link = await confirmationLink(email);
  await page.goto(link);
  await page.waitForLoadState("networkidle");
  await signAgreement(page, name, firstSigner);
  firstSigner = false;
}

// every new user signs the agreement before anything else; the first one draws, the rest type
let firstSigner = true;
async function signAgreement(page, name, draw) {
  await page.waitForURL(/\/agreement/);
  await page.getByRole("heading", { name: /חתימה על ההסכם/ }).waitFor();
  await page.waitForLoadState("networkidle");
  if (draw) {
    await page.locator("canvas").scrollIntoViewIfNeeded();
    const box = await page.locator("canvas").boundingBox();
    await page.mouse.move(box.x + 20, box.y + 100);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 18, box.y + 100 - (i % 2) * 50);
    await page.mouse.up();
    await expectText(page, "נחתם");
    await shot(page, "05a-agreement-sign-360");
  } else {
    await page.getByRole("radio", { name: "הקלדת שם" }).click();
  }
  // nothing is signed without the consent box
  await page.getByRole("button", { name: "חתימה והמשך" }).click();
  await expectText(page, "יש לסמן שקראתם ואתם מסכימים");
  await page.getByLabel(/קראתי את תנאי השימוש/).check();
  await page.getByRole("button", { name: "חתימה והמשך" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/agreement"), { timeout: 15000 });
  console.log(`${name} signed the agreement (${draw ? "drawn" : "typed"})`);
}

try {
  // ---------------------------------------------------------------- owner, phone width
  const owner = await newPage(360);

  step("signup + confirm email");
  await signUp(owner, "רונית בעלים", ownerEmail, `${APP}/signup`);
  console.log("after confirm:", owner.url());
  await owner.waitForURL(/\/onboarding/, { timeout: 15000 });
  await shot(owner, "01-onboarding-360");

  step("create organization");
  await owner.getByLabel("שם העסק").fill("שיפוצים בע\"מ");
  await owner.getByRole("button", { name: "יצירת העסק והמשך" }).click();
  await owner.waitForURL(/\/o\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const orgUrl = owner.url();
  console.log("org:", orgUrl);
  await shot(owner, "02-home-360");

  step("landing page: public for visitors, straight into the app when signed in (LND-01, LND-06)");
  {
    const visitor = await newPage(360);
    await visitor.goto(`${APP}/`);
    if (new URL(visitor.url()).pathname !== "/") throw new Error(`a visitor was sent away from the landing page: ${visitor.url()}`);
    await visitor.getByRole("link", { name: "כניסה", exact: true }).waitFor();
    // what the system does, from the catalog; only what works is listed as available (LND-03, LND-04)
    await visitor.getByRole("heading", { name: "כל מה שיש במערכת" }).waitFor();
    await visitor.getByRole("heading", { name: "בקרוב" }).waitFor();
    // search engines: the landing page yes, the app and the sign-in screens no (LND-11)
    if ((await visitor.locator('meta[name="robots"]').getAttribute("content")) !== "index, follow") throw new Error("the landing page is not open to search engines");
    const robotsTxt = await (await visitor.context().request.get(`${APP}/robots.txt`)).text();
    if (!robotsTxt.includes("Disallow: /o/") || !robotsTxt.includes("Disallow: /login")) throw new Error(`robots.txt: ${robotsTxt}`);
    // the header (sign-in and sign-up) stays in view while scrolling on a phone (LND-05)
    await visitor.mouse.wheel(0, 2000);
    await visitor.getByRole("navigation", { name: "כניסה והרשמה" }).getByRole("link", { name: "הרשמה", exact: true }).click();
    await visitor.waitForURL(/\/signup/);
    if ((await visitor.locator('meta[name="robots"]').getAttribute("content")) !== "noindex, nofollow") throw new Error("the sign-up screen is open to search engines");
    await visitor.close();
    await owner.goto(`${APP}/`);
    // one business: /app sends on to it
    await owner.waitForURL(/\/o\/[0-9a-f-]{36}$/, { timeout: 15000 });
    const manifest = await (await owner.context().request.get(`${APP}/manifest.webmanifest`)).json();
    if (manifest.start_url !== "/app" || manifest.id !== "/") throw new Error(`manifest: start ${manifest.start_url}, id ${manifest.id}`);
  }

  step("create lead");
  await owner.goto(`${orgUrl}/leads/new`);
  await owner.getByLabel("שם מלא").fill("משה כהן");
  await owner.getByLabel("טלפון").fill("050-1234567");
  await owner.getByLabel("חברה").fill("כהן ובניו");
  await owner.getByRole("button", { name: "יצירת ליד" }).click();
  await owner.waitForURL(/\/leads\/[0-9a-f-]{36}$/, { timeout: 15000 });

  step("add note");
  await owner.getByLabel("סוג הפעילות").selectOption({ label: "שיחה" });
  await owner.getByLabel("תיעוד").fill("דיברנו בטלפון, מעוניין בהצעה");
  await owner.getByRole("button", { name: "הוספה לציר הזמן" }).click();
  await expectText(owner, "דיברנו בטלפון, מעוניין בהצעה");

  step("convert lead");
  await owner.getByRole("button", { name: "המר לאיש קשר ועסקה" }).click();
  await owner.getByLabel("שווי העסקה (₪)").fill("12,500");
  await owner.getByRole("button", { name: "המרה", exact: true }).click();
  await expectText(owner, "הומר");
  await shot(owner, "03-lead-converted-360");

  step("deal board");
  await owner.goto(`${orgUrl}/deals`);
  await expectText(owner, "12,500");
  await shot(owner, "04-deals-360");

  step("phone: 'עוד' in the bottom bar reaches every screen; settings are one list in groups (DSN-11, FXU-13)");
  await owner.getByRole("navigation", { name: "ניווט ראשי" }).getByRole("button", { name: "עוד" }).click();
  const more = owner.getByRole("dialog", { name: "עוד" });
  for (const label of ["אנשי קשר", "חברות", "דוחות", "הגדרות", "התראות"]) await more.getByRole("link", { name: label }).waitFor();
  await shot(owner, "04a-more-360");
  await more.getByRole("link", { name: "הגדרות" }).click();
  await owner.waitForURL(/\/settings$/);
  for (const group of ["העסק", "התאמה אישית", "לידים ואוטומציות", "נתונים"]) await owner.getByRole("heading", { name: group }).waitFor();
  await shot(owner, "04b-settings-list-360");
  if (await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("settings list scrolls sideways at 360px");

  step("phone: every panel that opens from a button stays inside a 360px screen (FXA-01)");
  // the panel is the element the button controls (aria-controls)
  const panelInside = async (button, name) => {
    await button.click();
    const id = await button.getAttribute("aria-controls");
    const box = await owner.locator(`[id="${id}"]`).boundingBox();
    console.log(`${name} at 360px:`, box && { x: Math.round(box.x), width: Math.round(box.width) });
    if (!box || box.x < 0 || box.x + box.width > 360) throw new Error(`${name} runs off a 360px screen`);
    // Escape closes it and focus is back on the button
    await owner.keyboard.press("Escape");
    if ((await button.getAttribute("aria-expanded")) !== "false") throw new Error(`Escape did not close ${name}`);
  };
  await owner.goto(`${orgUrl}/leads`);
  await panelInside(owner.getByRole("button", { name: /התראות/ }).first(), "bell");
  await owner.getByRole("button", { name: "סינון ותצוגה" }).click();
  await panelInside(owner.getByRole("button", { name: "סינון מתקדם", exact: true }), "advanced filter");
  await panelInside(owner.getByRole("button", { name: "עמודות", exact: true }), "columns");
  {
    // export is a <details>: its panel is the element after the summary
    const exportMenu = owner.locator("details", { has: owner.getByText("ייצוא", { exact: true }) }).first();
    await exportMenu.locator("summary").click();
    const box = await exportMenu.locator("summary + div").boundingBox();
    console.log("export at 360px:", box && { x: Math.round(box.x), width: Math.round(box.width) });
    if (!box || box.x < 0 || box.x + box.width > 360) throw new Error("export runs off a 360px screen");
    await exportMenu.locator("summary").click();
  }
  await panelInside(owner.getByRole("button", { name: /רונית בעלים/ }), "user menu");
  await owner.goto(`${orgUrl}/settings`);

  step("settings: business details");
  await owner.getByRole("link", { name: /פרטי העסק/ }).click();
  await owner.waitForURL(/\/settings\/business$/);
  await owner.getByRole("link", { name: "הגדרות" }).first().waitFor();
  await owner.getByLabel("טלפון העסק").fill("03-5551234");
  await owner.getByText("לפי צוות").click();
  await owner.getByRole("button", { name: "שמירה" }).click();
  await expectText(owner, "פרטי העסק נשמרו");
  await shot(owner, "05-settings-360");
  await owner.reload();
  const checked = await owner.locator('input[name="record_visibility"]:checked').getAttribute("value");
  console.log("visibility after reload:", checked);
  if (checked !== "team") throw new Error("record_visibility not saved");

  step("settings: invite");
  await owner.goto(`${orgUrl}/settings/users`);
  await owner.getByLabel("אימייל").fill(inviteeEmail);
  await owner.getByLabel("תפקיד").selectOption("member");
  await owner.getByRole("button", { name: "יצירת קישור הזמנה" }).click();
  await expectText(owner, "ההזמנה ל-");
  const inviteLink = await owner.getByLabel("קישור ההזמנה").inputValue();
  console.log("invite link:", inviteLink.replace(/[0-9a-f]{64}$/, "<token>"));
  await shot(owner, "06-invite-link-360");
  await owner.getByRole("button", { name: "הזמנה נוספת" }).click();
  await expectText(owner, "הזמנות ממתינות (1)");

  // ---------------------------------------------------------------- invitee, desktop width
  step("invitee: open link signed out -> signup -> confirm -> accept");
  const invitee = await newPage(1280);
  await invitee.goto(inviteLink);
  console.log("signed-out invite goes to:", invitee.url().replace(/[0-9a-f]{64}/, "<token>"));
  await signUp(invitee, "דנה חברה", inviteeEmail, invitee.url());
  console.log("after confirm:", invitee.url().replace(/[0-9a-f]{64}/, "<token>"));
  await invitee.waitForURL(/\/invite\//, { timeout: 15000 });
  // the business name and the role are there before joining
  await invitee.getByRole("heading", { name: /הזמנה להצטרף לשיפוצים/ }).waitFor();
  await expectText(invitee, "משתמש");
  await shot(invitee, "07-invite-accept-1280");
  await invitee.getByRole("button", { name: "הצטרפות לעסק" }).click();
  await invitee.waitForURL(/\/o\/[0-9a-f-]{36}$/, { timeout: 15000 });
  if (!invitee.url().startsWith(orgUrl)) throw new Error("joined a different org?");
  await invitee.goto(`${orgUrl}/settings/users`);
  await shot(invitee, "08-users-as-member-1280");
  const inviteeSeesInvite = await invitee.getByText("הזמנת משתמש").count();
  console.log("member sees invite form:", inviteeSeesInvite);

  step("invite link opened again by the member -> already in");
  await invitee.goto(inviteLink);
  await expectText(invitee, "כבר יש לך גישה לעסק הזה");
  if (await invitee.getByRole("button", { name: "הצטרפות לעסק" }).count()) throw new Error("a used invitation still offers to join");

  // ---------------------------------------------------------------- owner manages, desktop
  step("owner: change role, team, suspend");
  const ownerDesk = await newPage(1280);
  await ownerDesk.goto(`${APP}/login`);
  await ownerDesk.getByLabel("אימייל").fill(ownerEmail);
  await ownerDesk.getByLabel("סיסמה").fill(PASSWORD);
  await ownerDesk.getByRole("button", { name: "כניסה" }).click();
  await ownerDesk.waitForURL(/\/o\//);

  step("PWA: manifest, and the install item appears when the browser offers installation");
  const manifest = await (await ownerDesk.request.get(`${APP}/manifest.webmanifest`)).json();
  if (manifest.name !== "Mexuz" || manifest.display !== "standalone" || manifest.icons.length < 3) throw new Error("bad manifest");
  await ownerDesk.waitForLoadState("networkidle");
  const menuButton = ownerDesk.getByRole("button", { name: /רונית בעלים/ });
  await menuButton.click();
  if (await ownerDesk.getByRole("button", { name: "התקנת האפליקציה" }).count()) throw new Error("install item shown without an offer");
  await menuButton.click();
  await ownerDesk.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = async () => { window.__installPrompted = true; };
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(event);
  });
  await menuButton.click();
  await ownerDesk.getByRole("button", { name: "התקנת האפליקציה" }).click();
  if (!(await ownerDesk.evaluate(() => window.__installPrompted === true))) throw new Error("install prompt not shown");
  await ownerDesk.keyboard.press("Escape");

  step("help center and legal pages open without signing in");
  const anon = await newPage(360);
  await anon.goto(`${APP}/help`);
  await anon.getByLabel("חיפוש במרכז העזרה").fill("אקסל");
  await anon.getByRole("link", { name: "ייבוא לידים ואנשי קשר מאקסל" }).first().click(); // the search result comes first
  await anon.waitForURL(/\/help\/import$/);
  await expectText(anon, "ביטול ייבוא");
  await anon.goto(`${APP}/legal/accessibility`);
  await expectText(anon, "הנוסח ייבדק על ידי עורך דין");
  if (new URL(anon.url()).pathname !== "/legal/accessibility") throw new Error("legal page redirected");
  await shot(anon, "pwa-help-legal-360");
  await anon.context().close();

  await ownerDesk.goto(`${orgUrl}/settings/users`);
  await ownerDesk.getByLabel("תפקיד של דנה חברה").selectOption("manager");
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await ownerDesk.locator("span", { hasText: /^מנהל צוות$/ }).first().waitFor({ timeout: 15000 });
  await shot(ownerDesk, "09-users-owner-1280");

  await ownerDesk.goto(`${orgUrl}/settings/teams`);
  await ownerDesk.getByLabel("שם הצוות").fill("צוות מכירות");
  await ownerDesk.getByRole("button", { name: "יצירת צוות" }).click();
  await ownerDesk.waitForURL(/\/settings\/teams\/[0-9a-f-]{36}$/);
  await ownerDesk.getByRole("combobox", { name: "משתמש" }).selectOption({ label: "דנה חברה" });
  await ownerDesk.getByLabel(/מנהל הצוות/).check();
  await ownerDesk.getByRole("button", { name: "הוספה לצוות" }).click();
  await expectText(ownerDesk, "חברי הצוות (1)");
  await shot(ownerDesk, "10-team-1280");

  // the manager now sees the team; members do not edit teams
  await invitee.goto(`${orgUrl}/settings/teams`);
  await expectText(invitee, "צוות מכירות");
  const inviteeCanCreateTeam = await invitee.getByRole("button", { name: "יצירת צוות" }).count();
  console.log("manager sees create team:", inviteeCanCreateTeam);

  await ownerDesk.goto(`${orgUrl}/settings/users`);
  await ownerDesk.getByRole("button", { name: /השבתה.*דנה חברה/ }).click();
  await ownerDesk.getByRole("button", { name: "כן, להשבית" }).click();
  await ownerDesk.locator("span", { hasText: /^מושבת$/ }).first().waitFor({ timeout: 15000 });
  await shot(ownerDesk, "11-suspended-1280");

  step("suspended user is locked out");
  await invitee.goto(orgUrl);
  const title = await invitee.title();
  console.log("suspended user sees:", title, invitee.url());

  await ownerDesk.getByRole("button", { name: /החזרה לפעילות.*דנה חברה/ }).click();
  await ownerDesk.waitForTimeout(1500);
  await invitee.goto(orgUrl);
  console.log("reactivated user lands on:", invitee.url());

  step("the phone session is still signed in");
  await owner.goto(orgUrl);
  console.log("owner (phone) still signed in:", owner.url());

  // ---------------------------------------------------------------- section 2: core screens
  step("companies: list, card, edit");
  await ownerDesk.goto(`${orgUrl}/companies`);
  await ownerDesk.getByRole("link", { name: "כהן ובניו" }).click();
  await ownerDesk.waitForURL(/\/companies\/[0-9a-f-]{36}$/);
  await expectText(ownerDesk, "משה כהן");
  await ownerDesk.getByRole("button", { name: "עריכה" }).click();
  await ownerDesk.getByLabel("עיר").fill("חיפה");
  await ownerDesk.getByLabel("אתר").fill("cohen.co.il");
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await ownerDesk.getByRole("link", { name: "cohen.co.il" }).waitFor({ timeout: 15000 });
  await shot(ownerDesk, "20-company-1280");

  step("contact: edit");
  await ownerDesk.getByRole("link", { name: "משה כהן" }).first().click();
  await ownerDesk.waitForURL(/\/contacts\/[0-9a-f-]{36}$/);
  const contactUrl = ownerDesk.url();
  await ownerDesk.getByRole("button", { name: "עריכה" }).click();
  await ownerDesk.getByLabel("תפקיד").fill("מנכ\"ל");
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await expectText(ownerDesk, "מנכ\"ל, כהן ובניו");

  step("deal card: open from board, edit amount");
  await ownerDesk.goto(`${orgUrl}/deals`);
  await ownerDesk.getByRole("link", { name: "משה כהן" }).first().click();
  await ownerDesk.waitForURL(/\/deals\/[0-9a-f-]{36}$/);
  const dealUrl = ownerDesk.url();
  await ownerDesk.getByRole("button", { name: "עריכה" }).click();
  await ownerDesk.getByLabel("שווי (₪)").fill("15,000");
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await expectText(ownerDesk, "15,000");
  await shot(ownerDesk, "21-deal-1280");

  step("board: drag the deal to the third stage");
  await ownerDesk.goto(`${orgUrl}/deals`);
  const card = ownerDesk.locator("li[draggable=true]", { hasText: "משה כהן" }).first();
  const target = ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: /הצעת מחיר/ }) });
  await card.dragTo(target);
  await target.locator("li", { hasText: "משה כהן" }).first().waitFor({ timeout: 15000 });
  // the board moves the card at once; wait until the server has saved it before opening the deal
  for (let i = 0; i < 60; i++) {
    const [{ stage }] = await sql("select s.name as stage from public.deals d join public.stages s on s.id = d.stage_id where d.id = $1", [
      new URL(dealUrl).pathname.split("/").pop(),
    ]);
    if (stage === "הצעת מחיר") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await ownerDesk.goto(dealUrl);
  await ownerDesk.locator("span.font-medium", { hasText: /^הצעת מחיר$/ }).first().waitFor({ timeout: 15000 });
  console.log("drag moved the deal: yes");

  step("tasks: create for a colleague, complete, reopen");
  await ownerDesk.goto(`${orgUrl}/tasks`);
  await ownerDesk.getByLabel("מה צריך לעשות").fill("לשלוח הצעת מחיר למשה");
  await ownerDesk.getByLabel("שעה").fill("16:30");
  await ownerDesk.getByRole("button", { name: "הוספת משימה" }).click();
  await expectText(ownerDesk, "לשלוח הצעת מחיר למשה");
  await ownerDesk.getByRole("button", { name: /^בוצע.*לשלוח הצעת מחיר/ }).click();
  await ownerDesk.getByRole("heading", { name: "הושלמו לאחרונה" }).waitFor({ timeout: 15000 });
  await ownerDesk.getByRole("button", { name: /החזרה לפתוחות.*לשלוח הצעת מחיר/ }).click();
  await ownerDesk.getByRole("button", { name: /^בוצע.*לשלוח הצעת מחיר/ }).waitFor({ timeout: 15000 });
  await ownerDesk.getByLabel("מה צריך לעשות").fill("משימה לדנה");
  await ownerDesk.getByLabel("באחריות").selectOption({ label: "דנה חברה" });
  await ownerDesk.getByRole("button", { name: "הוספת משימה" }).click();
  // leaving the page before the save answers would cut it off
  for (let i = 0; i < 60; i++) {
    const [{ n }] = await sql("select count(*)::int as n from public.tasks where title = 'משימה לדנה' and organization_id = $1", [orgUrl.split("/").pop()]);
    if (n > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await ownerDesk.goto(`${orgUrl}/tasks?who=all`);
  await expectText(ownerDesk, "באחריות דנה חברה");
  await shot(ownerDesk, "22-tasks-1280");
  await invitee.goto(`${orgUrl}/tasks`);
  await expectText(invitee, "משימה לדנה");

  step("recycle bin: trash a contact, restore it");
  await ownerDesk.goto(contactUrl);
  await ownerDesk.getByRole("button", { name: "העברה לסל המחזור" }).click();
  await ownerDesk.getByRole("button", { name: "כן, להעביר לסל" }).click();
  await ownerDesk.waitForURL(/\/contacts$/);
  await ownerDesk.goto(`${orgUrl}/settings/trash`);
  await expectText(ownerDesk, "משה כהן");
  await shot(ownerDesk, "23-trash-1280");
  await ownerDesk.getByRole("button", { name: /שחזור.*משה כהן/ }).click();
  await expectText(ownerDesk, "סל המחזור ריק");
  await ownerDesk.goto(contactUrl);
  await expectText(ownerDesk, "פרטי איש הקשר");

  step("recycle bin: an admin deletes a lead for good");
  await ownerDesk.goto(`${orgUrl}/leads/new`);
  await ownerDesk.getByLabel("שם מלא").fill("ליד למחיקה");
  await ownerDesk.getByRole("button", { name: "יצירת ליד" }).click();
  await ownerDesk.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
  const purgedLeadId = new URL(ownerDesk.url()).pathname.split("/").pop();
  await ownerDesk.getByRole("button", { name: "העברה לסל המחזור" }).click();
  await ownerDesk.getByRole("button", { name: "כן, להעביר לסל" }).click();
  await ownerDesk.waitForURL(/\/leads$/);
  await ownerDesk.goto(`${orgUrl}/settings/trash`);
  await ownerDesk.getByRole("button", { name: /מחיקה לצמיתות.*ליד למחיקה/ }).click();
  await ownerDesk.getByRole("button", { name: "כן" }).click();
  await expectText(ownerDesk, "סל המחזור ריק");
  const purgedLeft = await sql("select count(*)::int as n from public.leads where id = $1", [purgedLeadId]);
  if (purgedLeft[0].n !== 0) throw new Error("the purged lead is still in the database");

  step("leads board: drag between statuses; 'not relevant' asks why; the card menu does the same");
  await ownerDesk.goto(`${orgUrl}/leads/new`);
  await ownerDesk.getByLabel("שם מלא").fill("ליד בלוח");
  await ownerDesk.getByRole("button", { name: "יצירת ליד" }).click();
  await ownerDesk.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
  const boardLeadId = new URL(ownerDesk.url()).pathname.split("/").pop();
  const boardStatus = async (expected) => {
    for (let i = 0; i < 60; i++) {
      const [row] = await sql("select s.name, l.disqualify_reason as reason from public.leads l join public.lead_statuses s on s.id = l.status_id where l.id = $1", [boardLeadId]);
      if (row.name === expected) return row;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the board did not move the lead to ${expected}`);
  };
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByRole("link", { name: "לוח", exact: true }).click();
  await ownerDesk.waitForURL(/view=board/);
  const leadCard = () => ownerDesk.locator("li[draggable=true]", { hasText: "ליד בלוח" }).first();
  const statusColumn = (name) => ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: new RegExp(`^${name}`) }) });
  await leadCard().dragTo(statusColumn("בטיפול"));
  await boardStatus("בטיפול");
  // the last column is off screen in the board's sideways scroll; fire the drag events on it directly
  await ownerDesk.evaluate(() => {
    const card = [...document.querySelectorAll("li[draggable=true]")].find((li) => li.textContent.includes("ליד בלוח"));
    const column = [...document.querySelectorAll("section")].find((section) => section.querySelector("h2")?.textContent.startsWith("לא רלוונטי"));
    const data = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: data }));
    column.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
    column.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await ownerDesk.getByLabel("למה הליד ליד בלוח לא רלוונטי?").fill("כבר קנה אצל מתחרה");
  await shot(ownerDesk, "24-leads-board-1280");
  await ownerDesk.getByRole("form", { name: "סיבה לליד לא רלוונטי" }).getByRole("button", { name: "העברה" }).click();
  const disqualified = await boardStatus("לא רלוונטי");
  if (disqualified.reason !== "כבר קנה אצל מתחרה") throw new Error("the reason was not saved");
  await ownerDesk.reload();
  await statusColumn("לא רלוונטי").locator("li", { hasText: "ליד בלוח" }).first().waitFor();
  await ownerDesk.getByLabel("סטטוס של הליד ליד בלוח").selectOption({ label: "חדש" });
  await leadCard().getByRole("button", { name: "העברה" }).click();
  const back = await boardStatus("חדש");
  if (back.reason !== null) throw new Error("the reason stayed after the lead was reopened");

  step("lists: a click on a column header sorts by it, a second click reverses");
  await ownerDesk.goto(`${orgUrl}/leads`);
  const nameHeader = ownerDesk.getByRole("columnheader", { name: /^שם/ });
  await nameHeader.getByRole("link").click();
  await ownerDesk.waitForURL(/sort=name/);
  if ((await nameHeader.getAttribute("aria-sort")) !== "ascending") throw new Error("the name column is not marked as sorted");
  // the first row is the database's first name in its own collation
  const [{ first }] = await sql(
    "select full_name as first from public.leads where organization_id = $1 and deleted_at is null order by full_name nulls last, id limit 1",
    [orgUrl.split("/").pop()],
  );
  const firstShown = (await ownerDesk.locator("tbody tr td:first-child a").first().innerText()).trim();
  if (firstShown !== first) throw new Error(`leads are not sorted by name: first shown ${firstShown}, expected ${first}`);
  await nameHeader.getByRole("link").click();
  await ownerDesk.waitForURL(/sort=-name/);
  if ((await nameHeader.getAttribute("aria-sort")) !== "descending") throw new Error("a second click did not reverse the sort");
  await ownerDesk.goto(`${orgUrl}/companies`);
  await ownerDesk.getByRole("columnheader", { name: /^נוצר/ }).getByRole("link").click();
  await ownerDesk.waitForURL(/sort=-created/);
  // columns that show another table's name sort through computed fields (migration 0032)
  for (const [path, header, param] of [
    ["leads", "סטטוס", "status"],
    ["leads", "מקור", "source"],
    ["leads", "בעלים", "owner"],
    ["contacts", "חברה", "company"],
    ["contacts", "בעלים", "owner"],
    ["companies", "בעלים", "owner"],
  ]) {
    await ownerDesk.goto(`${orgUrl}/${path}?sort=${param}`);
    const column = ownerDesk.getByRole("columnheader", { name: new RegExp(`^${header}`) });
    if ((await column.getAttribute("aria-sort")) !== "ascending") throw new Error(`${path}: not sorted by ${header}`);
    await ownerDesk.locator("tbody tr").first().waitFor({ timeout: 15000 });
  }
  const [{ expected }] = await sql(
    `select l.full_name as expected from public.leads l join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
      where l.organization_id = $1 and l.deleted_at is null order by s.position, l.id limit 1`,
    [orgUrl.split("/").pop()],
  );
  await ownerDesk.goto(`${orgUrl}/leads?sort=status`);
  const firstByStatus = (await ownerDesk.locator("tbody tr td:first-child a").first().innerText()).trim();
  if (expected && firstByStatus !== expected) throw new Error(`leads by status: first shown ${firstByStatus}, expected ${expected}`);

  step("privacy request: erase the purged lead from the audit log");
  await ownerDesk.goto(`${orgUrl}/settings/audit?tab=privacy`);
  await ownerDesk.getByLabel("שם, טלפון או אימייל").fill("ליד למחיקה");
  await ownerDesk.getByRole("button", { name: "חיפוש", exact: true }).click();
  await ownerDesk.getByRole("button", { name: /מחיקת הפרטים מהיומן.*ליד למחיקה/ }).click();
  await shot(ownerDesk, "23b-audit-erase-1280");
  await ownerDesk.getByRole("button", { name: "כן" }).click();
  await expectText(ownerDesk, "לא נמצאה ביומן רשומה שנמחקה לצמיתות");
  const leftInLog = await sql("select count(*)::int as n from public.audit_log where entity_id = $1 and changes::text like '%ליד למחיקה%'", [purgedLeadId]);
  if (leftInLog[0].n !== 0) throw new Error("the erased lead's name is still in the audit log");

  step("files: upload to a contact, open, delete");
  await ownerDesk.goto(contactUrl);
  await ownerDesk.waitForLoadState("networkidle");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await ownerDesk.getByLabel("בחירת קבצים").setInputFiles([
    { name: "תמונה.png", mimeType: "image/png", buffer: png },
    { name: "הצעת מחיר.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%test\n") },
    { name: "דף.html", mimeType: "text/html", buffer: Buffer.from("<script>alert(1)</script>") },
  ]);
  await expectText(ownerDesk, "אי אפשר להעלות את סוג הקובץ של דף.html");
  await ownerDesk.getByRole("link", { name: "הצעת מחיר.pdf" }).waitFor({ timeout: 15000 });
  await ownerDesk.getByRole("link", { name: "תמונה.png" }).waitFor();
  await shot(ownerDesk, "26-files-1280");
  const imageHref = await ownerDesk.getByRole("link", { name: "תמונה.png" }).getAttribute("href");
  const openedFile = await ownerDesk.request.get(`${APP}${imageHref}`);
  if (openedFile.status() !== 200 || !(openedFile.headers()["content-type"] ?? "").startsWith("image/png")) throw new Error(`file did not open: ${openedFile.status()}`);
  await ownerDesk.getByRole("button", { name: /מחיקה.*הצעת מחיר\.pdf/ }).click();
  await ownerDesk.getByRole("button", { name: "כן" }).click();
  await ownerDesk.getByRole("link", { name: "הצעת מחיר.pdf" }).waitFor({ state: "detached", timeout: 15000 });
  const objectsLeft = await sql("select count(*)::int as n from storage.objects o join public.files f on f.storage_path = o.name where f.name = 'הצעת מחיר.pdf'");
  if (objectsLeft[0].n !== 0) throw new Error("the deleted file is still in storage");
  console.log("files: uploaded 2, refused 1, opened the image, deleted the PDF");

  // ---------------------------------------------------------------- section 3: customization
  step("pipelines: create, add a stage, switch on the board");
  await ownerDesk.goto(`${orgUrl}/settings/pipelines`);
  await ownerDesk.getByLabel("שם הפייפליין").fill("השכרות");
  await ownerDesk.getByRole("button", { name: "יצירת פייפליין" }).click();
  await expectText(ownerDesk, "הפייפליין נוצר");
  const rentals = ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "השכרות" }) });
  await rentals.getByLabel("שם השלב החדש").fill("סיור בנכס");
  await rentals.getByRole("button", { name: "הוספת שלב" }).click();
  await rentals.locator('input[name="name"][value="סיור בנכס"]').waitFor({ timeout: 15000 });
  const stageNames = await rentals.locator('ol input[name="name"]').evaluateAll((els) => els.map((el) => el.value));
  console.log("rentals stages:", stageNames.join(" > "));
  if (stageNames[1] !== "סיור בנכס") throw new Error("a new open stage should go before the closing stages");
  await shot(ownerDesk, "30-pipelines-1280");
  await ownerDesk.goto(`${orgUrl}/deals`);
  await ownerDesk.getByRole("link", { name: "השכרות" }).click();
  await ownerDesk.getByRole("heading", { name: /סיור בנכס/ }).waitFor({ timeout: 15000 });

  step("lead statuses and sources");
  await ownerDesk.goto(`${orgUrl}/settings/leads`);
  await ownerDesk.getByLabel("שם הסטטוס החדש").fill("ממתין לתשובה");
  await ownerDesk.getByRole("button", { name: "הוספת סטטוס" }).click();
  await ownerDesk.locator('input[name="name"][value="ממתין לתשובה"]').waitFor({ timeout: 15000 });
  await ownerDesk.getByLabel("שם המקור החדש").fill("תערוכה");
  await ownerDesk.getByRole("button", { name: "הוספת מקור" }).click();
  await ownerDesk.locator('input[name="name"][value="תערוכה"]').waitFor({ timeout: 15000 });
  await ownerDesk.getByRole("button", { name: /הסתרה.*: תערוכה/ }).click();
  await ownerDesk.locator("li", { has: ownerDesk.locator('input[value="תערוכה"]') }).getByText("מוסתר").waitFor({ timeout: 15000 });
  // the in-use status cannot be deleted
  const usedStatus = ownerDesk.locator("li", { has: ownerDesk.locator('input[name="name"][value="הומר"]') });
  await usedStatus.getByRole("button", { name: "מחיקה" }).click();
  await usedStatus.getByRole("button", { name: "כן" }).click();
  await usedStatus.getByText("יש לידים בסטטוס הזה").waitFor({ timeout: 15000 });
  await shot(ownerDesk, "31-lead-settings-1280");

  step("custom fields: define, fill in a new lead, see on the card");
  await ownerDesk.goto(`${orgUrl}/settings/fields?object=lead`);
  await ownerDesk.getByLabel("שם השדה").fill("תקציב");
  await ownerDesk.getByLabel("סוג השדה").selectOption("select");
  await ownerDesk.getByLabel("אפשרויות, כל אחת בשורה").fill("עד 10,000\n10,000-50,000\nמעל 50,000");
  await ownerDesk.getByRole("button", { name: "הוספת שדה" }).click();
  await expectText(ownerDesk, "השדה נוסף");
  await ownerDesk.getByLabel("שם השדה").fill("תאריך פגישה");
  await ownerDesk.getByLabel("סוג השדה").selectOption("date");
  await ownerDesk.getByLabel("שדה חובה").check();
  await ownerDesk.getByRole("button", { name: "הוספת שדה" }).click();
  await ownerDesk.locator("li", { hasText: "תאריך פגישה" }).getByText("חובה").waitFor({ timeout: 15000 });
  await shot(ownerDesk, "32-fields-1280");

  await ownerDesk.goto(`${orgUrl}/leads/new`);
  await ownerDesk.getByLabel("שם מלא").fill("רחל לוי");
  await ownerDesk.getByLabel("תקציב").selectOption("10,000-50,000");
  const sourceOptions = await ownerDesk.getByLabel("מקור").locator("option").allTextContents();
  if (sourceOptions.includes("תערוכה")) throw new Error("a hidden source is offered in the form");
  await ownerDesk.getByRole("button", { name: "יצירת ליד" }).click();
  await expectText(ownerDesk, "יש למלא את השדה");
  await ownerDesk.getByLabel("תאריך פגישה").fill("2026-11-01");
  await ownerDesk.getByRole("button", { name: "יצירת ליד" }).click();
  await ownerDesk.waitForURL(/\/leads\/[0-9a-f-]{36}$/, { timeout: 15000 });
  await expectText(ownerDesk, "10,000-50,000");
  await expectText(ownerDesk, "1 בנוב׳ 2026");
  const leadUrl = ownerDesk.url();

  step("list columns: hide one, add a custom field, move it, sort by it; back to the default");
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByRole("button", { name: "עמודות" }).click();
  const columnsPanel = ownerDesk.getByRole("group", { name: "בחירת עמודות" });
  await columnsPanel.getByLabel("מקור", { exact: true }).uncheck();
  await columnsPanel.getByLabel("תאריך פגישה", { exact: true }).check();
  await columnsPanel.getByRole("button", { name: "למעלה: תאריך פגישה" }).click();
  await columnsPanel.getByLabel("רוחב: תאריך פגישה").selectOption("wide");
  await shot(ownerDesk, "31-columns-1280");
  await columnsPanel.getByRole("button", { name: "שמירת העמודות" }).click();
  await ownerDesk.getByRole("columnheader", { name: /^תאריך פגישה/ }).waitFor({ timeout: 15000 });
  if (await ownerDesk.getByRole("columnheader", { name: /^מקור/ }).count()) throw new Error("the hidden column is still shown");
  await expectText(ownerDesk, "1 בנוב׳ 2026");
  const [saved] = await sql(
    "select p.columns from public.list_preferences p join auth.users u on u.id = p.user_id where u.email = $1 and p.object_type = 'lead'",
    [ownerEmail],
  );
  const savedKeys = saved.columns.map((c) => c.key);
  if (savedKeys.includes("source") || !savedKeys.some((k) => k.startsWith("cf:"))) throw new Error(`columns not saved: ${savedKeys.join(",")}`);
  // a custom field column sorts too
  await ownerDesk.getByRole("columnheader", { name: /^תאריך פגישה/ }).getByRole("link").click();
  await ownerDesk.waitForURL(/sort=cf%3A|sort=cf:/);
  await ownerDesk.locator("tbody tr").first().waitFor();
  await ownerDesk.getByRole("button", { name: "עמודות" }).click();
  await ownerDesk.getByRole("button", { name: "חזרה לברירת המחדל" }).click();
  await ownerDesk.getByRole("columnheader", { name: /^מקור/ }).waitFor({ timeout: 15000 });
  await ownerDesk.goto(leadUrl);

  step("advanced filter: conditions in groups, custom fields, saved in a view");
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByRole("button", { name: "סינון מתקדם" }).click();
  const filterPanel = ownerDesk.getByRole("group", { name: "סינון מתקדם" });
  await filterPanel.getByLabel("שדה לתנאי 1.1").selectOption({ label: "שם" });
  await filterPanel.getByLabel("פעולה לתנאי 1.1").selectOption("contains");
  await filterPanel.getByLabel("ערך לתנאי 1.1").fill("משה");
  await filterPanel.getByRole("button", { name: "הוספת קבוצה" }).click();
  await filterPanel.getByLabel("שדה לתנאי 2.1").selectOption({ label: "תאריך פגישה" });
  await filterPanel.getByLabel("פעולה לתנאי 2.1").selectOption("on_or_after");
  await filterPanel.getByLabel("ערך לתנאי 2.1").fill("2026-11-01");
  await filterPanel.getByLabel("להציג רשומות שעונות על").selectOption("any");
  await shot(ownerDesk, "32-advanced-filter-1280");
  await filterPanel.getByRole("button", { name: "החלת הסינון" }).click();
  await ownerDesk.waitForURL(/f=/);
  await ownerDesk.getByRole("button", { name: "סינון מתקדם (2)" }).waitFor({ timeout: 15000 });
  const meetingKey = (await sql("select key from public.field_definitions where organization_id = $1 and label = 'תאריך פגישה'", [orgUrl.split("/").pop()]))[0].key;
  const [{ n: expectedRows }] = await sql(
    `select count(*)::int as n from public.leads where organization_id = $1 and deleted_at is null
       and (full_name ilike '%משה%' or custom_fields->>$2 >= '2026-11-01')`,
    [orgUrl.split("/").pop(), meetingKey],
  );
  const shownRows = await ownerDesk.locator("tbody tr").count();
  if (shownRows !== expectedRows || expectedRows < 2) throw new Error(`advanced filter: shown ${shownRows}, expected ${expectedRows}`);
  // the filter is part of a saved view
  await ownerDesk.getByRole("button", { name: "שמירת התצוגה" }).click();
  await ownerDesk.getByLabel("שם התצוגה").fill("סינון מתקדם שמור");
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await ownerDesk.getByRole("link", { name: /סינון מתקדם שמור/ }).waitFor({ timeout: 15000 });
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByRole("link", { name: /סינון מתקדם שמור/ }).click();
  await ownerDesk.getByRole("button", { name: "סינון מתקדם (2)" }).waitFor({ timeout: 15000 });
  if ((await ownerDesk.locator("tbody tr").count()) !== expectedRows) throw new Error("the saved view did not bring the filter back");
  await ownerDesk.goto(leadUrl);

  step("tags: create on a record, filter the list, save a view");
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByRole("button", { name: "עריכת תגיות" }).click();
  await ownerDesk.getByLabel("תגית חדשה").fill("VIP");
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByRole("button", { name: "שמירה" }).click();
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByText("VIP").waitFor({ timeout: 15000 });
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByRole("combobox", { name: "תגית" }).selectOption({ label: "VIP" });
  await ownerDesk.getByRole("button", { name: "חיפוש", exact: true }).click();
  await ownerDesk.waitForURL(/tag=/);
  const rows = await ownerDesk.locator("tbody tr").count();
  console.log("leads tagged VIP:", rows);
  if (rows !== 1) throw new Error("tag filter should leave exactly one lead");
  await ownerDesk.getByRole("button", { name: "שמירת התצוגה" }).click();
  await ownerDesk.getByLabel("שם התצוגה").fill("לקוחות VIP");
  await ownerDesk.getByLabel("למי").selectOption("org");
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await ownerDesk.getByRole("link", { name: /לקוחות VIP/ }).waitFor({ timeout: 15000 });
  await shot(ownerDesk, "33-leads-view-1280");
  // a shared view shows for a colleague too. Record visibility is "by team"
  // (set above) and the lead is the owner's, so Dana sees the view but not the lead.
  await invitee.goto(`${orgUrl}/leads`);
  await invitee.getByRole("link", { name: /לקוחות VIP/ }).click();
  await invitee.waitForURL(/tag=/);
  await expectText(invitee, "לא נמצאו לידים");

  step("saved views keep the sort and the columns, and can be shared with a team");
  await ownerDesk.goto(`${orgUrl}/leads?sort=-name`);
  await ownerDesk.getByRole("button", { name: "שמירת התצוגה" }).click();
  await ownerDesk.getByLabel("שם התצוגה").fill("לפי שם, לצוות");
  await ownerDesk.getByLabel("למי").selectOption("team");
  await ownerDesk.getByLabel("איזה צוות").selectOption({ label: "צוות מכירות" });
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await ownerDesk.getByRole("link", { name: /לפי שם, לצוות/ }).waitFor({ timeout: 15000 });
  const [teamView] = await sql("select scope, team_id is not null as has_team, config from public.saved_views where name = 'לפי שם, לצוות'");
  if (teamView.scope !== "team" || !teamView.has_team || teamView.config.sort !== "-name" || !Array.isArray(teamView.config.columns) || teamView.config.columns.length === 0)
    throw new Error(`the team view was not saved as expected: ${JSON.stringify(teamView)}`);
  // opening the view brings its sort back
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByRole("link", { name: /לפי שם, לצוות/ }).click();
  await ownerDesk.waitForURL(/sv=/);
  if ((await ownerDesk.getByRole("columnheader", { name: /^שם/ }).getAttribute("aria-sort")) !== "descending") throw new Error("the view's sort was not applied");
  // Dana is in the sales team: she sees the view, and its columns replace hers
  await invitee.goto(`${orgUrl}/leads`);
  await invitee.getByRole("link", { name: /לפי שם, לצוות/ }).click();
  await invitee.waitForURL(/sv=/);
  await expectText(invitee, "העמודות לפי התצוגה");

  step("inline editing: name, status and owner change in the list's cell");
  const orgIdNow = orgUrl.split("/").pop();
  const pollLead = async (id, test, what) => {
    for (let i = 0; i < 60; i++) {
      const [row] = await sql("select full_name, status_id, owner_id from public.leads where id = $1", [id]);
      if (test(row)) return row;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`inline edit not saved: ${what}`);
  };
  const [inlineLead] = await sql(
    `select l.id, l.full_name, l.owner_id, l.status_id from public.leads l join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
      where l.organization_id = $1 and l.deleted_at is null and l.full_name is not null and s.kind = 'open' and l.converted_at is null order by l.created_at desc limit 1`,
    [orgIdNow],
  );
  const [{ id: otherStatus, name: otherStatusName }] = await sql(
    "select id, name from public.lead_statuses where organization_id = $1 and kind = 'open' and id <> $2 order by position limit 1",
    [orgIdNow, inlineLead.status_id],
  );
  const [{ id: danaId }] = await sql("select id from auth.users where email = $1", [inviteeEmail]);
  await ownerDesk.goto(`${orgUrl}/leads`);
  const inlineRow = () => ownerDesk.locator("tbody tr", { has: ownerDesk.getByRole("link", { name: inlineLead.full_name, exact: true }) });
  // the name: Enter saves
  await inlineRow().getByRole("button", { name: `עריכת שם: ${inlineLead.full_name}` }).click();
  await ownerDesk.getByRole("textbox", { name: `שם: ${inlineLead.full_name}` }).fill(`${inlineLead.full_name} בדיקה`);
  await shot(ownerDesk, "34-inline-edit-1280");
  await ownerDesk.getByRole("textbox", { name: `שם: ${inlineLead.full_name}` }).press("Enter");
  await pollLead(inlineLead.id, (r) => r.full_name === `${inlineLead.full_name} בדיקה`, "name");
  // Escape cancels without saving
  const renamed = `${inlineLead.full_name} בדיקה`;
  const row2 = () => ownerDesk.locator("tbody tr", { has: ownerDesk.getByRole("link", { name: renamed, exact: true }) });
  await row2().getByRole("button", { name: `עריכת שם: ${renamed}` }).click();
  await ownerDesk.getByRole("textbox", { name: `שם: ${renamed}` }).fill("לא נשמר");
  await ownerDesk.getByRole("textbox", { name: `שם: ${renamed}` }).press("Escape");
  await row2().getByRole("button", { name: `עריכת שם: ${renamed}` }).waitFor();
  // the status
  await row2().getByRole("button", { name: `עריכת סטטוס: ${renamed}` }).click();
  await row2().getByRole("combobox", { name: `סטטוס: ${renamed}` }).selectOption(otherStatus);
  await row2().getByRole("button", { name: "שמירה" }).click();
  await pollLead(inlineLead.id, (r) => r.status_id === otherStatus, "status");
  await row2().getByText(otherStatusName).waitFor({ timeout: 15000 });
  // the owner: to Dana, and back
  await row2().getByRole("button", { name: `עריכת בעלים: ${renamed}` }).click();
  await row2().getByRole("combobox", { name: `בעלים: ${renamed}` }).selectOption(danaId);
  await row2().getByRole("button", { name: "שמירה" }).click();
  await pollLead(inlineLead.id, (r) => r.owner_id === danaId, "owner");
  await row2().getByText("דנה חברה").waitFor({ timeout: 15000 });
  await row2().getByRole("button", { name: `עריכת בעלים: ${renamed}` }).click();
  await row2().getByRole("combobox", { name: `בעלים: ${renamed}` }).selectOption(inlineLead.owner_id);
  await row2().getByRole("button", { name: "שמירה" }).click();
  await pollLead(inlineLead.id, (r) => r.owner_id === inlineLead.owner_id, "owner back");
  // and the name back, so later steps find the lead as before
  await row2().getByRole("button", { name: `עריכת שם: ${renamed}` }).click();
  await ownerDesk.getByRole("textbox", { name: `שם: ${renamed}` }).fill(inlineLead.full_name);
  await ownerDesk.getByRole("textbox", { name: `שם: ${renamed}` }).press("Enter");
  await pollLead(inlineLead.id, (r) => r.full_name === inlineLead.full_name, "name back");

  step("bulk actions: pick leads, add a tag and change the status of all of them, move one to the bin");
  const bulkLeads = await sql(
    `select l.id, l.full_name, l.status_id, l.tag_ids from public.leads l join public.lead_statuses s on s.organization_id = l.organization_id and s.id = l.status_id
      where l.organization_id = $1 and l.deleted_at is null and l.full_name is not null and s.kind = 'open' and l.converted_at is null order by l.created_at desc limit 2`,
    [orgIdNow],
  );
  if (bulkLeads.length < 2) throw new Error("bulk: need two open leads");
  const [{ id: bulkTag }] = await sql("select id from public.tags where organization_id = $1 and name = 'VIP'", [orgIdNow]);
  await ownerDesk.goto(`${orgUrl}/leads`);
  for (const lead of bulkLeads) await ownerDesk.getByRole("checkbox", { name: `בחירה: ${lead.full_name}`, exact: true }).check();
  const bar = ownerDesk.getByRole("group", { name: "פעולות על הנבחרים" });
  await bar.getByText("נבחרו 2").waitFor();
  await bar.getByLabel("פעולה", { exact: true }).selectOption("tag");
  await bar.getByLabel("תגית", { exact: true }).selectOption(bulkTag);
  await shot(ownerDesk, "35-bulk-actions-1280");
  await bar.getByRole("button", { name: "ביצוע על 2" }).click();
  await bar.getByText("2 רשומות עודכנו.").waitFor({ timeout: 15000 });
  const tagged = await sql("select count(*)::int as n from public.leads where id = any($1) and $2 = any(tag_ids)", [bulkLeads.map((l) => l.id), bulkTag]);
  if (tagged[0].n !== 2) throw new Error("bulk: the tag was not added to both leads");
  for (const lead of bulkLeads) await ownerDesk.getByRole("checkbox", { name: `בחירה: ${lead.full_name}`, exact: true }).check();
  await bar.getByLabel("פעולה", { exact: true }).selectOption("status");
  await bar.getByLabel("סטטוס חדש").selectOption(otherStatus);
  await bar.getByRole("button", { name: "ביצוע על 2" }).click();
  await bar.getByText("2 רשומות עודכנו.").waitFor({ timeout: 15000 });
  const moved = await sql("select count(*)::int as n from public.leads where id = any($1) and status_id = $2", [bulkLeads.map((l) => l.id), otherStatus]);
  if (moved[0].n !== 2) throw new Error("bulk: the status did not change on both leads");
  // the bin asks first
  ownerDesk.once("dialog", (dialog) => dialog.accept());
  await ownerDesk.getByRole("checkbox", { name: `בחירה: ${bulkLeads[0].full_name}`, exact: true }).check();
  await bar.getByLabel("פעולה", { exact: true }).selectOption("trash");
  await bar.getByRole("button", { name: "ביצוע על 1" }).click();
  await bar.getByText("רשומה אחת עודכנה.").waitFor({ timeout: 15000 });
  const [{ trashed }] = await sql("select deleted_at is not null as trashed from public.leads where id = $1", [bulkLeads[0].id]);
  if (!trashed) throw new Error("bulk: the lead did not go to the bin");
  // put everything back, so the later steps see the leads as before
  for (const lead of bulkLeads) {
    await sql("update public.leads set deleted_at = null, status_id = $2, tag_ids = $3 where id = $1", [lead.id, lead.status_id, lead.tag_ids]);
  }

  step("export: the filtered list as Excel and CSV, the picked rows too; each export is in the audit log; a member may not");
  const exportsBefore = (await sql("select count(*)::int as n from public.audit_log where organization_id = $1 and action = 'export'", [orgIdNow]))[0].n;
  // the filter of the list goes into the file: search for one lead
  const exportQuery = `q=${encodeURIComponent(bulkLeads[1].full_name)}`;
  const listCsvResponse = await ownerDesk.request.get(`${orgUrl}/leads/export?${exportQuery}&format=csv`);
  if (listCsvResponse.status() !== 200) throw new Error(`export csv: ${listCsvResponse.status()}`);
  const listCsvBody = await listCsvResponse.text();
  const listCsvLines = listCsvBody.replace(/^\uFEFF/, "").trim().split("\r\n");
  if (!listCsvLines[0].startsWith("שם,") || !listCsvLines.some((line) => line.startsWith(bulkLeads[1].full_name))) throw new Error(`export csv content: ${listCsvBody.slice(0, 300)}`);
  const listXlsxResponse = await ownerDesk.request.get(`${orgUrl}/leads/export?format=xlsx`);
  const listSheet = strFromU8(unzipSync(new Uint8Array(await listXlsxResponse.body()))["xl/worksheets/sheet1.xml"]);
  const [{ n: liveLeads }] = await sql("select count(*)::int as n from public.leads where organization_id = $1 and deleted_at is null", [orgIdNow]);
  if ((listSheet.match(/<row /g) ?? []).length !== liveLeads + 1) throw new Error(`export xlsx: ${(listSheet.match(/<row /g) ?? []).length} rows, expected ${liveLeads + 1}`);
  // the menu above the list
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByText("ייצוא", { exact: true }).click();
  const [menuDownload] = await Promise.all([ownerDesk.waitForEvent("download"), ownerDesk.getByRole("link", { name: "קובץ Excel" }).click()]);
  if (!menuDownload.suggestedFilename().endsWith(".xlsx")) throw new Error(`export menu: ${menuDownload.suggestedFilename()}`);
  // the picked rows
  await ownerDesk.goto(`${orgUrl}/leads`);
  for (const lead of bulkLeads) await ownerDesk.getByRole("checkbox", { name: `בחירה: ${lead.full_name}`, exact: true }).check();
  await bar.getByLabel("פעולה", { exact: true }).selectOption("export");
  await bar.getByLabel("סוג הקובץ").selectOption("csv");
  const [pickedDownload] = await Promise.all([ownerDesk.waitForEvent("download"), bar.getByRole("button", { name: "ביצוע על 2" }).click()]);
  const pickedLines = (await readFile(await pickedDownload.path(), "utf8")).trim().split("\r\n");
  if (pickedLines.length !== 3) throw new Error(`export picked: ${pickedLines.length - 1} rows`);
  const exportsLogged = await sql(
    "select changes from public.audit_log where organization_id = $1 and action = 'export' order by id offset $2",
    [orgIdNow, exportsBefore],
  );
  if (exportsLogged.length !== 4 || exportsLogged[0].changes.filters?.q !== bulkLeads[1].full_name || exportsLogged[3].changes.scope !== "selected" || exportsLogged[3].changes.rows !== 2)
    throw new Error(`export audit: ${JSON.stringify(exportsLogged)}`);
  // Dana is a team manager here; as a plain member she gets no menu, and the address refuses her
  const [{ id: danaUser }] = await sql("select id from auth.users where email = $1", [inviteeEmail]);
  await sql("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [orgIdNow, danaUser]);
  await invitee.goto(`${orgUrl}/leads`);
  await invitee.getByRole("heading", { name: "לידים" }).waitFor();
  const memberSeesExport = (await invitee.getByText("ייצוא", { exact: true }).count()) !== 0;
  const memberExportStatus = (await invitee.request.get(`${orgUrl}/leads/export?format=csv`)).status();
  await sql("update public.memberships set role = 'manager' where organization_id = $1 and user_id = $2", [orgIdNow, danaUser]);
  if (memberSeesExport) throw new Error("a member sees the export menu");
  if (memberExportStatus !== 403) throw new Error(`a member could export: ${memberExportStatus}`);
  await ownerDesk.goto(leadUrl);

  step("deals and tasks as tables: edit a cell, sort, act on picked rows, export");
  const [tableDeal] = await sql(
    `select d.id, d.name, d.stage_id, d.pipeline_id from public.deals d join public.pipelines p on p.id = d.pipeline_id and p.is_default
      where d.organization_id = $1 and d.deleted_at is null
        and (select count(*) from public.deals x where x.pipeline_id = d.pipeline_id and x.name = d.name and x.deleted_at is null) = 1
      order by d.created_at limit 1`,
    [orgIdNow],
  );
  const [otherDealStage] = await sql("select id, name from public.stages where pipeline_id = $1 and id <> $2 and kind = 'open' order by position limit 1", [
    tableDeal.pipeline_id,
    tableDeal.stage_id,
  ]);
  await ownerDesk.goto(`${orgUrl}/deals?view=table`);
  const dealRow = ownerDesk.locator("tbody tr", { has: ownerDesk.getByRole("link", { name: tableDeal.name, exact: true }) });
  await dealRow.getByRole("button", { name: `עריכת שלב: ${tableDeal.name}` }).click();
  await dealRow.getByRole("combobox", { name: `שלב: ${tableDeal.name}` }).selectOption(otherDealStage.id);
  await dealRow.getByRole("button", { name: "שמירה" }).click();
  for (let i = 0; ; i++) {
    const [row] = await sql("select stage_id from public.deals where id = $1", [tableDeal.id]);
    if (row.stage_id === otherDealStage.id) break;
    if (i > 60) throw new Error("deals table: the stage was not saved");
    await new Promise((r) => setTimeout(r, 250));
  }
  await dealRow.getByText(otherDealStage.name).waitFor({ timeout: 15000 });
  await shot(ownerDesk, "36-deals-table-1280");
  await ownerDesk.getByRole("columnheader", { name: /^סכום/ }).getByRole("link").click();
  await ownerDesk.waitForURL(/sort=/);
  const dealsCsv = await ownerDesk.request.get(`${orgUrl}/deals/export?view=table&format=csv`);
  if (dealsCsv.status() !== 200 || !(await dealsCsv.text()).includes(tableDeal.name)) throw new Error(`deals export: ${dealsCsv.status()}`);
  await sql("update public.deals set stage_id = $2 where id = $1", [tableDeal.id, tableDeal.stage_id]);

  const [tableTask] = await sql(
    `select t.id, t.title from public.tasks t where t.organization_id = $1 and t.deleted_at is null and t.status = 'open'
        and (select count(*) from public.tasks x where x.organization_id = t.organization_id and x.title = t.title and x.deleted_at is null) = 1
      order by t.created_at limit 1`,
    [orgIdNow],
  );
  await ownerDesk.goto(`${orgUrl}/tasks?view=table&who=all`);
  await ownerDesk.getByRole("checkbox", { name: `בחירה: ${tableTask.title}`, exact: true }).check();
  const taskBar = ownerDesk.getByRole("group", { name: "פעולות על הנבחרים" });
  await taskBar.getByLabel("פעולה", { exact: true }).selectOption("status");
  await taskBar.getByLabel("מצב חדש").selectOption("done");
  await shot(ownerDesk, "37-tasks-table-1280");
  await taskBar.getByRole("button", { name: "ביצוע על 1" }).click();
  await taskBar.getByText("רשומה אחת עודכנה.").waitFor({ timeout: 15000 });
  const [doneTask] = await sql("select status, completed_at is not null as stamped from public.tasks where id = $1", [tableTask.id]);
  if (doneTask.status !== "done" || !doneTask.stamped) throw new Error(`tasks table: ${JSON.stringify(doneTask)}`);
  const tasksCsv = await ownerDesk.request.get(`${orgUrl}/tasks/export?view=table&who=all&format=csv`);
  if (tasksCsv.status() !== 200 || !(await tasksCsv.text()).includes(tableTask.title)) throw new Error(`tasks export: ${tasksCsv.status()}`);
  await sql("update public.tasks set status = 'open' where id = $1", [tableTask.id]);
  await ownerDesk.goto(leadUrl);

  // ---------------------------------------------------------------- section 4: lead intake
  step("intake: create a web form, set it up");
  await ownerDesk.goto(`${orgUrl}/settings/intake`);
  await ownerDesk.getByRole("textbox", { name: "שם", exact: true }).fill("טופס צור קשר");
  await ownerDesk.getByRole("button", { name: "יצירה" }).click();
  await ownerDesk.waitForURL(/\/settings\/intake\/[0-9a-f-]{36}$/);
  const formAdminUrl = ownerDesk.url();
  await ownerDesk.getByLabel("כותרת הטופס").fill("השאירו פרטים ונחזור אליכם");
  await ownerDesk.getByRole("checkbox", { name: "חברה", exact: true }).check();
  await ownerDesk.getByLabel("מקור הליד").selectOption({ label: "טופס באתר" });
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await expectText(ownerDesk, "נשמר.");
  const publicUrl = await ownerDesk.getByLabel("קישור ישיר לטופס").inputValue();
  await shot(ownerDesk, "40-intake-form-1280");

  step("intake: a visitor (signed out, phone) fills the public form");
  const frameHeaders = (await fetch(publicUrl)).headers.get("content-security-policy");
  console.log("public form frame-ancestors:", frameHeaders);
  if (!frameHeaders?.includes("frame-ancestors *")) throw new Error("the public form must be embeddable");
  const visitor = await newPage(360);
  await visitor.goto(`${publicUrl}?embed=1`);
  await visitor.getByRole("heading", { name: "השאירו פרטים ונחזור אליכם" }).waitFor();
  await visitor.getByLabel("שם מלא").fill("גלית מהאתר");
  await visitor.getByLabel("טלפון").fill("054-7778899");
  await visitor.getByLabel("חברה").fill("גלית עיצובים");
  await visitor.waitForTimeout(2200); // a person takes a moment; faster than 2 seconds counts as a bot
  await visitor.getByRole("button", { name: "שליחה" }).click();
  await expectText(visitor, "תודה! קיבלנו את הפרטים");
  await shot(visitor, "41-public-form-360");

  step("intake: a bot that fills the hidden field makes no lead");
  const formToken = publicUrl.split("/f/")[1];
  const botReply = await fetch(`${APP}/api/forms/${formToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name: "Bot", phone: "1234567", website_url: "http://spam.example" }),
  }).then((r) => r.json());
  if (!botReply.ok) throw new Error("spam must be answered like a success");
  await ownerDesk.goto(formAdminUrl);
  await expectText(ownerDesk, "ספאם, לא נוצר ליד");
  await ownerDesk.getByRole("link", { name: /גלית מהאתר/ }).click();
  await ownerDesk.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
  await expectText(ownerDesk, "גלית עיצובים");
  await expectText(ownerDesk, "טופס באתר");

  step("intake: a webhook takes JSON with other field names");
  await ownerDesk.goto(`${orgUrl}/settings/intake`);
  await ownerDesk.getByRole("textbox", { name: "שם", exact: true }).fill("Zapier");
  await ownerDesk.getByLabel("סוג").selectOption("webhook");
  await ownerDesk.getByRole("button", { name: "יצירה" }).click();
  await ownerDesk.waitForURL(/\/settings\/intake\/[0-9a-f-]{36}$/);
  const hookAdminUrl = ownerDesk.url();
  const hookUrl = await ownerDesk.getByLabel("כתובת ה-webhook").inputValue();
  const hookReply = await fetch(hookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "אבי מזאפייר", tel: "03-5556677", notes: "הגיע מקמפיין" }),
  });
  console.log("webhook status:", hookReply.status);
  if (hookReply.status !== 200) throw new Error(`webhook answered ${hookReply.status}`);
  const badReply = await fetch(hookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: "בלי פרטים" }) });
  if (badReply.status !== 400) throw new Error(`a webhook without name/phone/email should get 400, got ${badReply.status}`);
  // FXS-02: a body over 32KB is refused before the database, and still counts against the sender's rate limit
  const hugeReply = await fetch(hookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "גדול", notes: "x".repeat(40_000) }) });
  if (hugeReply.status !== 413) throw new Error(`a 40KB webhook body should get 413, got ${hugeReply.status}`);
  const [{ n: hugeLogged }] = await sql("select count(*)::int as n from public.form_submissions s join public.forms f on f.id = s.form_id where f.name = 'Zapier' and s.status = 'spam'");
  if (hugeLogged < 1) throw new Error("the refused body was not counted");
  await ownerDesk.goto(`${orgUrl}/leads?q=${encodeURIComponent("אבי מזאפייר")}`);
  await ownerDesk.getByRole("link", { name: "אבי מזאפייר" }).waitFor({ timeout: 15000 });

  // ---------------------------------------------------------------- section 5: routing and repeat leads
  step("repeat lead: the webhook adds to the existing lead instead of creating one");
  const again = await fetch(hookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "אבי שוב", phone: "+972-3-555-6677", message: "רוצה הצעה עדכנית" }),
  });
  if (again.status !== 200) throw new Error(`repeat webhook answered ${again.status}`);
  await ownerDesk.goto(`${orgUrl}/leads?q=${encodeURIComponent("אבי")}`);
  const aviRows = await ownerDesk.locator("tbody tr").count();
  if (aviRows !== 1) throw new Error(`expected one lead for Avi, found ${aviRows}`);
  await ownerDesk.getByRole("link", { name: "אבי מזאפייר" }).click();
  await expectText(ownerDesk, "פנייה נוספת דרך \"Zapier\"");
  await expectText(ownerDesk, "רוצה הצעה עדכנית");
  await shot(ownerDesk, "50-repeat-inquiry-1280");

  step("repeat lead: a manual lead with a known phone gets a warning first");
  await ownerDesk.goto(`${orgUrl}/leads/new`);
  await ownerDesk.getByLabel("שם מלא").fill("משה שוב");
  await ownerDesk.getByLabel("טלפון").fill("0501234567");
  await ownerDesk.getByLabel("תאריך פגישה").fill("2026-12-01");
  await ownerDesk.getByRole("button", { name: "יצירת ליד" }).click();
  await expectText(ownerDesk, "כבר קיים איש קשר עם הטלפון או האימייל האלה: משה כהן");
  await ownerDesk.getByLabel("ליצור ליד חדש בכל זאת").check();
  await ownerDesk.getByRole("button", { name: "יצירת ליד" }).click();
  await ownerDesk.waitForURL(/\/leads\/[0-9a-f-]{36}$/, { timeout: 15000 });

  step("round robin: leads alternate, and an unavailable rep is skipped");
  await ownerDesk.goto(hookAdminUrl);
  await ownerDesk.getByLabel("בסבב בין הנציגים הזמינים").check();
  await ownerDesk.getByRole("button", { name: "שמירה" }).click();
  await expectText(ownerDesk, "נשמר.");
  const sendLead = async (name, phone) => {
    const r = await fetch(hookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, phone }) });
    if (r.status !== 200) throw new Error(`webhook answered ${r.status}`);
  };
  const ownerOfLead = async (name) => {
    await ownerDesk.goto(`${orgUrl}/leads?q=${encodeURIComponent(name)}`);
    await ownerDesk.getByRole("link", { name }).click();
    await ownerDesk.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
    return (await ownerDesk.locator("dt", { hasText: "בעלים" }).locator("xpath=following-sibling::dd[1]").innerText()).trim();
  };
  await sendLead("סבב אחד", "058-1000001");
  await sendLead("סבב שתיים", "058-1000002");
  const rr = [await ownerOfLead("סבב אחד"), await ownerOfLead("סבב שתיים")];
  console.log("round robin owners:", rr.join(" / "));
  if (rr[0] === rr[1]) throw new Error("round robin should alternate between Ronit and Dana");

  // Dana goes on vacation from her own account menu
  await invitee.goto(orgUrl);
  await invitee.getByRole("button", { name: /דנה חברה/ }).click();
  await invitee.getByRole("switch", { name: "זמין לקבלת לידים" }).uncheck();
  await expectText(invitee, "לידים חדשים בסבב לא יגיעו אליך");
  // the switch answers at once; wait until the server has saved it before sending leads
  for (let i = 0; i < 40; i++) {
    const [{ available }] = await sql(
      "select m.is_available as available from public.memberships m join auth.users u on u.id = m.user_id where u.email = $1",
      [inviteeEmail],
    );
    if (!available) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await sendLead("סבב שלוש", "058-1000003");
  await sendLead("סבב ארבע", "058-1000004");
  const afterVacation = [await ownerOfLead("סבב שלוש"), await ownerOfLead("סבב ארבע")];
  console.log("while Dana is away:", afterVacation.join(" / "));
  if (afterVacation.some((name) => name !== "רונית בעלים")) throw new Error("an unavailable rep got a lead");
  await ownerDesk.goto(`${orgUrl}/settings/users`);
  await expectText(ownerDesk, "לא זמין ללידים");

  // ---------------------------------------------------------------- section 6: automations
  step("automations: a template runs by itself (pg_cron) on a new lead");
  await ownerDesk.goto(`${orgUrl}/settings/automations`);
  await ownerDesk.getByRole("button", { name: /הוספה.*ליד חדש: לחזור תוך 15 דקות/ }).click();
  await ownerDesk.waitForURL(/\/settings\/automations\/[0-9a-f-]{36}$/);
  await expectText(ownerDesk, "יצירת משימה: \"להתקשר ל{{name}}\", בעוד 15 דקות, לבעלים");
  await sendLead("אוטו ליד", "058-2000001");
  let autoTask = false;
  for (let i = 0; i < 24 && !autoTask; i++) {
    await ownerDesk.waitForTimeout(5000);
    await ownerDesk.goto(`${orgUrl}/tasks?who=all`);
    autoTask = (await ownerDesk.getByText("להתקשר לאוטו ליד").count()) > 0;
  }
  console.log("task created by the scheduled engine:", autoTask);
  if (!autoTask) throw new Error("the automation did not run within two minutes");
  await shot(ownerDesk, "60-auto-task-1280");

  step("automations: build a rule, test it on one record, see the log");
  await ownerDesk.goto(`${orgUrl}/settings/automations/new`);
  await ownerDesk.getByLabel("שם האוטומציה").fill("עסקה גדולה מקבלת VIP");
  await ownerDesk.getByLabel("מה קורה").selectOption("deal:created");
  await ownerDesk.getByRole("button", { name: "הוספת תנאי" }).click();
  await ownerDesk.getByLabel("תנאי 1", { exact: true }).selectOption("amount");
  await ownerDesk.getByLabel("ערך לתנאי 1").fill("10,000");
  await ownerDesk.getByLabel("סוג פעולה 1").selectOption("add_tag");
  await ownerDesk.getByLabel("תגית").selectOption({ label: "VIP" });
  await shot(ownerDesk, "61-builder-1280");
  await ownerDesk.getByRole("button", { name: "שמירה והפעלה" }).click();
  await ownerDesk.waitForURL(/\/settings\/automations\/[0-9a-f-]{36}$/);
  const builtRuleUrl = ownerDesk.url();
  await expectText(ownerDesk, "השווי לפחות (₪) 10,000");
  await ownerDesk.getByLabel("רשומה לבדיקה").selectOption({ label: "משה כהן" });
  await ownerDesk.getByRole("button", { name: "הרצת בדיקה" }).click();
  await expectText(ownerDesk, "הבדיקה הסתיימה: כל הפעולות בוצעו");
  await ownerDesk.locator("li", { hasText: "הצליחה" }).first().waitFor();
  await ownerDesk.goto(dealUrl);
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByText("VIP").waitFor();

  step("automations: edit a saved rule; the form starts from what was saved");
  await ownerDesk.goto(builtRuleUrl);
  await ownerDesk.getByRole("link", { name: "עריכה", exact: true }).click();
  await ownerDesk.waitForURL(/\/edit$/);
  if ((await ownerDesk.getByLabel("ערך לתנאי 1").inputValue()) !== "10000") throw new Error("the edit form did not start from the saved condition");
  if ((await ownerDesk.getByLabel("מה קורה").inputValue()) !== "deal:created") throw new Error("the edit form did not start from the saved trigger");
  // the record type stays: only deal triggers are offered
  if (await ownerDesk.getByLabel("מה קורה").locator('option[value="lead:created"]').count()) throw new Error("the edit form offers another record type");
  await ownerDesk.getByLabel("שם האוטומציה").fill("עסקה גדולה מאוד מקבלת VIP");
  await ownerDesk.getByLabel("ערך לתנאי 1").fill("50,000");
  await shot(ownerDesk, "62-builder-edit-1280");
  await ownerDesk.getByRole("button", { name: "שמירת השינויים" }).click();
  await ownerDesk.waitForURL(builtRuleUrl);
  await expectText(ownerDesk, "השווי לפחות (₪) 50,000");
  await expectText(ownerDesk, "עסקה גדולה מאוד מקבלת VIP");
  const editedRule = await sql("select conditions, actions from public.automations where id = $1", [builtRuleUrl.split("/").pop()]);
  if (editedRule[0].conditions[0].value !== "5000000" || editedRule[0].actions[0].type !== "add_tag") throw new Error("the edited rule was not saved as expected");

  // ---------------------------------------------------------------- section 7: notifications
  step("notifications: the bell updates live when a task is assigned");
  await invitee.goto(`${orgUrl}/companies`);
  const inviteeBell = invitee.getByRole("button", { name: /^התראות/ });
  await inviteeBell.waitFor();
  const unreadBefore = await inviteeBell.getAttribute("aria-label");
  await invitee.waitForTimeout(2000); // the realtime channel joins
  await ownerDesk.goto(`${orgUrl}/tasks`);
  await ownerDesk.getByLabel("מה צריך לעשות").fill("משימה חיה לדנה");
  await ownerDesk.getByLabel("באחריות").selectOption({ label: "דנה חברה" });
  await ownerDesk.getByRole("button", { name: "הוספת משימה" }).click();
  // no reload on Dana's side: the count changes by itself
  await invitee.waitForFunction(
    (before) => document.querySelector('button[aria-label^="התראות"]')?.getAttribute("aria-label") !== before,
    unreadBefore,
    { timeout: 15000 },
  );
  console.log("bell after assignment:", await inviteeBell.getAttribute("aria-label"));
  await inviteeBell.click();
  await shot(invitee, "70-bell-open");
  await invitee.getByRole("link", { name: /משימה חדשה הוקצתה לך/ }).first().click();
  await invitee.waitForURL(/\/tasks$/);
  await expectText(invitee, "משימה חיה לדנה");

  step("notifications: a task reminder arrives through the scheduled job");
  await ownerDesk.goto(`${orgUrl}/tasks`);
  await ownerDesk.getByLabel("מה צריך לעשות").fill("תזכורת לבדיקה");
  await ownerDesk.getByLabel("תאריך יעד").fill(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date()));
  await ownerDesk.getByLabel("שעה").fill("00:01");
  await ownerDesk.getByLabel("תזכורת").selectOption({ label: "בזמן היעד" });
  await ownerDesk.getByRole("button", { name: "הוספת משימה" }).click();
  await expectText(ownerDesk, "תזכורת בזמן היעד");
  let reminded = false;
  for (let i = 0; i < 24 && !reminded; i++) {
    await ownerDesk.waitForTimeout(5000);
    await ownerDesk.goto(`${orgUrl}/notifications`);
    reminded = (await ownerDesk.getByText("תזכורת: תזכורת לבדיקה").count()) > 0;
  }
  console.log("reminder delivered by the scheduled job:", reminded);
  if (!reminded) throw new Error("the task reminder did not arrive within two minutes");
  await ownerDesk.getByRole("heading", { name: "התראות לנייד ולמחשב" }).waitFor();
  await ownerDesk.getByRole("button", { name: "סימון הכל כנקרא" }).first().click();
  await ownerDesk.getByRole("button", { name: "סימון הכל כנקרא" }).waitFor({ state: "detached", timeout: 15000 });
  await shot(ownerDesk, "71-notifications-1280");
  await owner.goto(`${orgUrl}/notifications`);
  await shot(owner, "72-notifications-360");
  if (await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("notifications page scrolls sideways at 360px");

  // ---------------------------------------------------------------- section 8: reports
  step("reports: manager dashboard, every report opens, export for managers only");
  await ownerDesk.goto(`${orgUrl}/reports`);
  await expectText(ownerDesk, "תמונת מצב");
  await expectText(ownerDesk, "לידים חדשים החודש");
  await shot(ownerDesk, "80-reports-1280");
  for (const key of ["sources", "funnel", "response", "reps", "activity", "forecast", "lost", "cycle", "stuck", "revenue"]) {
    await ownerDesk.goto(`${orgUrl}/reports/${key}`);
    await ownerDesk.getByRole("link", { name: "כל הדוחות" }).waitFor({ timeout: 15000 });
    if ((await ownerDesk.getByText("משהו השתבש").count()) > 0) throw new Error(`report ${key} failed`);
  }
  await ownerDesk.goto(`${orgUrl}/reports/sources?period=this_year`);
  const sourcesText = await ownerDesk.locator("main").innerText();
  console.log("sources report shows leads:", /לפי מקור/.test(sourcesText));
  await shot(ownerDesk, "81-report-sources-1280");
  const csv = await ownerDesk.context().request.get(`${orgUrl}/reports/revenue/export?period=this_year`);
  const csvBody = await csv.text();
  console.log("export:", csv.status(), csv.headers()["content-type"]);
  if (csv.status() !== 200 || !csvBody.includes("הכנסות")) throw new Error("the owner could not export a report");
  // Dana is a team manager here (allowed to export); as a plain member she may not
  const setDanaRole = async (role, badge) => {
    await ownerDesk.goto(`${orgUrl}/settings/users`);
    await ownerDesk.getByLabel("תפקיד של דנה חברה").selectOption(role);
    await ownerDesk.getByRole("button", { name: "שמירה" }).click();
    await ownerDesk.locator("span", { hasText: badge }).first().waitFor({ timeout: 15000 });
  };
  await setDanaRole("member", /^משתמש$/);
  await invitee.goto(`${orgUrl}/reports/revenue`);
  await expectText(invitee, "הכנסה שנסגרה");
  if ((await invitee.getByText("ייצוא ל-Excel").count()) > 0) throw new Error("a member sees the export button");
  const memberCsv = await invitee.context().request.get(`${orgUrl}/reports/revenue/export`);
  console.log("member export status:", memberCsv.status());
  if (memberCsv.status() !== 403) throw new Error("a member could export");
  await setDanaRole("manager", /^מנהל צוות$/);
  await owner.goto(`${orgUrl}/reports/reps`);
  await shot(owner, "82-report-reps-360");
  if (await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("report scrolls sideways at 360px");
  await owner.goto(`${orgUrl}/reports`);
  await shot(owner, "83-reports-360");
  if (await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("reports page scrolls sideways at 360px");

  // ---------------------------------------------------------------- section 9: import and export
  step("import: a CSV of leads with a duplicate, a repeat and a bad row; then undo");
  await ownerDesk.goto(`${orgUrl}/settings/import`);
  await ownerDesk.getByRole("link", { name: "ייבוא קובץ" }).click();
  await ownerDesk.getByLabel("לידים", { exact: true }).check();
  const leadsCsv = [
    "שם מלא,טלפון,אימייל,הערות",
    "יובל מהקובץ,0521110001,yuval@example.test,ראשון",
    "נועה מהקובץ,521110002,,טלפון בלי 0 כמו ב-Excel",
    "קיים כבר,058-1000001,,כפילות של ליד קיים",
    ",,,שורה בלי שם טלפון או אימייל",
    "יובל שוב,052-111-0001,,כפילות בתוך הקובץ",
    "דורון מהקובץ,,doron@example.test,",
  ].join("\n");
  await ownerDesk.locator('input[type="file"]').setInputFiles({ name: "לידים.csv", mimeType: "text/csv", buffer: Buffer.from("﻿" + leadsCsv, "utf8") });
  await expectText(ownerDesk, "6 שורות");
  if ((await ownerDesk.getByLabel("שדה לעמודה טלפון").inputValue()) !== "phone") throw new Error("the phone column was not mapped by itself");
  if ((await ownerDesk.getByLabel("שדה לעמודה הערות").inputValue()) !== "message") throw new Error("the notes column was not mapped by itself");
  await ownerDesk.getByRole("button", { name: "בדיקת 20 השורות הראשונות" }).click();
  await expectText(ownerDesk, "חסר שם, טלפון או אימייל");
  await shot(ownerDesk, "90-import-preview-1280");
  await ownerDesk.getByRole("button", { name: "ייבוא 6 שורות" }).click();
  await expectText(ownerDesk, "הייבוא הסתיים");
  const importSummary = await ownerDesk.locator("dl").last().innerText();
  console.log("import summary:", importSummary.replace(/\s+/g, " "));
  if (!/נוצרו\s*3/.test(importSummary) || !/דולגו \(כבר קיימים\)\s*2/.test(importSummary) || !/נכשלו\s*1/.test(importSummary)) throw new Error("unexpected import counts");
  await ownerDesk.getByRole("button", { name: /הורדת 1 השורות שנכשלו/ }).waitFor();
  await ownerDesk.goto(`${orgUrl}/leads?q=${encodeURIComponent("נועה מהקובץ")}`);
  await ownerDesk.getByRole("link", { name: "נועה מהקובץ" }).click();
  await expectText(ownerDesk, "0521110002"); // the leading 0 Excel drops is restored
  await ownerDesk.goto(`${orgUrl}/settings/import`);
  await shot(ownerDesk, "91-import-history-1280");
  await ownerDesk.getByRole("button", { name: /^ביטול הייבוא/ }).first().click();
  await ownerDesk.getByRole("button", { name: /^(כן|אישור)/ }).first().click();
  await expectText(ownerDesk, "בוטל");
  await ownerDesk.goto(`${orgUrl}/leads?q=${encodeURIComponent("יובל מהקובץ")}`);
  if ((await ownerDesk.getByRole("link", { name: "יובל מהקובץ" }).count()) > 0) throw new Error("undo did not remove the imported lead");

  step("import: contacts from a Windows-1255 CSV, companies from an xlsx");
  const cp1255 = (text) => Buffer.from([...text].map((ch) => {
    const code = ch.codePointAt(0);
    if (code >= 0x5d0 && code <= 0x5ea) return code - 0x5d0 + 0xe0;
    if (code < 0x80) return code;
    throw new Error(`no cp1255 byte for ${ch}`);
  }));
  await ownerDesk.goto(`${orgUrl}/settings/import/new`);
  await ownerDesk.getByLabel("אנשי קשר", { exact: true }).check();
  await ownerDesk.locator('input[type="file"]').setInputFiles({
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: cp1255("שם פרטי,שם משפחה,טלפון,חברה,תאריך לידה\nאורית,לוי,0547770001,חברת ייבוא,15/03/1985\n"),
  });
  await expectText(ownerDesk, "1 שורות");
  await ownerDesk.getByRole("button", { name: "בדיקת 20 השורות הראשונות" }).click();
  await ownerDesk.getByRole("button", { name: "ייבוא 1 שורות" }).click();
  await expectText(ownerDesk, "הייבוא הסתיים");
  await ownerDesk.goto(`${orgUrl}/contacts?q=${encodeURIComponent("אורית")}`);
  await ownerDesk.getByRole("link", { name: /אורית לוי/ }).click();
  await expectText(ownerDesk, "חברת ייבוא");

  const sheetXml = (rows) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => (typeof v === "number" ? `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${v}</v></c>` : `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)).join("")}</row>`)
      .join("")}</sheetData></worksheet>`;
  const xlsx = zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="חברות" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml([["שם החברה", "ח.פ.", "עיר", "טלפון"], ["אקסל בע\"מ", 515151515, "חיפה", 48001122]])),
  });
  await ownerDesk.goto(`${orgUrl}/settings/import/new`);
  await ownerDesk.getByLabel("חברות", { exact: true }).check();
  await ownerDesk.locator('input[type="file"]').setInputFiles({ name: "companies.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(xlsx) });
  await expectText(ownerDesk, "1 שורות");
  await ownerDesk.getByRole("button", { name: "בדיקת 20 השורות הראשונות" }).click();
  await ownerDesk.getByRole("button", { name: "ייבוא 1 שורות" }).click();
  await expectText(ownerDesk, "הייבוא הסתיים");
  await ownerDesk.goto(`${orgUrl}/companies?q=${encodeURIComponent("אקסל")}`);
  await ownerDesk.getByRole("link", { name: /אקסל בע"מ/ }).click();
  await expectText(ownerDesk, "515151515");
  await expectText(ownerDesk, "חיפה");

  step("import: undoing a contacts import removes the company it created, not one that was there (FXC-02)");
  await ownerDesk.goto(`${orgUrl}/settings/import/new`);
  await ownerDesk.getByLabel("אנשי קשר", { exact: true }).check();
  await ownerDesk.locator('input[type="file"]').setInputFiles({
    name: "contacts-2.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("﻿שם פרטי,שם משפחה,טלפון,חברה\nרון,זמני,0547770002,חברה זמנית\nשירה,זמנית,0547770003,\"אקסל בע\"\"מ\"\n", "utf8"),
  });
  await expectText(ownerDesk, "2 שורות");
  await ownerDesk.getByRole("button", { name: "בדיקת 20 השורות הראשונות" }).click();
  await ownerDesk.getByRole("button", { name: "ייבוא 2 שורות" }).click();
  await expectText(ownerDesk, "הייבוא הסתיים");
  const tempCompanies = async () => (await sql("select count(*)::int as n from public.companies where organization_id = $1 and deleted_at is null and name in ('חברה זמנית', 'אקסל בע\"מ')", [orgUrl.split("/").pop()]))[0].n;
  if ((await tempCompanies()) !== 2) throw new Error("the contacts import did not create its company or matched the wrong one");
  await ownerDesk.goto(`${orgUrl}/settings/import`);
  await ownerDesk.getByRole("button", { name: /^ביטול הייבוא/ }).first().click();
  await ownerDesk.getByRole("button", { name: /^(כן|אישור)/ }).first().click();
  // "בוטל" is already on the page from the leads import: wait for the database instead
  for (let i = 0; i < 40 && (await tempCompanies()) !== 1; i++) await new Promise((r) => setTimeout(r, 250));
  const left = (await sql("select name from public.companies where organization_id = $1 and deleted_at is null and name in ('חברה זמנית', 'אקסל בע\"מ')", [orgUrl.split("/").pop()])).map((r) => r.name);
  if (left.length !== 1 || left[0] !== 'אקסל בע"מ') throw new Error(`undo left the wrong companies: ${left.join(", ")}`);

  step("export: the owner downloads everything; a team manager may not");
  const zipRes = await ownerDesk.context().request.get(`${orgUrl}/settings/import/export`);
  const zipBytes = await zipRes.body();
  console.log("full export:", zipRes.status(), zipRes.headers()["content-type"], `${zipBytes.length} bytes`);
  if (zipRes.status() !== 200 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) throw new Error("full export is not a zip");
  const zipEntries = Object.keys(unzipSync(new Uint8Array(zipBytes)));
  const imageEntry = zipEntries.find((n) => n.startsWith("files/") && n.endsWith("תמונה.png"));
  console.log("export has files.csv:", zipEntries.includes("files.csv"), "and the uploaded image:", Boolean(imageEntry));
  if (!zipEntries.includes("files.csv") || !imageEntry) throw new Error("the full export is missing the files");
  const danaZip = await invitee.context().request.get(`${orgUrl}/settings/import/export`);
  console.log("manager full export status:", danaZip.status());
  if (danaZip.status() !== 403) throw new Error("a team manager downloaded the full export");
  await owner.goto(`${orgUrl}/settings/import/new`);
  await shot(owner, "92-import-360");
  if (await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("import page scrolls sideways at 360px");

  // ---------------------------------------------------------------- section 11: platform admin
  step("platform: staff only, two-step verification, organizations, support access with consent");
  const staffEmail = `staff-${run}@example.test`;
  const staff = await newPage(1280);
  await signUp(staff, "צוות פלטפורמה", staffEmail, `${APP}/signup`);
  await sql("insert into app.platform_staff (user_id, role) select id, 'owner' from auth.users where email = $1", [staffEmail]);
  // a customer who is not staff: the panel does not exist for them
  const notStaff = await invitee.goto(`${APP}/admin`);
  console.log("admin panel for a customer:", notStaff?.status());
  if (notStaff?.status() !== 404) throw new Error("a customer reached the admin panel");
  await staff.goto(`${APP}/admin`);
  await expectText(staff, "אימות דו-שלבי");
  const secret = (await staff.locator("code").first().innerText()).trim();
  await staff.getByLabel("קוד אימות").fill(totp(secret));
  await staff.getByRole("button", { name: "אימות" }).click();
  await expectText(staff, "הכנסה חודשית חוזרת");
  await shot(staff, "100-admin-metrics-1280");



  await staff.goto(`${APP}/admin/orgs?q=${encodeURIComponent("שיפוצים")}`);
  await staff.getByRole("link", { name: /שיפוצים/ }).first().click();
  await expectText(staff, "הלקוח לא אישר גישת תמיכה");
  // the customer lets support in for an hour
  await ownerDesk.goto(`${orgUrl}/settings/business`);
  await ownerDesk.getByRole("button", { name: "לשעה" }).click();
  await expectText(ownerDesk, "גישת תמיכה פתוחה עד");
  await staff.reload();
  await staff.getByRole("button", { name: "כניסה לארגון (צפייה)" }).click();
  await staff.waitForURL(new RegExp(`/o/${orgUrl.split("/o/")[1]}$`));
  await expectText(staff, "מצב תמיכה: צפייה בלבד");
  await staff.goto(`${orgUrl}/leads`);
  await expectText(staff, "משה כהן");
  if ((await staff.getByRole("link", { name: "ליד חדש" }).count()) > 0) throw new Error("support sees the new lead button");
  await shot(staff, "101-support-session-1280");
  const opened = await sql("select count(*)::int as n from public.audit_log where organization_id = $1 and action = 'support_open'", [orgUrl.split("/o/")[1]]);
  console.log("support entries in the customer's audit log:", opened[0].n);
  if (opened[0].n < 1) throw new Error("support access was not logged for the customer");

  // a plan change, with its reason in the platform log
  await staff.goto(`${APP}/admin/orgs/${orgUrl.split("/o/")[1]}`);
  await staff.getByLabel("חבילה", { exact: true }).selectOption({ label: "עסקי" });
  await staff.getByLabel("סיבה (נרשמת ביומן)").first().fill("פיילוט בבדיקה");
  await staff.getByRole("button", { name: "שמירה" }).first().click();
  await expectText(staff, "נשמר.");
  await staff.reload();
  await expectText(staff, "פיילוט בבדיקה");
  await shot(staff, "102-admin-org-1280");

  // the customer closes the door: support is out at once
  await ownerDesk.goto(`${orgUrl}/settings/business`);
  await ownerDesk.getByRole("button", { name: "סגירת הגישה עכשיו" }).click();
  await ownerDesk.getByRole("button", { name: "לשעה" }).waitFor({ timeout: 15000 });
  const afterRevoke = await staff.goto(`${orgUrl}/leads`);
  console.log("support after the customer revoked:", afterRevoke?.status());
  if (afterRevoke?.status() !== 404) throw new Error("support kept access after it was revoked");
  const staffPhone = await newPage(360);
  await staffPhone.context().addCookies(await staff.context().cookies());
  await staffPhone.goto(`${APP}/admin/orgs`);
  await shot(staffPhone, "103-admin-orgs-360");
  if (await staffPhone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("admin page scrolls sideways at 360px");

  step("design gallery: every shared component, light and dark, 360px and 1280px (DSN-07, DSN-08)");
  await staff.goto(`${APP}/admin/design`);
  await expectText(staff, "כל הרכיבים המשותפים");
  await shot(staff, "104-design-gallery-1280");
  await staffPhone.goto(`${APP}/admin/design`);
  await expectText(staffPhone, "כל הרכיבים המשותפים");
  await shot(staffPhone, "105-design-gallery-360");
  if (await staffPhone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error("design gallery scrolls sideways at 360px");
  // FXA-01: a popover stays inside a 360px screen
  const bell = staffPhone.getByRole("button", { name: "התראות" }).first();
  await bell.click();
  const panel = await staffPhone.getByRole("dialog", { name: "התראות" }).first().boundingBox();
  console.log("popover at 360px:", panel);
  if (!panel || panel.x < 0 || panel.x + panel.width > 360) throw new Error("popover runs off a 360px screen");
  await staffPhone.keyboard.press("Escape");
  if ((await bell.getAttribute("aria-expanded")) !== "false") throw new Error("Escape did not close the popover");
  // the dialog: opens, Escape closes it
  await staffPhone.getByRole("button", { name: "פתיחת מגירה" }).first().click();
  await staffPhone.getByRole("dialog", { name: "מגירה תחתונה" }).waitFor();
  await shot(staffPhone, "106-design-sheet-360");
  await staffPhone.keyboard.press("Escape");
  await staffPhone.getByRole("dialog", { name: "מגירה תחתונה" }).waitFor({ state: "hidden" });
  // the date picker: weeks start on Sunday; the left arrow is the next day in Hebrew
  await staffPhone.getByRole("button", { name: /תאריך יעד/ }).first().click();
  const grid = staffPhone.getByRole("grid").first();
  const firstHeader = await grid.locator("th").first().textContent();
  if (firstHeader !== "א׳") throw new Error(`the week starts on ${firstHeader}, not Sunday`);
  await staffPhone.getByRole("button", { name: "יום שישי, 9 באוקטובר 2026" }).first().focus();
  await staffPhone.keyboard.press("ArrowLeft");
  await staffPhone.keyboard.press("Enter");
  await expectText(staffPhone, "10.10.2026");
  // the confirm: a failed action keeps the window open with its message
  await staffPhone.getByRole("button", { name: "אישור שנכשל" }).first().click();
  await staffPhone.getByRole("button", { name: "כן, להעביר" }).click();
  await expectText(staffPhone, "לא הצלחנו להעביר לסל");
  await shot(staffPhone, "107-design-confirm-error-360");
  await staffPhone.keyboard.press("Escape");

  step("phone width: tasks and deal card");
  await owner.goto(`${orgUrl}/tasks`);
  await expectText(owner, "משימות פתוחות");
  await shot(owner, "24-tasks-360");
  const tasksOverflow = await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await owner.goto(dealUrl);
  await expectText(owner, "פרטי העסקה");
  await shot(owner, "25-deal-360");
  const overflow = tasksOverflow || (await owner.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  console.log("horizontal overflow at 360px (tasks, deal card):", overflow);
  if (overflow) throw new Error("page scrolls sideways at 360px");

  // ---------------------------------------------------------------- section 12: security and account (last: it turns on 2FA)
  step("security: forgotten password by email");
  const resetEmail = `reset-${run}@example.test`;
  const resetter = await newPage(1280);
  await signUp(resetter, "שוכח סיסמה", resetEmail, `${APP}/signup`);
  const fresh = await newPage(1280);
  await fresh.goto(`${APP}/login`);
  await fresh.getByRole("link", { name: "שכחתי סיסמה" }).click();
  await fresh.waitForURL(/\/forgot-password$/);
  await fresh.waitForLoadState("networkidle");
  await fresh.getByLabel("אימייל").fill(resetEmail);
  await fresh.getByRole("button", { name: "שליחת קישור" }).click();
  await expectText(fresh, "שלחנו אליה קישור");
  const resetLink = await mailLink(resetEmail, "Reset");
  await fresh.goto(resetLink);
  await fresh.waitForURL(/\/reset-password/);
  await fresh.waitForLoadState("networkidle");
  await fresh.getByLabel("סיסמה חדשה").fill("New-pass-67890");
  await fresh.getByLabel("הסיסמה שוב").fill("New-pass-67890");
  await fresh.getByRole("button", { name: "שמירת הסיסמה" }).click();
  await expectText(fresh, "הסיסמה עודכנה");
  const relogin = await newPage(1280);
  await relogin.goto(`${APP}/login`);
  await relogin.waitForLoadState("networkidle");
  await relogin.getByLabel("אימייל").fill(resetEmail);
  await relogin.getByLabel("סיסמה").fill("New-pass-67890");
  await relogin.getByRole("button", { name: "כניסה" }).click();
  await relogin.waitForURL((url) => !url.pathname.startsWith("/login"));
  console.log("signed in with the new password:", relogin.url());

  step("notifications: each user chooses which kinds to get, and where");
  await ownerDesk.goto(`${orgUrl}/settings/account`);
  await ownerDesk.getByLabel("התראות מאוטומציות").selectOption("off");
  await ownerDesk.getByLabel("רשומה או משימה הוקצתה לי").selectOption("bell");
  await ownerDesk.getByRole("button", { name: "שמירת ההעדפות" }).click();
  await expectText(ownerDesk, "ההעדפות נשמרו.");
  await shot(ownerDesk, "105-notification-settings-1280");
  // after saving, the form still shows what was chosen
  if ((await ownerDesk.getByLabel("התראות מאוטומציות").inputValue()) !== "off") throw new Error("the form went back to the old choice after saving");
  const [prefs] = await sql("select s.muted, s.no_push from public.notification_settings s join auth.users u on u.id = s.user_id where u.email = $1", [ownerEmail]);
  if (prefs.muted.join() !== "automation" || prefs.no_push.join() !== "assigned") throw new Error(`notification settings not saved: ${JSON.stringify(prefs)}`);
  const [{ n: mutedCount }] = await sql(
    `with u as (select id from auth.users where email = $1),
          ins as (insert into public.notifications (organization_id, user_id, type, title)
                  select $2, u.id, 'automation', 'מושתק' from u returning id)
     select count(*)::int as n from ins`,
    [ownerEmail, orgUrl.split("/").pop()],
  );
  if (mutedCount !== 0) throw new Error("a muted notification was still created");
  await ownerDesk.reload();
  if ((await ownerDesk.getByLabel("התראות מאוטומציות").inputValue()) !== "off") throw new Error("the saved choice is not shown");
  await ownerDesk.getByLabel("התראות מאוטומציות").selectOption("all");
  await ownerDesk.getByLabel("רשומה או משימה הוקצתה לי").selectOption("all");
  await ownerDesk.getByRole("button", { name: "שמירת ההעדפות" }).click();
  await expectText(ownerDesk, "ההעדפות נשמרו.");

  step("security: two-step verification for me, then required for the whole business");
  await ownerDesk.goto(`${orgUrl}/settings/account`);
  await ownerDesk.getByRole("button", { name: "הפעלת אימות דו-שלבי" }).click();
  const ownerSecret = (await ownerDesk.locator("code").first().innerText()).trim();
  await ownerDesk.getByLabel("קוד אימות").fill(await freshTotp(ownerSecret));
  await ownerDesk.getByRole("button", { name: "אימות", exact: true }).click();
  await expectText(ownerDesk, "אימות דו-שלבי פעיל בחשבון שלך");
  await shot(ownerDesk, "110-account-1280");
  await ownerDesk.goto(`${orgUrl}/settings/business`);
  await ownerDesk.getByRole("button", { name: "חיוב אימות דו-שלבי לכולם" }).click();
  await ownerDesk.getByRole("button", { name: "כן" }).click();
  await expectText(ownerDesk, "כל המשתמשים בעסק חייבים אימות דו-שלבי");
  // Dana has no authenticator yet: she is sent to set one up before she can open the business
  await invitee.goto(`${orgUrl}/leads`);
  await invitee.waitForURL(/\/login\/mfa/);
  const danaSecret = (await invitee.locator("code").first().innerText()).trim();
  await invitee.getByLabel("קוד אימות").fill(await freshTotp(danaSecret));
  await invitee.getByRole("button", { name: "אימות", exact: true }).click();
  await invitee.waitForURL((url) => url.pathname === `/o/${orgUrl.split("/o/")[1]}`);
  await invitee.goto(`${orgUrl}/leads`);
  await invitee.getByRole("heading", { name: "לידים", level: 1 }).waitFor({ timeout: 15000 });
  // turning on two-step verification signed the owner out of every other device (Supabase does this);
  // the phone signs in again: password, then the code
  await owner.goto(orgUrl);
  await owner.waitForURL(/\/login(\?|$)/, { timeout: 30000 });
  await owner.waitForLoadState("networkidle");
  await owner.getByLabel("אימייל").fill(ownerEmail);
  await owner.getByLabel("סיסמה").fill(PASSWORD);
  await owner.getByRole("button", { name: "כניסה" }).click();
  await owner.waitForURL(/\/login\/mfa/);
  await shot(owner, "111-mfa-360");
  await owner.getByLabel("קוד אימות").fill(await freshTotp(ownerSecret));
  await owner.getByRole("button", { name: "אימות", exact: true }).click();
  await owner.waitForURL((url) => url.pathname.startsWith("/o/"));
  await owner.getByRole("heading", { level: 1 }).first().waitFor();

  step("security: devices, sign out the others; audit log and record history");
  await ownerDesk.goto(`${orgUrl}/settings/account`);
  await expectText(ownerDesk, "המכשיר הזה");
  const devices = await ownerDesk.locator("#account-sessions").locator("xpath=ancestor::section[1]").locator("li").count();
  console.log("devices listed for the owner:", devices);
  await ownerDesk.getByRole("button", { name: "ניתוק כל המכשירים האחרים" }).click();
  await ownerDesk.getByRole("button", { name: "כן" }).click();
  // the list is re-read after the action: one device left (this one)
  const deviceRows = ownerDesk.locator("#account-sessions").locator("xpath=ancestor::section[1]").locator("li");
  for (let i = 0; i < 30 && (await deviceRows.count()) > 1; i++) await ownerDesk.waitForTimeout(500);
  console.log("devices after signing out the others:", await deviceRows.count());
  await owner.goto(`${orgUrl}/leads`);
  console.log("the owner's phone after 'sign out the others':", new URL(owner.url()).pathname);
  if (!owner.url().includes("/login")) throw new Error("the other device stayed signed in");
  await ownerDesk.goto(`${orgUrl}/settings/audit?entity=leads`);
  await expectText(ownerDesk, "יצירה");
  await shot(ownerDesk, "112-audit-1280");
  await ownerDesk.goto(`${orgUrl}/settings/audit?tab=logins`);
  await expectText(ownerDesk, "כניסה");
  await ownerDesk.goto(`${orgUrl}/leads?q=${encodeURIComponent("סבב אחד")}`);
  await ownerDesk.getByRole("link", { name: "סבב אחד" }).click();
  await ownerDesk.getByText(/היסטוריית שינויים/).click();
  await shot(ownerDesk, "113-record-history-1280");

  step("security: backup codes; a lost phone gets in with one and sets up a new authenticator");
  await ownerDesk.goto(`${orgUrl}/settings/account`);
  await expectText(ownerDesk, "אין לך קודי גיבוי");
  await ownerDesk.getByRole("button", { name: "יצירת קודי גיבוי" }).click();
  const codeList = ownerDesk.getByRole("list", { name: "קודי גיבוי" });
  await codeList.waitFor();
  const backupCodes = (await codeList.locator("li").allInnerTexts()).map((c) => c.trim());
  if (backupCodes.length !== 10) throw new Error(`expected 10 backup codes, got ${backupCodes.length}`);
  await shot(ownerDesk, "114-backup-codes-1280");
  await ownerDesk.getByRole("button", { name: "שמרתי את הקודים" }).click();
  await expectText(ownerDesk, "נשארו 10 קודי גיבוי");

  const lost = await newPage(360);
  await lost.goto(`${APP}/login`);
  await lost.waitForLoadState("networkidle");
  await lost.getByLabel("אימייל").fill(ownerEmail);
  await lost.getByLabel("סיסמה").fill(PASSWORD);
  await lost.getByRole("button", { name: "כניסה" }).click();
  await lost.waitForURL(/\/login\/mfa/);
  await lost.getByRole("button", { name: /כניסה עם קוד גיבוי/ }).click();
  await lost.getByLabel("קוד גיבוי").fill("0000-0000-0000");
  await lost.getByRole("button", { name: "כניסה עם קוד גיבוי", exact: true }).click();
  await expectText(lost, "הקוד לא נכון");
  await lost.getByLabel("קוד גיבוי").fill(backupCodes[0].toUpperCase());
  await lost.getByRole("button", { name: "כניסה עם קוד גיבוי", exact: true }).click();
  // the business requires two-step verification, so a new authenticator is set up right away
  await lost.getByRole("img", { name: "קוד QR לחיבור אפליקציית האימות" }).waitFor({ timeout: 15000 });
  const newSecret = (await lost.locator("code").first().innerText()).trim();
  await lost.getByLabel("קוד אימות").fill(await freshTotp(newSecret));
  await lost.getByRole("button", { name: "אימות", exact: true }).click();
  await lost.waitForURL((url) => url.pathname.startsWith("/o/"), { timeout: 30000 });
  await lost.goto(`${orgUrl}/settings/account`);
  await expectText(lost, "אימות דו-שלבי פעיל בחשבון שלך");
  await expectText(lost, "אין לך קודי גיבוי");
  await lost.goto(`${orgUrl}/settings/audit?entity=memberships`);
  await expectText(lost, "כניסה עם קוד גיבוי");
  // using a code signs out every other device
  await ownerDesk.goto(`${orgUrl}/leads`);
  if (!new URL(ownerDesk.url()).pathname.startsWith("/login")) throw new Error("the other device stayed signed in after a backup code");
  console.log("backup code used, new authenticator set up");

  step("global search: Ctrl+K, a typo, Enter opens the record; '/' opens it too");
  await lost.goto(orgUrl);
  await lost.waitForLoadState("networkidle");
  await lost.keyboard.press("Control+k");
  const searchBox = lost.getByRole("combobox", { name: /חיפוש לידים/ });
  await searchBox.fill("סבב אחת");
  await lost.getByRole("option", { name: /סבב אחד/ }).first().waitFor({ timeout: 15000 });
  await shot(lost, "116-search-360");
  await searchBox.press("Enter");
  await lost.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
  await lost.keyboard.press("/");
  await searchBox.fill("0000000000xyz");
  await expectText(lost, "לא נמצא דבר");
  await searchBox.press("Escape");

  step("signed agreement: the owner sees the signed copy with the drawn signature");
  await lost.goto(`${APP}/agreement/signed`);
  await lost.getByRole("img", { name: "החתימה של רונית בעלים" }).waitFor();
  await expectText(lost, "טביעת המסמך (SHA-256)");
  await shot(lost, "115-signed-agreement-360");

  step("security: an admin resets the two-step verification of a member who lost everything");
  await lost.goto(`${orgUrl}/settings/users`);
  await lost.getByRole("button", { name: /איפוס אימות דו-שלבי.*דנה חברה/ }).click();
  await lost.getByRole("button", { name: "כן" }).click();
  // Dana is signed out everywhere, and sets up a new authenticator at the next sign-in
  for (let i = 0; i < 20; i++) {
    await invitee.goto(`${orgUrl}/leads`);
    if (new URL(invitee.url()).pathname.startsWith("/login")) break;
    await invitee.waitForTimeout(500);
  }
  if (!new URL(invitee.url()).pathname.startsWith("/login")) throw new Error("the member stayed signed in after the reset");
  await invitee.waitForLoadState("networkidle");
  await invitee.getByLabel("אימייל").fill(inviteeEmail);
  await invitee.getByLabel("סיסמה").fill(PASSWORD);
  await invitee.getByRole("button", { name: "כניסה" }).click();
  await invitee.waitForURL(/\/login\/mfa/);
  await invitee.getByRole("img", { name: "קוד QR לחיבור אפליקציית האימות" }).waitFor({ timeout: 15000 });
  await lost.goto(`${orgUrl}/settings/audit?entity=memberships`);
  await expectText(lost, "איפוס אימות דו-שלבי");

  step("duplicates: the record page offers a merge; picked values stay, the duplicate goes");
  const makeLead = async (name, force) => {
    await lost.goto(`${orgUrl}/leads/new`);
    await lost.waitForLoadState("networkidle");
    await lost.getByLabel("שם מלא").fill(name);
    await lost.getByLabel("טלפון").fill("054-9998877");
    // a required custom field defined earlier in the flow
    await lost.getByLabel("תאריך פגישה").fill("2026-12-01");
    await lost.getByRole("button", { name: "יצירת ליד" }).click();
    if (force) {
      await lost.getByLabel("ליצור ליד חדש בכל זאת").check();
      await lost.getByRole("button", { name: "יצירת ליד" }).click();
    }
    await lost.waitForURL(/\/leads\/[0-9a-f-]{36}$/, { timeout: 15000 });
    return lost.url();
  };
  const firstDupUrl = await makeLead("כפול ראשון", false);
  const secondDupUrl = await makeLead("כפול שני", true);
  await lost.getByRole("heading", { name: "כפילויות אפשריות" }).waitFor();
  await lost.getByRole("link", { name: /מיזוג.*כפול ראשון/ }).click();
  await lost.waitForURL(/\/merge\?/);
  await lost.getByRole("radiogroup", { name: "שם מלא" }).getByLabel(/כפול ראשון/).check();
  await shot(lost, "117-merge-360");
  await lost.getByRole("button", { name: "מיזוג" }).click();
  await lost.waitForURL((url) => url.href === secondDupUrl, { timeout: 15000 });
  await lost.getByRole("heading", { name: "כפול ראשון", level: 1 }).waitFor();
  await expectText(lost, "מוזג עם רשומה כפולה");
  await lost.goto(firstDupUrl);
  await expectText(lost, "הרשומה לא נמצאה");

  step("files: a deleted row's stored file is removed at night (database -> pg_net -> app -> Storage)");
  const [{ path: orphanPath }] = await sql("delete from public.files where name = 'תמונה.png' returning storage_path as path");
  await sql("select app.cleanup_files()");
  let objectGone = false;
  for (let i = 0; i < 40 && !objectGone; i++) {
    const [{ n }] = await sql("select count(*)::int as n from storage.objects where bucket_id = 'record-files' and name = $1", [orphanPath]);
    objectGone = n === 0;
    if (!objectGone) await new Promise((r) => setTimeout(r, 500));
  }
  const [{ n: queued }] = await sql("select count(*)::int as n from app.orphan_files where storage_path = $1", [orphanPath]);
  console.log("orphan file removed from storage:", objectGone, "queue left:", queued);
  if (!objectGone || queued !== 0) throw new Error("the nightly file cleanup did not remove the object");

  step("handover: an admin moves all of a member's records to another user");
  await lost.goto(`${orgUrl}/settings/users`);
  await lost.getByRole("link", { name: /העברת רשומות.*דנה חברה/ }).click();
  await lost.waitForURL(/\/transfer$/);
  await lost.getByLabel("למי להעביר").selectOption({ label: "רונית בעלים" });
  await lost.getByRole("button", { name: "העברת כל הרשומות" }).click();
  await expectText(lost, "הועברו");
  const [{ n: danaOwns }] = await sql(
    "select count(*)::int as n from public.leads l join auth.users u on u.id = l.owner_id where u.email = $1",
    [inviteeEmail],
  );
  console.log("Dana's leads after the handover:", danaOwns);
  if (danaOwns !== 0) throw new Error("records were left with the member");

  // a blocked resource is a broken screen (FXS-05: file thumbnails were blocked once)
  const blocked = errors.filter((e) => e.includes("Content Security Policy"));
  if (blocked.length) throw new Error(`the security policy blocked ${blocked.length} resources: ${blocked[0].slice(0, 200)}`);
  console.log("\nFLOW OK");
  process.exitCode = 0;
} catch (error) {
  console.log("\nFLOW FAILED:", error.message);
  process.exitCode = 1;
  const pages = browser.contexts().flatMap((c) => c.pages());
  const last = pages[pages.length - 1];
  if (last) {
    console.log("url:", last.url());
    await shot(last, "zz-failure");
    console.log((await last.locator("main, body").first().innerText()).slice(0, 800));
  }
} finally {
  console.log("\nbrowser errors:", errors.length ? errors.join("\n") : "none");
  await browser.close();
}
