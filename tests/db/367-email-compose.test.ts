import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asService, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const SITE = "https://mexuz.test";
const NIL = "00000000-0000-4000-8000-000000000000";

type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

// md5 of the email composer as built for EML-01 (owner (195) א, (268) א): body, security definer, settings and arguments (test
// 284's and 352's shape). A change of a body fails here until it gets a fresh independent review against CLAUDE.md's "THE
// FUTURE SENDER" notes and 021198's header (the attachments); then update the md5.
// Rechecked after the independent review of lane/n-eml05: the core also answers `links` (only the https URLs it put in the
// text itself: the minted links and the stored review link); nothing else changed.
// Then the delta review of 6b981972 (2): only a plain https URL (no space, quote or angle bracket) is listed in `links`.
// Then 021278 (owner's answer (8) ב, 13 November 2026): an automation's email (automation_id, no reply_to_user_id) answers to
// the record's owner (a deal's email: the deal's owner) while an active member with a plain address; only those lines added.
const REVIEWED_MD5: Record<string, string> = {
  "email_job_compose(uuid,uuid,text)": "c5c2ae88f99865569bd24ddf80c2168f",
  "app.email_compose_core(uuid,uuid,text)": "e57db159309a421faa1ca3eede225198",
  "app.email_usage_give_back(uuid)": "c952eaea4bb85cf196cf49280e8b7816",
  "email_quota_return(uuid,uuid)": "9a75bbbe4baa464daf175f376f2be501",
};

const FEATURES = {
  meeting_reminders: true,
  signatures: true,
  collection: true,
  documents: true,
  payments: true,
  punch_cards: true,
  instant_reply: true,
  review_requests: true,
};
const allow = (org: string, features: Record<string, boolean> = FEATURES) =>
  asAdmin((q) =>
    q(`update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1`, [
      org,
      JSON.stringify(features),
    ]),
  );

const template = (org: string, fields: { type: string; body: string; subject?: string; notice?: string | null; channel?: string; active?: boolean }) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.message_templates (organization_id, name, channel, message_type, subject, body, is_active, notice_kind)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [
            org,
            `t-${Math.random().toString(36).slice(2, 10)}`,
            fields.channel ?? "email",
            fields.type,
            (fields.channel ?? "email") === "email" ? (fields.subject ?? "שלום {שם פרטי}") : null,
            fields.body,
            fields.active ?? true,
            fields.notice ?? null,
          ],
        )
      ).rows[0].id,
  );

/** A message.send job queued, claimed, passed and counted by the send check (send_checked_lease, usage_counted), as the worker holds it. */
const prepared = async (org: string, payload: Answer): Promise<Claimed> => {
  const id = await asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify(payload)])).rows[0].id);
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id, usage_counted = true where id = $1", [id]));
  return job as Claimed;
};
const compose = (job: Claimed, site: string | null = SITE) =>
  asService(async (q) => (await q<{ r: Answer }>("select public.email_job_compose($1, $2, $3) as r", [job.id, job.lease, site])).rows[0].r);

const contact = (user: string, org: string, email: string | null) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, last_name, email, owner_id) values ($1, 'דנה', 'כהן', $2, $3) returning id",
          [org, email, user],
        )
      ).rows[0].id,
  );

/** A consent entry on the record's email channel (marketing needs a recorded grant, CNS-07). */
const consent = (org: string, record: { contact?: string; lead?: string }, state: "granted" | "withdrawn") =>
  asAdmin((q) =>
    q("insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method) values ($1, $2, $3, 'email', $4, 'manual', 'בשיחה')", [
      org,
      record.lead ?? null,
      record.contact ?? null,
      state,
    ]),
  );

// a confirmed file of a record (a server row: no waiting mark)
const recordFile = (org: string, column: string, record: string, size = 1000, activity: string | null = null) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.files (organization_id, ${column}, activity_id, name, mime_type, size_bytes) values ($1, $2, $3, 'הצעה.pdf', 'application/pdf', $4) returning id`,
          [org, record, activity, size],
        )
      ).rows[0].id,
  );
const libraryItem = (user: string, org: string) =>
  asUser(
    user,
    async (q) =>
      (await q<{ id: string }>("insert into public.library_items (organization_id, kind, title, is_active) values ($1, 'file', 'מצגת', true) returning id", [org])).rows[0].id,
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
const pathOf = (file: string) => asAdmin(async (q) => (await q<{ p: string }>("select storage_path as p from public.files where id = $1", [file])).rows[0].p);

describe("the email composer (EML-01, Resend)", () => {
  let owner: { id: string; email: string }, member: { id: string; email?: string }, ownerB: { id: string };
  let org: string, orgB: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("ecompose-owner");
    org = await createOrg(owner.id, "עסק הרכבה");
    member = await addMember(org, owner.id, "member", "ecompose-member");
    ownerB = await createUser("ecompose-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
    await allow(org);
    await allow(orgB);
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '03-5550000' where id = $1", [org]);
      await q("update public.profiles set full_name = 'נועה הנציגה' where id = $1", [owner.id]);
      await q("update public.profiles set full_name = 'משה החבר' where id = $1", [member.id]);
      await q(
        "insert into public.org_document_settings (organization_id, address_line, city) values ($1, 'הרצל 1', 'תל אביב') on conflict (organization_id) do update set address_line = excluded.address_line, city = excluded.city",
        [org],
      );
    });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(closePool);

  it("is for service_role only, and only once on the lease the send check passed", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "רון לוי", email: "ron@example.test", owner_id: owner.id });
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
    const denied = await asUser(owner.id, (q) => q("select public.email_job_compose($1, $2, $3)", [job.id, job.lease, SITE])).catch((e: { code?: string }) => e.code);
    expect(denied).toBe("42501");
    const core = await asService((q) => q("select app.email_compose_core($1, $2, $3)", [job.id, job.lease, SITE])).catch((e: { code?: string }) => e.code);
    expect(core).toBe("42501");
    expect(await compose({ id: job.id, lease: NIL })).toEqual({ refused: "stale" });
    await asAdmin((q) => q("update app.jobs set send_checked_lease = null where id = $1", [job.id]));
    expect(await compose(job)).toEqual({ refused: "stale" });
    const fresh = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
    await asAdmin((q) => q("update app.jobs set usage_counted = false where id = $1", [fresh.id]));
    expect(await compose(fresh)).toEqual({ refused: "stale" });
    const twice = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
    expect(await compose(twice)).toMatchObject({ to: "ron@example.test" });
    expect(await compose(twice)).toEqual({ refused: "stale" });
    // an SMS job is not the email composer's
    const sms = await template(org, { type: "requested_document", channel: "sms", body: "שלום" });
    await asAdmin((q) => q("update public.leads set phone = '052-1112222' where id = $1", [lead]));
    const smsJob = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: sms, lead_id: lead });
    expect(await compose(smsJob)).toEqual({ refused: "not_email" });
  });

  it("fills a card's service email from the record as it is now, with the reply-to and the files' paths only", async () => {
    const lead = await insertLead(member.id, org, { full_name: "רון לוי", email: "ron-old@example.test", owner_id: member.id });
    const file = await recordFile(org, "lead_id", lead);
    const item = await libraryItem(owner.id, org);
    const lib = await libraryFile(org, item);
    const t = await template(org, {
      type: "requested_document",
      subject: "המסמך עבור {שם פרטי}",
      body: "שלום {שם פרטי} {שם מלא}, כאן {שם הנציג} מ{שם העסק} {טלפון העסק}, {כתובת העסק}.",
    });
    const job = await prepared(org, {
      channel: "email",
      message_type: "requested_document",
      template_id: t,
      lead_id: lead,
      reply_to_user_id: member.id,
      file_ids: [file],
      library_file_ids: [lib],
    });
    // the address changed after queuing: the CURRENT one is used
    await asAdmin((q) => q("update public.leads set email = '  ron@example.test ' where id = $1", [lead]));
    const memberEmail = await asAdmin(async (q) => (await q<{ e: string }>("select email as e from auth.users where id = $1", [member.id])).rows[0].e);
    expect(await compose(job)).toEqual({
      to: "ron@example.test",
      from_name: "עסק הרכבה",
      subject: "המסמך עבור רון",
      text: "שלום רון רון לוי, כאן משה החבר מעסק הרכבה 03-5550000, הרצל 1, תל אביב.",
      reply_to: memberEmail,
      list_unsubscribe: null,
      // review finding 1: only what the composer put in itself is clickable; a card's service email puts none
      links: [],
      attachments: [
        { bucket: "record-files", path: await pathOf(file), name: "הצעה.pdf", type: "application/pdf" },
        { bucket: "record-files", path: await pathOf(lib), name: "מצגת.pdf", type: "application/pdf" },
      ],
    });
  });

  it("has no reply-to once the sender is no longer an active member", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "יעל", email: "yael@example.test", owner_id: owner.id });
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const leaver = await addMember(org, owner.id, "member", "ecompose-leaver");
    const job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, reply_to_user_id: leaver.id });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    expect(await compose(job)).toMatchObject({ to: "yael@example.test", reply_to: null });
  });

  it("refuses a gone record, a missing or odd address, a changed template and a field without a value", async () => {
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const gone = await insertLead(owner.id, org, { full_name: "א", email: "a1@example.test", owner_id: owner.id });
    let job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: gone });
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [gone]));
    expect(await compose(job)).toEqual({ refused: "record_gone" });

    const lead = await insertLead(owner.id, org, { full_name: "ב", email: "a2@example.test", owner_id: owner.id });
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
    await asAdmin((q) => q("update public.leads set email = null where id = $1", [lead]));
    expect(await compose(job)).toEqual({ refused: "no_address" });
    for (const odd of ["a2@example", "a2@example.test, x@y.test", "<a2@example.test>"]) {
      await asAdmin((q) => q("update public.leads set email = 'a2@example.test' where id = $1", [lead]));
      job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
      await asAdmin((q) => q("update public.leads set email = $2 where id = $1", [lead, odd]));
      expect(await compose(job), odd).toEqual({ refused: "bad_address" });
    }
    await asAdmin((q) => q("update public.leads set email = 'a2@example.test' where id = $1", [lead]));

    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
    await asAdmin((q) => q("update public.message_templates set is_active = false where id = $1", [t]));
    expect(await compose(job)).toEqual({ refused: "inactive" });
    await asAdmin((q) => q("update public.message_templates set is_active = true where id = $1", [t]));

    const quote = await template(org, { type: "requested_document", body: "ההצעה: {קישור להצעה}" });
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: quote, lead_id: lead });
    expect(await compose(job)).toEqual({ refused: "unfilled_field" });
    // a field without a value in the subject refuses too
    const subject = await template(org, { type: "requested_document", subject: "ההצעה {קישור להצעה}", body: "שלום" });
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: subject, lead_id: lead });
    expect(await compose(job)).toEqual({ refused: "unfilled_field" });
  });

  it("judges every file again on the send day", async () => {
    const lead = await insertLead(member.id, org, { full_name: "ג", email: "files@example.test", owner_id: member.id });
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const card = (extra: Answer) => prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, reply_to_user_id: member.id, ...extra });

    // a record file that waits for its confirmation again
    let file = await recordFile(org, "lead_id", lead);
    let job = await card({ file_ids: [file] });
    await asAdmin((q) => q("update public.files set unconfirmed_since = now() where id = $1", [file]));
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });

    // a file of a note that became private, the sender neither its author nor an admin
    const note = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.activities (organization_id, lead_id, type, body, created_by) values ($1, $2, 'note', 'הערה', $3) returning id", [org, lead, owner.id]))
          .rows[0].id,
    );
    file = await recordFile(org, "lead_id", lead, 1000, note);
    job = await card({ file_ids: [file] });
    await asAdmin((q) => q("update public.activities set is_private = true where id = $1", [note]));
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });
    // the same file sent by an admin goes
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, reply_to_user_id: owner.id, file_ids: [file] });
    expect(((await compose(job)).attachments as unknown[]).length).toBe(1);

    // a file of another record
    const otherLead = await insertLead(member.id, org, { full_name: "ד", email: "d@example.test", owner_id: member.id });
    file = await recordFile(org, "lead_id", otherLead);
    job = await card({ file_ids: [file] });
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });

    // a library item switched off, expired, or replaced by a newer file
    const item = await libraryItem(owner.id, org);
    const lib = await libraryFile(org, item);
    job = await card({ library_file_ids: [lib] });
    await asAdmin((q) => q("update public.library_items set is_active = false where id = $1", [item]));
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });
    await asAdmin((q) => q("update public.library_items set is_active = true where id = $1", [item]));
    job = await card({ library_file_ids: [lib] });
    await asAdmin((q) => q("update public.library_items set valid_until = current_date - 2 where id = $1", [item]));
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });
    await asAdmin((q) => q("update public.library_items set valid_until = null, valid_from = current_date + 5 where id = $1", [item]));
    job = await card({ library_file_ids: [lib] });
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });
    await asAdmin((q) => q("update public.library_items set valid_from = null where id = $1", [item]));
    job = await card({ library_file_ids: [lib] });
    expect(((await compose(job)).attachments as unknown[]).length).toBe(1);
    job = await card({ library_file_ids: [lib] });
    await libraryFile(org, item);
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });

    // files on an email no person sent from the card
    file = await recordFile(org, "lead_id", lead);
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, file_ids: [file] });
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });

    // over the size of one email together
    const big = await recordFile(org, "lead_id", lead, 11 * 1024 * 1024);
    job = await card({ file_ids: [big] });
    expect(await compose(job)).toEqual({ refused: "attachments_too_large" });
  });

  it("wraps a marketing email in the envelope with its own unsubscribe link and one-click address", async () => {
    const c = await contact(owner.id, org, "dana@example.test");
    const t = await template(org, { type: "marketing", subject: "חדש אצלנו, {שם פרטי}", body: "שלום {שם פרטי}, יש חדש." });
    let job = await prepared(org, { channel: "email", message_type: "marketing", template_id: t, contact_id: c });
    expect(await compose(job)).toEqual({ refused: "consent_missing" });
    await consent(org, { contact: c }, "granted");
    job = await prepared(org, { channel: "email", message_type: "marketing", template_id: t, contact_id: c });
    expect(await compose(job, null)).toEqual({ refused: "site_url" });
    job = await prepared(org, { channel: "email", message_type: "marketing", template_id: t, contact_id: c });
    const answer = await compose(job);
    expect(answer.subject).toBe("פרסומת: חדש אצלנו, דנה");
    const text = String(answer.text);
    expect(text).toMatch(/^שלום דנה, יש חדש\.\n\nעסק הרכבה · 03-5550000 · הרצל 1, תל אביב\nלהסרה מרשימת התפוצה: https:\/\/mexuz\.test\/f\/unsub\/[A-Za-z0-9_-]{64}$/);
    const token = text.slice(-64);
    expect(answer.list_unsubscribe).toBe(`${SITE}/api/forms/unsub/${token}`);
    expect(answer.links).toEqual([`${SITE}/f/unsub/${token}`]);
    const kept = await asAdmin(
      async (q) =>
        (await q<{ n: number }>("select count(*)::int as n from app.consent_preference_tokens where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') and organization_id = $2", [token, org]))
          .rows[0].n,
    );
    expect(kept).toBe(1);
    // withdrawn after the send check: judged again on the address
    job = await prepared(org, { channel: "email", message_type: "marketing", template_id: t, contact_id: c });
    await consent(org, { contact: c }, "withdrawn");
    expect(await compose(job)).toEqual({ refused: "consent_suppressed" });
  });

  it("judges a service email's blocklist again, and cannot check without the hash key", async () => {
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const c = await contact(owner.id, org, "blocked@example.test");
    let job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: c });
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'email', $2, 'complaint')", [org, ["blocked@example.test"]]));
    expect(await compose(job)).toEqual({ refused: "consent_blocked" });
    const d = await contact(owner.id, org, "nokey@example.test");
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: d });
    await asAdmin((q) => q("delete from app.settings where key = 'consent_hash_key'"));
    try {
      expect(await compose(job)).toEqual({ refused: "consent_unknown" });
    } finally {
      await asAdmin((q) => q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]));
    }
  });

  it("owner (8) ב: an automation's email answers to the record's owner (a deal's email: the deal's owner), else none", async () => {
    const RULE = "77777777-7777-4777-8777-777777777777";
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const emailOf = (user: string) => asAdmin(async (q) => (await q<{ e: string }>("select email as e from auth.users where id = $1", [user])).rows[0].e);
    const memberEmail = await emailOf(member.id);
    const ownerEmail = await emailOf(owner.id);

    // a lead's owner
    const lead = await insertLead(member.id, org, { full_name: "שיר", email: "shir@example.test", owner_id: member.id });
    let job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, automation_id: RULE });
    expect(await compose(job)).toMatchObject({ to: "shir@example.test", reply_to: memberEmail });
    // a button run (pressed_by_user_id) is still the rule's email: the record's owner, not the presser
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, automation_id: RULE, pressed_by_user_id: owner.id });
    expect(await compose(job)).toMatchObject({ reply_to: memberEmail });

    // a contact's owner
    const c = await contact(member.id, org, "rule-contact@example.test");
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: c, automation_id: RULE });
    expect(await compose(job)).toMatchObject({ reply_to: memberEmail });

    // a deal's email: the deal's owner, not the contact's
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'ע', $2, $3, $4, $5) returning id", [org, pipelineId, stages[0].id, c, owner.id]))
          .rows[0].id,
    );
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: c, deal_id: deal, automation_id: RULE });
    expect(await compose(job)).toMatchObject({ to: "rule-contact@example.test", reply_to: ownerEmail });

    // no owner, or an owner who is no longer an active member: no reply-to
    const unowned = await insertLead(owner.id, org, { full_name: "אין", email: "none@example.test" });
    await asAdmin((q) => q("update public.leads set owner_id = null where id = $1", [unowned]));
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: unowned, automation_id: RULE });
    expect(await compose(job)).toMatchObject({ to: "none@example.test", reply_to: null });
    const leaver = await addMember(org, owner.id, "member", "ecompose-rule-leaver");
    const left = await insertLead(owner.id, org, { full_name: "עזב", email: "left@example.test", owner_id: leaver.id });
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: left, automation_id: RULE });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, leaver.id]));
    expect(await compose(job)).toMatchObject({ to: "left@example.test", reply_to: null });

    // a card send keeps the sending person's address, whoever owns the record
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, reply_to_user_id: owner.id });
    expect(await compose(job)).toMatchObject({ reply_to: ownerEmail });
    // a job with neither (a system message) has none
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
    expect(await compose(job)).toMatchObject({ reply_to: null });
  });

  it("refuses a card's email from a system template, a collection email without the keys, and a deal whose contact changed", async () => {
    const c = await contact(owner.id, org, "card@example.test");
    const notice = await template(org, { type: "requested_document", notice: "signature_reminder", body: "שלום {שם פרטי}" });
    let job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: notice, contact_id: c, reply_to_user_id: owner.id });
    expect(await compose(job)).toEqual({ refused: "template_changed" });

    const collection = await template(org, { type: "collection", body: "שלום {שם פרטי}, נשמח להסדרת החוב." });
    await allow(org, { ...FEATURES, payments: false });
    try {
      job = await prepared(org, { channel: "email", message_type: "collection", template_id: collection, contact_id: c, reply_to_user_id: owner.id });
      expect(await compose(job)).toEqual({ refused: "feature_off" });
    } finally {
      await allow(org);
    }
    job = await prepared(org, { channel: "email", message_type: "collection", template_id: collection, contact_id: c, reply_to_user_id: owner.id });
    expect(await compose(job)).toMatchObject({ to: "card@example.test" });

    const c2 = await contact(owner.id, org, "card2@example.test");
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'ע', $2, $3, $4, $5) returning id", [org, pipelineId, stages[0].id, c, owner.id]))
          .rows[0].id,
    );
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const file = await recordFile(org, "deal_id", deal);
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: c, deal_id: deal, reply_to_user_id: owner.id, file_ids: [file] });
    expect(((await compose(job)).attachments as unknown[]).length).toBe(1);
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: c, deal_id: deal, reply_to_user_id: owner.id });
    await asAdmin((q) => q("update public.deals set contact_id = $2 where id = $1", [deal, c2]));
    expect(await compose(job)).toEqual({ refused: "customer_changed" });
  });

  it("a meeting reminder: the meeting as queued, its personal link minted last", async () => {
    const c = await contact(owner.id, org, "meet@example.test");
    const starts = await asAdmin(async (q) => (await q<{ t: string }>("select (date_trunc('hour', now()) + interval '26 hours')::text as t")).rows[0].t);
    const meeting = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.meetings (organization_id, title, starts_at, ends_at, owner_id, contact_id, location, created_by) values ($1, 'פגישה', $2, $2::timestamptz + interval '1 hour', $3, $4, 'המשרד', $3) returning id",
            [org, starts, owner.id, c],
          )
        ).rows[0].id,
    );
    await asAdmin((q) =>
      q(
        `insert into public.org_message_settings (organization_id, meeting_remind_day) values ($1, true)
         on conflict (organization_id) do update set meeting_remind_day = true`,
        [org],
      ),
    );
    const t = await template(org, { type: "meeting_reminder", notice: "meeting_day", subject: "תזכורת לפגישה", body: "תזכורת: {תאריך} ב-{שעה}{, ב-{מיקום}}. לשינוי: {קישור}" });
    const queue = async () => {
      const job = await prepared(org, { channel: "email", message_type: "meeting_reminder", template_id: t, contact_id: c, meeting_id: meeting, event_at: new Date(starts).toISOString() });
      await asAdmin((q) =>
        q(
          `insert into app.meeting_customer_messages (organization_id, meeting_id, kind, starts_at, outcome, job_id) values ($1, $2, 'day', $3, 'queued', $4)
           on conflict do nothing`,
          [org, meeting, starts, job.id],
        ),
      );
      return job;
    };
    let job = await queue();
    const answer = await compose(job);
    expect(String(answer.text)).toMatch(/^תזכורת: יום .+, \d+ ב.+ ב-\d\d:\d\d, ב-המשרד\. לשינוי: https:\/\/mexuz\.test\/f\/book\/manage\/[0-9a-f]{64}$/);
    expect(answer.list_unsubscribe).toBeNull();
    expect(answer.links).toEqual([String(answer.text).slice(String(answer.text).indexOf("https://"))]);
    await asAdmin((q) => q("delete from app.meeting_customer_messages where meeting_id = $1", [meeting]));
    job = await queue();
    await asAdmin((q) => q("update public.meetings set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1", [meeting]));
    expect(await compose(job)).toEqual({ refused: "meeting_changed" });
  });

  it("an instant reply: only while the record's email is still the typed one", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "מיכל", email: "michal@example.test", owner_id: owner.id });
    const form = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.forms (organization_id, name, instant_reply) values ($1, 'טופס', true) returning id", [org])).rows[0].id);
    const submission = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.form_submissions (organization_id, form_id, status, lead_id, payload) values ($1, $2, 'accepted', $3, $4) returning id", [org, form, lead, { email: "Michal@Example.test" }]))
          .rows[0].id,
    );
    const t = await template(org, { type: "instant_reply", notice: "instant_reply_open", subject: "קיבלנו", body: "{שם פרטי}, נחזור עד {שעה}. {שם העסק}" });
    const queue = async () => {
      const job = await prepared(org, { channel: "email", message_type: "instant_reply", template_id: t, lead_id: lead, form_submission_id: submission, event_at: "2030-01-01T10:30:00Z" });
      await asAdmin((q) =>
        q(
          `insert into app.instant_replies (submission_id, organization_id, form_id, outcome, job_id) values ($1, $2, $3, 'queued', $4)
           on conflict (submission_id) do update set job_id = excluded.job_id`,
          [submission, org, form, job.id],
        ),
      );
      return job;
    };
    expect((await compose(await queue())).text).toBe("מיכל, נחזור עד 12:30. עסק הרכבה");
    const job = await queue();
    await asAdmin((q) => q("update public.leads set email = 'other@example.test' where id = $1", [lead]));
    expect(await compose(job)).toEqual({ refused: "address_changed" });
  });

  it("a review request: the stored link only, the envelope, never while the outside-link switch holds the business", async () => {
    const c = await contact(owner.id, org, "review@example.test");
    await consent(org, { contact: c }, "granted");
    await asAdmin((q) =>
      q(
        `insert into public.review_request_settings (organization_id, enabled, review_url) values ($1, true, 'https://g.page/r/abc/review')
         on conflict (organization_id) do update set enabled = true, review_url = excluded.review_url`,
        [org],
      ),
    );
    const t = await template(org, { type: "review_request", notice: "review_request", subject: "נשמח לביקורת", body: "{שם פרטי}, נשמח לביקורת: {קישור לביקורת}" });
    const queue = async () => {
      const request = await asAdmin(
        async (q) =>
          (await q<{ id: string }>("insert into app.review_requests (organization_id, source_kind, source_id, contact_id, outcome, channel) values ($1, 'deal', gen_random_uuid(), $2, 'pending', 'email') returning id", [org, c]))
            .rows[0].id,
      );
      const job = await prepared(org, { channel: "email", message_type: "review_request", template_id: t, contact_id: c, review_request_id: request });
      await asAdmin((q) => q("update app.review_requests set job_id = $2, outcome = 'queued' where id = $1", [request, job.id]));
      return job;
    };
    const answer = await compose(await queue());
    expect(answer.subject).toBe("פרסומת: נשמח לביקורת");
    expect(String(answer.text).startsWith("דנה, נשמח לביקורת: https://g.page/r/abc/review")).toBe(true);
    expect(String(answer.list_unsubscribe)).toMatch(/\/api\/forms\/unsub\/[A-Za-z0-9_-]{64}$/);
    expect((answer.links as string[]).sort()).toEqual(["https://g.page/r/abc/review", String(answer.text).slice(-(SITE.length + "/f/unsub/".length + 64))].sort());
    // delta review (2): a stored link with a quote goes out as text, outside `links`, and the answer stays whole
    await asAdmin((q) => q("update public.review_request_settings set review_url = $2 where organization_id = $1", [org, "https://g.page/r/a'b/review"]));
    const quoted = await compose(await queue());
    expect(String(quoted.text)).toContain("https://g.page/r/a'b/review");
    expect((quoted.links as string[]).some((u) => u.includes("g.page"))).toBe(false);
    expect((quoted.links as string[]).length).toBe(1);
    await asAdmin((q) => q("update public.review_request_settings set review_url = 'https://g.page/r/abc/review' where organization_id = $1", [org]));
    const job = await queue();
    await asAdmin((q) => q("insert into app.qr_external_blocks (organization_id, blocked, reason) values ($1, true, 'בדיקה') on conflict (organization_id) do update set blocked = true", [org]));
    expect(await compose(job)).toEqual({ refused: "link_blocked" });
    await asAdmin((q) => q("update app.qr_external_blocks set blocked = false where organization_id = $1", [org]));
  });

  it("a signature reminder (SGN-03): the document as sent, its link minted last", async () => {
    const c = await contact(owner.id, org, "sign@example.test");
    const doc = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.signature_documents (organization_id, contact_id, title, body, content_sha256, status, sent_at, expires_at)
             values ($1, $2, 'הסכם שירות', 'טקסט', repeat('0', 64), 'sent', now(), now() + interval '3 days') returning id`,
            [org, c],
          )
        ).rows[0].id,
    );
    const t = await template(org, { type: "requested_document", notice: "signature_reminder", subject: "תזכורת: {שם המסמך}", body: "{שם פרטי}, המסמך {שם המסמך} מחכה עד {תאריך}: {קישור}" });
    const queue = async () => {
      const job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: c, signature_document_id: doc });
      await asAdmin((q) =>
        q(
          `insert into app.signature_customer_reminders (organization_id, document_id, outcome, job_id) values ($1, $2, 'queued', $3)
           on conflict (document_id) do update set job_id = excluded.job_id, outcome = 'queued'`,
          [org, doc, job.id],
        ),
      );
      return job;
    };
    const answer = await compose(await queue());
    expect(answer.subject).toBe("תזכורת: הסכם שירות");
    expect(String(answer.text)).toMatch(/^דנה, המסמך הסכם שירות מחכה עד \d+ ב.+ \d{4}: https:\/\/mexuz\.test\/f\/sign\/[A-Za-z0-9_-]{64}$/);
    expect(answer.links).toEqual([String(answer.text).slice(String(answer.text).indexOf("https://"))]);
    // cancelled after queuing: nothing is minted
    const job = await queue();
    await asAdmin((q) => q("update public.signature_documents set status = 'cancelled', cancelled_at = now() where id = $1", [doc]));
    expect(await compose(job)).toEqual({ refused: "document_changed" });
  });

  it("a collection reminder (COL-07): the stage's refusal rule, and the balance at send time", async () => {
    const c = await contact(owner.id, org, "pay@example.test");
    await asAdmin((q) =>
      q(`update public.org_document_settings set collection_customer_reminder = true, collection_customer_stages = '{0,7,14}' where organization_id = $1`, [org]),
    );
    const doc = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, 'tax_invoice', '2001', current_date - 10, 123450, current_date) returning id",
            [org, c],
          )
        ).rows[0].id,
    );
    const t = await template(org, { type: "collection", notice: "collection_reminder", subject: "תזכורת לתשלום", body: "{שם פרטי}, {מסמך} על {סכום}, עד {מועד תשלום}." });
    const queue = async (offset: number) => {
      const job = await prepared(org, { channel: "email", message_type: "collection", template_id: t, contact_id: c, collection_document_id: doc });
      await asAdmin((q) =>
        q(
          `insert into app.collection_reminders_sent (organization_id, document_id, due_date, offset_days, customer_job_id) values ($1, $2, current_date, $3, $4)
           on conflict do nothing`,
          [org, doc, offset, job.id],
        ),
      );
      return job;
    };
    const answer = await compose(await queue(0));
    expect(String(answer.text)).toMatch(/^דנה, חשבונית מס 2001 על 1,234\.50 ₪, עד \d+ ב.+ \d{4}\.$/);
    expect(answer.links).toEqual([]);
    expect(await compose(await queue(-3))).toEqual({ refused: "stage_off" });
  });

  it("a punch card notice (PKG-03): the card still active and the contact's, the business's switch on", async () => {
    const c = await contact(owner.id, org, "card-notice@example.test");
    const product = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, 'כרטיסייה') returning id", [org])).rows[0].id);
    const card = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, status, activated_at, expires_on) values ($1, $2, $3, 'עשר כניסות', 10, 'active', now(), '2027-03-01') returning id",
            [org, c, product],
          )
        ).rows[0].id,
    );
    const t = await template(org, { type: "punch_card_notice", notice: "punch_card_low", subject: "הכרטיסייה שלך", body: "{שם פרטי}, ב{שם הכרטיסייה} {כניסות}, עד {תאריך}." });
    await asAdmin((q) => q("update public.punch_card_alert_settings set customer_messages = false where organization_id = $1", [org]));
    let job = await prepared(org, { channel: "email", message_type: "punch_card_notice", template_id: t, contact_id: c, punch_card_id: card });
    expect(await compose(job)).toEqual({ refused: "messages_off" });
    await asAdmin((q) =>
      q(
        `insert into public.punch_card_alert_settings (organization_id, customer_messages) values ($1, true)
         on conflict (organization_id) do update set customer_messages = true`,
        [org],
      ),
    );
    job = await prepared(org, { channel: "email", message_type: "punch_card_notice", template_id: t, contact_id: c, punch_card_id: card });
    expect((await compose(job)).text).toBe("דנה, בעשר כניסות נשארו 10 כניסות, עד 1 במרץ 2027.");
    job = await prepared(org, { channel: "email", message_type: "punch_card_notice", template_id: t, contact_id: c, punch_card_id: card });
    await asAdmin((q) => q("update public.punch_cards set status = 'cancelled', cancelled_at = now(), cancel_reason = 'בדיקה' where id = $1", [card]));
    expect(await compose(job)).toEqual({ refused: "card_changed" });
  });

  it("never reaches across businesses", async () => {
    const other = await contact(ownerB.id, orgB, "b@example.test");
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    let job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, contact_id: other });
    expect(await compose(job)).toEqual({ refused: "record_gone" });
    const own = await contact(ownerB.id, orgB, "b2@example.test");
    job = await prepared(orgB, { channel: "email", message_type: "requested_document", template_id: t, contact_id: own });
    expect(await compose(job)).toEqual({ refused: "not_found" });
    // another business's file on a card email
    const tB = await template(orgB, { type: "requested_document", body: "שלום {שם פרטי}" });
    const ourLead = await insertLead(owner.id, org, { full_name: "ה", email: "h@example.test", owner_id: owner.id });
    const theirFile = await recordFile(org, "lead_id", ourLead);
    job = await prepared(orgB, { channel: "email", message_type: "requested_document", template_id: tB, contact_id: own, reply_to_user_id: ownerB.id, file_ids: [theirFile] });
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });
  });

  it("gives the email count back for a refused message and for one that never reached Resend, once, never for another holder's lease", async () => {
    const t = await template(org, { type: "requested_document", body: "ההצעה: {קישור להצעה}" });
    const ok = await template(org, { type: "requested_document", body: "שלום" });
    const lead = await insertLead(owner.id, org, { full_name: "ז", email: "count@example.test", owner_id: owner.id });
    const today = async () =>
      asAdmin(async (q) => (await q<{ d: string }>("select ((now() at time zone app.intake_zone(o.timezone))::date)::text as d from public.organizations o where o.id = $1", [org])).rows[0].d);
    const service = async () =>
      asAdmin(
        async (q) =>
          (await q<{ s: number }>("select coalesce((select u.service from app.message_usage_days u where u.organization_id = $1 and u.channel = 'email' and u.day = $2::date), -1) as s", [org, await today()]))
            .rows[0].s,
      );
    const counted = async (template: string) => {
      const job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: template, lead_id: lead });
      await asAdmin(async (q) =>
        q(
          `insert into app.message_usage_days (organization_id, channel, day, marketing, service) values ($1, 'email', $2::date, 0, 5)
           on conflict (organization_id, channel, day) do update set service = 5`,
          [org, await today()],
        ),
      );
      return job;
    };
    let job = await counted(t);
    expect(await compose({ id: job.id, lease: NIL })).toEqual({ refused: "stale" });
    expect(await service()).toBe(5);
    expect(await compose(job)).toEqual({ refused: "unfilled_field" });
    expect(await service()).toBe(4);
    expect(await asAdmin(async (q) => (await q<{ c: boolean }>("select usage_counted as c from app.jobs where id = $1", [job.id])).rows[0].c)).toBe(false);

    // the adapter's path: lease-bound, once, after the composer stamped the day
    job = await counted(ok);
    expect(await compose(job)).toMatchObject({ to: "count@example.test" });
    const back = (j: Claimed) => asService(async (q) => (await q<{ r: Answer }>("select public.email_quota_return($1, $2) as r", [j.id, j.lease])).rows[0].r);
    expect(await back({ id: job.id, lease: NIL })).toEqual({ refused: "stale" });
    expect(await back(job)).toEqual({ returned: true });
    expect(await back(job)).toEqual({ returned: false });
    expect(await service()).toBe(4);
    const denied = await asUser(owner.id, (q) => q("select public.email_quota_return($1, $2)", [job.id, job.lease])).catch((e: { code?: string }) => e.code);
    expect(denied).toBe("42501");
    // never for an SMS job
    await asAdmin((q) => q("update public.leads set phone = '052-1113333' where id = $1", [lead]));
    const sms = await template(org, { type: "requested_document", channel: "sms", body: "שלום" });
    const smsJob = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: sms, lead_id: lead });
    expect(await back(smsJob)).toEqual({ refused: "stale" });
  });

  it("owner (7) ב: the platform's dashboard counts the emails a refused key stopped, for platform owner and support only", async () => {
    const support = await createUser("ecompose-platform-support");
    const finance = await createUser("ecompose-platform-finance");
    const staff = (id: string, role: string) =>
      asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [id, role]));
    await staff(support.id, "support");
    await staff(finance.id, "finance");
    try {
      const health = (user: string) => asMfaUser(user, async (q) => (await q<{ h: Answer }>("select public.platform_email_health() as h")).rows[0].h);
      const before = Number((await health(support.id)).key_refused_24h);
      const lead = await insertLead(owner.id, org, { full_name: "מפתח", email: "key@example.test", owner_id: owner.id });
      const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
      const finish = (job: Claimed, code: string) =>
        asService((q) => q("select public.finish_job($1, $2, false, 'resend ' || $3, true, true, 'resend', null, $3)", [job.id, job.lease, code]));
      await finish(await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead }), "key_refused");
      await finish(await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead }), "key_refused");
      // another failure, and a stop older than 24 hours, are not counted
      await finish(await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead }), "http_422");
      const old = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead });
      await finish(old, "key_refused");
      await asAdmin((q) => q("update app.jobs set finished_at = now() - interval '25 hours' where id = $1", [old.id]));
      const answer = await health(support.id);
      expect(Object.keys(answer).sort()).toEqual(["key_refused_24h", "last_key_refused_at"]);
      expect(Number(answer.key_refused_24h)).toBe(before + 2);
      expect(answer.last_key_refused_at).not.toBeNull();
      // other platform roles, a session without the second factor and a business member are refused
      expect((await pgError(asMfaUser(finance.id, (q) => q("select public.platform_email_health()")))).code).toBe("42501");
      expect((await pgError(asUser(support.id, (q) => q("select public.platform_email_health()")))).code).toBe("42501");
      expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_email_health()")))).code).toBe("42501");
      const acl = await asAdmin(async (q) => (await q<{ a: string }>("select array_to_string(proacl, ',') as a from pg_proc where oid = 'public.platform_email_health()'::regprocedure")).rows[0].a);
      expect(acl).not.toMatch(/(^|,)anon=/);
      expect(acl).not.toMatch(/(^|,)=X/);
    } finally {
      await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [[support.id, finance.id]]));
    }
  });

  it("is pinned as reviewed, service_role only", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string; acl: string | null }>(
            `select p.oid::regprocedure::text as name,
                    md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_function_identity_arguments(p.oid)) as md5,
                    array_to_string(p.proacl, ',') as acl
               from pg_proc p
              where p.oid in ('public.email_job_compose(uuid, uuid, text)'::regprocedure, 'app.email_compose_core(uuid, uuid, text)'::regprocedure,
                              'app.email_usage_give_back(uuid)'::regprocedure, 'public.email_quota_return(uuid, uuid)'::regprocedure)`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
    for (const r of rows) expect(r.acl ?? "", r.name).not.toMatch(/(^|,)(anon|authenticated)=/);
    for (const name of ["email_job_compose(uuid,uuid,text)", "email_quota_return(uuid,uuid)"]) {
      expect(rows.find((r) => r.name === name)?.acl, name).toMatch(/service_role=X/);
    }
    for (const name of ["app.email_compose_core(uuid,uuid,text)", "app.email_usage_give_back(uuid)"]) {
      expect(rows.find((r) => r.name === name)?.acl ?? "", name).not.toMatch(/service_role=/);
    }
  });
});
