import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupPrefixes, orphanPaths, personRows, rowsOf, seed, snapshot, storageFor, type Snapshot } from "./org-cleanup-fixture";
import { addMember, asAdmin, asMfaUser, asService, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

/**
 * ADM-03 (owner, 13 November 2026, answers (361) ב, (362) ב, (363) ב; migrations 021272 and 021273 (pasted by hand)):
 * only the owner, in a two-step session and by typing the business's name, asks to delete the business; the request takes
 * effect only after the owner types the reauthentication code Supabase Auth emailed (owner (373) ג), which the database
 * checks against auth.users (GoTrue's hex SHA-224 of email || code, and its send time); then the business is read-only for
 * 30 days and its owner may cancel; at the end the business's data goes and its people's accounts stay.
 */

afterAll(closePool);

const one = async <T>(q: Query, sql: string, params: unknown[] = []) => (await q<T & Record<string, unknown>>(sql, params)).rows[0];
const request = (user: string, org: string, name: string) =>
  asMfaUser(user, async (q) => (await one<{ r: Record<string, unknown> & { ok: boolean } }>(q, "select public.org_deletion_request($1, $2) as r", [org, name])).r);
/** What Supabase Auth's GET /reauthenticate stores (GoTrue v2.197.0, crypto.GenerateTokenHash): hex SHA-224 of email || code. */
const reauthenticate = (user: string, code: string, sentAgo = "0 seconds", prefix = "") =>
  asAdmin((q) =>
    q(
      `update auth.users set reauthentication_token = $3 || encode(sha224(convert_to(email || $2, 'UTF8')), 'hex'),
              reauthentication_sent_at = now() - $4::interval where id = $1`,
      [user, code, prefix, sentAgo],
    ));
const confirm = (user: string, org: string, code: string, mfa = true) =>
  (mfa ? asMfaUser : asUser)(user, async (q) =>
    (await one<{ r: { ok: boolean; reason?: string } }>(q, "select public.org_deletion_confirm($1, $2) as r", [org, code])).r);
/** a request and its code, in the order the app does them */
const requestAndCode = async (user: string, org: string, name: string, code = "123456") => {
  const r = await request(user, org, name);
  await reauthenticate(user, code);
  return r;
};
const writable = (org: string) =>
  asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.org_writable($1) as w", [org])).w);
const status = (user: string, org: string) =>
  asMfaUser(user, async (q) => (await one<{ s: Record<string, unknown> | null }>(q, "select public.org_deletion_status($1) as s", [org])).s);
const clear = (org: string) => asAdmin((q) => q("update app.org_deletions set cancelled_at = now() where organization_id = $1 and cancelled_at is null", [org]));

describe("asking to delete a business", () => {
  let owner: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let org: string;
  let otherOwner: { id: string };
  let other: string;
  let privacyToken: string;

  beforeAll(async () => {
    owner = await createUser("del-owner");
    otherOwner = await createUser("del-other");
    org = await createOrg(owner.id, "  עסק למחיקה ");
    other = await createOrg(otherOwner.id, "עסק אחר");
    admin = await addMember(org, owner.id, "admin", "del-admin");
    member = await addMember(org, owner.id, "member", "del-member");
    privacyToken = await asUser(owner.id, async (q) =>
      (await one<{ t: string }>(q, "select public.privacy_request_link_create($1) as t", [org])).t);
  });

  it("only the owner, with the second step and the business's name", async () => {
    expect((await pgError(asMfaUser(admin.id, (q) => q("select public.org_deletion_request($1, $2)", [org, "עסק למחיקה"]))) ).code).toBe("42501");
    expect((await pgError(asMfaUser(member.id, (q) => q("select public.org_deletion_request($1, $2)", [org, "עסק למחיקה"])))).code).toBe("42501");
    // another business's owner learns nothing
    expect((await pgError(asMfaUser(otherOwner.id, (q) => q("select public.org_deletion_request($1, $2)", [org, "עסק למחיקה"])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select public.org_deletion_request($1, $2)", [org, "עסק למחיקה"])))).hint).toBe("org_deletion:mfa");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.org_deletion_request($1, $2)", [org, "עסק אחר"])))).hint).toBe("org_deletion:name");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.org_deletion_request($1, $2)", [org, ""])))).hint).toBe("org_deletion:name");
    // anon and the client roles cannot call it at all, nor read the table
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.org_deletions")))).code).toBe("42501");
  });

  it("a request alone changes nothing; only the emailed code starts the clock", async () => {
    // a code sent BEFORE the request never confirms it
    await reauthenticate(owner.id, "111111", "10 minutes");
    const r = await request(owner.id, org, "עסק למחיקה");
    expect(r.ok).toBe(true);
    // no secret in the answer
    expect(Object.keys(r).sort()).toEqual(["expires_at", "ok"]);
    expect((await confirm(owner.id, org, "111111")).reason).toBe("no_code");
    expect(await writable(org)).toBe(true);
    expect((await status(owner.id, org))?.pending).toBe(false);
    expect((await status(owner.id, org))?.awaiting_until).toBeTruthy();
    // the admin does not see the open request
    expect((await status(admin.id, org))?.awaiting_until).toBeNull();

    await reauthenticate(owner.id, "654321");
    // only the requester who is the owner, in a two-step session
    expect((await confirm(admin.id, org, "654321")).reason).toBe("invalid");
    expect((await confirm(otherOwner.id, org, "654321")).reason).toBe("invalid");
    expect((await confirm(owner.id, org, "654321", false)).reason).toBe("mfa");
    // a wrong or malformed code counts a try
    expect((await confirm(owner.id, org, "000000")).reason).toBe("code");
    expect((await confirm(owner.id, org, "abc")).reason).toBe("code");
    expect(await writable(org)).toBe(true);

    const c = await confirm(owner.id, org, "654321");
    expect(c.ok).toBe(true);
    expect(await writable(org)).toBe(false);
    // confirmed once
    expect((await confirm(owner.id, org, "654321")).reason).toBe("pending");
    const s = await status(member.id, org);
    expect(s?.pending).toBe(true);
    const days = (new Date(String(s?.scheduled_for)).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    // a notice to owners and admins, not to the member
    const notified = await asAdmin(async (q) =>
      (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and entity_type = 'org_deletion'", [org])).rows.map((x) => x.user_id));
    expect(notified.sort()).toEqual([owner.id, admin.id].sort());
    // the audit names the steps, never the code
    const audit = await asAdmin(async (q) =>
      (await q<{ changes: unknown }>("select changes from public.audit_log where organization_id = $1 and action = 'org_deletion' order by created_at", [org])).rows);
    expect(audit.map((a) => (a.changes as { step: string }).step)).toEqual(["requested", "confirmed"]);
    expect(JSON.stringify(audit)).not.toContain("654321");
    // other businesses are untouched
    expect(await writable(other)).toBe(true);
    expect(await status(otherOwner.id, org)).toBeNull();
  });

  it("while pending: read-only, no leads, public pages closed, a second request refused", async () => {
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.org_deletion_request($1, $2)", [org, "עסק למחיקה"])))).hint).toBe("org_deletion:pending");
    const flags = await asAdmin((q) => one<{ l: boolean; p: boolean }>(q, "select app.org_takes_leads($1) l, app.org_public_pages_open($1) p", [org]));
    expect(flags).toEqual({ l: false, p: false });
    // a business write by the owner is refused (the read-only rule of app.org_writable / app.can_write)
    const e = await pgError(asMfaUser(owner.id, (q) => q("insert into public.companies (organization_id, name) values ($1, 'חברה')", [org])));
    expect(e.code).toBe("42501");
    // read-only means read-only (lead, 13 November 2026): the business row, others' memberships, invitations, support
    // grants, the sending pause and the ownership transfer are refused as in a closed business
    const rows = async (user: string, sql: string, params: unknown[]) =>
      (await asMfaUser(user, (q) => q(sql, params))).rowCount;
    expect(await rows(owner.id, "update public.organizations set phone = '031234567' where id = $1", [org])).toBe(0);
    expect(await rows(owner.id, "update public.memberships set role = 'manager' where organization_id = $1 and user_id = $2", [org, member.id])).toBe(0);
    expect(await rows(admin.id, "delete from public.memberships where organization_id = $1 and user_id = $2", [org, member.id])).toBe(0);
    expect((await pgError(asMfaUser(owner.id, (q) =>
      q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 day')", [org])))).code).toBe("42501");
    expect((await pgError(asMfaUser(owner.id, (q) =>
      q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'x')", [org])))).code).toBe("42501");
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.transfer_ownership($1, $2)", [org, admin.id])))).hint).toBe("org_deletion:read_only");
    // a person still changes their own membership row (as in a closed business)
    expect(await rows(member.id, "update public.memberships set is_available = false where organization_id = $1 and user_id = $2", [org, member.id])).toBe(1);
    // the full export's reads still answer for the owner
    expect(await rows(owner.id, "select id from public.organizations where id = $1", [org])).toBe(1);
    // PRK-02: the privacy-request page stays open (privacy is never locked), and the staff status says so
    const page = await asService(async (q) =>
      (await one<{ r: { business?: string } }>(q, "select public.privacy_request_page($1, $2) as r", [privacyToken, "a".repeat(64)])).r);
    expect(page.business).toBeTruthy();
    const linkStatus = await asMfaUser(owner.id, async (q) =>
      (await one<{ r: { pages_open: boolean } }>(q, "select public.privacy_request_link_status($1) as r", [org])).r);
    expect(linkStatus.pages_open).toBe(true);
    // the status is unchanged
    const st = await asAdmin((q) => one<{ status: string }>(q, "select status from public.organizations where id = $1", [org]));
    expect(st.status).not.toBe("cancelled");
  });

  it("only the owner cancels, and the business is writable again at once", async () => {
    expect((await pgError(asMfaUser(admin.id, (q) => q("select public.org_deletion_cancel($1)", [org])))).code).toBe("42501");
    const r = await asMfaUser(owner.id, async (q) => (await one<{ r: { ok: boolean } }>(q, "select public.org_deletion_cancel($1) as r", [org])).r);
    expect(r.ok).toBe(true);
    expect(await writable(org)).toBe(true);
    expect((await status(owner.id, org))?.pending).toBe(false);
  });

  it("a code ages out, a newer request replaces the open one, five wrong codes end it, the pkce_ form is accepted", async () => {
    await requestAndCode(owner.id, org, "עסק למחיקה", "222222");
    await reauthenticate(owner.id, "222222", "61 minutes");
    expect((await confirm(owner.id, org, "222222")).reason).toBe("no_code");
    // the request itself lasts as long as the code
    await asAdmin((q) => q("update app.org_deletions set requested_at = now() - interval '61 minutes' where organization_id = $1 and confirmed_at is null and cancelled_at is null and replaced_at is null", [org]));
    expect((await confirm(owner.id, org, "222222")).reason).toBe("expired");
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [org]));

    await requestAndCode(owner.id, org, "עסק למחיקה", "333333");
    for (let i = 0; i < 4; i += 1) expect((await confirm(owner.id, org, "999999")).reason).toBe("code");
    expect((await confirm(owner.id, org, "999999")).reason).toBe("tries");
    expect((await confirm(owner.id, org, "333333")).reason).toBe("tries");
    expect(await writable(org)).toBe(true);

    // a new request replaces the open one and starts its own count
    await request(owner.id, org, "עסק למחיקה");
    await reauthenticate(owner.id, "444444", "0 seconds", "pkce_");
    expect((await confirm(owner.id, org, "444444")).ok).toBe(true);
    expect(await writable(org)).toBe(false);
    await clear(org);
    expect(await writable(org)).toBe(true);
  });

  it("one sent code gets five guesses in all, whichever of the person's businesses they come through", async () => {
    const second = await createOrg(owner.id, "עסק שני");
    await request(owner.id, org, "עסק למחיקה");
    await request(owner.id, second, "עסק שני");
    await reauthenticate(owner.id, "246810");
    for (let i = 0; i < 3; i += 1) expect((await confirm(owner.id, org, "111111")).reason).toBe("code");
    expect((await confirm(owner.id, second, "111111")).reason).toBe("code");
    expect((await confirm(owner.id, second, "111111")).reason).toBe("tries");
    // the sixth, even the right code, through either business
    expect((await confirm(owner.id, second, "246810")).reason).toBe("tries");
    expect((await confirm(owner.id, org, "246810")).reason).toBe("tries");
    expect(await writable(org)).toBe(true);
    expect(await writable(second)).toBe(true);
    // a new code opens new guesses
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [second]));
    await request(owner.id, second, "עסק שני");
    await reauthenticate(owner.id, "135791");
    expect((await confirm(owner.id, second, "135791")).ok).toBe(true);
    expect(await writable(second)).toBe(false);
    await clear(second);
    await clear(org);
  });

  it("the guess counter row is made before the code is compared, and old counters go with the run", async () => {
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [org]));
    await requestAndCode(owner.id, org, "עסק למחיקה", "112233");
    const rowFor = async () =>
      asAdmin(async (q) =>
        (await q<{ tries: number }>(
          `select t.tries from app.org_deletion_code_tries t join auth.users u on u.id = t.user_id
            where t.user_id = $1 and t.sent_at = u.reauthentication_sent_at`, [owner.id])).rows);
    expect(await rowFor()).toEqual([]);
    // the right code on the first try: the row exists (made, then locked), with no guess counted
    expect((await confirm(owner.id, org, "112233")).ok).toBe(true);
    expect(await rowFor()).toEqual([{ tries: 0 }]);
    await clear(org);
    // the pasted purge removes counters of codes older than a day, at the start of every run
    await asAdmin((q) => q("insert into app.org_deletion_code_tries (user_id, sent_at, tries) values ($1, now() - interval '25 hours', 3)", [owner.id]));
    await asAdmin((q) => q("select app.run_org_deletions(20)"));
    const left = await asAdmin(async (q) =>
      (await q<{ old: number; fresh: number }>(
        `select count(*) filter (where sent_at < now() - interval '1 day')::int old,
                count(*) filter (where sent_at >= now() - interval '1 day')::int fresh
           from app.org_deletion_code_tries where user_id = $1`, [owner.id])).rows[0]);
    // the earlier tests' recent counters stay
    expect(left.old).toBe(0);
    expect(left.fresh).toBeGreaterThan(0);
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [org]));
  });

  it("no confirmation while the account has an email change Auth has not finished", async () => {
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [org]));
    await requestAndCode(owner.id, org, "עסק למחיקה", "864200");
    await asAdmin((q) => q("update auth.users set email_change = 'new@example.test', email_change_sent_at = now() where id = $1", [owner.id]));
    expect((await confirm(owner.id, org, "864200")).reason).toBe("email_change");
    // a change asked long ago and left open still counts while email_change is set
    await asAdmin((q) => q("update auth.users set email_change_sent_at = now() - interval '3 hours' where id = $1", [owner.id]));
    expect((await confirm(owner.id, org, "864200")).reason).toBe("email_change");
    // a change finished within the code's lifetime too
    await asAdmin((q) => q("update auth.users set email_change = '', email_change_sent_at = now() - interval '5 minutes' where id = $1", [owner.id]));
    expect((await confirm(owner.id, org, "864200")).reason).toBe("email_change");
    await asAdmin((q) => q("update auth.users set email_change = null, email_change_sent_at = null where id = $1", [owner.id]));
    expect(await writable(org)).toBe(true);
    expect((await confirm(owner.id, org, "864200")).ok).toBe(true);
    await clear(org);
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [org]));
  });

  it("three requests a day per business", async () => {
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [org]));
    for (let i = 0; i < 3; i += 1) expect((await request(owner.id, org, "עסק למחיקה")).ok).toBe(true);
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.org_deletion_request($1, $2)", [org, "עסק למחיקה"])))).hint).toBe("org_deletion:rate");
    await asAdmin((q) => q("update app.org_deletions set requested_at = requested_at - interval '2 days' where organization_id = $1", [org]));
    expect((await request(owner.id, org, "עסק למחיקה")).ok).toBe(true);
    await clear(org);
  });

  it("the run waits for the due date", async () => {
    await requestAndCode(owner.id, org, "עסק למחיקה", "555555");
    expect((await confirm(owner.id, org, "555555")).ok).toBe(true);
    const n = await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.run_org_deletions(20) n")).n);
    expect(n).toBe(0);
    expect(await asAdmin(async (q) => (await q("select 1 from public.organizations where id = $1", [org])).rowCount)).toBe(1);
    // the service role cannot run it
    expect((await pgError(asService((q) => q("select app.run_org_deletions(20)")))).code).toBe("42501");
    await clear(org);
  });
});

describe("carrying out the deletion after 30 days (answer (363) ב)", () => {
  let owner: { id: string };
  let member: { id: string };
  let gone: string;
  let bystander: string;
  let bystanderBefore: Snapshot;
  let peopleBefore: Snapshot;
  const prefixes: string[] = [];

  afterAll(() => cleanupPrefixes(prefixes));

  beforeAll(async () => {
    owner = await createUser("gone-owner");
    const owner2 = await createUser("bystander-owner");
    gone = await createOrg(owner.id, "עסק שנמחק");
    bystander = await createOrg(owner2.id, "עסק שכן");
    prefixes.push(`${gone}/%`, `${bystander}/%`);
    await seed(owner, gone, "1");
    await seed(owner2, bystander, "2");
    member = await addMember(gone, owner.id, "member", "gone-member");
    await storageFor(owner, gone);
    await storageFor(owner2, bystander);
    await requestAndCode(owner.id, gone, "עסק שנמחק", "777777");
    expect((await confirm(owner.id, gone, "777777")).ok).toBe(true);
    bystanderBefore = await snapshot(bystander);
    peopleBefore = await personRows([owner.id, member.id]);
    expect(rowsOf(await snapshot(gone), "public.leads")).toBeGreaterThan(0);
    await asAdmin((q) => q("update app.org_deletions set scheduled_for = now() - interval '1 minute' where organization_id = $1 and done_at is null and cancelled_at is null and confirmed_at is not null", [gone]));
    const n = await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.run_org_deletions(20) n")).n);
    expect(n).toBe(1);
  });

  it("the business and everything of it is gone; the request row and the platform log stay", async () => {
    expect(await asAdmin(async (q) => (await q("select 1 from public.organizations where id = $1", [gone])).rowCount)).toBe(0);
    const after = await snapshot(gone);
    for (const [t, s] of Object.entries(after)) {
      if (t === "app.org_deletions" || t === "app.platform_log" || t === "app.automation_rule_runs") continue;
      expect(s, t).toBe("0:");
    }
    const done = await asAdmin((q) => one<{ d: string | null }>(q, "select max(done_at)::text d from app.org_deletions where organization_id = $1", [gone]));
    expect(done.d).toBeTruthy();
    const log = await asAdmin(async (q) => (await q("select 1 from app.platform_log where organization_id = $1 and action = 'org_deletion.done'", [gone])).rowCount);
    expect(log).toBe(1);
  });

  it("people keep their accounts and profiles", async () => {
    const after = await personRows([owner.id, member.id]);
    for (const t of ["auth.users", "public.profiles"]) {
      expect(after[t], t).toBe(peopleBefore[t]);
    }
  });

  it("its files wait for the nightly cleanup; the neighbour is untouched", async () => {
    expect((await orphanPaths(gone)).length).toBeGreaterThan(0);
    expect(await orphanPaths(bystander)).toEqual([]);
    expect(await snapshot(bystander)).toEqual(bystanderBefore);
  });

  it("a second run does nothing", async () => {
    const n = await asAdmin(async (q) => (await one<{ n: number }>(q, "select app.run_org_deletions(20) n")).n);
    expect(n).toBe(0);
  });
});
