import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Job = { id: string; lease: string; payload: Record<string, string> };

// LNK-02 (owner (394) א): the worker's path, pinned by md5(pg_get_functiondef) without carriage returns (body, security
// definer, settings, arguments). A change needs a fresh independent review against answer (55)'s conditions (ids only in the
// queue; the service key calls only the claim and the record; no person records a provider's answer).
const REVIEWED_MD5: Record<string, string> = {
  "app.payment_link_notice": "29f10fbe38f5e0eb57e9b65423dbd07e",
  "app.payment_link_page_close": "bcffd876414e5173f4e3c4fb398d1588",
  "app.payment_link_provider_usable": "0e3c9c3c178613665cdea4d949b26335",
  "app.payment_links_check": "6b6db348ec1c7a6e32c7764314a707d9",
  "app.payment_links_queue_page": "bb1e033ecc02b8371738ddfbe5509354",
  "public.payment_link_page_claim": "c45ac4e2f2cbb8eff6299a08da5523c3",
  "public.payment_link_page_record": "0c09bc2235e5869dbc6c09163d305e27",
};

/**
 * LNK-02 (the provider call; owner (394) א): a new pending link queues one `payment_link.create` job ({link_id} only); the
 * worker's claim answers the link's amount and title on the live lease only, and the record keeps the provider's id and the
 * page's address once. A refusal or no answer by the last try cancels the link 'page_failed' and tells its maker.
 */
describe("payment link pages (LNK-02, the provider call)", () => {
  let owner: U, admin: U;
  let org: string;
  const FEATURES = { documents: true, payments: true, payment_links: true, quotes: true, orders: true };
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

  const contact = () =>
    asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, owner.id])).id);
  const link = (contactId: string, amount = 5000, maker: U = owner) =>
    asUser(maker.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.payment_links (organization_id, contact_id, amount_agorot, max_installments, expires_on, provider)
           values ($1, $2, $3, 3, (now() at time zone 'Asia/Jerusalem')::date + 7, 'fake') returning id`,
          [org, contactId, amount],
        )
      ).id,
    );
  const jobOf = (linkId: string) =>
    asAdmin((q) => one<{ id: string; payload: Record<string, string> }>(q, "select id, payload from app.jobs where kind = 'payment_link.create' and payload ->> 'link_id' = $1", [linkId]));
  const claimJob = async (linkId: string): Promise<Job> => {
    const wanted = (await jobOf(linkId)).id;
    const rows = await asService(async (q) => (await one<{ r: Job[] }>(q, "select public.claim_jobs(array['payment_link.create'], 100) as r")).r);
    for (const other of rows.filter((x) => x.id !== wanted)) {
      await asService((q) => q("select public.finish_job($1, $2, false, null, false, false)", [other.id, other.lease]));
    }
    const job = rows.find((x) => x.id === wanted);
    if (!job) throw new Error("the link's job was not claimed");
    return job;
  };
  const claim = (job: Job) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_page_claim($1, $2) as r", [job.id, job.lease])).r);
  const record = (job: Job, answer: Record<string, unknown>) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_page_record($1, $2, $3) as r", [job.id, job.lease, JSON.stringify(answer)])).r);
  const finish = (job: Job, ok = true) => asService((q) => q("select public.finish_job($1, $2, $3, null, false)", [job.id, job.lease, ok]));
  const row = (linkId: string) =>
    asAdmin((q) =>
      one<{ status: string; closed_reason: string | null; provider_link_id: string | null; hosted_url: string | null; page: boolean; code: string | null }>(
        q,
        "select status, closed_reason, provider_link_id, hosted_url, page_created_at is not null as page, page_error_code as code from public.payment_links where id = $1",
        [linkId],
      ),
    );
  const told = (u: U) => asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and user_id = $2 and title = 'קישור התשלום לא נוצר'", [org, u.id]));

  beforeAll(async () => {
    owner = await createUser("lnkp-owner");
    org = await createOrg(owner.id, "עסק דפי התשלום");
    admin = await addMember(org, owner.id, "admin", "lnkp-admin");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("insert into app.settings (key, value) values ('payment_links_fake', 'on') on conflict (key) do update set value = excluded.value"));
  });

  it("a new link queues one job with the link's id only, and the claim answers its amount and title", async () => {
    const l = await link(await contact());
    const job = await jobOf(l);
    expect(job.payload).toEqual({ link_id: l });
    const claimed = await claimJob(l);
    const answer = await claim(claimed);
    expect(answer).toMatchObject({ link_id: l, provider: "fake", provider_link_id: `fake_${l}`, request: { amount_agorot: 5000, currency: "ILS", max_installments: 3, title: "תשלום", organization_id: org } });
    expect(Object.keys(answer.request as object).sort()).toEqual(["amount_agorot", "currency", "expires_at", "max_installments", "organization_id", "title"]);
    expect(await record(claimed, { ok: true, provider_link_id: `fake_${l}`, hosted_url: "https://pay.example/abc" })).toEqual({ status: "created" });
    await finish(claimed);
    expect(await row(l)).toMatchObject({ status: "pending", provider_link_id: `fake_${l}`, hosted_url: "https://pay.example/abc", page: true, code: null });
  });

  it("a dead lease answers stale; a person cannot call the claim or the record", async () => {
    const l = await link(await contact());
    const claimed = await claimJob(l);
    expect(await asService(async (q) => (await one<{ r: unknown }>(q, "select public.payment_link_page_claim($1, $2) as r", [claimed.id, randomUUID()])).r)).toEqual({ refused: "stale" });
    expect(await asService(async (q) => (await one<{ r: unknown }>(q, "select public.payment_link_page_record($1, $2, '{\"ok\":true}') as r", [claimed.id, randomUUID()])).r)).toEqual({ status: "stale" });
    for (const fn of ["payment_link_page_claim($1, $2)", "payment_link_page_record($1, $2, '{}')"]) {
      expect((await pgError(asUser(owner.id, (q) => q(`select public.${fn}`, [claimed.id, claimed.lease])))).code).toBe("42501");
    }
    await finish(claimed);
  });

  it("the provider's id must be the one kept; a bad address or id cancels the link and tells its maker", async () => {
    const before = await told(admin);
    const l = await link(await contact(), 5000, admin);
    const claimed = await claimJob(l);
    await claim(claimed);
    expect(await record(claimed, { ok: true, provider_link_id: "fake_other", hosted_url: null })).toEqual({ status: "cancelled", code: "provider_id_mismatch" });
    await finish(claimed);
    expect(await row(l)).toMatchObject({ status: "cancelled", closed_reason: "page_failed", code: "provider_id_mismatch", page: false });
    expect(await told(admin)).toBe(before + 1);

    const l2 = await link(await contact());
    const j2 = await claimJob(l2);
    await claim(j2);
    expect(await record(j2, { ok: true, provider_link_id: `fake_${l2}`, hosted_url: "http://plain.example" })).toEqual({ status: "cancelled", code: "provider_answer" });
    await finish(j2);
  });

  it("a retryable failure waits for the next try; a final one cancels; the last try cancels", async () => {
    const l = await link(await contact());
    let job = await claimJob(l);
    await claim(job);
    expect(await record(job, { ok: false, code: "timeout", final: false })).toEqual({ status: "pending", code: "timeout" });
    await finish(job, false);
    expect(await row(l)).toMatchObject({ status: "pending", code: "timeout" });
    // the next try (made due at once): a final refusal
    await asAdmin((q) => q("update app.jobs set next_run_at = now() where payload ->> 'link_id' = $1", [l]));
    job = await claimJob(l);
    await claim(job);
    expect(await record(job, { ok: false, code: "refused", final: true })).toEqual({ status: "cancelled", code: "refused" });
    await finish(job);
    expect(await row(l)).toMatchObject({ status: "cancelled", closed_reason: "page_failed", code: "refused" });

    const last = await link(await contact());
    await asAdmin((q) => q("update app.jobs set attempts = app.job_max_attempts() - 1 where payload ->> 'link_id' = $1", [last]));
    job = await claimJob(last);
    await claim(job);
    expect(await record(job, { ok: false, code: "timeout", final: false })).toEqual({ status: "cancelled", code: "retries_spent" });
    await finish(job);
  });

  it("a cancelled link is finished; a closed source or a missing key cancels it at the claim", async () => {
    const l = await link(await contact());
    await asUser(owner.id, (q) => q("update public.payment_links set status = 'cancelled' where id = $1", [l]));
    let job = await claimJob(l);
    expect(await claim(job)).toEqual({ refused: "finished" });
    await finish(job);

    const c = await contact();
    const binned = await link(c);
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [c]));
    job = await claimJob(binned);
    expect(await claim(job)).toEqual({ refused: "source_closed" });
    await finish(job);
    expect(await row(binned)).toMatchObject({ status: "cancelled", closed_reason: "source_closed" });

    const off = await link(await contact());
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, payment_links: false })]));
    try {
      job = await claimJob(off);
      expect(await claim(job)).toEqual({ refused: "feature:payment_links" });
      await finish(job);
      expect(await row(off)).toMatchObject({ status: "cancelled", closed_reason: "page_failed", code: "feature:payment_links" });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
  });

  it("the page columns are the server's: a person writes none of them", async () => {
    const l = await link(await contact());
    for (const sql of ["update public.payment_links set hosted_url = 'https://x.example' where id = $1", "update public.payment_links set page_created_at = now() where id = $1"]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql, [l])))).code).toBe("42501");
    }
    // the server's page branch is only for the worker (no session) and only once
    const claimed = await claimJob(l);
    await claim(claimed);
    await record(claimed, { ok: true, provider_link_id: `fake_${l}`, hosted_url: null });
    expect(await record(claimed, { ok: true, provider_link_id: `fake_${l}`, hosted_url: "https://late.example" })).toEqual({ status: "created" });
    await finish(claimed);
    expect((await row(l)).hosted_url).toBeNull();
  });

  it("the payload is the link's id only", async () => {
    const ok = (payload: unknown) => asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('payment_link.create', $1) as ok", [JSON.stringify(payload)])).ok);
    expect(await ok({ link_id: randomUUID() })).toBe(true);
    expect(await ok({ link_id: randomUUID(), amount_agorot: 1 })).toBe(false);
    expect(await ok({ link_id: "x" })).toBe(false);
    expect(await ok({})).toBe(false);
  });

  it("the payment_link.create functions are the reviewed ones", async () => {
    const names = Object.keys(REVIEWED_MD5).map((n) => n.split("."));
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string }>(
            `select n.nspname || '.' || p.proname as name, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname || '.' || p.proname) = any ($1) order by 1`,
            [names.map((x) => x.join("."))],
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
  });
});
