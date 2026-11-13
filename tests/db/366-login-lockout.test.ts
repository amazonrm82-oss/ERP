import { createHmac, randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asService, asUser, closePool, createUser, pgError } from "./helpers";

afterAll(closePool);

// USR-13 (owner, 13 November 2026, answers (364) א and (370) א; CLAUDE.md hard rule 5): 5 failed sign-ins for one address
// lock it for 15 minutes, 50 from one sender across addresses lock the sender; the message is the same as a wrong
// password (the app's part); one definer function for the service role only; keyed hashes only, never a plain value.
// Each try is reserved before Auth ('attempt'), given back on a non-credential failure ('release'), cleared on 'success'.

/** A fresh 64-hex keyed hash (as the server would send). */
const hash = () => randomBytes(32).toString("hex");

type Answer = { locked: boolean; email_window?: string | null; ip_window?: string | null };
const guard = (email: string | null, ip: string | null, event: string, reserved: Answer | null = null) =>
  asService(async (q) =>
    (
      await q<{ r: Answer }>("select public.login_guard($1, $2, $3, $4, $5) as r", [
        email,
        ip,
        event,
        reserved?.email_window ?? null,
        reserved?.ip_window ?? null,
      ])
    ).rows[0].r,
  );

async function row(kind: "email" | "ip", h: string) {
  return asAdmin(async (q) => (await q("select * from app.login_attempts where kind = $1 and key_hash = $2", [kind, h])).rows[0]);
}

const lockLogs = () => asAdmin(async (q) => Number((await q("select count(*) as n from app.platform_log where action = 'login.locked'")).rows[0].n));

describe("sign-in lockout (USR-13)", () => {
  it("only the service role may call login_guard; no API role reads the table", async () => {
    const user = await createUser("login-lock");
    expect((await pgError(asAnon((q) => q("select public.login_guard(null, null, 'attempt')")))).code).toBe("42501");
    expect((await pgError(asUser(user.id, (q) => q("select public.login_guard(null, null, 'attempt')")))).code).toBe("42501");
    for (const role of [asAnon, asService] as const) {
      expect((await pgError(role((q) => q("select * from app.login_attempts")))).code).toBe("42501");
    }
    const acl = await asAdmin(async (q) =>
      (
        await q<{ grantee: string }>(`
          select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee
          from pg_proc p, aclexplode(p.proacl) a
          where p.oid = 'public.login_guard(text, text, text, timestamptz, timestamptz)'::regprocedure and a.privilege_type = 'EXECUTE'`)
      ).rows.map((r) => r.grantee),
    );
    expect(acl.filter((g) => g !== "postgres")).toEqual(["service_role"]);
    const settings = await asAdmin(async (q) =>
      (await q<{ prosecdef: boolean; proconfig: string[] }>("select prosecdef, proconfig from pg_proc where oid = 'public.login_guard(text, text, text, timestamptz, timestamptz)'::regprocedure")).rows[0],
    );
    expect(settings).toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
    // the purge and its wrapper are callable by no API role
    for (const fn of ["app.login_attempts_purge_rows(integer)", "app.run_login_attempts_purge()"]) {
      const grantees = await asAdmin(async (q) =>
        (
          await q<{ grantee: string }>(
            `select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee from pg_proc p, aclexplode(p.proacl) a
              where p.oid = $1::regprocedure and a.privilege_type = 'EXECUTE'`,
            [fn],
          )
        ).rows.map((r) => r.grantee),
      );
      expect(grantees.filter((g) => g !== "postgres"), fn).toEqual([]);
    }
    // the rules in one place
    const rules = await asAdmin(async (q) =>
      (await q("select app.login_lock_threshold('email') as email, app.login_lock_threshold('ip') as ip, extract(epoch from app.login_window())::int as w, extract(epoch from app.login_lock_length())::int as l")).rows[0],
    );
    expect(rules).toEqual({ email: 5, ip: 50, w: 900, l: 900 });
  });

  it("5 tries for one address go through, the 6th is refused for 15 minutes; refusals are not counted", async () => {
    const email = hash();
    const logsBefore = await lockLogs();
    for (let i = 1; i <= 5; i++) {
      expect(await guard(email, null, "attempt")).toMatchObject({ locked: false });
    }
    expect(await guard(email, null, "attempt")).toEqual({ locked: true });
    const locked = await row("email", email);
    expect(locked.failures).toBe(5);
    const minutes = (new Date(locked.locked_until).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15.1);
    // refusals do not lengthen the lock or count; the lock is logged once, with the kind only
    expect(await guard(email, null, "attempt")).toEqual({ locked: true });
    expect(await row("email", email)).toMatchObject({ failures: 5, locked_until: locked.locked_until });
    expect((await lockLogs()) - logsBefore).toBe(1);
    const logged = await asAdmin(async (q) =>
      (await q("select details from app.platform_log where action = 'login.locked' order by id desc limit 1")).rows[0].details,
    );
    expect(logged).toEqual({ kind: "email" });
    // another address is not locked
    expect(await guard(hash(), null, "attempt")).toMatchObject({ locked: false });
    // the lock ends after its 15 minutes; the next try starts a new window
    await asAdmin((q) => q("update app.login_attempts set locked_until = now() - interval '1 second', window_start = now() - interval '20 minutes' where kind = 'email' and key_hash = $1", [email]));
    expect(await guard(email, null, "attempt")).toMatchObject({ locked: false });
    expect(await row("email", email)).toMatchObject({ failures: 1, locked_until: null });
  });

  it("a burst of 10 parallel tries for one address lets at most 5 through", async () => {
    const email = hash();
    const answers = await Promise.all(Array.from({ length: 10 }, () => guard(email, hash(), "attempt")));
    expect(answers.filter((a) => !a.locked).length).toBe(5);
    expect((await row("email", email)).failures).toBe(5);
  });

  it("tries outside the 15-minute window start a new count", async () => {
    const email = hash();
    for (let i = 0; i < 4; i++) await guard(email, null, "attempt");
    await asAdmin((q) => q("update app.login_attempts set window_start = now() - interval '16 minutes' where kind = 'email' and key_hash = $1", [email]));
    expect(await guard(email, null, "attempt")).toMatchObject({ locked: false });
    expect((await row("email", email)).failures).toBe(1);
  });

  it("a success clears the address's count (4 wrong then right is not locked) and gives the sender's try back", async () => {
    const email = hash();
    const ip = hash();
    for (let i = 0; i < 4; i++) await guard(email, ip, "attempt");
    // the 5th try is the right password: it reached the threshold, and the success clears it
    const fifth = await guard(email, ip, "attempt");
    expect(fifth).toMatchObject({ locked: false });
    expect(await guard(email, ip, "success", fifth)).toMatchObject({ locked: false });
    expect(await row("email", email)).toMatchObject({ failures: 0, window_start: null, locked_until: null });
    // the sender's four wrong tries stay; the right one is given back
    expect((await row("ip", ip)).failures).toBe(4);
    expect(await guard(email, ip, "attempt")).toMatchObject({ locked: false });
  });

  it("a release gives a reserved try back, and lifts the lock that try set", async () => {
    const email = hash();
    const ip = hash();
    let fifth: Answer = { locked: false };
    for (let i = 0; i < 5; i++) fifth = await guard(email, ip, "attempt");
    expect((await row("email", email)).locked_until).not.toBeNull();
    // the 5th try's Auth call failed for another reason: the try is given back on both rows
    expect(await guard(email, ip, "release", fifth)).toMatchObject({ locked: false });
    expect(await row("email", email)).toMatchObject({ failures: 4, locked_until: null });
    expect((await row("ip", ip)).failures).toBe(4);
    expect(await guard(email, ip, "attempt")).toMatchObject({ locked: false });
    // a release never goes below zero
    const fresh = hash();
    const one = await guard(fresh, null, "attempt");
    await guard(fresh, null, "release", one);
    await guard(fresh, null, "release", one);
    expect((await row("email", fresh)).failures).toBe(0);
    // no window = nothing given back
    await guard(fresh, null, "attempt");
    await guard(fresh, null, "release");
    expect((await row("email", fresh)).failures).toBe(1);
  });

  it("a late release or success never takes a try off a newer window", async () => {
    const email = hash();
    const ip = hash();
    const old = await guard(email, ip, "attempt");
    // both windows ended and new ones began
    await asAdmin((q) => q("update app.login_attempts set window_start = now() - interval '16 minutes' where key_hash in ($1, $2)", [email, ip]));
    await guard(email, ip, "attempt");
    await guard(email, ip, "attempt");
    await guard(email, ip, "release", old);
    await guard(email, ip, "success", old);
    expect((await row("email", email)).failures).toBe(2);
    expect((await row("ip", ip)).failures).toBe(2);
  });

  it("60 successful sign-ins from one sender across addresses never lock it", async () => {
    const ip = hash();
    for (let i = 0; i < 60; i++) {
      const email = hash();
      const reserved = await guard(email, ip, "attempt");
      expect(reserved, `sign-in ${i + 1}`).toMatchObject({ locked: false });
      await guard(email, ip, "success", reserved);
    }
    expect(await row("ip", ip)).toMatchObject({ failures: 0, locked_until: null });
  });

  it("50 tries from one sender across addresses lock the sender", async () => {
    const ip = hash();
    for (let i = 1; i <= 50; i++) {
      expect(await guard(hash(), ip, "attempt")).toMatchObject({ locked: false });
    }
    // any address from that sender is refused (and that address is not counted); another sender is not
    const email = hash();
    expect(await guard(email, ip, "attempt")).toEqual({ locked: true });
    // a locked sender creates no row for a new address
    expect(await row("email", email)).toBeUndefined();
    expect(await guard(email, hash(), "attempt")).toMatchObject({ locked: false });
  });

  it("stores no plain value, only keyed hashes; stale rows are removed by the purge, live ones kept", async () => {
    const secret = "db-test-secret";
    const email = createHmac("sha256", secret).update("login-email:someone@example.co").digest("hex");
    const ip = createHmac("sha256", secret).update("login:198.51.100.4").digest("hex");
    await guard(email, ip, "attempt");
    const dump = await asAdmin(async (q) => JSON.stringify((await q("select * from app.login_attempts")).rows));
    expect(dump).not.toMatch(/someone|example|198\.51\.100/);
    const columns = await asAdmin(async (q) =>
      (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'app' and table_name = 'login_attempts' order by ordinal_position")).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(["kind", "key_hash", "failures", "window_start", "locked_until", "lock_logged_at"]);

    const live = hash();
    const locked = hash();
    for (let i = 0; i < 5; i++) await guard(locked, null, "attempt");
    await guard(live, null, "attempt");
    await asAdmin((q) => q("update app.login_attempts set window_start = now() - interval '16 minutes' where key_hash in ($1, $2, $3)", [email, ip, locked]));
    const removed = await asAdmin(async (q) => (await q<{ n: number }>("select app.run_login_attempts_purge() as n")).rows[0].n);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await row("email", email)).toBeUndefined();
    expect(await row("ip", ip)).toBeUndefined();
    // a live window and a live lock stay
    expect(await row("email", live)).toBeDefined();
    expect(await row("email", locked)).toBeDefined();
  });

  it("a refusal from a stale read never writes back the counts or the lock (a success committed meanwhile is kept)", async () => {
    const ip = hash();
    for (let i = 0; i < 50; i++) await guard(hash(), ip, "attempt");
    // A read the locked sender row without a row lock ...
    const stale = await asAdmin(async (q) => (await q("select a::text as r from app.login_attempts a where kind = 'ip' and key_hash = $1", [ip])).rows[0].r);
    // ... meanwhile B's correct sign-in gave its try back and lifted the lock
    await asAdmin((q) => q("update app.login_attempts set failures = 49, locked_until = null where kind = 'ip' and key_hash = $1", [ip]));
    const logsBefore = await lockLogs();
    await asAdmin((q) => q("select app.login_refused($1::app.login_attempts)", [stale]));
    expect(await row("ip", ip)).toMatchObject({ failures: 49, locked_until: null, lock_logged_at: null });
    expect(await lockLogs()).toBe(logsBefore);
    // a refusal while the stored row is still locked logs once and touches only lock_logged_at
    for (let i = 0; i < 1; i++) await guard(hash(), ip, "attempt");
    const locked = await row("ip", ip);
    expect(locked.failures).toBe(50);
    expect(await guard(hash(), ip, "attempt")).toEqual({ locked: true });
    expect(await row("ip", ip)).toMatchObject({ failures: 50, locked_until: locked.locked_until });
    expect((await row("ip", ip)).lock_logged_at).not.toBeNull();
    expect((await lockLogs()) - logsBefore).toBe(1);
  });

  it("ignores malformed hashes and refuses an unknown event", async () => {
    expect(await guard("not-a-hash", "DANA@EXAMPLE.CO", "attempt")).toMatchObject({ locked: false });
    const dump = await asAdmin(async (q) => JSON.stringify((await q("select key_hash from app.login_attempts")).rows));
    expect(dump).not.toMatch(/not-a-hash|DANA/i);
    for (const event of ["check", "failure", "reset"]) {
      expect((await pgError(guard(hash(), null, event))).hint).toBe("login:event");
    }
  });
});
