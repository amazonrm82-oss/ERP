import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError, type Query } from "./helpers";

// IMP-04 (owner's answer (155) א, 9 November 2026): background imports and the full export through the OPS-04 queue.
// The queue holds ids only; the work runs with the ordering person's own rights; the files sit in the private bucket
// 'job-files' for 7 days; the worker's functions are pinned by md5 (a change needs a fresh independent review against
// answer (55)'s conditions and (155)'s: ids only, the person's own rights, never more).
// IMP-04 (021184): as written after owner (160)-(163); first independent review: no critical or high finding. The functions
// below that the review's findings 1-5 changed carry a "(changed: ...)" line; they need the review's re-check.
const REVIEWED_MD5: Record<string, string> = {
  "app.audit_log_background": "bd8b23fbe9f1f5a785b78c1414b51152",
  "app.background_allowed": "e24ba176043e287dbbf81306b522f9c8",
  // (changed: review 3, the aal is the lower of the order's and the ordering session's now, app.background_session_aal)
  "app.background_claims": "2d4d67aaf0a4696db54394a881774629",
  "app.background_job_row": "93f7e9dcb244a917923cf3cabef1e440",
  "app.background_notify": "cd9b1f1e97cb7c8233920cc6edc2e0c6",
  // (changed: review 3, the session through app.background_session_aal: not run out, readable or refused; review 5, the
  // legal agreement: the app's version, registered in app.agreement_texts, is the person's latest signature)
  "app.background_refusal": "7feea5c9e5dc84d5ac57e15632638f4d",
  // (changed: review 5, the notice text for 'agreement')
  "app.background_refuse": "7ac41efd0cad65b6a8b9d5aeee2c0910",
  "app.background_request_of": "a791478094906e370c1fc11ab9481643",
  // (changed: new, review 3: the ordering session as it is now; fails closed on any read error)
  "app.background_session_aal": "168f3a96985ac663aee077d90c23ac18",
  // (changed: review 5, takes the app's legal version and hands it to app.background_refusal)
  "public.background_job_begin": "24e3acbc2593a163488c33938c15bcc0",
  "public.background_job_end": "5eb3a018e50c42ac7aed4dfa84024a6b",
  "public.background_job_progress": "2b9931caa09e2ce9f263211e7deb631e",
  // (changed: review 2, answers the lease's end locked_until; review 5, takes the app's legal version)
  "public.background_job_token": "3fe60ddef23662bbc6d1755d9ce9b322",
};

type Claimed = { id: string; lease: string; kind: string; organization_id: string; payload: Record<string, unknown> };

let owner: { id: string };
let manager: { id: string };
let member: { id: string };
let viewer: { id: string };
let org: string;
let otherOwner: { id: string };
let otherOrg: string;

const sourceOf = (o: string, r: string) => `${o}/${r}/source.json`;

// review 5: the app's LEGAL_VERSION, which the worker hands to begin and token (src/features/legal/documents.ts)
const LEGAL = /export const LEGAL_VERSION = "([^"]+)"/.exec(readFileSync(join(process.cwd(), "src/features/legal/documents.ts"), "utf8"))?.[1] as string;
/** The person signed this version of the agreement (as sign_agreement keeps it). */
const sign = (userId: string, version = LEGAL) =>
  asAdmin((q) =>
    q(
      "insert into app.agreement_signatures (user_id, version, documents, content_hash, full_name, method) values ($1, $2, '[]', repeat('a', 64), 'חותם בדיקה', 'typed')",
      [userId, version],
    ),
  );

const sessions = new Map<string, string>();
/** The person's open session (one per person), as auth.sessions holds it. */
async function sessionOf(userId: string): Promise<string> {
  const known = sessions.get(userId);
  if (known) return known;
  const id = await asAdmin(async (q) => (await q<{ id: string }>("insert into auth.sessions (user_id, aal) values ($1, 'aal1') returning id", [userId])).rows[0].id);
  sessions.set(userId, id);
  return id;
}

async function order(userId: string, kind: "import" | "export", o = org, extra: Record<string, unknown> = {}): Promise<string> {
  const claims = { aal: "aal1", session_id: await sessionOf(userId), ...extra };
  return asUser(
    userId,
    async (q) =>
      (
        await q<{ id: string }>(
          kind === "import"
            ? "insert into public.background_requests (organization_id, kind, entity_type, file_name, total_rows, duplicate_mode) values ($1, 'import', 'lead', 'leads.xlsx', 3000, 'skip') returning id"
            : "insert into public.background_requests (organization_id, kind) values ($1, 'export') returning id",
          [o],
        )
      ).rows[0].id,
    claims,
  );
}

// touch_row keeps created_at; the tests move it back with the triggers off
const backdate = (id: string, by: string) =>
  asAdmin(async (q) => {
    await q("set local session_replication_role = replica");
    await q("update public.background_requests set created_at = now() - $2::interval where id = $1", [id, by]);
  });
const putObject = (name: string) => asAdmin((q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1) on conflict do nothing", [name]));
const requestOf = (id: string) =>
  asAdmin(async (q) => (await q<Record<string, unknown>>("select * from public.background_requests where id = $1", [id])).rows[0]);
const jobOf = (id: string) => asAdmin(async (q) => (await q<{ status: string; last_error: string | null; payload: Record<string, unknown> }>("select status, last_error, payload from app.jobs where id = $1", [id])).rows[0]);

/** Claims only background jobs of this file's businesses (other files' jobs are left as they are). */
async function claimFor(requestId: string): Promise<Claimed> {
  const req = await requestOf(requestId);
  // make sure no other due background job stands before it
  await asAdmin((q) => q("update app.jobs set next_run_at = now() + interval '1 day' where kind in ('import.run', 'export.run') and status = 'queued' and id <> $1", [req.queue_job_id]));
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['import.run', 'export.run'], 1, 900) as r")).rows[0].r);
  expect(rows.map((r) => r.id)).toEqual([req.queue_job_id]);
  return rows[0];
}

const begin = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.background_job_begin($1, $2, $3) as r", [job.id, job.lease, LEGAL])).rows[0].r);
const token = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.background_job_token($1, $2, $3) as r", [job.id, job.lease, LEGAL])).rows[0].r);
/** Exactly what the worker's token of the person carries (owner (160) א). */
type TokenClaims = { sub: string; role: string; aal: string; session_id: string; crm_background: string };
async function claimsOf(job: Claimed): Promise<TokenClaims> {
  const answer = await token(job);
  expect(answer.ok).toBe(true);
  return answer.claims as TokenClaims;
}
/** Runs as the token's claims: role authenticated and exactly those claims, as PostgREST would with that token. */
const asToken = <T>(claims: TokenClaims, fn: (q: Query) => Promise<T>) => {
  const { sub, ...rest } = claims;
  return asUser(sub, fn, rest);
};
const progress = (job: Claimed, rows: number, counts: unknown, importJob: string | null = null) =>
  asService(
    async (q) =>
      (await q<{ r: string }>("select public.background_job_progress($1, $2, $3, $4, $5) as r", [job.id, job.lease, rows, JSON.stringify(counts), importJob])).rows[0].r,
  );
const end = (job: Claimed, ok: boolean, counts: unknown = null, message: string | null = null, path: string | null = null) =>
  asService(
    async (q) =>
      (
        await q<{ r: string }>("select public.background_job_end($1, $2, $3, $4, $5, $6) as r", [
          job.id,
          job.lease,
          ok,
          counts === null ? null : JSON.stringify(counts),
          message,
          path,
        ])
      ).rows[0].r,
  );
const notices = (userId: string, requestId: string) =>
  asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and entity_type = 'background_request' and entity_id = $2 and type = 'system'", [userId, requestId]));

/** An import order with its file, submitted and claimed. */
async function runningImport(userId: string): Promise<{ id: string; job: Claimed }> {
  const id = await order(userId, "import");
  await putObject(sourceOf(org, id));
  await asUser(userId, (q) => q("select public.background_request_submit($1, $2)", [org, id]));
  const job = await claimFor(id);
  return { id, job };
}

beforeAll(async () => {
  owner = await createUser("bg-owner");
  org = await createOrg(owner.id, "עסק רקע");
  manager = await addMember(org, owner.id, "manager");
  member = await addMember(org, owner.id, "member");
  viewer = await addMember(org, owner.id, "viewer");
  otherOwner = await createUser("bg-other");
  otherOrg = await createOrg(otherOwner.id, "עסק אחר");
  for (const u of [owner, manager, member, viewer, otherOwner]) await sign(u.id);
});

afterAll(async () => {
  await asAdmin(async (q) => {
    await q("delete from storage.objects where bucket_id = 'job-files' and (name like $1 or name like $2)", [`${org}/%`, `${otherOrg}/%`]);
    await q("delete from app.orphan_files where bucket = 'job-files' and (storage_path like $1 or storage_path like $2)", [`${org}/%`, `${otherOrg}/%`]);
  });
  await closePool();
});

describe("IMP-04: background imports and the full export", () => {
  it("the queue takes the two kinds with ids only", async () => {
    const enqueue = (kind: string, payload: unknown) => asAdmin((q) => q("select app.enqueue_job($1, $2, $3)", [org, kind, JSON.stringify(payload)]));
    const u = randomUUID();
    for (const bad of [{}, { request_id: u }, { request_id: u, user_id: u, file: "a.csv" }, { request_id: "x", user_id: u }, { request_id: u.toUpperCase(), user_id: u }]) {
      expect((await pgError(enqueue("import.run", bad))).hint, JSON.stringify(bad)).toBe("job:payload");
      expect((await pgError(enqueue("export.run", bad))).hint, JSON.stringify(bad)).toBe("job:payload");
    }
    const seen = await asAdmin(async (q) => (await q<{ kind: string }>("select kind from app.job_kind_seen where kind in ('import.run', 'export.run') order by 1")).rows);
    expect(seen.map((r) => r.kind)).toEqual(["export.run", "import.run"]);
  });

  it("only who may do the work orders it: an import needs the import right, the full export the owner", async () => {
    expect((await pgError(order(viewer.id, "import"))).code).toBe("42501");
    expect((await pgError(order(member.id, "import"))).code).toBe("42501");
    expect((await pgError(order(manager.id, "export"))).code).toBe("42501");
    // another business's member orders nothing here
    expect((await pgError(order(otherOwner.id, "import"))).code).toBe("42501");
    // a member with the PRM-01 import grant may import (the plan's capability decides whether the grant can be set)
    const id = await order(manager.id, "import");
    const row = await requestOf(id);
    expect(row).toMatchObject({ created_by: manager.id, status: "awaiting_file", source_path: sourceOf(org, id), queue_job_id: null, ordered_aal: "aal1" });
    // owner (163) ב: a background import never creates duplicates again; the database refuses "create" and no rule at all
    for (const mode of ["'create'", "null"]) {
      const refused = await pgError(asUser(manager.id, (q) => q(`insert into public.background_requests (organization_id, kind, entity_type, file_name, total_rows, duplicate_mode) values ($1, 'import', 'lead', 'a', 1, ${mode})`, [org])));
      expect(refused.code, mode).toBe("23514");
    }
    // server-kept columns cannot be sent
    for (const column of ["status", "created_by", "source_path", "file_path", "queue_job_id", "ordered_aal"]) {
      const error = await pgError(asUser(manager.id, (q) => q(`insert into public.background_requests (organization_id, kind, entity_type, file_name, total_rows, duplicate_mode, ${column}) values ($1, 'import', 'lead', 'a', 1, 'skip', null)`, [org])));
      expect(error.code, column).toBe("42501");
    }
    // nobody updates or deletes through the API
    expect((await pgError(asUser(manager.id, (q) => q("update public.background_requests set status = 'queued' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asUser(manager.id, (q) => q("delete from public.background_requests where id = $1", [id])))).code).toBe("42501");
    // the person reads their own orders only
    expect(await asUser(manager.id, (q) => count(q, "select 1 from public.background_requests where id = $1", [id]))).toBe(1);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.background_requests where id = $1", [id]))).toBe(0);
    expect(await asUser(otherOwner.id, (q) => count(q, "select 1 from public.background_requests where id = $1", [id]))).toBe(0);
    // the ordering session's aal and id are kept from the claims
    const session = randomUUID();
    const withSession = await order(owner.id, "export", org, { aal: "aal2", session_id: session });
    expect(await requestOf(withSession)).toMatchObject({ ordered_aal: "aal2", ordered_session_id: session, status: "queued" });
    await asUser(owner.id, (q) => q("select public.background_request_cancel($1, $2)", [org, withSession]));
    await asUser(manager.id, (q) => q("select public.background_request_cancel($1, $2)", [org, id]));
  });

  it("at most three open orders per person and business", async () => {
    const ids = [await order(owner.id, "export"), await order(owner.id, "export"), await order(owner.id, "export")];
    expect((await pgError(order(owner.id, "export"))).hint).toBe("background:busy");
    for (const id of ids) expect(await asUser(owner.id, async (q) => (await q<{ r: boolean }>("select public.background_request_cancel($1, $2) as r", [org, id])).rows[0].r)).toBe(true);
    // a cancelled order cannot be cancelled again
    expect(await asUser(owner.id, async (q) => (await q<{ r: boolean }>("select public.background_request_cancel($1, $2) as r", [org, ids[0]])).rows[0].r)).toBe(false);
  });

  it("the file goes only to the person's own waiting order; submit needs it and queues ids only", async () => {
    const id = await order(manager.id, "import");
    const name = sourceOf(org, id);
    // someone else (same business or another) cannot put the file there; the person can, only at that exact path
    expect((await pgError(asUser(owner.id, (q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1)", [name])))).code).toBe("42501");
    expect((await pgError(asUser(otherOwner.id, (q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1)", [name])))).code).toBe("42501");
    expect((await pgError(asUser(manager.id, (q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1)", [`${org}/${id}/other.json`])))).code).toBe("42501");
    expect((await pgError(asUser(manager.id, (q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1)", [`${otherOrg}/${id}/source.json`])))).code).toBe("42501");
    expect((await pgError(asUser(manager.id, (q) => q("select public.background_request_submit($1, $2)", [org, id])))).hint).toBe("background:no_file");
    await asUser(manager.id, (q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1)", [name]));
    // only the person submits
    expect((await pgError(asUser(owner.id, (q) => q("select public.background_request_submit($1, $2)", [org, id])))).code).toBe("42501");
    await asUser(manager.id, (q) => q("select public.background_request_submit($1, $2)", [org, id]));
    const row = await requestOf(id);
    expect(row.status).toBe("queued");
    const job = await jobOf(row.queue_job_id as string);
    expect(job).toMatchObject({ status: "queued", payload: { request_id: id, user_id: manager.id } });
    expect((await pgError(asUser(manager.id, (q) => q("select public.background_request_submit($1, $2)", [org, id])))).hint).toBe("background:state");
    // once queued, the file is not readable by the browser (only while it runs, by the person)
    expect(await asUser(manager.id, (q) => count(q, "select 1 from storage.objects where bucket_id = 'job-files' and name = $1", [name]))).toBe(0);
    await asUser(manager.id, (q) => q("select public.background_request_cancel($1, $2)", [org, id]));
  });

  it("begin answers no claims; the token answers exactly the person's claims, logs the signing and puts the worker's claims back", async () => {
    const { id, job } = await runningImport(manager.id);
    const begun = await begin(job);
    expect(begun).toMatchObject({ ok: true, kind: "import", request_id: id, duplicate_mode: "skip", rows_done: 0, source_path: sourceOf(org, id) });
    expect(begun).not.toHaveProperty("claims");
    expect((await requestOf(id)).status).toBe("running");
    const logged = () =>
      asAdmin(async (q) => (await q<{ details: Record<string, unknown>; actor_id: string | null }>("select details, actor_id from app.platform_log where action = 'background.token' and organization_id = $1 and details ->> 'request_id' = $2 order by id", [org, id])).rows);
    expect(await logged()).toEqual([]);
    const answer = await asService(async (q) => {
      const r = (await q<{ r: Record<string, unknown> }>("select public.background_job_token($1, $2, $3) as r", [job.id, job.lease, LEGAL])).rows[0].r;
      const claims = (await q<{ c: string }>("select current_setting('request.jwt.claims', true) as c")).rows[0].c;
      return { r, claims: JSON.parse(claims) };
    });
    expect(answer.claims).toEqual({ role: "service_role" });
    const lockedUntil = await asAdmin(async (q) => (await q<{ t: string }>("select to_jsonb(locked_until) #>> '{}' as t from app.jobs where id = $1", [job.id])).rows[0].t);
    expect(answer.r).toEqual({
      ok: true,
      claims: { sub: manager.id, role: "authenticated", aal: "aal1", session_id: await sessionOf(manager.id), crm_background: id },
      // review 2: the lease's end, so the signed token never outlives it
      locked_until: lockedUntil,
    });
    // every signing is logged, ids only
    await token(job);
    const rows = await logged();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ actor_id: null, details: { request_id: id, user_id: manager.id, session_id: await sessionOf(manager.id), job_id: job.id } });
    // review 4: the running import's file is readable only under the worker's token of this order: not by the person's
    // browser session, not with a token of another order, not by anyone else
    const readSource = (userId: string, extra: Record<string, unknown> = {}) =>
      asUser(userId, (q) => count(q, "select 1 from storage.objects where bucket_id = 'job-files' and name = $1", [sourceOf(org, id)]), extra);
    expect(await readSource(manager.id, answer.r.claims as Record<string, unknown>)).toBe(1);
    expect(await readSource(manager.id)).toBe(0);
    expect(await readSource(manager.id, { crm_background: randomUUID() })).toBe(0);
    expect(await readSource(owner.id)).toBe(0);
    expect(await readSource(owner.id, { crm_background: id })).toBe(0);
    // a wrong lease gets nothing, and nothing is logged
    expect(await asService(async (q) => (await q<{ r: unknown }>("select public.background_job_token($1, $2, $3) as r", [job.id, randomUUID(), LEGAL])).rows[0].r)).toEqual({ ok: false, reason: "stale" });
    expect(await logged()).toHaveLength(2);
    await asUser(manager.id, (q) => q("select public.background_request_cancel($1, $2)", [org, id]));
    // a cancelled order signs nothing more
    expect(await token(job)).toEqual({ ok: false, reason: "request_closed" });
  });

  it("the token's aal is the ordering session's, never more", async () => {
    const session = await asAdmin(async (q) => (await q<{ id: string }>("insert into auth.sessions (user_id, aal) values ($1, 'aal2') returning id", [owner.id])).rows[0].id);
    const twoStep = await order(owner.id, "export", org, { aal: "aal2", session_id: session });
    const job = await claimFor(twoStep);
    await begin(job);
    expect((await claimsOf(job)).aal).toBe("aal2");
    await end(job, false, null, "x");
    const plain = await order(owner.id, "export");
    const job2 = await claimFor(plain);
    await begin(job2);
    expect((await claimsOf(job2)).aal).toBe("aal1");
    await end(job2, false, null, "x");
  });

  it("review 3: the session must not have run out, and a session lowered since the order signs at its lower aal", async () => {
    const session = await asAdmin(async (q) => (await q<{ id: string }>("insert into auth.sessions (user_id, aal) values ($1, 'aal2') returning id", [owner.id])).rows[0].id);
    const id = await order(owner.id, "export", org, { aal: "aal2", session_id: session });
    const job = await claimFor(id);
    expect((await begin(job)).ok).toBe(true);
    expect((await claimsOf(job)).aal).toBe("aal2");
    // the session dropped to aal1 (Supabase keeps the session's current level): the token says aal1
    await asAdmin((q) => q("update auth.sessions set aal = 'aal1' where id = $1", [session]));
    expect((await claimsOf(job)).aal).toBe("aal1");
    // a session never rises above the order's level
    const low = await asAdmin(async (q) => (await q<{ id: string }>("insert into auth.sessions (user_id, aal) values ($1, 'aal2') returning id", [owner.id])).rows[0].id);
    const lowId = await order(owner.id, "export", org, { aal: "aal1", session_id: low });
    const lowJob = await claimFor(lowId);
    await begin(lowJob);
    expect((await claimsOf(lowJob)).aal).toBe("aal1");
    await end(lowJob, false, null, "x");
    // a session still in the table but past its not_after has ended
    await asAdmin((q) => q("update auth.sessions set not_after = now() + interval '1 hour' where id = $1", [session]));
    expect((await token(job)).ok).toBe(true);
    await asAdmin((q) => q("update auth.sessions set not_after = now() - interval '1 second' where id = $1", [session]));
    expect(await token(job)).toEqual({ ok: false, reason: "session_ended" });
    expect((await requestOf(id)).status).toBe("failed");
  });

  it("review 5: the current legal agreement must be signed, by the version the app serves and the database registered", async () => {
    const signer = await addMember(org, owner.id, "manager", "bg-signer");
    await sign(signer.id);
    const { id, job } = await runningImport(signer.id);
    expect((await begin(job)).ok).toBe(true);
    expect((await token(job)).ok).toBe(true);
    // a version the database never registered texts for is refused, whatever the person signed
    const bogus = await asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.background_job_token($1, $2, $3) as r", [job.id, job.lease, "1999-01-01"])).rows[0].r);
    expect(bogus).toEqual({ ok: false, reason: "agreement" });
    expect((await requestOf(id)).status).toBe("failed");
    expect(await notices(signer.id, id)).toBe(1);
    // a person whose latest signature is of an older version: refused at begin
    const late = await addMember(org, owner.id, "manager", "bg-late");
    await sign(late.id, "2026-10-07");
    const second = await runningImport(late.id);
    expect(await begin(second.job)).toEqual({ ok: false, reason: "agreement" });
    // and one who never signed
    const never = await addMember(org, owner.id, "manager", "bg-never");
    const third = await runningImport(never.id);
    expect(await begin(third.job)).toEqual({ ok: false, reason: "agreement" });
    // the latest signature counts (signing the current version again lets the next order through)
    await sign(late.id);
    const fourth = await runningImport(late.id);
    expect((await begin(fourth.job)).ok).toBe(true);
    await asUser(late.id, (q) => q("select public.background_request_cancel($1, $2)", [org, fourth.id]));
  });

  it("the token reads nothing beyond the person: another business, records RLS hides, service-only functions", async () => {
    const { id, job } = await runningImport(manager.id);
    await begin(job);
    const claims = await claimsOf(job);
    // another business's rows
    const theirLead = await insertLead(otherOwner.id, otherOrg, { full_name: "של עסק אחר" });
    expect(await asToken(claims, (q) => count(q, "select 1 from public.leads where id = $1", [theirLead]))).toBe(0);
    expect(await asToken(claims, (q) => count(q, "select 1 from public.leads where organization_id = $1", [otherOrg]))).toBe(0);
    expect(await asToken(claims, (q) => count(q, "select 1 from public.background_requests where organization_id = $1", [otherOrg]))).toBe(0);
    expect((await pgError(asToken(claims, (q) => q("insert into public.leads (organization_id, status_id, full_name) values ($1, (select id from public.lead_statuses where organization_id = $1 limit 1), 'x')", [otherOrg])))).code).toBe("42501");
    // a record of this business the person may not read: own-records visibility, owned by the owner
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const ownersLead = await insertLead(owner.id, org, { full_name: "של הבעלים", owner_id: owner.id });
      expect(await asUser(owner.id, (q) => count(q, "select 1 from public.leads where id = $1", [ownersLead]))).toBe(1);
      expect(await asToken(claims, (q) => count(q, "select 1 from public.leads where id = $1", [ownersLead]))).toBe(0);
      expect(await asToken(claims, async (q) => (await q("update public.leads set full_name = 'נפרץ' where id = $1", [ownersLead])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // the owner's own background orders and the audit log (owners/admins only) are not the manager's to read
    expect(await asToken(claims, (q) => count(q, "select 1 from public.background_requests where created_by <> $1", [manager.id]))).toBe(0);
    expect(await asToken(claims, (q) => count(q, "select 1 from public.audit_log where organization_id = $1", [org]))).toBe(0);
    // service-only functions
    for (const fn of [
      "public.claim_jobs(array['import.run'])",
      "public.background_job_token($1, $2, 'x')",
      "public.background_job_begin($1, $2, 'x')",
      "public.background_job_end($1, $2, true)",
      "public.finish_job($1, $2, true)",
    ]) {
      const params = fn.includes("$1") ? [job.id, job.lease] : [];
      expect((await pgError(asToken(claims, (q) => q(`select ${fn}`, params)))).code, fn).toBe("42501");
    }
    // nothing changed for the job: it is still the worker's
    expect((await jobOf(job.id)).status).toBe("running");
    await asUser(manager.id, (q) => q("select public.background_request_cancel($1, $2)", [org, id]));
  });

  it("the audit says the person did it through a background job, and only for a real running order of theirs", async () => {
    const { id, job } = await runningImport(owner.id);
    await begin(job);
    const claims = await claimsOf(job);
    const leadId = await asToken(claims, async (q) =>
      (await q<{ id: string }>("insert into public.leads (organization_id, status_id, full_name) values ($1, (select id from public.lead_statuses where organization_id = $1 and is_default), 'מייבוא ברקע') returning id", [org])).rows[0].id,
    );
    await asToken(claims, (q) => q("update public.leads set full_name = 'שונה ברקע' where id = $1", [leadId]));
    const entries = () =>
      asAdmin(async (q) => (await q<{ action: string; actor_id: string; changes: Record<string, unknown> }>("select action, actor_id, changes from public.audit_log where entity_id = $1 order by id", [leadId])).rows);
    const made = await entries();
    expect(made.map((e) => e.action)).toEqual(["insert", "update"]);
    for (const e of made) {
      expect(e.actor_id).toBe(owner.id);
      expect(e.changes.background).toEqual({ request_id: id });
    }
    // the same person in the browser (no claim): no stamp
    await asUser(owner.id, (q) => q("update public.leads set full_name = 'בדפדפן' where id = $1", [leadId]));
    expect((await entries()).at(-1)?.changes.background).toBeUndefined();
    // a claim that names another person's order, another business's, or an order that is not running stamps nothing
    const managerOrder = await order(manager.id, "import");
    const { sub: person, ...rest } = claims;
    expect(person).toBe(owner.id);
    for (const forged of [managerOrder, randomUUID(), "not-a-uuid"]) {
      await asUser(owner.id, (q) => q("update public.leads set full_name = $2 where id = $1", [leadId, `זיוף ${forged}`]), { ...rest, crm_background: forged });
      expect((await entries()).at(-1)?.changes.background, forged).toBeUndefined();
    }
    await asUser(owner.id, (q) => q("select public.background_request_cancel($1, $2)", [org, id]));
    await asToken(claims, (q) => q("update public.leads set full_name = 'אחרי ביטול' where id = $1", [leadId]));
    expect((await entries()).at(-1)?.changes.background).toBeUndefined();
    // a delete's entry keeps the row as it was (its snapshot), never stamped
    await asAdmin((q) => q("update public.background_requests set status = 'running' where id = $1", [id]));
    await asToken(claims, (q) => q("update public.leads set deleted_at = now() where id = $1", [leadId]));
    expect((await entries()).at(-1)).toMatchObject({ action: "trash", changes: { background: { request_id: id } } });
    await asUser(manager.id, (q) => q("select public.background_request_cancel($1, $2)", [org, managerOrder]));
    await asAdmin((q) => q("update public.background_requests set status = 'cancelled' where id = $1", [id]));
  });

  it("the worker's four calls are for service_role only", async () => {
    for (const fn of [
      "background_job_begin(gen_random_uuid(), gen_random_uuid(), 'x')",
      "background_job_token(gen_random_uuid(), gen_random_uuid(), 'x')",
      "background_job_progress(gen_random_uuid(), gen_random_uuid(), 0, '{}')",
      "background_job_end(gen_random_uuid(), gen_random_uuid(), true)",
    ]) {
      expect((await pgError(asUser(owner.id, (q) => q(`select public.${fn}`)))).code, fn).toBe("42501");
    }
  });

  it("a person who lost the right, left the business or signed out of the ordering session gets nothing", async () => {
    // lost the right: the manager became a member (no import grant)
    const a = await runningImport(manager.id);
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, manager.id]));
    expect(await begin(a.job)).toEqual({ ok: false, reason: "not_allowed" });
    expect(await jobOf(a.job.id)).toMatchObject({ status: "refused", last_error: "refused:not_allowed" });
    expect((await requestOf(a.id)).status).toBe("failed");
    expect(await notices(manager.id, a.id)).toBe(1);
    await asAdmin((q) => q("update public.memberships set role = 'manager' where organization_id = $1 and user_id = $2", [org, manager.id]));
    // and at a refresh: the right lost between two signings stops the next one
    const r = await runningImport(manager.id);
    await begin(r.job);
    expect((await token(r.job)).ok).toBe(true);
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, manager.id]));
    expect(await token(r.job)).toEqual({ ok: false, reason: "not_allowed" });
    expect((await requestOf(r.id)).status).toBe("failed");
    await asAdmin((q) => q("update public.memberships set role = 'manager' where organization_id = $1 and user_id = $2", [org, manager.id]));

    // left the business (suspended): refused, and no notice to someone who is not a member
    const b = await runningImport(manager.id);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, manager.id]));
    expect(await begin(b.job)).toEqual({ ok: false, reason: "not_member" });
    expect((await requestOf(b.id)).status).toBe("failed");
    expect(await notices(manager.id, b.id)).toBe(0);
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, manager.id]));

    // an order made without a session id cannot be checked: refused (fail closed)
    const noSession = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.background_requests (organization_id, kind) values ($1, 'export') returning id", [org])).rows[0].id);
    expect(await begin(await claimFor(noSession))).toEqual({ ok: false, reason: "session_ended" });
    // the ordering session ended (signed out, or sessions revoked by an MFA reset), also between two signings
    const session = await asAdmin(async (q) => (await q<{ id: string }>("insert into auth.sessions (user_id, aal) values ($1, 'aal1') returning id", [owner.id])).rows[0].id);
    const midRun = await order(owner.id, "export", org, { aal: "aal1", session_id: session });
    const midJob = await claimFor(midRun);
    expect((await begin(midJob)).ok).toBe(true);
    expect((await token(midJob)).ok).toBe(true);
    await asAdmin((q) => q("delete from auth.sessions where id = $1", [session]));
    expect(await token(midJob)).toEqual({ ok: false, reason: "session_ended" });
    expect(await jobOf(midJob.id)).toMatchObject({ status: "refused", last_error: "refused:session_ended" });
    expect((await requestOf(midRun)).status).toBe("failed");
    expect(await notices(owner.id, midRun)).toBe(1);
    const session2 = await asAdmin(async (q) => (await q<{ id: string }>("insert into auth.sessions (user_id, aal) values ($1, 'aal1') returning id", [owner.id])).rows[0].id);
    const exportId = await order(owner.id, "export", org, { aal: "aal1", session_id: session2 });
    const job = await claimFor(exportId);
    await asAdmin((q) => q("delete from auth.sessions where id = $1", [session2]));
    expect(await begin(job)).toEqual({ ok: false, reason: "session_ended" });
    expect((await requestOf(exportId)).status).toBe("failed");

    // a cancelled order is refused quietly
    const c = await runningImport(member.id).catch(() => null);
    expect(c).toBeNull();
    const d = await order(owner.id, "import");
    await putObject(sourceOf(org, d));
    await asUser(owner.id, (q) => q("select public.background_request_submit($1, $2)", [org, d]));
    const djob = await claimFor(d);
    await asUser(owner.id, (q) => q("select public.background_request_cancel($1, $2)", [org, d]));
    expect(await begin(djob)).toEqual({ ok: false, reason: "request_closed" });
    expect((await requestOf(d)).status).toBe("cancelled");
    expect(await notices(owner.id, d)).toBe(0);
  });

  it("the aal of the order is the aal the work runs with: a business that requires two-step refuses an aal1 order", async () => {
    const { id, job } = await runningImport(owner.id);
    await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
    try {
      expect(await begin(job)).toEqual({ ok: false, reason: "not_allowed" });
      expect((await requestOf(id)).status).toBe("failed");
    } finally {
      await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
    }
  });

  it("progress moves forward only, takes only the person's own import job, and tells a cancel", async () => {
    const { id, job } = await runningImport(owner.id);
    expect((await begin(job)).ok).toBe(true);
    const own = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, duplicate_mode, file_name, total_rows) values ($1, 'lead', 'skip', 'leads.xlsx', 3000) returning id", [org])).rows[0].id,
    );
    const someoneElse = await asUser(manager.id, async (q) =>
      (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, duplicate_mode, file_name, total_rows) values ($1, 'lead', 'skip', 'x.xlsx', 1) returning id", [org])).rows[0].id,
    );
    expect(await progress(job, 0, {}, someoneElse)).toBe("invalid");
    expect(await progress(job, 250, { created: 250, updated: 0, skipped: 0, failed: 0 }, own)).toBe("ok");
    expect(await progress(job, 100, {})).toBe("invalid");
    expect(await progress(job, 3001, {})).toBe("invalid");
    expect(await progress(job, 300, { created: -1 })).toBe("invalid");
    expect(await progress(job, 300, { created: 1, note: 2 })).toBe("invalid");
    expect(await progress(job, 300, { created: 1 }, someoneElse)).toBe("invalid");
    expect(await requestOf(id)).toMatchObject({ rows_done: 250, import_job_id: own });
    await asUser(owner.id, (q) => q("select public.background_request_cancel($1, $2)", [org, id]));
    expect(await progress(job, 500, {})).toBe("cancelled");
    expect(await end(job, true, {})).toBe("cancelled");
  });

  it("an import's end keeps its counts and tells the person", async () => {
    const { id, job } = await runningImport(owner.id);
    await begin(job);
    expect(await end(job, true, { created: 2990, updated: 0, skipped: 10, failed: 0 }, null, `${org}/${id}/${randomUUID()}.zip`)).toBe("invalid");
    expect(await end(job, true, { created: 2990, updated: 0, skipped: 10, failed: 0 })).toBe("ended");
    expect(await requestOf(id)).toMatchObject({ status: "done", file_path: null, file_expires_at: null });
    const notice = await asAdmin(async (q) => (await q<{ title: string; body: string }>("select title, body from public.notifications where entity_id = $1", [id])).rows[0]);
    expect(notice).toEqual({ title: "הייבוא ברקע הסתיים", body: "leads.xlsx: נוצרו 2990, עודכנו 0, דולגו 10, נכשלו 0." });
    // done: nothing more for the lease
    expect(await end(job, true, {})).toBe("cancelled");
  });

  it("the export's file: in its own folder, present, readable by its owner for 7 days only", async () => {
    const id = await order(owner.id, "export");
    const job = await claimFor(id);
    expect((await begin(job)).ok).toBe(true);
    const file = `${org}/${id}/${randomUUID()}.zip`;
    const claims = await claimsOf(job);
    const put = (userId: string, name: string, extra: Record<string, unknown> = {}) =>
      asUser(userId, (q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1)", [name]), extra);
    // the worker writes it with the owner's token of this order: only into this running order's folder
    expect((await pgError(put(manager.id, file))).code).toBe("42501");
    expect((await pgError(put(manager.id, file, { crm_background: id }))).code).toBe("42501");
    expect((await pgError(put(owner.id, `${org}/${id}/x.zip`, claims))).code).toBe("42501");
    // review 4: the owner's own browser session (no claim, or another order's) cannot write into the folder
    expect((await pgError(put(owner.id, file))).code).toBe("42501");
    expect((await pgError(put(owner.id, file, { crm_background: randomUUID() }))).code).toBe("42501");
    expect(await end(job, true, { rows: 10 }, null, file)).toBe("invalid");
    await asToken(claims, (q) => q("insert into storage.objects (bucket_id, name) values ('job-files', $1)", [file]));
    expect(await end(job, true, { rows: 10 }, null, `${otherOrg}/${id}/${randomUUID()}.zip`)).toBe("invalid");
    expect(await end(job, true, { rows: 10 }, null, file)).toBe("ended");
    const row = await requestOf(id);
    expect(row).toMatchObject({ status: "done", file_path: file });
    expect(Math.round((new Date(row.file_expires_at as string).getTime() - Date.now()) / 86_400_000)).toBe(7);
    expect(await notices(owner.id, id)).toBe(1);
    const read = (userId: string) => asUser(userId, (q) => count(q, "select 1 from storage.objects where bucket_id = 'job-files' and name = $1", [file]));
    // the finished export is downloaded through the signed link made with the owner's own session (no claim)
    expect(await read(owner.id)).toBe(1);
    expect(await read(manager.id)).toBe(0);
    expect(await read(otherOwner.id)).toBe(0);
    // expired: no longer readable (no signed link can be made)
    await asAdmin((q) => q("update public.background_requests set file_expires_at = now() - interval '1 second' where id = $1", [id]));
    expect(await read(owner.id)).toBe(0);
  });

  it("the sweep fails an order whose job died, cancels a file that never came, and sends 7-day-old folders to the cleanup", async () => {
    const dead = await runningImport(owner.id);
    await asAdmin((q) => q("update app.jobs set status = 'dead', lease_id = null, locked_until = null where id = $1", [dead.job.id]));
    const waiting = await order(owner.id, "import");
    await backdate(waiting, "2 days");
    await asAdmin((q) => q("select app.background_requests_sweep()"));
    expect((await requestOf(dead.id)).status).toBe("failed");
    expect(await notices(owner.id, dead.id)).toBe(1);
    expect((await requestOf(waiting)).status).toBe("cancelled");

    // 7 days later: every object of the folder goes to the cleanup queue, and only then may it be claimed
    await putObject(`${org}/${dead.id}/${randomUUID()}.zip`);
    const claimable = (path: string) => asAdmin(async (q) => (await q<{ c: boolean }>("select app.orphan_claimable('job-files', $1) as c", [path])).rows[0].c);
    expect(await claimable(sourceOf(org, dead.id))).toBe(false);
    await backdate(dead.id, "8 days");
    await asAdmin((q) => q("select app.background_requests_sweep()"));
    const queued = await asAdmin(async (q) => (await q<{ p: string }>("select storage_path as p from app.orphan_files where bucket = 'job-files' and storage_path like $1 order by 1", [`${org}/${dead.id}/%`])).rows);
    expect(queued.length).toBe(2);
    expect(queued.map((r) => r.p)).toContain(sourceOf(org, dead.id));
    expect(await requestOf(dead.id)).toMatchObject({ source_path: null, file_path: null });
    expect(await claimable(sourceOf(org, dead.id))).toBe(true);
    // an export still inside its own 7 days keeps its file
    const kept = await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.background_requests where files_cleared_at is null and file_expires_at > now() and created_at <= now() - interval '7 days'")).rows[0].n);
    expect(kept).toBe(0);
  });

  it("a deleted order (the business's cascade) sends its folder to the cleanup", async () => {
    const id = await order(otherOwner.id, "import", otherOrg);
    await putObject(sourceOf(otherOrg, id));
    await asAdmin((q) => q("delete from public.background_requests where id = $1", [id]));
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where bucket = 'job-files' and storage_path = $1", [sourceOf(otherOrg, id)]))).toBe(1);
  });

  it("another business is untouched by this business's jobs", async () => {
    const theirs = await order(otherOwner.id, "export", otherOrg);
    const { job } = await runningImport(owner.id);
    await begin(job);
    await end(job, false, { created: 0 }, "נעצר");
    expect(await requestOf(theirs)).toMatchObject({ status: "queued", started_at: null });
    expect(await notices(otherOwner.id, theirs)).toBe(0);
    await asUser(otherOwner.id, (q) => q("select public.background_request_cancel($1, $2)", [otherOrg, theirs]));
  });

  it("the worker's functions are the reviewed ones (md5 pins)", async () => {
    const rows = await asAdmin(
      async (q: Query) =>
        (
          await q<{ name: string; md5: string }>(
            `select n.nspname || '.' || p.proname as name,
                    md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_function_identity_arguments(p.oid)) as md5
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname, p.proname) in (('app', 'audit_log_background'), ('app', 'background_allowed'), ('app', 'background_claims'),
                                               ('app', 'background_job_row'), ('app', 'background_notify'), ('app', 'background_refusal'),
                                               ('app', 'background_refuse'), ('app', 'background_request_of'), ('app', 'background_session_aal'),
                                               ('public', 'background_job_begin'), ('public', 'background_job_end'),
                                               ('public', 'background_job_progress'), ('public', 'background_job_token'))
              order by 1`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
    // none of the worker's functions is executable by a person
    const grants = await asAdmin(
      async (q) =>
        (
          await q<{ name: string }>(
            `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname like 'background_job_%' and has_function_privilege('authenticated', p.oid, 'execute')`,
          )
        ).rows,
    );
    expect(grants).toEqual([]);
  });
});
