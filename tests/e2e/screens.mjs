// Screenshots of the main screens with sample data, at 360px and 1280px, for the
// design pass (DSN-14: "before" and "after" of every screen). LOCAL ONLY.
//   node tests/e2e/screens.mjs <out-dir> [screen ...]
// E2E_SHOTS_VIEWPORT=1 photographs only the first screen (for the landing page, LND-02).
// The first run signs up a sample business and fills it with data; its address
// is kept in <out-dir>/../screens-state.json, so later runs photograph the same data.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import pg from "pg";
import { chromium } from "playwright";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3000";
const MAIL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
const DB = process.env.E2E_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
for (const url of [APP, MAIL, DB.replace(/^postgresql:/, "http:")]) {
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error(`Refusing to run against ${url}: this script creates accounts and only runs locally.`);
  }
}

const [outDir, ...only] = process.argv.slice(2);
if (!outDir) throw new Error("usage: node tests/e2e/screens.mjs <out-dir> [screen ...]");
const stateFile = join(dirname(outDir), "screens-state.json");
const PASSWORD = "Test-pass-12345";

async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

async function confirmationLink(email) {
  for (let i = 0; i < 30; i++) {
    const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (list.messages?.length) {
      const msg = await (await fetch(`${MAIL}/api/v1/message/${list.messages[0].ID}`)).json();
      const match = (msg.Text ?? msg.HTML).match(/https?:\/\/[^\s"<>)]+verify[^\s"<>)]+/);
      if (match) return match[0].replace(/&amp;/g, "&");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no confirmation email for ${email}`);
}

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined });

async function newPage(width) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, locale: "he-IL" });
  return context.newPage();
}

// a new owner and business, filled with a realistic small company's data
async function createSample() {
  const email = `screens-${Date.now().toString(36)}@example.test`;
  const page = await newPage(1280);
  await page.goto(`${APP}/signup`);
  await page.getByLabel("שם מלא").fill("רונית לוי");
  await page.getByLabel("אימייל").fill(email);
  await page.getByLabel("סיסמה").fill(PASSWORD);
  await page.getByRole("button", { name: "יצירת חשבון" }).click();
  await page.getByText("שלחנו הודעת אימות").waitFor();
  await page.goto(await confirmationLink(email));
  await page.waitForURL(/\/agreement/);
  await page.getByRole("radio", { name: "הקלדת שם" }).click();
  await page.getByLabel(/קראתי את תנאי השימוש/).check();
  await page.getByRole("button", { name: "חתימה והמשך" }).click();
  await page.waitForURL(/\/onboarding/, { timeout: 15000 });
  await page.getByLabel("שם העסק").fill("לוי שיפוצים ובנייה");
  await page.getByRole("button", { name: "יצירת העסק והמשך" }).click();
  await page.waitForURL(/\/o\/[0-9a-f-]{36}$/, { timeout: 20000 });
  const orgId = page.url().split("/o/")[1];
  await page.context().close();
  await seed(orgId, email);
  return { email, orgId };
}

async function seed(orgId, email) {
  const [{ id: me }] = await sql("select id from auth.users where email = $1", [email]);
  const statuses = await sql("select id, name from public.lead_statuses where organization_id = $1 order by position", [orgId]);
  const sources = await sql("select id from public.lead_sources where organization_id = $1 order by created_at", [orgId]);
  const [pipeline] = await sql("select id from public.pipelines where organization_id = $1 order by position limit 1", [orgId]);
  const stages = await sql("select id from public.stages where organization_id = $1 and pipeline_id = $2 and kind = 'open' order by position", [orgId, pipeline.id]);

  const people = [
    ["משה כהן", "050-1234567", "moshe@kohen.co.il", "כהן ובניו"],
    ["שירה אברהם", "052-7654321", "shira@gmail.com", null],
    ["דוד מזרחי", "054-1112233", null, "מזרחי נכסים"],
    ["נועה פרידמן", "053-9876543", "noa.f@walla.co.il", "סטודיו נועה"],
    ["יוסי ביטון", "058-4445566", null, null],
    ["מיכל רוזן", "050-3332211", "michal@rozen.co.il", "רוזן אדריכלים"],
    ["אבי גולן", "052-6667788", "avi@golan.com", null],
    ["תמר שלום", "054-9990011", null, "שלום הפקות"],
  ];
  for (const [i, [name, phone, mail, company]] of people.entries()) {
    await sql(
      `insert into public.leads (organization_id, full_name, phone, email, company_name, status_id, source_id, owner_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(hours => $9))`,
      [orgId, name, phone, mail, company, statuses[i % Math.min(3, statuses.length)].id, sources[i % sources.length]?.id ?? null, me, i * 7],
    );
  }

  const contacts = [];
  for (const [first, last, phone, company] of [
    ["רחל", "דהן", "050-2223344", "דהן ייזום"],
    ["עומר", "חדד", "052-5556677", null],
    ["ליאת", "כץ", "054-8889900", "כץ משפטים"],
  ]) {
    let companyId = null;
    if (company) [{ id: companyId }] = await sql("insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [orgId, company, me]);
    const [{ id }] = await sql(
      "insert into public.contacts (organization_id, first_name, last_name, phone, company_id, owner_id) values ($1, $2, $3, $4, $5, $6) returning id",
      [orgId, first, last, phone, companyId, me],
    );
    contacts.push({ id, companyId });
  }

  for (const [i, [name, amount]] of [
    ["שיפוץ מטבח, דהן", 4_850_000],
    ["חדר רחצה, חדד", 2_200_000],
    ["משרדים, כץ משפטים", 12_000_000],
    ["מרפסת, דהן", 1_350_000],
    ["צביעת דירה, חדד", 650_000],
  ].entries()) {
    const contact = contacts[i % contacts.length];
    await sql(
      `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, contact_id, company_id, owner_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [orgId, name, amount, pipeline.id, stages[i % stages.length].id, contact.id, contact.companyId, me],
    );
  }

  for (const [title, hours] of [
    ["לחזור למשה כהן עם הצעת מחיר", -3],
    ["לתאם ביקור אצל שירה אברהם", 2],
    ["לשלוח חוזה לכץ משפטים", 5],
    ["להזמין חומרים למטבח של דהן", 30],
  ]) {
    await sql("insert into public.tasks (organization_id, title, due_at, owner_id) values ($1, $2, now() + make_interval(hours => $3), $4)", [orgId, title, hours, me]);
  }
}

async function signIn(page, email) {
  await page.goto(`${APP}/login`);
  await page.getByLabel("אימייל").fill(email);
  await page.getByLabel("סיסמה").fill(PASSWORD);
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
}

await mkdir(outDir, { recursive: true });
let state = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : null;
if (state) {
  const [row] = await sql("select 1 from public.organizations where id = $1", [state.orgId]);
  if (!row) state = null;
}
if (!state) {
  state = await createSample();
  await writeFile(stateFile, JSON.stringify(state));
}

const org = `/o/${state.orgId}`;
const [{ id: firstLead }] = await sql("select id from public.leads where organization_id = $1 order by created_at limit 1", [state.orgId]);
const [{ id: firstDeal }] = await sql("select id from public.deals where organization_id = $1 order by created_at limit 1", [state.orgId]);
const [{ id: firstContact }] = await sql("select id from public.contacts where organization_id = $1 order by created_at limit 1", [state.orgId]);

const SCREENS = {
  home: org,
  leads: `${org}/leads`,
  "leads-board": `${org}/leads?view=board`,
  lead: `${org}/leads/${firstLead}`,
  deals: `${org}/deals`,
  deal: `${org}/deals/${firstDeal}`,
  tasks: `${org}/tasks`,
  contacts: `${org}/contacts`,
  contact: `${org}/contacts/${firstContact}`,
  companies: `${org}/companies`,
  settings: `${org}/settings`,
  "settings-business": `${org}/settings/business`,
  login: "/login",
  onboarding: "/onboarding",
};

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
