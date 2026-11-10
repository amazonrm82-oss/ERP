// UX-01 prototype: screenshots of the lead side panel for the owner's approval (LOCAL ONLY).
//   E2E_APP_URL=http://localhost:3007 node tests/e2e/ux01-peek-shots.mjs <out-dir>
// Signs up a sample business (tests/e2e/sample.mjs), adds two leads for the panel and a member account
// for the take-only view, then photographs at 360px and 1280px (deviceScaleFactor 2: these are for a person).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "playwright";

import { APP, createSample, refuseRemote, signIn, signUpUser, sql } from "./sample.mjs";

refuseRemote("this script");
const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: node tests/e2e/ux01-peek-shots.mjs <out-dir>");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined, args: ["--lang=he-IL"], env: { ...process.env, LANG: "he_IL.UTF-8", LANGUAGE: "he" } });
const newPage = async (width, height = 800) =>
  (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: "he-IL" })).newPage();

// --- the sample business and the panel's two leads
const setup = await newPage(1280);
const { email, orgId } = await createSample(setup);
await setup.context().close();
const [{ id: me }] = await sql("select id from auth.users where email = $1", [email]);
const [status] = await sql("select id from public.lead_statuses where organization_id = $1 and is_default order by position limit 1", [orgId]);
const [source] = await sql("select id from public.lead_sources where organization_id = $1 order by created_at limit 1", [orgId]);
await sql(
  `insert into public.field_definitions (organization_id, object_type, key, label, field_type, position)
   values ($1, 'lead', 'qty', 'כמות', 'number', 1)`,
  [orgId],
);
const [{ id: kitchen }] = await sql("insert into public.products (organization_id, name) values ($1, 'מטבח מודולרי') returning id", [orgId]);
const [{ id: bath }] = await sql("insert into public.products (organization_id, name) values ($1, 'שיפוץ חדר רחצה') returning id", [orgId]);

async function lead(name, phone, mail, owner, minutes, product, qty, message) {
  const [{ id }] = await sql(
    `insert into public.leads (organization_id, full_name, phone, email, status_id, source_id, owner_id, requested_product_id, custom_fields, message, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - make_interval(mins => $11)) returning id`,
    [orgId, name, phone, mail, status.id, source?.id ?? null, owner, product, qty === null ? {} : { qty }, message, minutes],
  );
  return id;
}
async function entry(leadId, type, minutesAgo, body, metadata = {}, author = null, isPrivate = false) {
  await sql(
    `insert into public.activities (organization_id, lead_id, type, body, metadata, created_by, is_private, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8))`,
    [orgId, leadId, type, body, metadata, author, isPrivate, minutesAgo],
  );
}

const owned = await lead(
  "אורית נחום",
  "050-7788990",
  "orit.nahum@gmail.com",
  me,
  42,
  kitchen,
  3,
  "שלום, אנחנו עוברים דירה בחודש הבא ומחפשים מטבח חדש בקיר של 3.2 מטר. אשמח שתחזרו אליי אחרי 17:00.",
);
await entry(owned, "inquiry", 41, null, { form_name: "טופס באתר", full_name: "אורית נחום", phone: "050-7788990" });
await entry(owned, "assignment", 40, "הליד הוקצה לרונית לוי בסבב.");
await entry(owned, "system", 38, "נשלחה הודעת תודה אוטומטית.");
await entry(owned, "note", 20, "לבדוק אם זו אורית מהתערוכה בחולון.", {}, me, true);
await entry(owned, "inquiry", 9, "ראיתי שיש מבצע על מטבחים, זה עדיין בתוקף?", { form_name: "WhatsApp מהאתר", full_name: "אורית נחום" });
await entry(owned, "system", 8, "נוסף תיוג: מטבחים.");

const unowned = await lead("גיל ששון", "052-3344556", null, null, 12, bath, null, "רוצה הצעה לשיפוץ חדר רחצה קטן, כולל ריצוף.");
await entry(unowned, "inquiry", 12, null, { form_name: "טופס באתר", full_name: "גיל ששון", phone: "052-3344556" });

// --- a member of the same business, for the take-only view
const memberPage = await newPage(1280);
const memberEmail = `ux01-member-${Date.now().toString(36)}@example.test`;
await signUpUser(memberPage, "יואב מזרחי", memberEmail);
await memberPage.context().close();
const [{ id: member }] = await sql("select id from auth.users where email = $1", [memberEmail]);
await sql("insert into public.memberships (organization_id, user_id, role, status) values ($1, $2, 'member', 'active')", [orgId, member]);
await sql("update public.profiles set guide_tour_seen_at = now() where id in ($1, $2)", [me, member]);
// the take-only view: the member does not read the unowned lead under "own" visibility, it is only offered to take (SPD-01)
await sql("update public.organizations set record_visibility = 'own' where id = $1", [orgId]);

const list = `/o/${orgId}/leads`;
async function open(page, leadId, path = `${list}?`) {
  await page.goto(`${APP}${path}peek=${leadId}`);
  await page.locator("dialog[open]").waitFor();
  await page.waitForLoadState("networkidle");
  // the sheet's rise animation
  await page.waitForTimeout(400);
}
const shot = async (page, name) => (await page.mouse.move(0, 0), await page.waitForTimeout(300), page).screenshot({ path: join(outDir, `${name}.png`), caret: "initial" });

for (const width of [360, 1280]) {
  const page = await newPage(width);
  await signIn(page, email);
  await open(page, owned);
  await shot(page, `ux01-panel-${width}`);
  if (width === 360) {
    await page.locator("dialog[open]").evaluate((d) => (d.scrollTop = d.scrollHeight));
    await page.waitForTimeout(200);
    await shot(page, "ux01-panel-timeline-360");
    await page.locator("dialog[open]").evaluate((d) => (d.scrollTop = 0));
  }
  await page.getByRole("button", { name: "התקשרתי" }).click();
  await page.getByText("איך הסתיימה השיחה?").scrollIntoViewIfNeeded();
  await shot(page, `ux01-call-menu-${width}`);
  await page.getByRole("button", { name: "לחזור ב…" }).click();
  await page.getByLabel("שעה").first().scrollIntoViewIfNeeded();
  await shot(page, `ux01-call-back-${width}`);
  await page.context().close();

  const memberView = await newPage(width);
  await signIn(memberView, memberEmail);
  // the waiting list's "כל מה שאני רואה" tab offers the leads nobody owns
  await open(memberView, unowned, `${list}/waiting?who=all&`);
  await shot(memberView, `ux01-take-only-${width}`);
  await memberView.context().close();
}
await browser.close();
console.log(`ux01 shots -> ${outDir}`);
