import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

const KEY = "test-consent-key";

type Claimed = { id: string; lease: string };
type Message = {
  lead_id: string | null;
  contact_id: string | null;
  channel: string;
  direction: string;
  status: string;
  provider: string | null;
  provider_message_id: string | null;
  provider_error_code: string | null;
  job_id: string | null;
  sent_at: Date | null;
};

const enqueue = (org: string, payload: Record<string, unknown>) =>
  asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2) as id", [org, JSON.stringify(payload)])).rows[0].id);
const passCheck = async (job: Claimed) => {
  const answer = await asService(
    async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r,
  );
  expect(answer).toEqual({ may_send: true });
};
// claims the job; by default it also passes the send check (only such an attempt records a message)
const claimOne = async (id: string, check = true): Promise<Claimed> => {
  const rows = await asService(async (q) => (await q<{ r: Array<Claimed> }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  if (check) await passCheck(job as Claimed);
  return job as Claimed;
};
const finish = (job: Claimed, ok: boolean, extra: { provider?: string | null; id?: string | null; code?: string | null; final?: boolean } = {}) =>
  asService(
    async (q) =>
      (
        await q<{ r: string }>("select public.finish_job($1, $2, $3, null, $4, true, $5, $6, $7) as r", [
          job.id,
          job.lease,
          ok,
          extra.final ?? false,
          extra.provider ?? null,
          extra.id ?? null,
          extra.code ?? null,
        ])
      ).rows[0].r,
  );
const messageOf = (job: string) =>
  asAdmin(async (q) => (await q<Message>("select * from public.messages where job_id = $1", [job])).rows[0] ?? null);

/**
 * MSG-03: every message the queue sent (or failed to send) is kept with channel, direction, status, the provider's id and
 * an error code; no content, no cost (owner (75) א); one row per job; a provider id once per business and provider; never written by a client; it follows its record
 * (purge cascades, merge moves).
 */
describe("messages (MSG-03)", () => {
  let owner: { id: string }, org: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("messages-owner");
    org = await createOrg(owner.id, "עסק הודעות");
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(() => closePool());

  it("a sent job records one outbound message with the provider's id; a dead one records a failure with its error code", async () => {
    const lead = await insertLead(owner.id, org, { email: "sent@example.test", phone: "0509900001" });
    const id = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    const job = await claimOne(id);
    expect(await finish(job, true, { provider: "fake", id: "fake-1", code: "ignored-on-success" })).toBe("done");
    expect(await messageOf(id)).toMatchObject({
      lead_id: lead,
      contact_id: null,
      channel: "email",
      direction: "outbound",
      status: "sent",
      provider: "fake",
      provider_message_id: "fake-1",
      provider_error_code: null,
    });
    expect((await messageOf(id))?.sent_at).not.toBeNull();

    const dead = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(dead), false, { final: true, provider: "fake", code: " E.550:rejected " })).toBe("dead");
    expect(await messageOf(dead)).toMatchObject({ channel: "sms", status: "failed", provider: "fake", provider_error_code: "E.550:rejected", sent_at: null });
    // a malformed error code is dropped, the failure still recorded
    const badCode = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(badCode), false, { final: true, provider: "fake", code: "has space; drop table" })).toBe("dead");
    expect(await messageOf(badCode)).toMatchObject({ status: "failed", provider_error_code: null });

    // a try that failed and will be tried again records nothing yet
    const retry = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(retry), false)).toBe("failed");
    expect(await messageOf(retry)).toBeNull();
  });

  it("only an attempt that passed the send check records: no check, the last try, a lease that ran out on the last try", async () => {
    const lead = await insertLead(owner.id, org, { email: "unknown@example.test", phone: "0509911111" });
    // done without the check (a handler that skipped it): nothing
    const unchecked = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(unchecked, false), true, { provider: "fake", id: "u-1" })).toBe("done");
    expect(await messageOf(unchecked)).toBeNull();
    // final without the check (a malformed payload, no provider): nothing
    const finalUnchecked = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(finalUnchecked, false), false, { final: true })).toBe("dead");
    expect(await messageOf(finalUnchecked)).toBeNull();
    // a provider failure (not final) on the last allowed try, after the check: the repeated failure is recorded
    const outOfTries = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    await asAdmin((q) => q("update app.jobs set attempts = 4 where id = $1", [outOfTries]));
    expect(await finish(await claimOne(outOfTries), false)).toBe("dead");
    expect(await messageOf(outOfTries)).toMatchObject({ status: "failed", sent_at: null });
    // the same on the last try without the check (the attempt never reached the provider): nothing
    const lastUnchecked = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    await asAdmin((q) => q("update app.jobs set attempts = 4 where id = $1", [lastUnchecked]));
    expect(await finish(await claimOne(lastUnchecked, false), false)).toBe("dead");
    expect(await messageOf(lastUnchecked)).toBeNull();
    // an earlier failed try (not the last) records nothing yet
    const early = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(early), false)).toBe("failed");
    expect(await messageOf(early)).toBeNull();
    // a lease that ran out on the last try after passing the check: claim_jobs ends it dead, outcome unknown, nothing
    const expired = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    await asAdmin((q) => q("update app.jobs set attempts = 4 where id = $1", [expired]));
    await claimOne(expired);
    await asAdmin((q) => q("update app.jobs set locked_until = now() - interval '1 second' where id = $1", [expired]));
    await asService((q) => q("select public.claim_jobs(array['message.send'], 100)"));
    expect((await asAdmin((q) => q<{ status: string }>("select status from app.jobs where id = $1", [expired]))).rows[0].status).toBe("dead");
    expect(await messageOf(expired)).toBeNull();
    // a check passed under an earlier lease does not count for a later one
    const reclaimed = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    await claimOne(reclaimed);
    await asAdmin((q) => q("update app.jobs set locked_until = now() - interval '1 second' where id = $1", [reclaimed]));
    expect(await finish(await claimOne(reclaimed, false), true, { provider: "fake", id: "r-1" })).toBe("done");
    expect(await messageOf(reclaimed)).toBeNull();
  });

  it("a provider id is printable ASCII only; anything else is dropped, never refused", async () => {
    const lead = await insertLead(owner.id, org, { email: "ascii@example.test", phone: "0509922222" });
    for (const bad of ["has space", "tab\there", "new\nline", "שלום", "x".repeat(201)]) {
      const id = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
      expect(await finish(await claimOne(id), true, { provider: "fake", id: bad })).toBe("done");
      expect(await messageOf(id), JSON.stringify(bad)).toMatchObject({ status: "sent", provider: "fake", provider_message_id: null });
    }
    const ok = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(ok), true, { provider: "fake", id: "  <abc-1@mail.example>  " })).toBe("done");
    expect(await messageOf(ok)).toMatchObject({ provider_message_id: "<abc-1@mail.example>" });
    const direct = await pgError(
      asAdmin((q) =>
        q("insert into public.messages (organization_id, lead_id, channel, direction, status, provider, provider_message_id) values ($1, $2, 'sms', 'outbound', 'sent', 'fake', 'a b')", [org, lead]),
      ),
    );
    expect(direct.code).toBe("23514");
  });

  it("a provider answer of the wrong shape is left out, never refused (the message went out)", async () => {
    const lead = await insertLead(owner.id, org, { email: "shape@example.test", phone: "0509900002" });
    const id = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    expect(await finish(await claimOne(id), true, { provider: "Bad Name!", id: "x" })).toBe("done");
    expect(await messageOf(id)).toMatchObject({ status: "sent", provider: null, provider_message_id: null });
  });

  it("a provider id is kept once per business and provider: a repeat is recorded without it", async () => {
    const lead = await insertLead(owner.id, org, { email: "dup@example.test", phone: "0509900003" });
    const a = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    const b = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    const rows = await asService(async (q) => (await q<{ r: Array<Claimed> }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
    const [ja, jb] = [a, b].map((x) => rows.find((r) => r.id === x) as Claimed);
    await passCheck(ja);
    await passCheck(jb);
    expect(await finish(ja, true, { provider: "fake", id: "same-id" })).toBe("done");
    expect(await finish(jb, true, { provider: "fake", id: "same-id" })).toBe("done");
    expect(await messageOf(a)).toMatchObject({ provider_message_id: "same-id" });
    expect(await messageOf(b)).toMatchObject({ status: "sent", provider: "fake", provider_message_id: null });
    const dup = await pgError(
      asAdmin((q) =>
        q(
          "insert into public.messages (organization_id, lead_id, channel, direction, status, provider, provider_message_id) values ($1, $2, 'email', 'outbound', 'sent', 'fake', 'same-id')",
          [org, lead],
        ),
      ),
    );
    expect(dup.code).toBe("23505");
  });

  it("a record purged before the job ends records nothing, and the job still finishes", async () => {
    const lead = await insertLead(owner.id, org, { email: "gone@example.test", phone: "0509900004" });
    const id = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    const job = await claimOne(id);
    await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
    expect(await finish(job, true, { provider: "fake", id: "gone-1" })).toBe("done");
    expect(await messageOf(id)).toBeNull();
  });

  it("purging the record takes its messages; a merge moves the duplicate's to the kept record", { timeout: 30_000 }, async () => {
    const lead = await insertLead(owner.id, org, { email: "purge@example.test", phone: "0509900005" });
    const id = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    await finish(await claimOne(id), true, { provider: "fake", id: "purge-1" });
    await asAdmin((q) => q("delete from public.leads where id = $1", [lead]));
    expect(await messageOf(id)).toBeNull();

    const keep = await insertLead(owner.id, org, { full_name: "נשאר", email: "keep@example.test", phone: "0509900006" });
    const dupLead = await insertLead(owner.id, org, { full_name: "כפול", email: "keep2@example.test", phone: "0509900007" });
    const sent = await enqueue(org, { channel: "email", lead_id: dupLead, message_type: "collection" });
    await finish(await claimOne(sent), true, { provider: "fake", id: "merge-1" });
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [org, keep, dupLead]));
    expect(await messageOf(sent)).toMatchObject({ lead_id: keep });

    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'א', 'c1@example.test') returning id", [org])).rows[0].id,
    );
    const dupContact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'ב', 'c2@example.test') returning id", [org])).rows[0].id,
    );
    const toContact = await enqueue(org, { channel: "email", contact_id: dupContact, message_type: "collection" });
    await finish(await claimOne(toContact), true, { provider: "fake", id: "merge-2" });
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, contact, dupContact]));
    expect(await messageOf(toContact)).toMatchObject({ contact_id: contact });
  });

  it("the shape holds: one record, a known channel and status, ILS only, and no other business's record", async () => {
    const lead = await insertLead(owner.id, org, { email: "shape2@example.test", phone: "0509900008" });
    const other = await createOrg(owner.id, "עסק אחר להודעות");
    const otherLead = await insertLead(owner.id, other, { email: "other@example.test", phone: "0509900009" });
    const insert = (cols: string, values: string, params: unknown[]) =>
      pgError(asAdmin((q) => q(`insert into public.messages (organization_id, ${cols}) values ($1, ${values})`, [org, ...params])));
    expect((await insert("channel, direction, status", "'sms', 'outbound', 'sent'", [])).code).toBe("23514");
    expect((await insert("lead_id, channel, direction, status", "$2, 'fax', 'outbound', 'sent'", [lead])).code).toBe("23514");
    expect((await insert("lead_id, channel, direction, status", "$2, 'sms', 'inbound', 'sent'", [lead])).code).toBe("23514");
    // owner (75) א: the log has no content or cost columns
    const columns = await asAdmin(
      async (q) =>
        (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'messages' order by 1")).rows.map(
          (r) => r.c,
        ),
    );
    expect(columns).toEqual([
      "channel", "contact_id", "created_at", "delivered_at", "direction", "id", "job_id", "lead_id", "occurred_at", "organization_id",
      "provider", "provider_error_code", "provider_message_id", "sent_at", "status", "template_code", "updated_at",
    ]);
    expect((await insert("lead_id, channel, direction, status", "$2, 'sms', 'outbound', 'sent'", [otherLead])).code).toBe("23503");
    expect((await insert("lead_id, channel, direction, status, provider_message_id", "$2, 'sms', 'outbound', 'sent', 'x'", [lead])).code).toBe("23514");
    expect((await insert("lead_id, channel, direction, status, provider_error_code", "$2, 'sms', 'outbound', 'failed', 'bad code!'", [lead])).code).toBe("23514");
    expect((await insert("lead_id, channel, direction, status", "$2, 'sms', 'outbound', 'sent'", [randomUUID()])).code).toBe("23503");
  });

  it("the trigger that writes messages is not callable by any API role, and the old finish_job is retired", async () => {
    const rights = await asAdmin(
      async (q) =>
        (
          await q<{ role: string; t: boolean; m: boolean }>(
            `select r as role,
                    has_function_privilege(r, 'app.jobs_record_message()', 'execute') as t,
                    has_function_privilege(r, 'app.merge_messages()', 'execute') as m
               from unnest(array['anon', 'authenticated', 'service_role']) r`,
          )
        ).rows,
    );
    for (const r of rights) expect(r, r.role).toMatchObject({ t: false, m: false });
    const retired = await asAdmin(
      async (q) =>
        (
          await q<{ n: number; granted: boolean }>(
            `select count(*)::int as n,
                    bool_or(has_function_privilege('service_role', p.oid, 'execute')) as granted
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname = 'finish_job_021146_retired'`,
          )
        ).rows[0],
    );
    expect(retired).toEqual({ n: 1, granted: false });
    const publics = await asAdmin(
      async (q) => (await q<{ n: number }>("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'finish_job'")).rows[0].n,
    );
    expect(publics).toBe(1);
  });
});
