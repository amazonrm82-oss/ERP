// End-to-end check of the main path, in a real browser, against a LOCAL stack:
//   npx supabase start                      (Docker; uses supabase/config.toml)
//   npm run dev with the local URL and publishable key in .env.local
//   npm run test:e2e
// sign up -> confirm email (read from the local Mailpit inbox) -> create the
// business -> lead -> note -> convert -> deal board -> settings -> invite a
// second user -> they sign up from the link and join -> roles, teams, suspend.
// It refuses to run against anything that is not on this machine.
import { createHmac } from "node:crypto";

import { strToU8, zipSync } from "fflate";
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

  step("settings: business details");
  await owner.goto(`${orgUrl}/settings`);
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
  await shot(invitee, "07-invite-accept-1280");
  await invitee.getByRole("button", { name: "הצטרפות לעסק" }).click();
  await invitee.waitForURL(/\/o\/[0-9a-f-]{36}$/, { timeout: 15000 });
  if (!invitee.url().startsWith(orgUrl)) throw new Error("joined a different org?");
  await invitee.goto(`${orgUrl}/settings/users`);
  await shot(invitee, "08-users-as-member-1280");
  const inviteeSeesInvite = await invitee.getByText("הזמנת משתמש").count();
  console.log("member sees invite form:", inviteeSeesInvite);

  step("invite link reused -> rejected");
  await invitee.goto(inviteLink);
  await invitee.getByRole("button", { name: "הצטרפות לעסק" }).click();
  await expectText(invitee, "אינה בתוקף");

  // ---------------------------------------------------------------- owner manages, desktop
  step("owner: change role, team, suspend");
  const ownerDesk = await newPage(1280);
  await ownerDesk.goto(`${APP}/login`);
  await ownerDesk.getByLabel("אימייל").fill(ownerEmail);
  await ownerDesk.getByLabel("סיסמה").fill(PASSWORD);
  await ownerDesk.getByRole("button", { name: "כניסה" }).click();
  await ownerDesk.waitForURL(/\/o\//);
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

  step("tags: create on a record, filter the list, save a view");
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByRole("button", { name: "עריכת תגיות" }).click();
  await ownerDesk.getByLabel("תגית חדשה").fill("VIP");
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByRole("button", { name: "שמירה" }).click();
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByText("VIP").waitFor({ timeout: 15000 });
  await ownerDesk.goto(`${orgUrl}/leads`);
  await ownerDesk.getByRole("combobox", { name: "תגית" }).selectOption({ label: "VIP" });
  await ownerDesk.getByRole("button", { name: "חיפוש" }).click();
  await ownerDesk.waitForURL(/tag=/);
  const rows = await ownerDesk.locator("tbody tr").count();
  console.log("leads tagged VIP:", rows);
  if (rows !== 1) throw new Error("tag filter should leave exactly one lead");
  await ownerDesk.getByRole("button", { name: "שמירת הסינון כתצוגה" }).click();
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
  await expectText(ownerDesk, "השווי לפחות (₪) 10,000");
  await ownerDesk.getByLabel("רשומה לבדיקה").selectOption({ label: "משה כהן" });
  await ownerDesk.getByRole("button", { name: "הרצת בדיקה" }).click();
  await expectText(ownerDesk, "הבדיקה הסתיימה: כל הפעולות בוצעו");
  await ownerDesk.locator("li", { hasText: "הצליחה" }).first().waitFor();
  await ownerDesk.goto(dealUrl);
  await ownerDesk.locator("section", { has: ownerDesk.getByRole("heading", { name: "תגיות" }) }).getByText("VIP").waitFor();

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

  step("export: the owner downloads everything; a team manager may not");
  const zipRes = await ownerDesk.context().request.get(`${orgUrl}/settings/import/export`);
  const zipBytes = await zipRes.body();
  console.log("full export:", zipRes.status(), zipRes.headers()["content-type"], `${zipBytes.length} bytes`);
  if (zipRes.status() !== 200 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) throw new Error("full export is not a zip");
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
  await ownerDesk.goto(`${orgUrl}/settings`);
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
  await ownerDesk.goto(`${orgUrl}/settings`);
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

  step("security: two-step verification for me, then required for the whole business");
  await ownerDesk.goto(`${orgUrl}/settings/account`);
  await ownerDesk.getByRole("button", { name: "הפעלת אימות דו-שלבי" }).click();
  const ownerSecret = (await ownerDesk.locator("code").first().innerText()).trim();
  await ownerDesk.getByLabel("קוד אימות").fill(await freshTotp(ownerSecret));
  await ownerDesk.getByRole("button", { name: "אימות", exact: true }).click();
  await expectText(ownerDesk, "אימות דו-שלבי פעיל בחשבון שלך");
  await shot(ownerDesk, "110-account-1280");
  await ownerDesk.goto(`${orgUrl}/settings`);
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
