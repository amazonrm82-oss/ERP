import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Claim = { lease?: string; page_id?: string; ciphertext?: string; refused?: string; retry_seconds?: number };

const envelope = (body: string) => `ps1.1.AAAAAAAAAAAAAAAA.${body}.BBBBBBBBBBBBBBBBBBBBBB`;

/**
 * INT-01 "test connection" with the stored token (owner, 10 November 2026, answer (227) ב): two definers granted to
 * service_role only; the claim answers the ciphertext and page id of THIS connection only, to a person checked again as an
 * active owner/admin, 5 times per connection in 10 minutes; the finish writes only verified_at / last_error_code and one log
 * line, under CAP-11's page-ownership rule.
 */
describe("test connection with the stored token (INT-01, owner (227) ב)", () => {
  let owner: U, admin: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let seq = (process.pid % 100000) * 1000 + 700;
  const id = () => String(8200000000 + (seq += 1));

  const makeConnection = (who: U, o: string, page: string, body = "VG9rZW5TdG9yZWQ") =>
    asUser(who.id, async (q) => {
      const made = (await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'הדף') returning id", [o, page])).rows[0].id;
      await q("select public.integration_secret_set($1, $2, $3, 1)", [o, made, envelope(body)]);
      return made;
    });
  const claim = (o: string, conn: string, user: string) =>
    asService(async (q) => (await q<{ r: Claim }>("select public.integration_test_claim($1, $2, $3) as r", [o, conn, user])).rows[0].r);
  const finish = (o: string, conn: string, lease: string, result: string) =>
    asService(async (q) => (await q<{ r: string }>("select public.integration_test_finish($1, $2, $3, $4) as r", [o, conn, lease, result])).rows[0].r);
  const row = (conn: string) =>
    asAdmin(async (q) => (await q<Record<string, unknown>>("select * from public.integrations where id = $1", [conn])).rows[0]);
  const testLines = (conn: string) =>
    asAdmin(
      async (q) =>
        (await q<{ kind: string; code: string | null }>(
          "select kind, code from public.integration_events where connection_id = $1 and kind like 'test_%' order by created_at",
          [conn],
        )).rows,
    );
  const resetWindow = (conn: string) => asAdmin((q) => q("update app.integration_tests set tests = 0 where integration_id = $1", [conn]));

  beforeAll(async () => {
    owner = await createUser("inttest-owner");
    org = await createOrg(owner.id, "עסק הבדיקה");
    admin = await addMember(org, owner.id, "admin", "inttest-admin");
    member = await addMember(org, owner.id, "member", "inttest-member");
    viewer = await addMember(org, owner.id, "viewer", "inttest-viewer");
    outsider = await createUser("inttest-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("only service_role may call the two definers", async () => {
    const rows = await asAdmin(
      async (q) =>
        (await q<{ name: string; definer: boolean; anon: boolean; authenticated: boolean; service: boolean }>(
          `select p.proname as name, p.prosecdef as definer,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                  has_function_privilege('service_role', p.oid, 'execute') as service
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('integration_test_claim', 'integration_test_finish')`,
        )).rows,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r, r.name).toMatchObject({ definer: true, anon: false, authenticated: false, service: true });
    const conn = await makeConnection(owner, org, id());
    for (const u of [owner, admin, member, viewer, outsider]) {
      expect((await pgError(asUser(u.id, (q) => q("select public.integration_test_claim($1, $2, $3)", [org, conn, u.id])))).code, u.email).toBe("42501");
    }
  });

  it("answers this connection's ciphertext only to an active owner or admin of its business, never another's", async () => {
    const conn = await makeConnection(owner, org, id(), "QnVzaW5lc3NPbmU");
    const theirs = await makeConnection(outsider, otherOrg, id(), "QnVzaW5lc3NUd28");
    for (const u of [owner, admin]) {
      const got = await claim(org, conn, u.id);
      expect(Object.keys(got).sort(), u.email).toEqual(["ciphertext", "lease", "page_id"]);
      expect(got.ciphertext).toContain("QnVzaW5lc3NPbmU");
    }
    for (const u of [member, viewer, outsider]) expect(await claim(org, conn, u.id), u.email).toEqual({ refused: "not_found" });
    // another business's connection through this business, or this person through the other business
    expect(await claim(org, theirs, owner.id)).toEqual({ refused: "not_found" });
    expect(await claim(otherOrg, conn, outsider.id)).toEqual({ refused: "not_found" });
    expect(await claim(otherOrg, theirs, owner.id)).toEqual({ refused: "not_found" });
  });

  it("5 tests per connection in 10 minutes, counted in the database; a refusal tells how long to wait", async () => {
    const conn = await makeConnection(owner, org, id());
    for (let n = 0; n < 5; n += 1) expect((await claim(org, conn, owner.id)).lease, `test ${n + 1}`).toBeTruthy();
    const refused = await claim(org, conn, admin.id);
    expect(refused.refused).toBe("rate");
    expect(refused.retry_seconds).toBeGreaterThan(0);
    expect(refused.retry_seconds).toBeLessThanOrEqual(600);
    // a new window counts again
    await asAdmin((q) => q("update app.integration_tests set window_start = now() - interval '11 minutes' where integration_id = $1", [conn]));
    expect((await claim(org, conn, owner.id)).lease).toBeTruthy();
  });

  it("a successful test writes only verified_at (and clears token_invalid), logs test_ok, and the lease is used once", async () => {
    const conn = await makeConnection(owner, org, id());
    const before = await row(conn);
    const secretBefore = await asAdmin(async (q) => (await q("select * from app.integration_secrets where integration_id = $1", [conn])).rows[0]);
    const got = await claim(org, conn, owner.id);
    expect(await finish(org, conn, got.lease!, "ok")).toBe("ok");
    const after = await row(conn);
    expect(after.verified_at).not.toBeNull();
    const strip = (r: Record<string, unknown>) => {
      const rest = { ...r };
      for (const key of ["verified_at", "last_error_code", "updated_at"]) delete rest[key];
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(await asAdmin(async (q) => (await q("select * from app.integration_secrets where integration_id = $1", [conn])).rows[0])).toEqual(secretBefore);
    expect(await testLines(conn)).toEqual([{ kind: "test_ok", code: null }]);
    // the same lease again
    expect(await finish(org, conn, got.lease!, "ok")).toBe("expired");
    expect(await finish(org, conn, "00000000-0000-4000-8000-000000000000", "ok")).toBe("expired");
  });

  it("a failed test logs its code; token_invalid is kept on the connection, a provider hiccup writes nothing", async () => {
    const conn = await makeConnection(owner, org, id());
    const before = await row(conn);
    let got = await claim(org, conn, owner.id);
    expect(await finish(org, conn, got.lease!, "graph_unavailable")).toBe("graph_unavailable");
    const mid = await row(conn);
    expect({ ...mid, updated_at: null }).toEqual({ ...before, updated_at: null });
    got = await claim(org, conn, owner.id);
    expect(await finish(org, conn, got.lease!, "token_invalid")).toBe("token_invalid");
    const after = await row(conn);
    expect(after.last_error_code).toBe("token_invalid");
    expect(after.status).toBe(before.status);
    expect(after.last_error_at).toEqual(before.last_error_at);
    expect(await testLines(conn)).toEqual([
      { kind: "test_failed", code: "graph_unavailable" },
      { kind: "test_failed", code: "token_invalid" },
    ]);
    // an unverified connection ended by token_invalid is not tested again until a new token
    expect(await claim(org, conn, owner.id)).toEqual({ refused: "closed" });
    // a code the function does not know is stored as 'error'
    await asUser(owner.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [org, conn, envelope("TmV3VG9rZW5Ib3Jl")]));
    got = await claim(org, conn, owner.id);
    expect(await finish(org, conn, got.lease!, "Bad Value; drop")).toBe("error");
  });

  it("a token replaced during the test answers 'changed' and writes nothing on the connection", async () => {
    const conn = await makeConnection(owner, org, id());
    const got = await claim(org, conn, owner.id);
    await asUser(owner.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [org, conn, envelope("UmVwbGFjZWRUb2tlbg")]));
    const before = await row(conn);
    expect(await finish(org, conn, got.lease!, "ok")).toBe("changed");
    expect(await row(conn)).toEqual(before);
  });

  it("follows CAP-11's page rule: verifying a page ends every other connection of it; a page verified elsewhere ends this one", async () => {
    const page = id();
    const mine = await makeConnection(owner, org, page, "TWluZVRva2Vu");
    const theirs = await makeConnection(outsider, otherOrg, page, "VGhlaXJzVG9rZW4");
    // I prove the page first
    let got = await claim(org, mine, owner.id);
    expect(await finish(org, mine, got.lease!, "ok")).toBe("ok");
    expect((await row(mine)).verified_at).not.toBeNull();
    const ended = await row(theirs);
    expect(ended).toMatchObject({ status: "error", last_error_code: "page_taken", verified_at: null });
    // their ended, unverified connection cannot be tested until a new token
    expect(await claim(otherOrg, theirs, outsider.id)).toEqual({ refused: "closed" });
    // a new token cannot take a page verified elsewhere (CAP-11's going-live rule, unchanged)
    expect(
      (await pgError(asUser(outsider.id, (q) => q("select public.integration_secret_set($1, $2, $3, 1)", [otherOrg, theirs, envelope("VGhlaXJzTmV3VG9rZW4")])))).hint,
    ).toBe("integration:taken");
    // the race: a connection still open while the page got verified elsewhere (a verification that skipped its locked row)
    const page2 = id();
    const late = await makeConnection(outsider, otherOrg, page2, "TGF0ZVRva2Vu");
    const first = await makeConnection(owner, org, page2, "Rmlyc3RUb2tlbg");
    got = await claim(otherOrg, late, outsider.id);
    await asAdmin((q) => q("update public.integrations set verified_at = now() where id = $1", [first]));
    expect(await finish(otherOrg, late, got.lease!, "ok")).toBe("page_taken");
    expect(await row(late)).toMatchObject({ status: "connected", last_error_code: "page_taken", verified_at: null });
    expect(await claim(otherOrg, late, outsider.id)).toEqual({ refused: "closed" });
    expect(await testLines(late)).toEqual([{ kind: "test_failed", code: "page_taken" }]);
    // the other business learns nothing about mine
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.integration_events where connection_id = $1", [mine]))).toBe(0);
    await resetWindow(mine);
  });

  it("a connection row held by another transaction answers 'busy' without waiting, and the lease is kept (review finding 1)", async () => {
    const conn = await makeConnection(owner, org, id());
    const got = await claim(org, conn, owner.id);
    const holder = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.integrations where id = $1 for update", [conn]);
      expect(await finish(org, conn, got.lease!, "ok")).toBe("busy");
      await holder.query("rollback");
    } finally {
      await holder.end();
    }
    expect((await row(conn)).verified_at).toBeNull();
    expect(await testLines(conn)).toEqual([]);
    expect(await finish(org, conn, got.lease!, "ok")).toBe("ok");
  });

  it("a KEY SHARE holder of the connection row (an arrival insert, a log line) does not make the test busy", async () => {
    const conn = await makeConnection(owner, org, id());
    const got = await claim(org, conn, owner.id);
    const holder = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.integrations where id = $1 for key share", [conn]);
      expect(await finish(org, conn, got.lease!, "ok")).toBe("ok");
      await holder.query("rollback");
    } finally {
      await holder.end();
    }
  });

  it("a successful test clears secret_unreadable too (review finding 5)", async () => {
    const conn = await makeConnection(owner, org, id());
    let got = await claim(org, conn, owner.id);
    expect(await finish(org, conn, got.lease!, "ok")).toBe("ok");
    got = await claim(org, conn, owner.id);
    expect(await finish(org, conn, got.lease!, "secret_unreadable")).toBe("secret_unreadable");
    expect((await row(conn)).last_error_code).toBe("secret_unreadable");
    got = await claim(org, conn, owner.id);
    expect(await finish(org, conn, got.lease!, "ok")).toBe("ok");
    expect((await row(conn)).last_error_code).toBeNull();
  });

  it("refuses a read-only business and writes nothing then", async () => {
    const conn = await makeConnection(owner, org, id());
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await claim(org, conn, owner.id)).toEqual({ refused: "read_only" });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
    }
    expect(await asAdmin((q) => count(q, "select 1 from app.integration_tests where integration_id = $1", [conn]))).toBe(0);
  });
});
