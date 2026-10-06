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
