import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

const KEY = "test-consent-key";
const setKey = (value: string | null) =>
  asAdmin((q) =>
    value === null
      ? q("update app.settings set value = '' where key = 'consent_hash_key'")
      : q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );

type Claimed = { id: string; lease: string };

const enqueue = (org: string, payload: Record<string, unknown>) =>
  asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2) as id", [org, JSON.stringify(payload)])).rows[0].id);
const claimOne = async (id: string): Promise<Claimed> => {
  const rows = await asService(async (q) => (await q<{ r: Array<Claimed> }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  return job as Claimed;
};
// MSG-06: these tests are not about sending hours or the rate; the job's business sends at any hour and its minute's
// count starts again (test 297 covers the window and the rate)
const anyHour = (job: string) =>
  asAdmin(async (q) => {
    await q(
      `insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days)
       select j.organization_id, '00:00', '24:00', false from app.jobs j where j.id = $1
       on conflict (organization_id) do update set window_from = excluded.window_from, window_until = excluded.window_until, skip_rest_days = false`,
      [job],
    );
    await q("update app.message_send_rate r set sent = 0 from app.jobs j where j.id = $1 and r.organization_id = j.organization_id", [job]);
    await q("update app.message_system_rate set sent = 0");
  });
const maySend = async (job: Claimed) => {
  await anyHour(job.id);
  return asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
};
const check = async (org: string, payload: Record<string, unknown>) => maySend(await claimOne(await enqueue(org, payload)));
const consent = (user: string, org: string, lead: string, channel: string, state: string) =>
  asUser(user, (q) =>
    q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, $3, $4, 'manual', 'בשיחה')", [
      org,
      lead,
      channel,
      state,
    ]),
  );

/**
 * CNS-07 / MSG-04, owner 3 November 2026, answer (73) א: every queued message has a type from a closed list; service is a
 * closed list of types (meeting_reminder, requested_document, collection, verification_code), everything else marketing.
 * Marketing needs a recorded grant for the channel and no opt-out; a service message goes after an ordinary opt-out and
 * stops only at the blocklist or a privacy erasure. Judged by the address, business-wide; cannot check = refused.
 */
describe("message types: marketing and service (CNS-07)", () => {
  let owner: { id: string }, org: string;
  // PKG-03 (owner (127) ב, 4 November 2026) adds punch_card_notice
  const SERVICE = ["meeting_reminder", "requested_document", "collection", "verification_code", "punch_card_notice", "instant_reply"];

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("types-owner");
    org = await createOrg(owner.id, "עסק סוגי הודעות");
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await setKey(KEY);
    await closePool();
  });

  it("a queued message must name a type from the closed list; the lists are the reviewed ones", async () => {
    const lead = await insertLead(owner.id, org, { email: "must@example.test" });
    expect((await pgError(enqueue(org, { channel: "email", lead_id: lead }))).hint).toBe("job:message_type");
    for (const bad of ["service", "promo", "MARKETING", 1]) {
      expect((await pgError(enqueue(org, { channel: "email", lead_id: lead, message_type: bad }))).hint, String(bad)).toBe("job:payload");
    }
    // the old free purpose is not a payload key
    expect((await pgError(enqueue(org, { channel: "email", lead_id: lead, message_type: "collection", purpose: "service" }))).hint).toBe("job:payload");
    const lists = await asAdmin(
      async (q) => (await q<{ all: string[]; service: string[] }>("select app.message_types() as all, app.service_message_types() as service")).rows[0],
    );
    expect(lists).toEqual({ all: [...SERVICE, "marketing"], service: SERVICE });
    for (const type of lists.all) await enqueue(org, { channel: "email", lead_id: lead, message_type: type });
  });

  it("opt-out + service = sent; opt-out + marketing = refused; marketing needs a grant of the channel", async () => {
    const lead = await insertLead(owner.id, org, { email: "optout@example.test", phone: "0507771111" });
    expect(await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).toEqual({ may_send: false, reason: "consent_missing" });
    for (const type of SERVICE) expect(await check(org, { channel: "email", lead_id: lead, message_type: type }), type).toEqual({ may_send: true });

    await consent(owner.id, org, lead, "email", "granted");
    expect(await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).toEqual({ may_send: true });
    // a grant on email does not open SMS
    expect(await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" })).toEqual({ may_send: false, reason: "consent_missing" });

    // an ordinary opt-out from marketing
    await consent(owner.id, org, lead, "email", "withdrawn");
    expect(await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).toEqual({ may_send: false, reason: "consent_suppressed" });
    for (const type of SERVICE) expect(await check(org, { channel: "email", lead_id: lead, message_type: type }), type).toEqual({ may_send: true });
  });

  it("blocklist + service = refused; erasure + service = refused (the address, across the business)", async () => {
    const listed = await insertLead(owner.id, org, { email: "listed@example.test" });
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'all', array['listed@example.test'], 'person_request')", [org]));
    for (const type of [...SERVICE, "marketing"]) {
      const answer = await check(org, { channel: "email", lead_id: listed, message_type: type });
      expect(answer, type).toEqual({ may_send: false, reason: type === "marketing" ? "consent_suppressed" : "consent_blocked" });
    }
    // an erasure at the person's request on ANOTHER record of the same address blocks this one too
    const erased = await insertLead(owner.id, org, { email: "erased@example.test" });
    const other = await insertLead(owner.id, org, { email: "erased@example.test" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'withdrawn', 'erasure')", [org, erased]));
    for (const type of SERVICE) {
      expect(await check(org, { channel: "email", lead_id: other, message_type: type }), type).toEqual({ may_send: false, reason: "consent_blocked" });
    }
    expect(await check(org, { channel: "email", lead_id: other, message_type: "marketing" })).toEqual({ may_send: false, reason: "consent_suppressed" });
  });

  it("app.consent_granted: a grant then a withdrawal; a grant an import undo cancelled; a blocklisted grant; awaiting only", async () => {
    const granted = (address: string, channel = "email") =>
      asAdmin(async (q) => (await q<{ g: boolean | null }>("select app.consent_granted($1, $2, $3) as g", [org, channel, address])).rows[0].g);
    const lead = await insertLead(owner.id, org, { email: "cg-1@example.test" });
    expect(await granted("cg-1@example.test")).toBe(false);
    await consent(owner.id, org, lead, "email", "granted");
    expect(await granted("  CG-1@example.test ")).toBe(true);
    // a grant on email opens no other channel
    expect(await granted("cg-1@example.test", "sms")).not.toBe(true);
    await consent(owner.id, org, lead, "email", "withdrawn");
    expect(await granted("cg-1@example.test")).toBe(false);

    // an import's grant that its undo cancelled counts as never written
    const job = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode, total_rows, consent_method, consent_note)
           values ($1, 'lead', 'list.csv', 'skip', 1, 'website_form', 'רשימה') returning id`,
          [org],
        )
      ).rows[0].id,
    );
    const imported = await insertLead(owner.id, org, { import_job_id: job, email: "cg-import@example.test" });
    const other = await insertLead(owner.id, org, { email: "cg-import@example.test" });
    expect(
      await asUser(owner.id, async (q) =>
        (
          await q<{ r: string[] }>("select public.import_record_consents($1, $2, $3) as r", [
            org,
            job,
            JSON.stringify([{ record_id: imported, channel: "email", state: "granted", address: "cg-import@example.test" }]),
          ])
        ).rows[0].r,
      ),
    ).toEqual(["written"]);
    expect(await granted("cg-import@example.test")).toBe(true);
    expect(await check(org, { channel: "email", lead_id: other, message_type: "marketing" })).toEqual({ may_send: true });
    await asUser(owner.id, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    await asUser(owner.id, (q) => q("select public.undo_import($1, $2)", [org, job]));
    expect(await granted("cg-import@example.test")).toBe(false);
    expect(await check(org, { channel: "email", lead_id: other, message_type: "marketing" })).toEqual({ may_send: false, reason: "consent_missing" });

    // the blocklist wins over a grant
    const listed = await insertLead(owner.id, org, { email: "cg-listed@example.test" });
    await consent(owner.id, org, listed, "email", "granted");
    expect(await granted("cg-listed@example.test")).toBe(true);
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'email', array['cg-listed@example.test'], 'person_request')", [org]));
    expect(await granted("cg-listed@example.test")).toBe(false);
    expect(await check(org, { channel: "email", lead_id: listed, message_type: "marketing" })).toEqual({ may_send: false, reason: "consent_suppressed" });

    // a tick waiting for double opt-in grants nothing
    const waiting = await insertLead(owner.id, org, { email: "cg-wait@example.test" });
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'awaiting_confirmation', 'form', 'טופס: אתר')", [
        org,
        waiting,
      ]),
    );
    expect(await granted("cg-wait@example.test")).toBe(false);
    expect(await check(org, { channel: "email", lead_id: waiting, message_type: "marketing" })).toEqual({ may_send: false, reason: "consent_missing" });
  });

  it("a job queued without a type (before 021147) is judged as marketing", async () => {
    const lead = await insertLead(owner.id, org, { email: "legacy@example.test" });
    const id = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into app.jobs (organization_id, kind, payload) values ($1, 'message.send', $2) returning id", [org, JSON.stringify({ channel: "email", lead_id: lead })]))
          .rows[0].id,
    );
    expect(await maySend(await claimOne(id))).toEqual({ may_send: false, reason: "consent_missing" });
  });

  it("without the consent key nothing is sent, marketing or service (fail closed)", async () => {
    const lead = await insertLead(owner.id, org, { email: "nokey@example.test" });
    await consent(owner.id, org, lead, "email", "granted");
    await setKey(null);
    try {
      for (const type of [...SERVICE, "marketing"]) {
        expect(await check(org, { channel: "email", lead_id: lead, message_type: type }), type).toEqual({ may_send: false, reason: "consent_unknown" });
      }
    } finally {
      await setKey(KEY);
    }
  });

  it("the type stays on the job, never on the message log; the consent helpers are callable by no API role", async () => {
    const lead = await insertLead(owner.id, org, { email: "kept@example.test" });
    const id = await enqueue(org, { channel: "email", lead_id: lead, message_type: "requested_document" });
    const job = await claimOne(id);
    expect(await maySend(job)).toEqual({ may_send: true });
    await asService((q) => q("select public.finish_job($1, $2, true, null, false, true, 'fake', 'type-1', null)", [job.id, job.lease]));
    const row = await asAdmin(async (q) => (await q<Record<string, unknown>>("select * from public.messages where job_id = $1", [id])).rows[0]);
    expect(row).toMatchObject({ status: "sent", provider_message_id: "type-1" });
    expect(Object.keys(row)).not.toContain("purpose");
    expect(Object.keys(row)).not.toContain("message_type");
    const rights = await asAdmin(
      async (q) =>
        (
          await q<{ g: boolean }>(
            `select bool_or(has_function_privilege(r, 'app.consent_granted(uuid,text,text)', 'execute')
                         or has_function_privilege(r, 'app.consent_service_blocked(uuid,text,text)', 'execute')) as g
               from unnest(array['anon', 'authenticated', 'service_role']) r`,
          )
        ).rows[0].g,
    );
    expect(rights).toBe(false);
  });
});
