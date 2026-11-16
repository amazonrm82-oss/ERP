// USR-10 end-to-end check of the sign-in by a one-time link to the email, against a LOCAL Supabase stack only: the link is
// asked for on /login, read from the stack's mail catcher (Mailpit), opened in the SAME browser context (the PKCE code
// verifier is a cookie of that context) and lands signed in on `next`. Also: an unknown address gets the same answer and no
// email, and the same link opened in another browser context ends on /login with the broken-link message.
//
// How to run (the stack is shared; run it where the lead runs the e2e):
//   1. npm run stack:start
//   2. Start the app (npm run dev, or npm run build && npm start) on localhost:3000 with the local stack's URL and key, and
//      WITHOUT the Turnstile keys (the widget would wait for Cloudflare).
//   3. node tests/e2e/magic-link.mjs
// Env: E2E_APP_URL (http://localhost:3000), E2E_MAIL_URL (http://127.0.0.1:54324), E2E_DB_URL (the local database),
// E2E_CHROMIUM_PATH. It prints PASS or FAIL per step and exits non-zero on any failure. It refuses to run against anything not
// on this machine (refuseRemote in ./sample.mjs).
import { chromium } from "playwright";

import { APP, MAIL, refuseRemote, signUpUser } from "./sample.mjs";

refuseRemote("the one-time link check");

const run = Date.now().toString(36);
const email = `magic-${run}@example.test`;
const unknown = `magic-nobody-${run}@example.test`;
const NEXT = "/onboarding";
const SENT = "אם הכתובת רשומה אצלנו, שלחנו אליה קישור כניסה. הקישור תקף לזמן קצר.";
const BROKEN = "הקישור אינו תקף או שפג תוקפו. אפשר לבקש קישור חדש או להיכנס עם סיסמה.";
const results = [];

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
  env: { ...process.env, LANG: process.env.LANG || "C.UTF-8" },
});

async function step(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push([name, false]);
    console.log(`FAIL ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** The ids of the messages to an address, newest first. */
async function messagesTo(address) {
  const list = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)).json();
  return (list.messages ?? []).map((m) => m.ID);
}

/** The newest one-time sign-in link sent to an address (Supabase's default template: /auth/v1/verify?…type=magiclink…). */
async function magicLink(address, seen) {
  for (let i = 0; i < 40; i++) {
    for (const id of await messagesTo(address)) {
      if (seen.has(id)) continue;
      const msg = await (await fetch(`${MAIL}/api/v1/message/${id}`)).json();
      const body = `${msg.Text ?? ""}\n${msg.HTML ?? ""}`.replace(/&amp;/g, "&");
      const match = body.match(/https?:\/\/[^\s"<>)]+type=magiclink[^\s"<>)]*/) ?? body.match(/https?:\/\/[^\s"<>)]+token_hash=[^\s"<>)]+/);
      if (match) return match[0];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no sign-in link email for ${address}`);
}

/** Opens the box on /login?next=…, asks for a link and waits for the one answer. */
async function askForLink(page, address) {
  await page.goto(`${APP}/login?next=${encodeURIComponent(NEXT)}`);
  await page.getByRole("button", { name: "כניסה בקישור למייל" }).click();
  // one Turnstile widget at a time: the password form is hidden while the box is open
  if ((await page.getByLabel("סיסמה").count()) !== 0) throw new Error("the password form is still shown");
  await page.getByLabel("אימייל לקבלת הקישור").fill(address);
  await page.getByRole("button", { name: "שליחת קישור כניסה" }).click();
  await page.getByText(SENT).waitFor({ timeout: 15000 });
}

let failed = false;
try {
  const context = await browser.newContext({ locale: "he-IL" });
  const page = await context.newPage();
  let link = "";

  await step("sign up an account (then signed out)", async () => {
    await signUpUser(page, "דנה כהן", email);
    await context.clearCookies();
    await page.goto(`${APP}${NEXT}`);
    await page.waitForURL(/\/login/, { timeout: 15000 });
  });

  await step("ask for a link: the one answer, and an email arrives", async () => {
    const before = new Set(await messagesTo(email));
    await askForLink(page, email);
    link = await magicLink(email, before);
  });

  await step("the link, opened in the same browser, lands signed in on next", async () => {
    await page.goto(link);
    await page.waitForURL((url) => url.pathname === NEXT, { timeout: 20000 });
    // still signed in on a page that needs a session
    await page.goto(`${APP}/app`);
    await page.waitForLoadState("networkidle");
    if (new URL(page.url()).pathname.startsWith("/login")) throw new Error("not signed in after the link");
  });

  await step("an unknown address: the same answer and no email", async () => {
    const other = await browser.newContext({ locale: "he-IL" });
    const otherPage = await other.newPage();
    await askForLink(otherPage, unknown);
    await new Promise((r) => setTimeout(r, 3000));
    const got = await messagesTo(unknown);
    await other.close();
    if (got.length !== 0) throw new Error(`an email was sent to an unknown address (${got.length})`);
  });

  await step("a link opened in another browser: back to /login with the broken-link message", async () => {
    const before = new Set(await messagesTo(email));
    const asker = await browser.newContext({ locale: "he-IL" });
    await askForLink(await asker.newPage(), email);
    const second = await magicLink(email, before);
    await asker.close();
    const stranger = await browser.newContext({ locale: "he-IL" });
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(second);
    await strangerPage.waitForURL(/\/login/, { timeout: 20000 });
    await strangerPage.getByText(BROKEN).waitFor({ timeout: 10000 });
    await stranger.close();
  });
  await context.close();
} catch {
  failed = true;
} finally {
  await browser.close();
}

console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} steps passed`);
process.exit(failed || results.some(([, ok]) => !ok) ? 1 : 0);
