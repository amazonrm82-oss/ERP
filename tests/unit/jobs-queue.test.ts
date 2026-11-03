import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runJobsRoute } from "@/features/jobs/run-server";
import { createRegistry, JOB_KINDS, parseClaimed, redactJobError, type ClaimedJob, type JobHandler } from "@/features/jobs/registry";
import { runJobs, type FinishAnswer, type QueueCalls } from "@/features/jobs/runner";
import { clearFakeSentMessages, createFakeProvider, FAKE_SENT_KEPT, fakeSentMessages } from "@/features/messaging/providers/fake";
import { messagingProvider } from "@/features/messaging/providers/select";
import { createSendHandler } from "@/features/messaging/send-handler";
import { bearerSecretMatches } from "@/lib/shared-secret";

const root = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const migration = () => {
  const file = readdirSync(join(root, "supabase/migrations")).find((f) => f.endsWith("_jobs_queue.sql"));
  expect(file, "the OPS-04 migration").toBeDefined();
  return read(join("supabase/migrations", file as string));
};

/**
 * The line for CLAUDE.md, hard rule 5 (drafted with OPS-04; the lead adds it when the branch merges). Once CLAUDE.md
 * names /api/jobs/run, it must hold this line (whitespace aside), so the two cannot drift.
 */
const IN_USE_LINE =
  "In use (OPS-04, owner 26 October 2026, answer (א) and wave 3 use (1); conditions of 2 November 2026, answers (52)-(55); migration " +
  "`_jobs_queue.sql`): the background job worker (`src/features/jobs/run-server.ts`, route `POST /api/jobs/run`, public prefix in " +
  "`src/lib/supabase/proxy.ts`), woken by `app.wake_job_worker()` (pg_cron `crm-jobs-wake`, pg_net; `app.settings` `jobs_run_url`, " +
  "else derived from `push_dispatch_url`; secret `push_dispatch_secret`) every minute while due jobs are of a kind a worker asked for " +
  "in the last day, else at most once an hour per kind (`app.job_kind_seen`, `app.job_wake_kinds`). It checks the secret timing-safe " +
  "first (`src/lib/shared-secret.ts`) and calls only `public.claim_jobs()`, `public.finish_job()` and `public.job_message_may_send()`. " +
  "(55) א: only `job_message_may_send` reads customer records and it answers may_send, reason and retry only; `claim_jobs` answers " +
  "only id, lease, kind, organization_id, payload (ids and codes, optional event_at) and attempt, `finish_job` only its status; " +
  "`app.job_kinds()` is exactly `message.send`, and every new kind needs the owner's approval and its own In use line; the three " +
  "bodies are pinned by md5 and a change needs a fresh review (test 284). " +
  "The send check works on a live lease only: a business that cannot write (`app.org_writable`: deleted, suspended, cancelled or " +
  "read-only, (53) א, (54) ב) or an `event_at` that passed cancels the job; while HEB-09 `app.customer_sending_paused` holds, the job " +
  "waits uncounted (with the business's other due message jobs, in one step) and is sent after the resume, and is cancelled once " +
  "the pause has lasted more than 24 hours, also after the resume when it waited through such a pause ((52) ג); then " +
  "`app.consent_suppressed` with null = cancelled. Cancellations are counted only, one `app.platform_log` entry `jobs.cancelled` per " +
  "business and run (`app.flush_job_cancellations`). Jobs claimed but not started in time are handed back uncounted; a finish the " +
  "queue did not take after a send is logged (one redacted line). The queue `app.jobs` (no grants) holds ids and codes only. Only " +
  "`message.send` is registered, through the provider layer (`src/features/messaging/providers/`), whose only provider is the fake " +
  "(`MESSAGING_PROVIDER=fake`, refused on a Vercel production or preview deployment; it keeps the last 100 in memory and sends " +
  "nothing). In the eslint allow-list.";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

const job = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: "11111111-1111-4111-8111-111111111111",
  lease: "22222222-2222-4222-8222-222222222222",
  kind: "message.send",
  organization_id: "33333333-3333-4333-8333-333333333333",
  payload: { channel: "email", lead_id: "44444444-4444-4444-8444-444444444444" },
  attempt: 1,
  ...over,
});

describe("OPS-04: the shared-secret check", () => {
  it("accepts only the exact bearer secret", () => {
    expect(bearerSecretMatches("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(bearerSecretMatches("Bearer s3cret-value", " s3cret-value ")).toBe(true);
    expect(bearerSecretMatches("Bearer s3cret-valuE", "s3cret-value")).toBe(false);
    expect(bearerSecretMatches("Bearer s3cret", "s3cret-value")).toBe(false);
    expect(bearerSecretMatches("bearer s3cret-value", "s3cret-value")).toBe(false);
    expect(bearerSecretMatches("s3cret-value", "s3cret-value")).toBe(false);
    expect(bearerSecretMatches(null, "s3cret-value")).toBe(false);
    expect(bearerSecretMatches("Bearer ", "")).toBe(false);
    expect(bearerSecretMatches("Bearer x", undefined)).toBe(false);
  });
});

describe("OPS-04: the worker route", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const post = (auth?: string) =>
    runJobsRoute(new Request("http://localhost/api/jobs/run", { method: "POST", headers: auth ? { authorization: auth } : {} }));

  it("answers 503 without its secret, 401 for a wrong or missing one, and checks the secret before anything else", async () => {
    delete process.env.PUSH_DISPATCH_SECRET;
    expect((await post("Bearer anything")).status).toBe(503);
    process.env.PUSH_DISPATCH_SECRET = "route-secret";
    expect((await post()).status).toBe(401);
    expect((await post("Bearer wrong")).status).toBe(401);
    const unauthorized = await post("Bearer wrong");
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    // the right secret reaches the service client, which is not configured here
    expect((await post("Bearer route-secret")).status).toBe(503);
  });

  it("calls only its three queue functions and touches no table or storage", () => {
    const code = read("src/features/jobs/run-server.ts");
    const rpcs = [...code.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["claim_jobs", "finish_job", "job_message_may_send"]);
    expect(code).not.toMatch(/\.from\(|\.storage\b|\.schema\(/);
    expect(read("src/app/api/jobs/run/route.ts")).toContain("runJobsRoute");
  });
});

describe("OPS-04: the registry", () => {
  it("mirrors app.job_kinds() of the migration", () => {
    const m = migration().match(/function app\.job_kinds\(\)[\s\S]*?array\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const kinds = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(kinds).toEqual([...JOB_KINDS]);
  });

  it("registers only kinds with a ready handler", async () => {
    const handler: JobHandler = async () => ({ status: "done" });
    expect(createRegistry({ "message.send": null }).kinds).toEqual([]);
    const registry = createRegistry({ "message.send": handler });
    expect(registry.kinds).toEqual(["message.send"]);
    expect(registry.handlerFor("message.send")).toBe(handler);
    expect(registry.handlerFor("import.run")).toBeNull();
  });

  it("reads claim_jobs' answer and leaves malformed rows out", () => {
    expect(parseClaimed(null)).toEqual([]);
    expect(parseClaimed([job(), { ...job(), kind: "other" }, { id: 1 }, { ...job(), payload: [] }])).toEqual([job()]);
  });

  it("redacts emails and numbers in an error", () => {
    expect(redactJobError(new Error("no inbox dani@example.com, call +972 50-123-4567"))).toBe("no inbox [email], call [number]");
    expect(redactJobError("")).toBe("error");
    expect(redactJobError("x".repeat(400))).toHaveLength(300);
  });
});

describe("OPS-04: the runner", () => {
  type Finished = { id: string; ok: boolean; error: string | null; final: boolean; started: boolean };
  const calls = (batches: unknown[], answer: (f: Finished) => FinishAnswer | Error = (f) => (!f.started ? "released" : f.ok ? "done" : f.final ? "dead" : "failed")) => {
    const finished: Finished[] = [];
    const claims: string[][] = [];
    const queue: QueueCalls = {
      claim: async (kinds) => {
        claims.push(kinds);
        return batches.shift() ?? [];
      },
      finish: async (j, report) => {
        const f = { id: j.id, ...report };
        finished.push(f);
        const a = answer(f);
        if (a instanceof Error) throw a;
        return a;
      },
    };
    return { queue, finished, claims };
  };
  const quiet = () => {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  };

  it("claims nothing when no kind is ready", async () => {
    const { queue, claims } = calls([[job()]]);
    expect(await runJobs(queue, createRegistry({}))).toEqual({ claimed: 0, done: 0, failed: 0, ended: 0, released: 0, unconfirmed: 0 });
    expect(claims).toEqual([]);
  });

  it("reports each outcome: done, failed (with final), ended (not reported again), and a throw as a failed try", async () => {
    const outcomes = [
      { status: "done" as const },
      { status: "failed" as const, error: "to dani@example.com", final: true },
      { status: "ended" as const, reason: "sending_paused" },
    ];
    let n = 0;
    const handler: JobHandler = async () => {
      if (n === 3) throw new Error("boom 0501234567");
      return outcomes[n++];
    };
    const ids = ["a", "b", "c", "d"].map((x) => job({ id: x }));
    const { queue, finished, claims } = calls([ids]);
    const { lines, log } = quiet();
    const summary = await runJobs(queue, createRegistry({ "message.send": handler }), { batch: 20, log });
    expect(summary).toEqual({ claimed: 4, done: 1, failed: 2, ended: 1, released: 0, unconfirmed: 0 });
    expect(claims).toEqual([["message.send"]]);
    expect(finished).toEqual([
      { id: "a", ok: true, error: null, final: false, started: true },
      { id: "b", ok: false, error: "to [email]", final: true, started: true },
      { id: "d", ok: false, error: "boom [number]", final: false, started: true },
    ]);
    expect(lines).toEqual([]);
  });

  it("hands back the jobs it did not start before the time budget, uncounted", async () => {
    let clock = 0;
    const handler: JobHandler = async () => {
      clock += 30_000;
      return { status: "done" };
    };
    const { queue, finished } = calls([[job({ id: "a" }), job({ id: "b" }), job({ id: "c" }), job({ id: "d" })]]);
    const summary = await runJobs(queue, createRegistry({ "message.send": handler }), { budgetMs: 40_000, now: () => clock, log: quiet().log });
    expect(finished.map((f) => [f.id, f.started])).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
      ["d", false],
    ]);
    expect(summary).toMatchObject({ claimed: 4, done: 2, released: 2, unconfirmed: 0 });
  });

  it("logs one redacted line, never success, when the queue does not take a finish after a send", async () => {
    const handler: JobHandler = async () => ({ status: "done" });
    for (const answer of ["stale" as const, null, new Error("network to dani@example.com")]) {
      const { queue } = calls([[job({ id: "a" })]], () => answer);
      const { lines, log } = quiet();
      const summary = await runJobs(queue, createRegistry({ "message.send": handler }), { log });
      expect(summary).toMatchObject({ done: 1, unconfirmed: 1 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("job a");
      expect(lines[0]).toContain(answer === "stale" ? "answer stale" : "answer error");
      expect(lines[0]).not.toMatch(/dani|example|lead_id|channel/);
    }
  });
});

describe("OPS-04: the send handler", () => {
  beforeEach(() => clearFakeSentMessages());

  it("refuses while sending is paused or the address is suppressed, and sends nothing", async () => {
    for (const reason of ["sending_paused", "consent_suppressed", "consent_unknown", "business_closed"]) {
      const maySend = vi.fn(async () => ({ may_send: false, reason }));
      const handler = createSendHandler({ maySend, providerFor: () => createFakeProvider({ channel: "email" }) });
      expect(await handler(job())).toEqual({ status: "ended", reason });
      expect(maySend).toHaveBeenCalledWith(job());
    }
    expect(fakeSentMessages()).toEqual([]);
  });

  it("(52) ג: a waiting answer during a pause ends this run without sending (the database queued the job again)", async () => {
    const handler = createSendHandler({
      maySend: async () => ({ may_send: false, reason: "sending_paused", retry: true }),
      providerFor: () => createFakeProvider(),
    });
    expect(await handler(job())).toEqual({ status: "ended", reason: "sending_paused" });
    expect(fakeSentMessages()).toEqual([]);
  });

  it("sends through the provider with ids and codes only once the database says yes", async () => {
    const handler = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: (channel) => createFakeProvider({ channel }) });
    expect(await handler(job())).toMatchObject({ status: "done", receipt: { provider: "fake" } });
    expect(
      await handler(job({ id: "c2", payload: { channel: "sms", contact_id: "55555555-5555-4555-8555-555555555555", message_type: "collection" } })),
    ).toMatchObject({ status: "done" });
    expect(fakeSentMessages()).toEqual([
      // CNS-07: a payload without a type counts as marketing
      {
        jobId: job().id,
        organizationId: job().organization_id,
        channel: "email",
        messageType: null,
        purpose: "marketing",
        recordType: "lead",
        recordId: "44444444-4444-4444-8444-444444444444",
      },
      {
        jobId: "c2",
        organizationId: job().organization_id,
        channel: "sms",
        messageType: "collection",
        purpose: "service",
        recordType: "contact",
        recordId: "55555555-5555-4555-8555-555555555555",
      },
    ]);
  });

  it("never sends on a malformed answer or payload, and reports a provider failure", async () => {
    const provider = createFakeProvider();
    for (const answer of [null, {}, { may_send: "yes" }, { may_send: false }]) {
      const handler = createSendHandler({ maySend: async () => answer, providerFor: () => provider });
      expect((await handler(job())).status).toBe("failed");
    }
    const asked = vi.fn(async () => ({ may_send: true }));
    const bad = createSendHandler({ maySend: asked, providerFor: () => provider });
    expect(await bad(job({ payload: { channel: "fax", lead_id: "x" } }))).toEqual({ status: "failed", error: "payload", final: true });
    expect(asked).not.toHaveBeenCalled();
    expect(fakeSentMessages()).toEqual([]);
    const failing = createFakeProvider({ fail: () => ({ ok: false, error: "quota" }) });
    const handler = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: () => failing });
    expect(await handler(job())).toEqual({ status: "failed", error: "quota", final: undefined, receipt: { provider: "fake" } });
  });

  it("uses the fake provider only when asked, and never on production", () => {
    expect(messagingProvider({})).toBeNull();
    expect(messagingProvider({ MESSAGING_PROVIDER: "real" })).toBeNull();
    expect(messagingProvider({ MESSAGING_PROVIDER: "fake" })?.name).toBe("fake");
    expect(messagingProvider({ MESSAGING_PROVIDER: "fake", VERCEL_ENV: "development" })?.name).toBe("fake");
    expect(messagingProvider({ MESSAGING_PROVIDER: "fake", VERCEL_ENV: "production" })).toBeNull();
    expect(messagingProvider({ MESSAGING_PROVIDER: "fake", VERCEL_ENV: "preview" })).toBeNull();
  });

  it("the fake keeps only the last 100 messages", async () => {
    const fake = createFakeProvider();
    for (let i = 0; i < FAKE_SENT_KEPT + 5; i++) {
      await fake.send({ jobId: `j${i}`, organizationId: "o", channel: "sms", messageType: "collection", purpose: "service", recordType: "lead", recordId: "r" });
    }
    expect(fakeSentMessages()).toHaveLength(FAKE_SENT_KEPT);
    expect(fakeSentMessages()[0].jobId).toBe("j5");
  });
});

describe("OPS-04: hard rule 5 (service-role key)", () => {
  it("the eslint allow-list names the worker, and only one new OPS-04 file", () => {
    const config = read("eslint.config.mjs");
    const start = config.indexOf("FXC-08: the service-role key");
    const block = config.slice(config.indexOf("ignores: [", start), config.indexOf("],", config.indexOf("ignores: [", start)));
    expect(block).toContain('"src/features/jobs/run-server.ts"');
    expect(block).not.toMatch(/src\/features\/messaging\//);
    expect(block.match(/src\/features\/jobs\//g)).toHaveLength(1);
  });

  it("the drafted In use line names files and functions that exist, granted to service_role only", () => {
    for (const path of [...IN_USE_LINE.matchAll(/`(src\/[^`]+)`/g)].map((m) => m[1])) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
    const sql = migration();
    for (const fn of ["claim_jobs", "finish_job", "job_message_may_send"]) {
      expect(IN_USE_LINE).toContain(`public.${fn}()`);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`));
    }
    expect(sql).toContain("'crm-jobs-wake'");
    expect(sql).toContain("revoke all on app.jobs from public, anon, authenticated, service_role;");
  });

  it("CLAUDE.md holds the drafted line once it names the route", () => {
    const guide = read("CLAUDE.md");
    if (guide.includes("/api/jobs/run")) {
      expect(squash(guide)).toContain(squash(IN_USE_LINE));
    } else {
      // not merged yet: the lead adds IN_USE_LINE to hard rule 5 with this branch
      expect(guide).not.toContain("OPS-04, owner 26 October 2026, answer (א) and wave 3 use (1)");
    }
  });
});
