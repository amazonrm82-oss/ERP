// The sample business shared by the design screenshots (DSN-14, tests/e2e/screens.mjs) and the
// screenshot comparison (DSN-18, tests/visual/run.mjs). LOCAL ONLY: it creates accounts on the
// local Supabase stack and writes sample rows straight into its database.
import { createHmac } from "node:crypto";

import pg from "pg";

export const APP = process.env.E2E_APP_URL ?? "http://localhost:3000";
export const MAIL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
export const DB = process.env.E2E_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const PASSWORD = "Test-pass-12345";

export function refuseRemote(what) {
  for (const url of [APP, MAIL, DB.replace(/^postgresql:/, "http:")]) {
    if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
      throw new Error(`Refusing to run against ${url}: ${what} creates accounts and only runs locally.`);
    }
  }
}

export async function sql(text, params = []) {
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

// RFC 6238 code from a base32 secret, as an authenticator app computes it
export function totp(secret) {
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

/** Sign up, confirm the e-mail and sign the agreement (typed name). The page ends after the agreement. */
export async function signUpUser(page, name, email) {
  await page.goto(`${APP}/signup`);
  await page.getByLabel("שם מלא").fill(name);
  await page.getByLabel("אימייל").fill(email);
  await page.getByLabel("סיסמה").fill(PASSWORD);
  await page.getByRole("button", { name: "יצירת חשבון" }).click();
  await page.getByText("שלחנו הודעת אימות").waitFor();
  await page.goto(await confirmationLink(email));
  await page.waitForURL(/\/agreement/);
  await page.getByRole("radio", { name: "הקלדת שם" }).click();
  await page.getByLabel(/קראתי את תנאי השימוש/).check();
  await page.getByRole("button", { name: "חתימה והמשך" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/agreement"), { timeout: 15000 });
}

export async function signIn(page, email) {
  await page.goto(`${APP}/login`);
  await page.getByLabel("אימייל").fill(email);
  await page.getByLabel("סיסמה").fill(PASSWORD);
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
}

/** A new owner and business, filled with a realistic small company's data. `page` is a fresh 1280px page. */
export async function createSample(page) {
  const email = `screens-${Date.now().toString(36)}@example.test`;
  await signUpUser(page, "רונית לוי", email);
  await page.waitForURL(/\/onboarding/, { timeout: 15000 });
  await page.getByLabel("שם העסק").fill("לוי שיפוצים ובנייה");
  await page.getByRole("button", { name: "יצירת העסק והמשך" }).click();
  // a new business opens the setup wizard (USR-03)
  await page.waitForURL(/\/o\/[0-9a-f-]{36}\/setup$/, { timeout: 20000 });
  const orgId = new URL(page.url()).pathname.split("/")[2];
  await seed(orgId, email);
  return { email, orgId };
}

/**
 * A platform staff member with two-step verification on (the design gallery needs aal2).
 * `page` is a fresh page; it ends signed in at aal2.
 */
export async function createStaff(page) {
  const email = `staff-${Date.now().toString(36)}@example.test`;
  await signUpUser(page, "צוות פלטפורמה", email);
  await sql("insert into app.platform_staff (user_id, role) select id, 'owner' from auth.users where email = $1", [email]);
  await page.goto(`${APP}/admin`);
  await page.getByText("אימות דו-שלבי").first().waitFor();
  const secret = (await page.locator("code").first().innerText()).trim();
  await page.getByLabel("קוד אימות").fill(totp(secret));
  await page.getByRole("button", { name: "אימות" }).click();
  await page.getByText("הכנסה חודשית חוזרת").first().waitFor({ timeout: 15000 });
  return { email };
}

// The fixed week the calendar screen shows (DSN-18: the same week on every run).
export const CALENDAR_WEEK = "2026-10-12";

async function seed(orgId, email) {
  const [{ id: me }] = await sql("select id from auth.users where email = $1", [email]);
  // UX-05: the photographing owner has seen the first-visit tour, so it never lands in a screenshot
  await sql("update public.profiles set guide_tour_seen_at = now() where id = $1", [me]);
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

  // Due times on the business's own calendar days, so a task lands in the same group
  // (overdue, today, tomorrow, later) whatever the hour of the run (DSN-18).
  for (const [title, dayOffset, time] of [
    ["לחזור למשה כהן עם הצעת מחיר", -1, "12:00"],
    ["לתאם ביקור אצל שירה אברהם", 0, "23:59"],
    ["לשלוח חוזה לכץ משפטים", 1, "10:00"],
    ["להזמין חומרים למטבח של דהן", 3, "09:00"],
  ]) {
    await sql(
      `insert into public.tasks (organization_id, title, due_at, owner_id)
       select $1, $2, ((now() at time zone o.timezone)::date + $3::int + $4::time) at time zone o.timezone, $5
       from public.organizations o where o.id = $1`,
      [orgId, title, dayOffset, time, me],
    );
  }

  // meetings in a fixed past week, the one the calendar screen opens on
  for (const [title, day, from, to, contact] of [
    ["פגישת היכרות עם רחל דהן", "2026-10-12", "10:00", "11:00", 0],
    ["מדידות במטבח", "2026-10-13", "14:00", "15:30", 0],
    ["שיחת וידאו עם כץ משפטים", "2026-10-14", "09:30", "10:00", 2],
    ["ביקור באתר, חדד", "2026-10-15", "16:00", "17:00", 1],
  ]) {
    await sql(
      `insert into public.meetings (organization_id, title, starts_at, ends_at, owner_id, created_by, contact_id)
       select $1, $2, ($3::date + $4::time) at time zone o.timezone, ($3::date + $5::time) at time zone o.timezone, $6, $6, $7
       from public.organizations o where o.id = $1`,
      [orgId, title, day, from, to, me, contacts[contact].id],
    );
  }
}

/** The main screens of the sample business (path per screen name). */
export async function sampleScreens(orgId) {
  const org = `/o/${orgId}`;
  const first = async (table) => (await sql(`select id from public.${table} where organization_id = $1 order by created_at, id limit 1`, [orgId]))[0].id;
  return {
    home: org,
    leads: `${org}/leads`,
    "leads-board": `${org}/leads?view=board`,
    lead: `${org}/leads/${await first("leads")}`,
    deals: `${org}/deals`,
    deal: `${org}/deals/${await first("deals")}`,
    tasks: `${org}/tasks`,
    calendar: `${org}/calendar?view=week&date=${CALENDAR_WEEK}`,
    contacts: `${org}/contacts`,
    contact: `${org}/contacts/${await first("contacts")}`,
    companies: `${org}/companies`,
    setup: `${org}/setup?step=2`,
    settings: `${org}/settings`,
    "settings-business": `${org}/settings/business`,
    login: "/login",
    onboarding: "/onboarding",
  };
}
