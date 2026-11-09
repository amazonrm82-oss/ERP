// IMP-04 end-to-end check of the background import and full export, against a LOCAL Supabase stack only: the person's
// HS256 token through the real PostgREST and Storage, crm_background reaching request.jwt.claims inside Storage (the
// job-files policies), the worker's export upload while the order runs, and the audit stamp.
//
// How to run (the stack is shared; run it where the lead runs the e2e):
//   1. npm run stack:start
//   2. Fill app.settings once (as CI does): push_dispatch_url = http://<host>:3000/api/push/dispatch and
//      push_dispatch_secret = <a long random string>.
//   3. Start the app (npm run dev, or npm run build && npm start) on localhost:3000 with the local stack's URL and
//      publishable key, PUSH_DISPATCH_SECRET = the same string, and SUPABASE_JWT_SECRET = the local stack's JWT secret
//      (`npx -y supabase@2.121.0 status -o env` prints it as JWT_SECRET; the documented local default). Without it the
//      background buttons are not offered and step 1 fails at once.
//   4. node tests/e2e/background-jobs.mjs
// Env: E2E_APP_URL (http://localhost:3000), E2E_MAIL_URL (http://127.0.0.1:54324), E2E_DB_URL (the local database),
// PUSH_DISPATCH_SECRET (else read from app.settings push_dispatch_secret), E2E_CHROMIUM_PATH, E2E_SUPABASE_URL and
// E2E_SUPABASE_ANON_KEY (else NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY, else `supabase status -o env`).
// It prints PASS or FAIL per step and exits non-zero on any failure. It refuses to run against anything not on this machine.
import { execFileSync } from "node:child_process";

import { unzipSync } from "fflate";
import pg from "pg";
import { chromium } from "playwright";

const APP = process.env.E2E_APP_URL ?? "http://localhost:3000";
const MAIL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
const DB = process.env.E2E_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function stackEnv() {
  try {
    const out = execFileSync("npx", ["-y", "supabase@2.121.0", "status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Object.fromEntries(
      out
        .split("\n")
        .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
  } catch {
    return {};
  }
}
const needsStack = !(process.env.E2E_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) || !(process.env.E2E_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const stack = needsStack ? stackEnv() : {};
const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? stack.API_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? stack.ANON_KEY ?? stack.PUBLISHABLE_KEY ?? "";

for (const url of [APP, MAIL, SUPABASE_URL, DB.replace(/^postgresql:/, "http:")]) {
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error(`Refusing to run against ${url}: this check creates accounts and only runs locally.`);
  }
}

const run = Date.now().toString(36);
const ownerEmail = `bg-owner-${run}@example.test`;
const memberEmail = `bg-member-${run}@example.test`;
const PASSWORD = "Test-pass-12345";
const ROWS = 2001; // the wizard offers the background path above 2,000 rows
const results = [];

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
  env: { ...process.env, LANG: process.env.LANG || "C.UTF-8" },
});

async function sql(text, params = []) {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "he-IL" });
  return context.newPage();
}

async function expectText(page, text, timeout = 15000) {
  await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ timeout });
}

async function confirmationLink(email) {
  for (let i = 0; i < 40; i++) {
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

async function signAgreement(page) {
  await page.waitForURL(/\/agreement/);
  await page.getByRole("heading", { name: /חתימה על ההסכם/ }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.getByRole("radio", { name: "הקלדת שם" }).click();
  await page.getByLabel(/קראתי את תנאי השימוש/).check();
  await page.getByRole("button", { name: "חתימה והמשך" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/agreement"), { timeout: 15000 });
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
  await page.goto(await confirmationLink(email));
  await page.waitForLoadState("networkidle");
  await signAgreement(page);
}

async function dispatchSecret() {
  if (process.env.PUSH_DISPATCH_SECRET) return process.env.PUSH_DISPATCH_SECRET;
  const [row] = await sql("select value from app.settings where key = 'push_dispatch_secret'");
  if (!row?.value) throw new Error("no shared secret: set PUSH_DISPATCH_SECRET (the app's) or app.settings push_dispatch_secret");
  return row.value;
}

/** Wakes the worker the way the database does, until the order ends (it may take a few runs: 40 s each). */
async function runUntilDone(requestId, secret, limit = 40) {
  for (let i = 0; i < limit; i++) {
    const res = await fetch(`${APP}/api/jobs/run`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: "{}" });
    const summary = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`the worker answered ${res.status}: ${JSON.stringify(summary)}`);
    const [row] = await sql("select status, result_message, rows_done from public.background_requests where id = $1", [requestId]);
    console.log(`  run ${i + 1}: ${JSON.stringify(summary)} -> ${row.status}${row.rows_done ? ` (${row.rows_done} rows)` : ""}`);
    if (["done", "failed", "cancelled"].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the order did not end after ${limit} runs`);
}

async function check(name, fn) {
  console.log(`\n== ${name}`);
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push([name, false]);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

let owner;
let orgUrl;
let orgId;
let secret;

try {
  await check("setup: an owner with a business, and the worker's shared secret", async () => {
    secret = await dispatchSecret();
    owner = await newPage();
    await signUp(owner, "בעלים רקע", ownerEmail, `${APP}/signup`);
    await owner.waitForURL(/\/onboarding/, { timeout: 15000 });
    await owner.getByLabel("שם העסק").fill(`עבודות רקע ${run}`);
    await owner.getByRole("button", { name: "יצירת העסק והמשך" }).click();
    await owner.waitForURL(/\/o\/[0-9a-f-]{36}\/setup/, { timeout: 20000 });
    orgId = owner.url().match(/\/o\/([0-9a-f-]{36})/)[1];
    orgUrl = `${APP}/o/${orgId}`;
  });

  await check(`1. a background import of ${ROWS} leads with "skip", as the owner, stamped in the audit`, async () => {
    if (!orgId) throw new Error("no business (setup failed)");
    await owner.goto(`${orgUrl}/settings/import/new`);
    await owner.getByLabel("לידים", { exact: true }).check();
    const lines = ["שם מלא,טלפון"];
    for (let i = 0; i < ROWS; i++) lines.push(`ליד רקע ${i},05${String(20000000 + i).padStart(8, "0")}`);
    await owner.locator('input[type="file"]').setInputFiles({ name: "רקע.csv", mimeType: "text/csv", buffer: Buffer.from("﻿" + lines.join("\n"), "utf8") });
    // wait for the file to be read, as main-flow does ("N שורות"), before the check button
    await owner.getByText(`${ROWS.toLocaleString("en-US")} שורות`).first().waitFor({ timeout: 60000 });
    await owner.getByRole("button", { name: "בדיקת 20 השורות הראשונות" }).click({ timeout: 60000 });
    const button = owner.getByRole("button", { name: "ייבוא ברקע" });
    await button.waitFor({ timeout: 15000 }).catch(() => {
      throw new Error("no background button: is the app running with SUPABASE_JWT_SECRET?");
    });
    await button.click();
    await expectText(owner, "הייבוא ירוץ ברקע", 60000);
    const [order] = await sql(
      "select r.id, r.status, r.duplicate_mode, r.ordered_session_id from public.background_requests r join auth.users u on u.id = r.created_by where u.email = $1 and r.kind = 'import' order by r.created_at desc limit 1",
      [ownerEmail],
    );
    if (!order || order.status !== "queued" || order.duplicate_mode !== "skip" || !order.ordered_session_id) throw new Error(`order: ${JSON.stringify(order)}`);
    const end = await runUntilDone(order.id, secret);
    if (end.status !== "done") throw new Error(`the import ended ${end.status}: ${end.result_message}`);
    const [req] = await sql("select import_job_id, counts from public.background_requests where id = $1", [order.id]);
    const [{ n: leads }] = await sql("select count(*)::int as n from public.leads where organization_id = $1 and import_job_id = $2", [orgId, req.import_job_id]);
    if (leads !== ROWS) throw new Error(`${leads} leads made, expected ${ROWS} (counts ${JSON.stringify(req.counts)})`);
    const [{ n: stamped }] = await sql(
      "select count(*)::int as n from public.audit_log where organization_id = $1 and entity_type = 'leads' and action = 'insert' and changes -> 'background' ->> 'request_id' = $2",
      [orgId, order.id],
    );
    if (stamped !== ROWS) throw new Error(`${stamped} audit entries carry the background claim, expected ${ROWS}`);
    const [{ actor }] = await sql(
      "select distinct a.actor_id = u.id as actor from public.audit_log a join auth.users u on u.email = $2 where a.organization_id = $1 and a.changes -> 'background' ->> 'request_id' = $3",
      [orgId, ownerEmail, order.id],
    );
    if (!actor) throw new Error("the stamped entries are not the owner's");
    const [{ n: signed }] = await sql("select count(*)::int as n from app.platform_log where action = 'background.token' and details ->> 'request_id' = $1", [order.id]);
    if (signed < 1) throw new Error("no signing was logged");
    // the import page lists it
    await owner.goto(`${orgUrl}/settings/import`);
    await owner.getByRole("heading", { name: "עבודות ברקע" }).waitFor();
    console.log(`  ${leads} leads, ${stamped} stamped audit entries, ${signed} signings logged`);
  });

  await check("2. a background full export, kept in its order's folder, downloaded through the signed link", async () => {
    if (!orgId) throw new Error("no business (setup failed)");
    await owner.goto(`${orgUrl}/settings/import`);
    await owner.getByRole("button", { name: "הכנה ברקע" }).click();
    await expectText(owner, "הייצוא יוכן ברקע");
    const [order] = await sql(
      "select r.id from public.background_requests r join auth.users u on u.id = r.created_by where u.email = $1 and r.kind = 'export' order by r.created_at desc limit 1",
      [ownerEmail],
    );
    const end = await runUntilDone(order.id, secret);
    if (end.status !== "done") throw new Error(`the export ended ${end.status}: ${end.result_message}`);
    const [req] = await sql("select file_path from public.background_requests where id = $1", [order.id]);
    if (!new RegExp(`^${orgId}/${order.id}/[0-9a-f-]{36}\\.zip$`).test(req.file_path ?? "")) throw new Error(`file path: ${req.file_path}`);
    // written by the worker with the owner's token: the object exists in Storage with the owner as its owner
    const [obj] = await sql("select owner_id::text as owner_id, (metadata ->> 'size')::bigint as size from storage.objects where bucket_id = 'job-files' and name = $1", [req.file_path]).catch(() =>
      sql("select owner::text as owner_id, (metadata ->> 'size')::bigint as size from storage.objects where bucket_id = 'job-files' and name = $1", [req.file_path]),
    );
    const [{ id: ownerId }] = await sql("select id from auth.users where email = $1", [ownerEmail]);
    if (!obj) throw new Error("no object in Storage");
    if (obj.owner_id && obj.owner_id !== ownerId) throw new Error(`the object's owner is ${obj.owner_id}, not the person`);
    const [{ n: logged }] = await sql("select count(*)::int as n from public.audit_log where organization_id = $1 and action = 'export' and changes -> 'background' ->> 'request_id' = $2", [orgId, order.id]);
    console.log(`  export audit entries stamped: ${logged}`);
    const res = await owner.request.get(`${orgUrl}/settings/import/background/${order.id}`);
    if (res.status() !== 200) throw new Error(`download answered ${res.status()}`);
    const bytes = new Uint8Array(await res.body());
    if (bytes.length < 100 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`not a zip (${bytes.length} bytes)`);
    const names = Object.keys(unzipSync(bytes));
    if (!names.includes("README.txt") || names.length < 5) throw new Error(`zip holds ${names.join(", ")}`);
    console.log(`  zip: ${bytes.length} bytes, ${names.length} files`);
  });

  await check("3. a member without import rights: no background import page, and the database refuses the order", async () => {
    if (!orgId) throw new Error("no business (setup failed)");
    await owner.goto(`${orgUrl}/settings/users`);
    await owner.getByLabel("אימייל").fill(memberEmail);
    await owner.getByLabel("תפקיד").selectOption("member");
    await owner.getByRole("button", { name: "יצירת קישור הזמנה" }).click();
    const inviteLink = await owner.getByLabel("קישור ההזמנה").inputValue();
    const member = await newPage();
    await member.goto(inviteLink);
    await signUp(member, "חבר רקע", memberEmail, member.url());
    await member.waitForURL(/\/invite\//, { timeout: 15000 });
    await member.getByRole("button", { name: "הצטרפות לעסק" }).click();
    await member.waitForURL(/\/o\/[0-9a-f-]{36}$/, { timeout: 15000 });
    // the import page and the wizard are not offered to a member
    for (const path of ["/settings/import", "/settings/import/new"]) {
      const res = await member.goto(`${orgUrl}${path}`);
      if ((await member.getByRole("button", { name: "ייבוא ברקע" }).count()) > 0) throw new Error(`${path} offers the background import`);
      if ((await member.getByRole("button", { name: "הכנה ברקע" }).count()) > 0) throw new Error(`${path} offers the background export`);
      console.log(`  ${path}: ${res?.status()}`);
    }
    // the order itself, sent straight to the API with the member's own session, is refused by the database
    if (!ANON_KEY) throw new Error("no publishable key for the API check (set E2E_SUPABASE_ANON_KEY)");
    const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: memberEmail, password: PASSWORD }),
    });
    const { access_token: token } = await login.json();
    if (!token) throw new Error(`member sign-in failed (${login.status})`);
    for (const body of [
      { organization_id: orgId, kind: "import", entity_type: "lead", file_name: "x.csv", total_rows: 3000, duplicate_mode: "skip" },
      { organization_id: orgId, kind: "export" },
    ]) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/background_requests`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(body),
      });
      if (res.status < 400) throw new Error(`the database took a member's ${body.kind} order (${res.status})`);
      console.log(`  member's ${body.kind} order: ${res.status}`);
    }
    // nor can the member forge the worker's claim in Storage: an upload into the owner's export folder is refused
    const [last] = await sql("select organization_id, id from public.background_requests where kind = 'export' and organization_id = $1 order by created_at desc limit 1", [orgId]);
    const put = await fetch(`${SUPABASE_URL}/storage/v1/object/job-files/${last.organization_id}/${last.id}/${crypto.randomUUID()}.zip`, {
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
      body: new Uint8Array([0x50, 0x4b, 3, 4]),
    });
    if (put.status < 400) throw new Error(`a member wrote into the export folder (${put.status})`);
    console.log(`  member's upload into the export folder: ${put.status}`);
    await member.context().close();
  });
} finally {
  await browser.close();
}

const failed = results.filter(([, ok]) => !ok);
console.log("\n" + results.map(([name, ok]) => `${ok ? "PASS" : "FAIL"} ${name}`).join("\n"));
console.log(failed.length ? `\nBACKGROUND JOBS FAILED (${failed.length})` : "\nBACKGROUND JOBS OK");
process.exitCode = failed.length ? 1 : 0;
