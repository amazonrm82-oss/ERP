import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Line = { kind: string; code: string | null; hits: number };

// DOC-16 (migration invoice_provider_events): the invoice provider connection's sync log, written only by triggers on the
// settings row and on the issue requests (the worker's pinned functions are unchanged), read by owners and admins; a fallen
// connection (the key refused, the provider unreachable on every try, a failed check) tells the active owners and admins
// once a business day. A document the provider refused is a log line, not an alert.

const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
const TITLE = "החיבור לספק החשבוניות הפסיק לעבוד";

describe("invoice provider sync log and connection notice (DOC-16)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let person: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const lines = (o = org) =>
    asAdmin(async (q) => (await q<Line>("select kind, code, hits from public.invoice_provider_events where organization_id = $1 order by created_at, kind, code", [o])).rows);
  const line = async (kind: string, code: string | null = null) => (await lines()).find((l) => l.kind === kind && l.code === code);
  // the notices of the current case (each case starts its own business day, beforeEach)
  let since = "";
  const told = () =>
    asAdmin(async (q) =>
      (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and title = $2 and entity_type = 'invoice_provider' and created_at >= $3", [org, TITLE, since])).rows
        .map((x) => x.user_id)
        .sort(),
    );
  const doc = { doc_type: "tax_invoice", prices_include_vat: false, lines: [{ description: "ייעוץ", quantity: 1, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false }] };
  const begin = () =>
    run(owner, async (q) =>
      (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_begin($1, $2, 'contact', $3, $4) as r", [org, randomUUID(), person, JSON.stringify(doc)])).r
        .request_id as string,
    );
  type Job = { id: string; lease: string };
  const claimJob = async (request: string): Promise<Job> => {
    const jobId = (await asAdmin((q) => one<{ j: string }>(q, "select job_id as j from app.invoice_issue_requests where id = $1", [request]))).j;
    const rows = await asService(async (q) => (await one<{ r: Job[] }>(q, "select public.claim_jobs(array['invoice.issue'], 100) as r")).r);
    for (const other of rows.filter((x) => x.id !== jobId)) {
      await asService((q) => q("select public.finish_job($1, $2, false, null, false, false)", [other.id, other.lease]));
    }
    const job = rows.find((x) => x.id === jobId);
    if (!job) throw new Error("the request's job was not claimed");
    await asService((q) => q("select public.invoice_issue_claim($1, $2)", [job.id, job.lease]));
    return job;
  };
  const record = (job: Job, answer: Record<string, unknown>) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_record($1, $2, $3) as r", [job.id, job.lease, JSON.stringify(answer)])).r);

  beforeAll(async () => {
    owner = await createUser("ipe-owner");
    org = await createOrg(owner.id, "עסק היומן");
    admin = await addMember(org, owner.id, "admin", "ipe-admin");
    manager = await addMember(org, owner.id, "manager", "ipe-manager");
    member = await addMember(org, owner.id, "member", "ipe-member");
    viewer = await addMember(org, owner.id, "viewer", "ipe-viewer");
    outsider = await createUser("ipe-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"documents\": true}' where organization_id = any($1::uuid[])", [[org, otherOrg]]));
    await run(owner, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    await defaultPipeline(org);
    person = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, owner_id) values ($1, 'דנה', 'לוי', $2) returning id", [org, owner.id])).id,
    );
  });

  // each case starts a fresh business day for the notice
  beforeEach(async () => {
    since = (await asAdmin((q) => one<{ t: string }>(q, "select clock_timestamp()::text as t"))).t;
    await asAdmin((q) => q("update app.invoice_provider_notice_days set day = day - 400 where organization_id = $1", [org]));
  });
  afterEach(() =>
    asAdmin(async (q) => {
      await q("update app.invoice_issue_requests set status = 'stale', error_code = 'stale', finished_at = now() where organization_id = $1 and status = 'pending'", [org]);
      await q("update app.jobs set status = 'done', lease_id = null, locked_until = null, finished_at = now() where kind = 'invoice.issue' and status in ('queued', 'running', 'failed')");
    }),
  );

  it("logs the connection's life; a defaults save writes nothing", async () => {
    await run(admin, (q) => q("insert into public.invoice_provider_settings (organization_id, locale) values ($1, 'en')", [org]));
    expect(await lines()).toEqual([]);
    await run(admin, (q) => q("select public.invoice_provider_connect($1, 'fake')", [org]));
    await run(owner, (q) => q("select public.invoice_provider_check_recorded($1, true)", [org]));
    await run(owner, (q) => q("update public.invoice_provider_settings set locale = 'he' where organization_id = $1", [org]));
    await run(admin, (q) => q("select public.invoice_provider_disconnect($1)", [org]));
    await run(admin, (q) => q("select public.invoice_provider_connect($1, 'fake')", [org]));
    expect(await lines()).toEqual([
      { kind: "connected", code: null, hits: 2 },
      { kind: "check_ok", code: null, hits: 1 },
      { kind: "disconnected", code: null, hits: 1 },
    ]);
    expect(await told()).toEqual([]);
  });

  it("a failed check is a fall: owners and admins are told once a business day", async () => {
    await run(owner, (q) => q("select public.invoice_provider_check_recorded($1, false)", [org]));
    await run(owner, (q) => q("select public.invoice_provider_check_recorded($1, false)", [org]));
    expect(await line("check_failed")).toMatchObject({ hits: 2 });
    expect(await told()).toEqual([owner.id, admin.id].sort());
  });

  it("logs issued documents, retries and the provider's refusals, and folds a day into one line per kind and code", async () => {
    for (let i = 0; i < 2; i += 1) {
      const job = await claimJob(await begin());
      expect(await record(job, { ok: true, provider_document_id: `fake_ipe_${randomUUID()}`, number: `7${i}${Date.now() % 100000}` })).toMatchObject({ status: "issued" });
    }
    expect(await line("issued", "tax_invoice")).toMatchObject({ hits: 2 });

    // one document refused for its details: a line, no alert
    const refused = await claimJob(await begin());
    expect(await record(refused, { ok: false, code: "bad_tax_id", final: true })).toEqual({ status: "failed", code: "bad_tax_id" });
    expect(await line("failed", "bad_tax_id")).toMatchObject({ hits: 1 });

    // a provider that did not answer: a retry line, then a timeout that never reached it on the last try
    const busy = await claimJob(await begin());
    expect(await record(busy, { ok: false, code: "timeout", final: false })).toEqual({ status: "pending", code: "timeout" });
    expect(await record(busy, { ok: false, code: "unreachable", final: false })).toEqual({ status: "pending", code: "unreachable" });
    expect(await line("retry", "timeout")).toMatchObject({ hits: 1 });
    expect(await line("retry", "unreachable")).toMatchObject({ hits: 1 });
    expect(await told()).toEqual([]);
    await asAdmin((q) => q("update app.jobs set attempts = app.job_max_attempts() where id = $1", [busy.id]));
    expect(await record(busy, { ok: false, code: "unreachable", final: false })).toEqual({ status: "unrecorded", code: "retries_spent" });
    expect(await line("unrecorded", "retries_spent")).toMatchObject({ hits: 1 });
    // every try could not reach the provider: the connection fell
    expect(await told()).toEqual([owner.id, admin.id].sort());
  });

  it("the key refused (auth) is a fall, also on a retry; a person's close and the stale mark are lines", async () => {
    const job = await claimJob(await begin());
    expect(await record(job, { ok: false, code: "auth:key_refused", final: true })).toEqual({ status: "failed", code: "auth:key_refused" });
    expect(await line("failed", "auth:key_refused")).toMatchObject({ hits: 1 });
    expect(await told()).toEqual([owner.id, admin.id].sort());
    // once a business day: a second fall that day tells no one again
    const again = await claimJob(await begin());
    await record(again, { ok: false, code: "customer_auth:key_refused", final: false });
    expect(await line("retry", "customer_auth:key_refused")).toMatchObject({ hits: 1 });
    expect((await told()).length).toBe(2);
    // ended, so the next begin is a new request (a pending one of the last 15 minutes would be reused)
    expect(await record(again, { ok: false, code: "bad_tax_id", final: true })).toMatchObject({ status: "failed" });

    const open = await begin();
    expect((await run(owner, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.invoice_issue_close($1, $2) as r", [org, open])).r))).toMatchObject({ code: "closed" });
    expect(await line("closed")).toMatchObject({ hits: 1 });
    const old = await begin();
    await asAdmin((q) => q("update app.invoice_issue_requests set created_at = now() - interval '25 hours' where id = $1", [old]));
    await asAdmin((q) => q("update app.jobs set status = 'done', finished_at = now() where id = (select job_id from app.invoice_issue_requests where id = $1)", [old]));
    await asAdmin((q) => q("select app.invoice_issue_mark_stale()"));
    expect(await line("stale")).toBeDefined();
  });

  it("holds codes and kinds only: no customer, number, amount or person", async () => {
    const columns = await asAdmin(async (q) =>
      (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'invoice_provider_events' order by column_name")).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(["code", "created_at", "day", "hits", "id", "kind", "last_at", "organization_id", "provider"]);
  });

  it("owners and admins read it; nobody else sees it, no role writes it, another business sees nothing", async () => {
    for (const u of [owner, admin]) expect(await run(u, (q) => count(q, "select 1 from public.invoice_provider_events where organization_id = $1", [org])), u.email).toBeGreaterThan(0);
    for (const u of [manager, member, viewer, outsider]) expect(await run(u, (q) => count(q, "select 1 from public.invoice_provider_events where organization_id = $1", [org])), u.email).toBe(0);
    for (const u of [owner, admin, manager, member, viewer, outsider]) {
      expect((await pgError(run(u, (q) => q("update public.invoice_provider_events set hits = 9 where organization_id = $1", [org])))).code, u.email).toBe("42501");
      expect((await pgError(run(u, (q) => q("delete from public.invoice_provider_events where organization_id = $1", [org])))).code, u.email).toBe("42501");
      expect(
        (await pgError(run(u, (q) => q("insert into public.invoice_provider_events (organization_id, provider, kind, day) values ($1, 'fake', 'connected', current_date)", [org])))).code,
        u.email,
      ).toBe("42501");
    }
    expect(await lines(otherOrg)).toEqual([]);
  });

  it("the helpers and triggers are not callable by any client role; the purge waits for its pasted file", async () => {
    for (const fn of [
      "app.invoice_provider_event_log(uuid, text, text, text)",
      "app.invoice_provider_connection_failure(uuid, text)",
      "app.invoice_provider_auth_code(text)",
      "app.invoice_provider_unreachable_code(text)",
      "app.purge_old_invoice_provider_events()",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const can = await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok);
        expect(can, `${role} ${fn}`).toBe(false);
      }
    }
    const rule = await asAdmin(async (q) =>
      (await one<{ a: boolean[]; u: boolean[] }>(
        q,
        `select array[app.invoice_provider_auth_code('auth:x'), app.invoice_provider_auth_code('auth'), app.invoice_provider_auth_code('product_auth:y'),
                      app.invoice_provider_auth_code('author'), app.invoice_provider_auth_code('bad_tax_id'), app.invoice_provider_auth_code(null)] as a,
                array[app.invoice_provider_unreachable_code('timeout'), app.invoice_provider_unreachable_code('customer_unreachable'),
                      app.invoice_provider_unreachable_code('unreachable_x'), app.invoice_provider_unreachable_code(null)] as u`,
      )),
    );
    expect(rule.a).toEqual([true, true, true, false, false, false]);
    expect(rule.u).toEqual([true, true, false, false]);
  });

  it("lines older than 12 months are removed by the nightly purge, newer ones stay", async () => {
    await asAdmin((q) =>
      q("insert into public.invoice_provider_events (organization_id, provider, kind, code, day, last_at) values ($1, 'fake', 'retry', 'old_code', current_date - 400, now() - interval '13 months')", [org]),
    );
    const kept = (await lines()).length;
    await asAdmin((q) => q("select app.purge_old_invoice_provider_events()"));
    expect((await lines()).find((l) => l.code === "old_code")).toBeUndefined();
    expect((await lines()).length).toBe(kept - 1);
  });
});
