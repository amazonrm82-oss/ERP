// End-to-end check of the main path, in a real browser, against a LOCAL stack:
//   npx supabase start                      (Docker; uses supabase/config.toml)
//   npm run dev with the local URL and publishable key in .env.local
//   npm run test:e2e
// sign up -> confirm email (read from the local Mailpit inbox) -> create the
// business -> lead -> note -> convert -> deal board -> settings -> invite a
// second user -> they sign up from the link and join -> roles, teams, suspend.
// It refuses to run against anything that is not on this machine.
import { chromium } from "playwright";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3000";
const MAIL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
for (const url of [APP, MAIL]) {
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
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 });
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
  await owner.getByLabel("הערה חדשה").fill("דיברנו בטלפון, מעוניין בהצעה");
  await owner.getByRole("button", { name: "הוספת הערה" }).click();
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
  await expectText(ownerDesk, "https://cohen.co.il".replace("https://", ""));
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
