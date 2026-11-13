import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const SITE = "https://mexuz.test";
const NIL = "00000000-0000-4000-8000-000000000000";

type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

// md5 of the email composer as built for EML-01 (owner (195) א, (268) א): body, security definer, settings and arguments (test
// 284's and 352's shape). A change of a body fails here until it gets a fresh independent review against CLAUDE.md's "THE
// FUTURE SENDER" notes and 021198's header (the attachments); then update the md5.
const REVIEWED_MD5: Record<string, string> = {
  "email_job_compose(uuid,uuid,text)": "c5c2ae88f99865569bd24ddf80c2168f",
  "app.email_compose_core(uuid,uuid,text)": "b59b36659b2f8fc64b33326069ceb525",
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

    // a library item switched off, or a newer file of it
    const item = await libraryItem(owner.id, org);
    const lib = await libraryFile(org, item);
    job = await card({ library_file_ids: [lib] });
    await asAdmin((q) => q("update public.library_items set is_active = false where id = $1", [item]));
    expect(await compose(job)).toEqual({ refused: "attachment_changed" });
    await asAdmin((q) => q("update public.library_items set is_active = true where id = $1", [item]));
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
    const job = await queue();
    await asAdmin((q) => q("insert into app.qr_external_blocks (organization_id, blocked, reason) values ($1, true, 'בדיקה') on conflict (organization_id) do update set blocked = true", [org]));
    expect(await compose(job)).toEqual({ refused: "link_blocked" });
    await asAdmin((q) => q("update app.qr_external_blocks set blocked = false where organization_id = $1", [org]));
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
