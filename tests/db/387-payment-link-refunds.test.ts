import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Job = { id: string; lease: string };

// LNK-07 (owner (394) א): the payment_link.refund path, pinned by md5(pg_get_functiondef) without carriage returns. A change
// needs a fresh independent review (ids only in the queue; a refund recorded only after the provider answered ok; PAY-08's
// rights at the request and again at the claim).
const REVIEWED_MD5: Record<string, string> = {
  "app.job_kinds": "af20fc3f6ae938e0447f119549e5a7d0",
  "app.job_payload_ok": "0a583cd61b41ec40e991fd08ff8138d4",
  "app.payment_link_refund_notice": "cb4670d41f7dedfcdcb4228beb353a4c",
  "app.payment_link_refund_room": "017e752938c8f68846a8d376e2977175",
  // review of the LNK branch (2, 3): PAY-08's check, 021154's body plus the open provider requests and refund:provider_made
  "app.payment_refunds_check": "dd6043767014a14e78a055876fa174f1",
  // delta review (2): PAY-08's guard, 021154's body plus the open provider requests
  "app.payments_refund_guard": "6afd86d2b815707beed4abe9f9d2afbb", // lead, 18 November 2026: allocation cap judged against active refunds only (second delta review)
  "public.payment_link_refund_begin": "f8465be1047793d026c9ea11a7c89c88",
  "public.payment_link_refund_claim": "bbc81e093644558d129fee48eeb12028",
  // review 4
  "public.payment_link_refund_close": "c3a69b7424435d80c7475da085ffb7af",
  "public.payment_link_refund_record": "a113d2fab20521ebddea5a35a3fdbf9c",
  "public.payment_link_refund_state": "04fe33cc493f08974ae5064e787319d9",
};

describe("payment link refunds (LNK-07)", () => {
  let owner: U, admin: U, manager: U;
  let org: string;
  const FEATURES = { documents: true, payments: true, payment_links: true, quotes: true, orders: true };
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  // a contact's link paid through the webhook: its payment id
  const paidPayment = async (amount = 10000): Promise<string> => {
    const c = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'לקוח', $2) returning id", [org, owner.id])).id);
    const l = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payment_links (organization_id, contact_id, amount_agorot, expires_on, provider) values ($1, $2, $3, current_date + 3, 'fake') returning id", [org, c, amount])).id,
    );
    await asService((q) =>
      q("select public.payment_link_webhook('fake', $1)", [JSON.stringify({ event_id: `ev_${randomUUID()}`, provider_link_id: `fake_${l}`, status: "paid", paid_agorot: amount, currency: "ILS", provider_payment_id: `fake_payment_${randomUUID().slice(0, 8)}` })]),
    );
    return (await asAdmin((q) => one<{ p: string }>(q, "select payment_id as p from public.payment_links where id = $1", [l]))).p;
  };
  const begin = (u: U, payment: string, amount: number, key = randomUUID()) =>
    asUser(u.id, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_refund_begin($1, $2, $3, $4, 'החזר ללקוח') as r", [org, key, payment, amount])).r);
  const hint = async (p: Promise<unknown>) => {
    const e = await pgError(p);
    return e.hint ?? e.code;
  };
  const claimJob = async (request: string): Promise<Job> => {
    const wanted = (await asAdmin((q) => one<{ j: string }>(q, "select job_id as j from app.payment_link_refund_requests where id = $1", [request]))).j;
    const rows = await asService(async (q) => (await one<{ r: (Job & { id: string })[] }>(q, "select public.claim_jobs(array['payment_link.refund'], 100) as r")).r);
    for (const other of rows.filter((x) => x.id !== wanted)) await asService((q) => q("select public.finish_job($1, $2, false, null, false, false)", [other.id, other.lease]));
    const job = rows.find((x) => x.id === wanted);
    if (!job) throw new Error("the request's job was not claimed");
    return job;
  };
  const claim = (job: Job) => asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_refund_claim($1, $2) as r", [job.id, job.lease])).r);
  const record = (job: Job, answer: Record<string, unknown>) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_refund_record($1, $2, $3) as r", [job.id, job.lease, JSON.stringify(answer)])).r);
  const finish = (job: Job, ok = true) => asService((q) => q("select public.finish_job($1, $2, $3, null, false)", [job.id, job.lease, ok]));
  const refunds = (payment: string) => asAdmin((q) => count(q, "select 1 from public.payment_refunds where payment_id = $1 and status = 'active'", [payment]));
  const requestRow = (id: string) => asAdmin((q) => one<{ status: string; code: string | null }>(q, "select status, error_code as code from app.payment_link_refund_requests where id = $1", [id]));

  beforeAll(async () => {
    owner = await createUser("lnkr-owner");
    org = await createOrg(owner.id, "עסק ההחזרים");
    admin = await addMember(org, owner.id, "admin", "lnkr-admin");
    manager = await addMember(org, owner.id, "manager", "lnkr-manager");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("insert into app.settings (key, value) values ('payment_links_fake', 'on') on conflict (key) do update set value = excluded.value"));
  });

  it("a partial refund is recorded only after the provider answered ok, by the requester", async () => {
    const p = await paidPayment();
    const r = await begin(admin, p, 4000);
    expect(r).toMatchObject({ status: "pending" });
    expect(await refunds(p)).toBe(0);
    const job = await claimJob(r.request_id as string);
    expect(await claim(job)).toMatchObject({ request_id: r.request_id, provider: "fake", amount_agorot: 4000 });
    expect(await record(job, { ok: true, provider_refund_id: "fake_refund_1" })).toMatchObject({ status: "refunded" });
    await finish(job);
    const row = await asAdmin((q) => one<{ amount: number; method: string; reference: string; by: string }>(q, "select amount_agorot::int as amount, method, reference, created_by as by from public.payment_refunds where payment_id = $1", [p]));
    expect(row).toEqual({ amount: 4000, method: "credit", reference: "fake_refund_1", by: admin.id });
    // the same key answers the same request
    const again = await asUser(admin.id, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_refund_begin($1, $2, $3, 4000) as r", [org, randomUUID(), p])).r);
    expect(again.status).toBe("pending");
    // the rest only (10000 - 4000 refunded - 4000 asked now)
    expect(await hint(begin(admin, p, 2001))).toBe("refund:over");
    expect((await state(admin, p)).length).toBe(2);
  });

  const state = (u: U, p: string) => asUser(u.id, async (q) => (await one<{ r: unknown[] }>(q, "select public.payment_link_refund_state($1, $2) as r", [org, p])).r);

  it("a refund in full marks the payment refunded", async () => {
    const p = await paidPayment(5000);
    const r = await begin(owner, p, 5000);
    const job = await claimJob(r.request_id as string);
    await claim(job);
    await record(job, { ok: true, provider_refund_id: "fake_refund_2" });
    await finish(job);
    expect((await asAdmin((q) => one<{ s: string }>(q, "select status as s from public.payments where id = $1", [p]))).s).toBe("refunded");
  });

  it("a provider failure records nothing and tells the requester; a retryable one waits", async () => {
    const p = await paidPayment();
    const r = await begin(admin, p, 1000);
    let job = await claimJob(r.request_id as string);
    await claim(job);
    expect(await record(job, { ok: false, code: "timeout", final: false })).toEqual({ status: "pending", code: "timeout" });
    await finish(job, false);
    await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [job.id]));
    job = await claimJob(r.request_id as string);
    await claim(job);
    const before = await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and title = 'בדקו החזר אצל ספק הסליקה'", [admin.id]));
    // a refusal after an earlier try: nobody knows whether the first one went through
    expect(await record(job, { ok: false, code: "refused", final: true })).toEqual({ status: "unrecorded", code: "refused" });
    await finish(job);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and title = 'בדקו החזר אצל ספק הסליקה'", [admin.id]))).toBe(before + 1);
    expect(await refunds(p)).toBe(0);

    const r2 = await begin(admin, await paidPayment(), 1000);
    const j2 = await claimJob(r2.request_id as string);
    await claim(j2);
    expect(await record(j2, { ok: false, code: "not_refundable", final: true })).toEqual({ status: "failed", code: "not_refundable" });
    await finish(j2);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where user_id = $1 and title = 'ההחזר דרך ספק הסליקה לא בוצע'", [admin.id]))).toBeGreaterThan(0);
  });

  it("owners and admins only; a payment not from a link is refused; the claim judges the requester again", async () => {
    const p = await paidPayment();
    expect((await pgError(begin(manager, p, 100))).code).toBe("42501");
    expect(await state(manager, p)).toEqual([]);
    const c = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'אחר') returning id", [org])).id);
    const cash = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 500, 'cash') returning id", [org, c])).id);
    expect(await hint(begin(owner, cash, 100))).toBe("payment_link_refund:not_link");
    const r = await begin(admin, p, 100);
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, admin.id]));
    try {
      const job = await claimJob(r.request_id as string);
      expect(await claim(job)).toEqual({ refused: "requester_gone" });
      await finish(job);
      expect(await requestRow(r.request_id as string)).toEqual({ status: "failed", code: "requester_gone" });
    } finally {
      await asAdmin((q) => q("update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2", [org, admin.id]));
    }
    for (const fn of ["payment_link_refund_claim($1, $2)", "payment_link_refund_record($1, $2, '{}')"]) {
      expect((await pgError(asUser(owner.id, (q) => q(`select public.${fn}`, [randomUUID(), randomUUID()])))).code).toBe("42501");
    }
  });

  const close = (u: U, request: string, outcome: string) =>
    asUser(u.id, async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.payment_link_refund_close($1, $2, $3) as r", [org, request, outcome])).r);
  const manual = (u: U, p: string, amount: number) =>
    asUser(u.id, (q) => q("insert into public.payment_refunds (organization_id, payment_id, amount_agorot, refunded_on, method) values ($1, $2, $3, current_date + 1, 'cash') returning id", [org, p, amount]));
  // an unrecorded request: a refusal on the second try
  const unrecorded = async (p: string, amount: number) => {
    const r = await begin(admin, p, amount);
    let job = await claimJob(r.request_id as string);
    await claim(job);
    await record(job, { ok: false, code: "timeout", final: false });
    await finish(job, false);
    await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [job.id]));
    job = await claimJob(r.request_id as string);
    await claim(job);
    await record(job, { ok: false, code: "refused", final: true });
    await finish(job);
    return r.request_id as string;
  };

  it("review 2: a manual refund's cap counts the requests still open at the provider", async () => {
    const p = await paidPayment(10000);
    await begin(admin, p, 7000);
    expect(await hint(manual(owner, p, 3001))).toBe("refund:over");
    expect((await manual(owner, p, 3000)).rowCount).toBe(1);
  });

  it("review 3: a refund the provider made is not cancelled by hand", async () => {
    const p = await paidPayment(5000);
    const r = await begin(admin, p, 1000);
    const job = await claimJob(r.request_id as string);
    await claim(job);
    const done = await record(job, { ok: true, provider_refund_id: "fake_refund_9" });
    await finish(job);
    expect(await hint(asUser(owner.id, (q) => q("update public.payment_refunds set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [done.refund_id])))).toBe("refund:provider_made");
  });

  it("review 4: an unrecorded request is closed by an owner or admin, refunded at the provider or not, audited", async () => {
    const p = await paidPayment(10000);
    const a = await unrecorded(p, 2000);
    expect(await requestRow(a)).toMatchObject({ status: "unrecorded" });
    expect((await pgError(close(manager, a, "not_refunded"))).code).toBe("42501");
    expect(await close(owner, a, "not_refunded")).toEqual({ status: "released" });
    expect(await hint(close(owner, a, "not_refunded"))).toBe("payment_link_refund:closed");
    const b = await unrecorded(p, 3000);
    expect(await close(admin, b, "refunded_at_provider")).toEqual({ status: "refunded" });
    expect(await refunds(p)).toBe(1);
    const row = await asAdmin((q) => one<{ by: string; amount: number }>(q, "select created_by as by, amount_agorot::int as amount from public.payment_refunds where payment_id = $1", [p]));
    expect(row).toEqual({ by: admin.id, amount: 3000 });
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where action = 'refund_request_close' and entity_id = $1", [p]))).toBe(2);
    expect(await hint(manual(owner, p, 7001))).toBe("refund:over");
  });

  it("delta review (2): while a provider refund is open the payment keeps its status and enough amount", async () => {
    const p = await paidPayment(10000);
    const a = await unrecorded(p, 4000);
    for (const sql of [
      "update public.payments set status = 'failed' where id = $1",
      "update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1",
      "update public.payments set amount_agorot = 4000 where id = $1",
    ]) {
      expect(await hint(asUser(owner.id, (q) => q(sql, [p]))), sql).toBe("payment:refund_request_open");
    }
    // recorded <-> confirmed stays allowed, and an amount above the open request
    expect((await asUser(owner.id, (q) => q("update public.payments set status = 'recorded' where id = $1 returning id", [p]))).rowCount).toBe(1);
    expect((await asUser(owner.id, (q) => q("update public.payments set amount_agorot = 4001 where id = $1 returning id", [p]))).rowCount).toBe(1);
    // the close still records it
    expect(await close(owner, a, "refunded_at_provider")).toEqual({ status: "refunded" });
  });

  it("second delta review: allocations are judged against active refunds only, not the open request", async () => {
    const p = await paidPayment(10000);
    const c = (await asAdmin((q) => one<{ c: string }>(q, "select contact_id as c from public.payments where id = $1", [p]))).c;
    const d = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', $3, 10000) returning id", [org, c, `T-${randomUUID().slice(0, 8)}`])).id,
    );
    await asUser(owner.id, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 10000)", [org, p, d]));
    await unrecorded(p, 3000);
    // a correction that raises the amount is allowed: the allocation cap counts active refunds only
    expect((await asUser(owner.id, (q) => q("update public.payments set amount_agorot = 11000 where id = $1 returning id", [p]))).rowCount).toBe(1);
    // lowering below the allocations is still refused
    expect(await hint(asUser(owner.id, (q) => q("update public.payments set amount_agorot = 9999 where id = $1", [p])))).toBe("payment:allocated");
  });

  it("delta review (1): a provider refund already recorded by hand is not recorded again by the close", async () => {
    const p = await paidPayment(10000);
    const r = await begin(admin, p, 1000);
    let job = await claimJob(r.request_id as string);
    await claim(job);
    await record(job, { ok: false, code: "timeout", final: false });
    await finish(job, false);
    await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [job.id]));
    job = await claimJob(r.request_id as string);
    await claim(job);
    // the provider refunded, the database could not record it: kept with the provider's refund id
    await asAdmin((q) => q("update app.payment_link_refund_requests set status = 'unrecorded', provider_refund_id = 'fake_refund_77', finished_at = now() where id = $1", [r.request_id]));
    await finish(job);
    await asUser(owner.id, (q) => q("insert into public.payment_refunds (organization_id, payment_id, amount_agorot, refunded_on, method, reference) values ($1, $2, 1000, current_date + 1, 'credit', 'fake_refund_77')", [org, p]));
    expect(await hint(close(owner, r.request_id as string, "refunded_at_provider"))).toBe("payment_link_refund:recorded");
    expect(await close(owner, r.request_id as string, "not_refunded")).toEqual({ status: "released" });
    expect(await refunds(p)).toBe(1);
  });

  it("delta review (3): the same key twice answers the first request, not refund:over", async () => {
    const p = await paidPayment(1000);
    const key = randomUUID();
    const first = await begin(admin, p, 1000, key);
    const second = await begin(admin, p, 1000, key);
    expect(second.request_id).toBe(first.request_id);
  });

  it("the payload is the request's id only", async () => {
    const ok = (payload: unknown) => asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('payment_link.refund', $1) as ok", [JSON.stringify(payload)])).ok);
    expect(await ok({ request_id: randomUUID() })).toBe(true);
    expect(await ok({ request_id: randomUUID(), amount_agorot: 1 })).toBe(false);
  });

  it("the payment_link.refund functions are the reviewed ones", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string }>(
            `select n.nspname || '.' || p.proname as name, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) as md5
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname || '.' || p.proname) = any ($1) order by 1`,
            [Object.keys(REVIEWED_MD5)],
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
  });
});
