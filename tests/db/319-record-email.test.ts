import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string) =>
  asAdmin((q) =>
    q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );

type Claimed = { id: string; lease: string };
type Payload = Record<string, unknown>;

const send = (user: string, org: string, kind: string, record: string, template: string, files: string[] = [], library: string[] = []) =>
  asUser(
    user,
    async (q) =>
      (await q<{ r: { job_id: string; paused: boolean } }>("select public.record_email_send($1, $2, $3, $4, $5, $6) as r", [org, kind, record, template, files, library])).rows[0]
        .r,
  );
const queue = (user: string, org: string, kind: string, record: string) =>
  asUser(user, async (q) => (await q<{ r: Array<Record<string, unknown>> }>("select public.record_email_queue($1, $2, $3) as r", [org, kind, record])).rows[0].r);
const payloadOf = (job: string) => asAdmin(async (q) => (await q<{ payload: Payload }>("select payload from app.jobs where id = $1", [job])).rows[0].payload);
const claimOne = async (id: string): Promise<Claimed> => {
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  return job as Claimed;
};
// MSG-06: these tests are not about sending hours or the rate
const maySend = async (job: Claimed) => {
  await asAdmin(async (q) => {
    await q(
      `insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days)
       select j.organization_id, '00:00', '24:00', false from app.jobs j where j.id = $1
       on conflict (organization_id) do update set window_from = excluded.window_from, window_until = excluded.window_until, skip_rest_days = false`,
      [job.id],
    );
    await q("update app.message_send_rate r set sent = 0 from app.jobs j where j.id = $1 and r.organization_id = j.organization_id", [job.id]);
    await q("update app.message_system_rate set sent = 0");
  });
  return asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
};
const template = (user: string, org: string, fields: { name: string; type?: string; channel?: string; body?: string; active?: boolean }) =>
  asUser(user, async (q) =>
    (
      await q<{ id: string }>(
        "insert into public.message_templates (organization_id, name, channel, message_type, subject, body, is_active) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [
          org,
          fields.name,
          fields.channel ?? "email",
          fields.type ?? "requested_document",
          (fields.channel ?? "email") === "email" ? "המסמך שביקשת" : null,
          fields.body ?? "שלום {שם פרטי}, מצורף המסמך. {שם הנציג}",
          fields.active ?? true,
        ],
      )
    ).rows[0].id,
  );
// a confirmed file of a record (a server row: no waiting mark)
const serverFile = (org: string, column: string, record: string, size = 1000, activity: string | null = null) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.files (organization_id, ${column}, activity_id, name, mime_type, size_bytes) values ($1, $2, $3, 'הצעה.pdf', 'application/pdf', $4) returning id`,
          [org, record, activity, size],
        )
      ).rows[0].id,
  );

// LIB-01: a library item of kind file, and a confirmed file of it (a server row)
const libraryItem = (user: string, org: string, fields: { active?: boolean; from?: string | null; until?: string | null } = {}) =>
  asUser(
    user,
    async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.library_items (organization_id, kind, title, is_active, valid_from, valid_until) values ($1, 'file', 'מצגת', $2, $3, $4) returning id",
          [org, fields.active ?? true, fields.from ?? null, fields.until ?? null],
        )
      ).rows[0].id,
  );
const libraryFile = (org: string, item: string, size = 1000) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.files (organization_id, library_item_id, name, mime_type, size_bytes) values ($1, $2, 'מצגת.pdf', 'application/pdf', $3) returning id",
          [org, item, size],
        )
      ).rows[0].id,
  );

/**
 * EML-02: an email to the customer from the record's card, from an email template, with the record's and the library's files. It is an
 * OPS-04 message.send job (ids only), judged by the queue's own send check; nothing on the worker's path changes.
 */
describe("email from the record card (EML-02)", () => {
  let owner: { id: string }, member: { id: string }, other: { id: string }, viewer: { id: string };
  let org: string, orgB: string, ownerB: { id: string };
  let service: string;

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("eml-owner");
    org = await createOrg(owner.id, "עסק אימייל");
    member = await addMember(org, owner.id, "member", "eml-member");
    other = await addMember(org, owner.id, "member", "eml-other");
    viewer = await addMember(org, owner.id, "viewer", "eml-viewer");
    ownerB = await createUser("eml-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
    service = await template(owner.id, org, { name: "מסמך מבוקש" });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await setKey(KEY);
    await closePool();
  });

  it("queues one message.send job of ids only, with the template, the files and the sender", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-1@example.test", owner_id: member.id });
    const file = await serverFile(org, "lead_id", lead);
    const answer = await send(member.id, org, "lead", lead, service, [file]);
    expect(answer.paused).toBe(false);
    expect(await payloadOf(answer.job_id)).toEqual({
      channel: "email",
      lead_id: lead,
      message_type: "requested_document",
      template_id: service,
      reply_to_user_id: member.id,
      file_ids: [file],
    });
    // the card's list: waiting, the template's name, one file; no address
    const list = await queue(member.id, org, "lead", lead);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ job_id: answer.job_id, template_name: "מסמך מבוקש", sender_id: member.id, files: 1, state: "waiting", reason: null });
    expect(JSON.stringify(list)).not.toContain("eml-1@");
    // the send check takes it like any other service message
    expect(await maySend(await claimOne(answer.job_id))).toEqual({ may_send: true });
  });

  it("a deal's email goes to the deal's contact and names the deal; a deal without a contact is refused", async () => {
    const { pipelineId, stages } = await defaultPipeline(org);
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'דנה', 'eml-deal@example.test') returning id", [org])).rows[0].id,
    );
    const deal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקת אימייל', $2, $3, $4) returning id",
          [org, pipelineId, stages[0].id, contact],
        )
      ).rows[0].id,
    );
    const dealFile = await serverFile(org, "deal_id", deal);
    const answer = await send(owner.id, org, "deal", deal, service, [dealFile]);
    expect(await payloadOf(answer.job_id)).toMatchObject({ contact_id: contact, deal_id: deal, file_ids: [dealFile] });
    expect((await queue(owner.id, org, "deal", deal))[0]).toMatchObject({ job_id: answer.job_id });
    // only emails sent from this record's own card: the deal's email is not on its contact's card
    expect(await queue(owner.id, org, "contact", contact)).toEqual([]);
    const fromContact = await send(owner.id, org, "contact", contact, service);
    expect((await queue(owner.id, org, "contact", contact)).map((r) => r.job_id)).toEqual([fromContact.job_id]);
    expect((await queue(owner.id, org, "deal", deal)).map((r) => r.job_id)).toEqual([answer.job_id]);
    // the contact's own file is not the deal's
    const contactFile = await serverFile(org, "contact_id", contact);
    expect((await pgError(send(owner.id, org, "deal", deal, service, [contactFile]))).hint).toBe("record_email:file");
    const bare = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'בלי איש קשר', $2, $3) returning id", [org, pipelineId, stages[0].id]))
        .rows[0].id,
    );
    expect((await pgError(send(owner.id, org, "deal", bare, service))).hint).toBe("record_email:no_contact");
  });

  it("rights (193) ב: whoever writes and reads the record sends; a viewer, an unread record and another business are refused", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-rights@example.test", owner_id: member.id });
    expect((await pgError(send(viewer.id, org, "lead", lead, service))).code).toBe("42501");
    // a member who reads the lead but does not own it may send (the activities_insert rule, not can_edit_record)
    expect((await send(other.id, org, "lead", lead, service)).job_id).toBeTruthy();
    // under 'own' visibility the other member no longer reads it: not found, in both halves
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect((await pgError(send(other.id, org, "lead", lead, service))).hint).toBe("record_email:not_found");
      expect(
        (await pgError(asUser(other.id, (q) => q("select app.record_email_enqueue($1, 'lead', $2, $3, '{}', '{}')", [org, lead, service])))).hint,
      ).toBe("record_email:not_found");
      expect(await queue(other.id, org, "lead", lead)).toEqual([]);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // another business: its owner sees nothing of this one (RLS answers not found; the definer half would refuse too)
    expect((await pgError(send(ownerB.id, org, "lead", lead, service))).hint).toMatch(/record_email:(not_found|not_permitted)/);
    expect((await pgError(send(ownerB.id, orgB, "lead", lead, service))).hint).toBe("record_email:not_found");
    expect(await queue(ownerB.id, org, "lead", lead)).toEqual([]);
    expect(await queue(ownerB.id, orgB, "lead", lead)).toEqual([]);
    // another business's template is not found in this one
    const theirs = await template(ownerB.id, orgB, { name: "שלהם" });
    expect((await pgError(send(member.id, org, "lead", lead, theirs))).hint).toBe("record_email:template");
    // the definer half alone judges the business, the rights and the template again
    expect(
      await pgError(asUser(ownerB.id, (q) => q("select app.record_email_enqueue($1, 'lead', $2, $3, '{}', '{}')", [org, lead, service]))),
    ).toMatchObject({ code: "42501" });
    expect((await pgError(asUser(member.id, (q) => q("select app.record_email_enqueue($1, 'lead', $2, $3, '{}', '{}')", [org, lead, theirs])))).hint).toBe(
      "record_email:template",
    );
    // a binned record
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    expect((await pgError(send(member.id, org, "lead", lead, service))).hint).toBe("record_email:not_found");
    expect((await pgError(send(member.id, org, "task", lead, service))).hint).toBe("record_email:kind");
  });

  it("the address is the record's own email: none is refused", async () => {
    const lead = await insertLead(member.id, org, { phone: "0501234567", owner_id: member.id });
    expect((await pgError(send(member.id, org, "lead", lead, service))).hint).toBe("record_email:no_address");
  });

  it("files: only confirmed files of this record, readable by the sender, at most 5 and 10 MB together", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-files@example.test", owner_id: member.id });
    const otherLead = await insertLead(member.id, org, { email: "eml-files-2@example.test", owner_id: member.id });
    expect((await pgError(send(member.id, org, "lead", lead, service, [await serverFile(org, "lead_id", otherLead)]))).hint).toBe("record_email:file");
    // another business's file
    const leadB = await insertLead(ownerB.id, orgB, { email: "b@example.test" });
    expect((await pgError(send(member.id, org, "lead", lead, service, [await serverFile(orgB, "lead_id", leadB)]))).hint).toBe("record_email:file");
    // a waiting upload is not a file yet
    const waiting = await asUser(member.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'w.pdf', 'application/pdf', 10) returning id",
          [org, lead],
        )
      ).rows[0].id,
    );
    expect((await pgError(send(member.id, org, "lead", lead, service, [waiting]))).hint).toBe("record_email:file");
    // someone else's private note: its file is not the sender's to send
    const note = await asUser(other.id, async (q) =>
      (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'פרטית', $2, true) returning id", [org, lead])).rows[0].id,
    );
    const privateFile = await serverFile(org, "lead_id", lead, 10, note);
    expect((await pgError(send(member.id, org, "lead", lead, service, [privateFile]))).hint).toBe("record_email:file");
    expect(
      (await pgError(asUser(member.id, (q) => q("select app.record_email_enqueue($1, 'lead', $2, $3, $4, '{}')", [org, lead, service, [privateFile]])))).hint,
    ).toBe("record_email:file");
    // an owner reads the private note's file and may send it
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [lead, owner.id]));
    expect((await send(owner.id, org, "lead", lead, service, [privateFile])).job_id).toBeTruthy();
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [lead, member.id]));
    // six files, and two files over 10 MB together
    const six = [];
    for (let i = 0; i < 6; i += 1) six.push(await serverFile(org, "lead_id", lead));
    expect((await pgError(send(member.id, org, "lead", lead, service, six))).hint).toBe("record_email:files_max");
    const big = [await serverFile(org, "lead_id", lead, 6_000_000), await serverFile(org, "lead_id", lead, 6_000_000)];
    expect((await pgError(send(member.id, org, "lead", lead, service, big))).hint).toBe("record_email:files_size");
    // the same file twice counts once
    const answer = await send(member.id, org, "lead", lead, service, [six[0], six[0]]);
    expect((await payloadOf(answer.job_id)).file_ids).toEqual([six[0]]);
  });

  it("templates: email only, sendable now, and of a type a card may send", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-tpl@example.test", owner_id: member.id });
    const sms = await template(owner.id, org, { name: "סמס", channel: "sms" });
    expect((await pgError(send(member.id, org, "lead", lead, sms))).hint).toBe("record_email:channel");
    const inactive = await template(owner.id, org, { name: "כבויה", active: false });
    expect(await pgError(send(member.id, org, "lead", lead, inactive))).toMatchObject({ hint: "record_email:not_sendable" });
    const linked = await template(owner.id, org, { name: "עם קישור", body: "שלום, ראו www.example.com" });
    expect(await pgError(send(member.id, org, "lead", lead, linked))).toMatchObject({ hint: "record_email:not_sendable" });
    for (const type of ["meeting_reminder", "verification_code", "punch_card_notice"]) {
      const id = await template(owner.id, org, { name: `סוג ${type}`, type, body: "שלום" });
      expect((await pgError(send(member.id, org, "lead", lead, id))).hint, type).toBe("record_email:type");
    }
    // (194) א: collection only for whoever records payments (owners, admins, managers, or the personal key)
    const collection = await template(owner.id, org, { name: "גבייה", type: "collection", body: "שלום {שם פרטי}" });
    const FEATURES = { collection: true, documents: true, payments: true };
    const setFeatures = (features: Record<string, boolean>) =>
      asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1", [org, JSON.stringify(features)]));
    await setFeatures(FEATURES);
    try {
      expect((await pgError(send(member.id, org, "lead", lead, collection))).hint).toBe("record_email:collection");
      expect((await payloadOf((await send(owner.id, org, "lead", lead, collection)).job_id)).message_type).toBe("collection");
      // lead's interim choice: the plan keys of every collection feature
      for (const key of ["collection", "documents", "payments"]) {
        await setFeatures({ ...FEATURES, [key]: false });
        expect((await pgError(send(owner.id, org, "lead", lead, collection))).hint, key).toBe(`feature:${key}`);
        await setFeatures(FEATURES);
      }
    } finally {
      await setFeatures(FEATURES);
    }
  });

  it("marketing needs the queue's consent check: refused without a grant, sent with one", async () => {
    const marketing = await template(owner.id, org, { name: "עדכון", type: "marketing", body: "שלום {שם פרטי}, {תוכן העדכון}" });
    const lead = await insertLead(member.id, org, { email: "eml-mkt@example.test", owner_id: member.id });
    const first = await send(member.id, org, "lead", lead, marketing);
    expect(await maySend(await claimOne(first.job_id))).toEqual({ may_send: false, reason: "consent_missing" });
    expect((await queue(member.id, org, "lead", lead))[0]).toMatchObject({ job_id: first.job_id, state: "not_sent", reason: "consent" });
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'email', 'granted', 'manual', 'בשיחה')", [org, lead]),
    );
    const second = await send(member.id, org, "lead", lead, marketing);
    expect(await maySend(await claimOne(second.job_id))).toEqual({ may_send: true });
  });

  it("HEB-09: while sending is paused the email is queued, said so, and waits", async () => {
    const pausedOwner = await createUser("eml-pause-owner");
    const pausedOrg = await createOrg(pausedOwner.id, "עסק עצור");
    const tpl = await template(pausedOwner.id, pausedOrg, { name: "מסמך" });
    const lead = await insertLead(pausedOwner.id, pausedOrg, { email: "eml-pause@example.test" });
    await asUser(pausedOwner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [pausedOrg]));
    const answer = await send(pausedOwner.id, pausedOrg, "lead", lead, tpl);
    expect(answer.paused).toBe(true);
    expect(await maySend(await claimOne(answer.job_id))).toEqual({ may_send: false, reason: "sending_paused", retry: true });
    expect((await queue(pausedOwner.id, pausedOrg, "lead", lead))[0]).toMatchObject({ state: "waiting" });
  });

  it("library files (197) ב: active, valid today, by the current file; counted with the record's files", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-lib@example.test", owner_id: member.id });
    const mkt = await template(owner.id, org, { name: "שיווק עם קבצים", type: "marketing", body: "שלום {שם פרטי}" });
    const item = await libraryItem(owner.id, org);
    const older = await libraryFile(org, item);
    await asAdmin((q) => q("update public.files set created_at = now() - interval '1 day' where id = $1", [older]));
    const current = await libraryFile(org, item);
    const recordFile = await serverFile(org, "lead_id", lead);
    const answer = await send(member.id, org, "lead", lead, mkt, [recordFile], [item]);
    // the item is sent by its current file, under its own key
    expect(await payloadOf(answer.job_id)).toMatchObject({ file_ids: [recordFile], library_file_ids: [current] });
    expect((await queue(member.id, org, "lead", lead))[0]).toMatchObject({ job_id: answer.job_id, files: 2 });
    // owner (198) ב: on a service template too (a manual send from the card), as a service email
    const withService = await send(member.id, org, "lead", lead, service, [], [item]);
    expect(await payloadOf(withService.job_id)).toMatchObject({ message_type: "requested_document", library_file_ids: [current] });
    // the definer half refuses an older file of the item, and an item that is not a file
    expect(
      (await pgError(asUser(member.id, (q) => q("select app.record_email_enqueue($1, 'lead', $2, $3, '{}', $4)", [org, lead, mkt, [older]])))).hint,
    ).toBe("record_email:library");
    expect(
      (await pgError(asUser(member.id, (q) => q("select app.record_email_enqueue($1, 'lead', $2, $3, '{}', $4)", [org, lead, mkt, [recordFile]])))).hint,
    ).toBe("record_email:library");
    // an inactive item, one not yet valid, one past its last day, and one with no confirmed file
    const inactive = await libraryItem(owner.id, org, { active: false });
    await libraryFile(org, inactive);
    const future = await libraryItem(owner.id, org, { from: "2999-01-01" });
    await libraryFile(org, future);
    const expired = await libraryItem(owner.id, org, { from: "2000-01-01", until: "2000-12-31" });
    await libraryFile(org, expired);
    const empty = await libraryItem(owner.id, org);
    for (const bad of [inactive, future, expired, empty]) {
      expect((await pgError(send(member.id, org, "lead", lead, mkt, [], [bad]))).hint).toBe("record_email:library");
    }
    // another business's item is not read
    const theirs = await libraryItem(ownerB.id, orgB);
    await libraryFile(orgB, theirs);
    expect((await pgError(send(member.id, org, "lead", lead, mkt, [], [theirs]))).hint).toBe("record_email:library");
    // 5 files together, and 10 MB together
    const items = [];
    for (let i = 0; i < 3; i += 1) {
      const it = await libraryItem(owner.id, org);
      await libraryFile(org, it);
      items.push(it);
    }
    const three = [await serverFile(org, "lead_id", lead), await serverFile(org, "lead_id", lead), await serverFile(org, "lead_id", lead)];
    expect((await pgError(send(member.id, org, "lead", lead, mkt, three, items))).hint).toBe("record_email:files_max");
    const bigItem = await libraryItem(owner.id, org);
    await libraryFile(org, bigItem, 6_000_000);
    expect((await pgError(send(member.id, org, "lead", lead, mkt, [await serverFile(org, "lead_id", lead, 6_000_000)], [bigItem]))).hint).toBe(
      "record_email:files_size",
    );
    expect((await send(member.id, org, "lead", lead, mkt, [], [bigItem])).job_id).toBeTruthy();
  });

  it("library files (198) ב: with a service template from the card, never while an automation runs; the audit log names the files", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-lib-svc@example.test", owner_id: member.id });
    const item = await libraryItem(owner.id, org);
    const libFile = await libraryFile(org, item);
    const recordFile = await serverFile(org, "lead_id", lead);
    const answer = await send(member.id, org, "lead", lead, service, [recordFile], [item]);
    // a service email stays a service email: its own type, judged by the service rule (no marketing consent needed)
    expect(await payloadOf(answer.job_id)).toMatchObject({ message_type: "requested_document", file_ids: [recordFile], library_file_ids: [libFile] });
    expect(await maySend(await claimOne(answer.job_id))).toEqual({ may_send: true });
    // one entry on the lead: the job, the template, and each file by id and name; no address
    const entries = await asAdmin(
      async (q) =>
        (
          await q<{ actor_id: string; entity_type: string; entity_id: string; changes: Payload }>(
            "select actor_id, entity_type, entity_id, changes from public.audit_log where organization_id = $1 and action = 'email_attachments' and changes ->> 'job_id' = $2",
            [org, answer.job_id],
          )
        ).rows,
    );
    expect(entries).toEqual([
      {
        actor_id: member.id,
        entity_type: "leads",
        entity_id: lead,
        changes: {
          job_id: answer.job_id,
          template_id: service,
          message_type: "requested_document",
          files: [{ id: recordFile, name: "הצעה.pdf" }],
          library_files: [{ id: libFile, name: "מצגת.pdf", library_item_id: item }],
        },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("eml-lib-svc@");
    // an email with no file writes no entry
    const plain = await send(member.id, org, "lead", lead, service);
    expect(
      await asAdmin(
        async (q) => (await q("select 1 from public.audit_log where action = 'email_attachments' and changes ->> 'job_id' = $1", [plain.job_id])).rowCount,
      ),
    ).toBe(0);
    // never while an automation runs (no automation sends email; a manual-button rule runs under the same setting)
    expect(
      (
        await pgError(
          asUser(member.id, async (q) => {
            await q("select set_config('app.automation_running', 'on', true)");
            return q("select public.record_email_send($1, 'lead', $2, $3, '{}', $4)", [org, lead, service, [item]]);
          }),
        )
      ).hint,
    ).toBe("record_email:library_automation");
    // a record file alone still goes under the setting (the guard is about library files)
    const underAutomation = await asUser(member.id, async (q) => {
      await q("select set_config('app.automation_running', 'on', true)");
      return (await q<{ r: { job_id: string } }>("select public.record_email_send($1, 'lead', $2, $3, $4, '{}') as r", [org, lead, service, [recordFile]])).rows[0].r;
    });
    expect(underAutomation.job_id).toBeTruthy();
    // a deal's email is recorded on its contact, with the deal's id, so the contact's erasure reaches it
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'רוני', 'eml-lib-deal@example.test') returning id", [org]))
        .rows[0].id,
    );
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקת ספרייה', $2, $3, $4) returning id",
          [org, pipelineId, stages[0].id, contact],
        )
      ).rows[0].id,
    );
    const dealAnswer = await send(owner.id, org, "deal", deal, service, [], [item]);
    const dealEntry = await asAdmin(
      async (q) =>
        (
          await q<{ entity_type: string; entity_id: string; changes: Payload }>(
            "select entity_type, entity_id, changes from public.audit_log where action = 'email_attachments' and changes ->> 'job_id' = $1",
            [dealAnswer.job_id],
          )
        ).rows[0],
    );
    expect(dealEntry).toMatchObject({ entity_type: "contacts", entity_id: contact, changes: { deal_id: deal, files: [], library_files: [{ id: libFile }] } });
  });

  it("(198) ב: a privacy erasure of the person erases the attachments' audit entry (lead, and a deal's contact)", async () => {
    // by the entity, since the erasure replaces the whole of changes (job id included)
    const entryOf = (entity: string) =>
      asAdmin(
        async (q) =>
          (await q<{ changes: Payload }>("select changes from public.audit_log where action = 'email_attachments' and entity_id = $1", [entity])).rows,
      );
    const item = await libraryItem(owner.id, org);
    await libraryFile(org, item);

    // a lead: purged, then erased
    const lead = await insertLead(owner.id, org, { email: "eml-erase-lead@example.test", full_name: "ליד למחיקה" });
    const leadFile = await serverFile(org, "lead_id", lead);
    const leadJob = (await send(owner.id, org, "lead", lead, service, [leadFile], [item])).job_id;
    expect((await entryOf(lead))[0].changes).toMatchObject({ job_id: leadJob, files: [{ id: leadFile }] });
    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [lead]);
      await q("delete from public.leads where id = $1", [lead]);
      await q("select public.audit_erase_record($1, 'leads', $2)", [org, lead]);
    });
    expect(await entryOf(lead)).toEqual([{ changes: { erased: true } }]);

    // a deal's email is on its contact: the contact purged and erased erases it, the deal stays
    const contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email) values ($1, 'נועה', 'eml-erase-deal@example.test') returning id", [org]))
        .rows[0].id,
    );
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקת מחיקה', $2, $3, $4) returning id",
          [org, pipelineId, stages[0].id, contact],
        )
      ).rows[0].id,
    );
    const dealFile = await serverFile(org, "deal_id", deal);
    const dealJob = (await send(owner.id, org, "deal", deal, service, [dealFile], [item])).job_id;
    expect((await entryOf(contact))[0].changes).toMatchObject({ job_id: dealJob, deal_id: deal, files: [{ id: dealFile }] });
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contact]);
      await q("delete from public.contacts where id = $1", [contact]);
      await q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]);
    });
    expect(await entryOf(contact)).toEqual([{ changes: { erased: true } }]);
  });

  it("at most 30 emails a person an hour", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-rate@example.test", owner_id: member.id });
    await asAdmin((q) =>
      q(
        `select app.enqueue_job($1, 'message.send', jsonb_build_object('channel', 'email', 'lead_id', $2::text, 'message_type', 'requested_document',
                'reply_to_user_id', $3::text)) from generate_series(1, 30)`,
        [org, lead, other.id],
      ),
    );
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [lead, other.id]));
    expect((await pgError(send(other.id, org, "lead", lead, service))).hint).toBe("record_email:rate");
    // another person is not counted with them
    expect((await send(owner.id, org, "lead", lead, service)).job_id).toBeTruthy();
    // the person's emails count across every business: 30 sent in another business stop them here too
    const second = await createUser("eml-rate-two");
    const orgC = await createOrg(second.id, "עסק שלישי");
    const leadC = await insertLead(second.id, orgC, { email: "eml-rate-c@example.test" });
    const tplC = await template(second.id, orgC, { name: "מסמך" });
    const lead2 = await insertLead(owner.id, org, { email: "eml-rate-2@example.test" });
    await asAdmin((q) =>
      q(
        `select app.enqueue_job($1, 'message.send', jsonb_build_object('channel', 'email', 'lead_id', $2::text, 'message_type', 'requested_document',
                'reply_to_user_id', $3::text)) from generate_series(1, 30)`,
        [orgC, leadC, second.id],
      ),
    );
    expect((await pgError(send(second.id, orgC, "lead", leadC, tplC))).hint).toBe("record_email:rate");
    // the same person in this business (added as a member) is refused here as well
    const token = await asUser(owner.id, async (q) => (await q<{ t: string }>("select public.create_invitation($1, $2, 'member') as t", [org, second.email])).rows[0].t);
    await asUser(second.id, (q) => q("select public.accept_invitation($1)", [token]));
    expect((await pgError(send(second.id, org, "lead", lead2, service))).hint).toBe("record_email:rate");
  });

  it("the card's list: [] for a viewer, a non-reader and another business; coarse reasons only, no address or code", async () => {
    const lead = await insertLead(member.id, org, { email: "eml-list@example.test", owner_id: member.id });
    const sent = await send(member.id, org, "lead", lead, service);
    expect((await queue(member.id, org, "lead", lead)).map((r) => r.job_id)).toEqual([sent.job_id]);
    expect(await queue(viewer.id, org, "lead", lead)).toEqual([]);
    expect(await queue(ownerB.id, org, "lead", lead)).toEqual([]);
    expect(await queue(ownerB.id, orgB, "lead", lead)).toEqual([]);
    expect(await queue(member.id, org, "task", lead)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await queue(other.id, org, "lead", lead)).toEqual([]);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // the reasons: a consent code is "consent", an expired pause is "paused", anything else "other"; the code never shows
    const states: Array<[string, string, string | null]> = [
      ["refused", "refused:consent_suppressed", "consent"],
      ["refused", "refused:pause_expired", "paused"],
      ["dead", "provider:boom", "other"],
      ["done", "", null],
    ];
    for (const [status, error, reason] of states) {
      await asAdmin((q) => q("update app.jobs set status = $2, last_error = nullif($3, '') where id = $1", [sent.job_id, status, error]));
      const [row] = await queue(member.id, org, "lead", lead);
      expect(row, error).toMatchObject({ state: status === "done" ? "sent" : "not_sent", reason });
      const text = JSON.stringify(row);
      expect(text).not.toContain("eml-list@");
      expect(text).not.toContain("refused:");
      expect(text).not.toContain("boom");
    }
  });

  it("HEB-08: a deputy who reads an absent person's open lead may send from it and sees the list", async () => {
    const lead = await insertLead(owner.id, org, { email: "eml-deputy@example.test", owner_id: member.id });
    const deputy = await addMember(org, owner.id, "member", "eml-deputy");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // not yet absent: the other member does not read the member's lead
      expect((await pgError(send(deputy.id, org, "lead", lead, service))).hint).toBe("record_email:not_found");
      await asUser(owner.id, (q) =>
        q(
          `insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id)
           values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date - 1, (now() at time zone 'Asia/Jerusalem')::date + 2, 'vacation', $3)`,
          [org, member.id, deputy.id],
        ),
      );
      const answer = await send(deputy.id, org, "lead", lead, service);
      expect((await queue(deputy.id, org, "lead", lead)).map((r) => r.job_id)).toEqual([answer.job_id]);
      // the definer half alone admits the deputy by the same rule
      expect(
        (await asUser(deputy.id, async (q) => (await q<{ r: { job_id: string } }>("select app.record_email_enqueue($1, 'lead', $2, $3, '{}', '{}') as r", [org, lead, service])).rows[0].r)).job_id,
      ).toBeTruthy();
    } finally {
      await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1", [org]));
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("the payload: the email-only ids are refused on another channel and when malformed", async () => {
    const ok = (payload: Payload) => asAdmin(async (q) => (await q<{ ok: boolean }>("select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify(payload)])).rows[0].ok);
    const id = "11111111-1111-4111-8111-111111111111";
    const base = { channel: "email", contact_id: id, message_type: "collection" };
    expect(await ok({ ...base, deal_id: id, file_ids: [id], reply_to_user_id: id })).toBe(true);
    expect(await ok({ ...base, channel: "sms", reply_to_user_id: id })).toBe(false);
    expect(await ok({ ...base, channel: "sms", file_ids: [id] })).toBe(false);
    expect(await ok({ ...base, file_ids: [] })).toBe(false);
    expect(await ok({ ...base, file_ids: [id, id] })).toBe(false);
    expect(await ok({ ...base, file_ids: [id, id.replace("1111-4", "2222-4"), "x"] })).toBe(false);
    expect(await ok({ ...base, file_ids: Array.from({ length: 6 }, (_, i) => id.slice(0, -1) + i) })).toBe(false);
    expect(await ok({ ...base, file_ids: id })).toBe(false);
    expect(await ok({ ...base, reply_to_user_id: "me" })).toBe(false);
    // library files: their own key, the same shape, email only, and at most 5 together with the record's files
    const ids = (n: number, d: string) => Array.from({ length: n }, (_, i) => id.slice(0, -2) + d + i);
    expect(await ok({ ...base, library_file_ids: [id] })).toBe(true);
    expect(await ok({ ...base, file_ids: ids(2, "a"), library_file_ids: ids(3, "b") })).toBe(true);
    expect(await ok({ ...base, file_ids: ids(3, "a"), library_file_ids: ids(3, "b") })).toBe(false);
    expect(await ok({ ...base, library_file_ids: [] })).toBe(false);
    expect(await ok({ ...base, library_file_ids: [id, id] })).toBe(false);
    expect(await ok({ ...base, library_file_ids: ["x"] })).toBe(false);
    expect(await ok({ ...base, channel: "sms", library_file_ids: [id] })).toBe(false);
    // CAL-12's meeting id is still taken
    expect(await ok({ ...base, message_type: "meeting_reminder", meeting_id: id })).toBe(true);
    // a deal names the deal's contact, never a lead
    expect(await ok({ channel: "email", lead_id: id, message_type: "collection", deal_id: id })).toBe(false);
  });

  it("grants: the person's call and the list are for authenticated only; the definer half only through the call", async () => {
    const rights = await asAdmin(
      async (q) =>
        (
          await q<{ role: string; send: boolean; list: boolean; enqueue: boolean }>(
            `select r as role,
                    has_function_privilege(r, 'public.record_email_send(uuid,text,uuid,uuid,uuid[],uuid[])', 'execute') as send,
                    has_function_privilege(r, 'public.record_email_queue(uuid,text,uuid)', 'execute') as list,
                    has_function_privilege(r, 'app.record_email_enqueue(uuid,text,uuid,uuid,uuid[],uuid[])', 'execute') as enqueue
               from unnest(array['anon', 'authenticated']) r order by 1`,
          )
        ).rows,
    );
    expect(rights).toEqual([
      { role: "anon", send: false, list: false, enqueue: false },
      { role: "authenticated", send: true, list: true, enqueue: true },
    ]);
  });
});
