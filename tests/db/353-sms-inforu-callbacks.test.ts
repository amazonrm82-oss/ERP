import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

type Answer = Record<string, unknown>;

// md5 of the two callback functions as reviewed (review (10)); a change needs a fresh independent review
// Rechecked for the delta review of 47291672 (1): pending only for a job in the queue or finished in the last 15 minutes with no
// message row of its job, and a message whose job ended unknown_* settled by its job_id; (5): the number's bucket keyed with
// consent_hash_key (app.sms_inbound_number_take, pinned here too); sms_inbound_reply's body unchanged
// Then the final review of 902dcbfa: an id is cast to uuid only when it has the shape (1), and a message settled from
// unknown_* as delivered gets sent_at (2)
const REVIEWED_STATUS_MD5 = "b68858d0c5f0b15b83441313ffe0f52f";
const REVIEWED_TAKE_MD5 = "f6f63fc115fed7ad5b4d5bf598bce6e5";
const REVIEWED_REPLY_MD5 = "32283b28a308b691c0bf3b2d61da23b9";

const KEY = "test-consent-key";

const message = (org: string, lead: string, provider = "inforu", occurred = "now()") =>
  asAdmin(async (q) => {
    const id = randomUUID();
    await q(
      `insert into public.messages (organization_id, lead_id, channel, direction, status, provider, provider_message_id, job_id, occurred_at, sent_at)
       values ($1, $2, 'sms', 'outbound', 'sent', $3, $4, $5, ${occurred}, now())`,
      [org, lead, provider, id, id],
    );
    return id;
  });
const row = (id: string) =>
  asAdmin(async (q) => (await q<{ status: string; code: string | null; delivered: boolean }>("select status, provider_error_code as code, delivered_at is not null as delivered from public.messages where provider_message_id = $1", [id])).rows[0]);
const status = (items: unknown, provider = "inforu") =>
  asService(async (q) => (await q<{ r: Answer }>("select public.sms_delivery_status($1, $2::jsonb) as r", [provider, JSON.stringify(items)])).rows[0].r);
const reply = (phone: string, body: string, provider = "inforu") =>
  asService(async (q) => (await q<{ r: Answer }>("select public.sms_inbound_reply($1, $2, $3) as r", [provider, phone, body])).rows[0].r);
const listed = (org: string) =>
  asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.consent_blocklist where organization_id = $1 and reason = 'sms_reply' and removed_at is null", [org])).rows[0].n);

/** SMS-05 (owner (318) א), wave 3 use (2): InforU's delivery reports and replies, one service_role definer each. */
describe("InforU callbacks (SMS-05)", () => {
  let owner: { id: string }, ownerB: { id: string }, ownerC: { id: string };
  let org: string, orgB: string, orgC: string;

  beforeAll(async () => {
    await asAdmin((q) => q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]));
    owner = await createUser("inforu-owner");
    org = await createOrg(owner.id, "עסק דיווח");
    ownerB = await createUser("inforu-owner-b");
    orgB = await createOrg(ownerB.id, "עסק שני");
    ownerC = await createUser("inforu-owner-c");
    orgC = await createOrg(ownerC.id, "עסק שלישי");
    await asAdmin((q) => q("update app.sms_callback_counts set n = 0"));
  });
  afterAll(closePool);

  it("are for service_role only", async () => {
    for (const sql of ["select public.sms_delivery_status('inforu', '[]'::jsonb)", "select public.sms_inbound_reply('inforu', '0521234567', 'הסר')"]) {
      const code = await asUser(owner.id, (q) => q(sql)).catch((e: { code?: string }) => e.code);
      expect(code).toBe("42501");
    }
  });

  it("a delivery report moves only a sent message of that provider, never backwards", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "א", phone: "052-4440001", owner_id: owner.id });
    const a = await message(org, lead);
    const b = await message(org, lead);
    const fake = await message(org, lead, "fake");
    expect(await status([{ id: a, status: "delivered" }, { id: b, status: "failed", code: "inforu_undelivered" }, { id: fake, status: "delivered" }])).toEqual({ delivered: 1, failed: 1, pending: 0 });
    expect(await row(a)).toEqual({ status: "delivered", code: null, delivered: true });
    expect(await row(b)).toEqual({ status: "failed", code: "inforu_undelivered", delivered: false });
    expect((await row(fake)).status).toBe("sent");
    // a later "failed" for a delivered message changes nothing
    expect(await status([{ id: a, status: "failed" }])).toEqual({ delivered: 0, failed: 0, pending: 0 });
    expect((await row(a)).status).toBe("delivered");
  });

  it("refuses another provider, a malformed list and too many items; rate limits per minute", async () => {
    expect(await status([], "fake")).toEqual({ refused: "provider" });
    expect(await status({ id: "x" })).toEqual({ refused: "items" });
    expect(await status(Array.from({ length: 501 }, () => ({ id: "x", status: "delivered" })))).toEqual({ refused: "items" });
    await asAdmin((q) => q("insert into app.sms_callback_counts (kind, minute, n) values ('status', date_trunc('minute', now()), 20000) on conflict (kind) do update set minute = excluded.minute, n = 20000"));
    expect(await status([{ id: randomUUID(), status: "delivered" }])).toEqual({ rate_limited: true });
    await asAdmin((q) => q("update app.sms_callback_counts set n = 0"));
  });

  it("an opt-out reply reaches every business that recently texted the number through InforU, and only those", async () => {
    const phone = "052-4440099";
    const leadA = await insertLead(owner.id, org, { full_name: "ב", phone, owner_id: owner.id });
    const leadB = await insertLead(ownerB.id, orgB, { full_name: "ג", phone, owner_id: ownerB.id });
    // C holds the number but never texted it through InforU in 90 days
    const leadC = await insertLead(ownerC.id, orgC, { full_name: "ד", phone, owner_id: ownerC.id });
    await message(org, leadA);
    await message(orgB, leadB);
    await message(orgC, leadC, "inforu", "now() - interval '120 days'");

    expect(await reply("0524440099", "מה נשמע?")).toEqual({ status: "ignored" });
    expect(await listed(org)).toBe(0);

    expect(await reply("0524440099", "הסר")).toEqual({ status: "done", businesses: 2, opted_out: 2, limited: 0 });
    expect(await listed(org)).toBe(1);
    expect(await listed(orgB)).toBe(1);
    expect(await listed(orgC)).toBe(0);
    expect(await reply("0529999999", "הסר")).toEqual({ status: "no_business", businesses: 0, opted_out: 0, limited: 0 });
    expect(await reply("0524440099", "הסר", "fake")).toEqual({ refused: "provider" });
    // review (5): a repeated opt-out (InforU posting again) writes nothing twice
    expect(await reply("0524440099", "הסר")).toMatchObject({ status: "done", businesses: 2 });
    expect(await listed(org)).toBe(1);
    expect(await listed(orgB)).toBe(1);
  });

  it("a report for a job whose message row is not written yet is pending, so the route asks InforU to post again (review (6))", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ה", phone: "052-4440002", owner_id: owner.id });
    const job = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify({ channel: "sms", message_type: "requested_document", lead_id: lead, template_id: randomUUID() })]))
          .rows[0].id,
    );
    expect(await status([{ id: job, status: "delivered" }, { id: randomUUID(), status: "delivered" }])).toEqual({ delivered: 0, failed: 0, pending: 1 });
  });

  it("settles a message whose job ended unknown_*, and never keeps an old job pending (delta review (1))", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ח", phone: "052-4440003", owner_id: owner.id });
    const job = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify({ channel: "sms", message_type: "requested_document", lead_id: lead, template_id: randomUUID() })]))
          .rows[0].id,
    );
    const claimed = await asService(async (q) => (await q<{ r: { id: string; lease: string }[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
    const mine = claimed.find((r) => r.id === job)!;
    await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id where id = $1", [job]));
    // the worker's finish of a request that may have reached InforU (a timeout): final, the code kept, no provider id
    await asService((q) => q("select public.finish_job($1, $2, false, 'inforu unknown_timeout', true, true, 'inforu', null, 'unknown_timeout')", [job, mine.lease]));
    const msg = () =>
      asAdmin(async (q) => (await q<{ status: string; code: string | null; pid: string | null }>("select status, provider_error_code as code, provider_message_id as pid from public.messages where job_id = $1", [job])).rows[0]);
    expect(await msg()).toEqual({ status: "failed", code: "unknown_timeout", pid: null });
    expect(await status([{ id: job, status: "delivered" }])).toEqual({ delivered: 1, failed: 0, pending: 0 });
    expect(await msg()).toEqual({ status: "delivered", code: null, pid: job });
    // final review (2): settled as delivered = sent
    expect(await asAdmin(async (q) => (await q<{ s: boolean }>("select sent_at is not null as s from public.messages where job_id = $1", [job])).rows[0].s)).toBe(true);
    // final review (1): an id that is not a uuid never makes the batch raise
    expect(await status([{ id: "not-a-uuid", status: "delivered" }, { id: job, status: "failed" }])).toEqual({ delivered: 0, failed: 0, pending: 0 });

    // a message.send job that finished long ago without a message row is never pending
    const old = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify({ channel: "sms", message_type: "requested_document", lead_id: lead, template_id: randomUUID() })]))
          .rows[0].id,
    );
    await asAdmin((q) => q("update app.jobs set status = 'dead', finished_at = now() - interval '16 minutes' where id = $1", [old]));
    expect(await status([{ id: old, status: "delivered" }])).toEqual({ delivered: 0, failed: 0, pending: 0 });
  });

  it("goes to every business, past the old cap of 20, and limits one number before the total (review (4), (5))", async () => {
    const phone = "052-4440500";
    const orgs: string[] = [];
    for (let i = 0; i < 22; i += 1) {
      const u = await createUser(`inforu-many-${i}`);
      const o = await createOrg(u.id, `עסק ${i}`);
      const l = await insertLead(u.id, o, { full_name: "ו", phone, owner_id: u.id });
      await message(o, l);
      orgs.push(o);
    }
    await asAdmin((q) => q("update app.sms_inbound_number_counts set n = 0"));
    expect(await reply("0524440500", "הסר")).toEqual({ status: "done", businesses: 22, opted_out: 22, limited: 0 });
    for (const o of orgs) expect(await listed(o)).toBe(1);
    // the number's own limit: 5 opt-out replies in 10 minutes, then refused before anything is read or counted in total
    for (let i = 0; i < 4; i += 1) expect(await reply("0524440500", "הסר")).toMatchObject({ status: "done" });
    const total = async () => asAdmin(async (q) => (await q<{ n: number }>("select coalesce(max(n), 0)::int as n from app.sms_callback_counts where kind = 'inbound'")).rows[0].n);
    const before = await total();
    expect(await reply("0524440500", "הסר")).toEqual({ rate_limited: true, scope: "number" });
    expect(await total()).toBe(before);
    // another number is not held by it; the total limit still holds
    await asAdmin((q) => q("insert into app.sms_callback_counts (kind, minute, n) values ('inbound', date_trunc('minute', now()), 1200) on conflict (kind) do update set minute = excluded.minute, n = 1200"));
    expect(await reply("0524440501", "הסר")).toEqual({ rate_limited: true, scope: "all" });
    await asAdmin((q) => q("update app.sms_callback_counts set n = 0"));
    await asAdmin((q) => q("update app.sms_inbound_number_counts set n = 0"));
  });

  it("are pinned as reviewed (body, definer, settings, arguments)", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string }>(
            `select p.proname as name, md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_function_identity_arguments(p.oid)) as md5
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname in ('sms_delivery_status', 'sms_inbound_reply')) or (n.nspname = 'app' and p.proname = 'sms_inbound_number_take') order by 1`,
          )
        ).rows,
    );
    // a change of either body fails here until it gets a fresh independent review; then update the md5
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual({
      sms_delivery_status: REVIEWED_STATUS_MD5,
      sms_inbound_reply: REVIEWED_REPLY_MD5,
      sms_inbound_number_take: REVIEWED_TAKE_MD5,
    });
  });
});
