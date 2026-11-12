import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const SITE = "https://mexuz.test";

type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

// md5 of the composer as reviewed: body, security definer, settings and arguments (test 284's shape). A change of its body
// fails here until it gets a fresh independent review against CLAUDE.md's "THE FUTURE SENDER" notes; then update the md5.
// Rechecked 12 November 2026 after the independent review of lane/e-inforu: the record taken FOR KEY SHARE, its typed phone
// = the phone_e164 returned, the type's consent rule judged again (items 1), unfilled fields judged on the template so a
// customer's value is never read as a field (7), the rep named only as a member of the business (8), the punch card's
// customer-messages switch (9).
// Then owner (326) ב: the checks moved unchanged into app.sms_compose_core; public.sms_job_compose is the wrapper that gives
// the SMS count back on any refusal but 'stale' (app.sms_usage_give_back), and public.sms_quota_return does it for the adapter;
// owner (323) ב's code text. Pinned together.
// Then the delta review of 47291672: the core answers stale unless the job was counted and records its lease (4), stamps the
// counted day the give-back returns to, nothing when unknown (2), and names the rep only as an ACTIVE member (6); the wrapper
// and public.sms_quota_return are unchanged.
// Then the final review of 902dcbfa (3): the core takes the job row FOR UPDATE (it writes composed_lease and sms_counted_on);
// nothing else changed.
const REVIEWED_MD5: Record<string, string> = {
  "sms_job_compose(uuid,uuid,text)": "1788e9cddb254947e6079bdb0dca46f4",
  "app.sms_compose_core(uuid,uuid,text)": "f5a80b0d92abd021c1b127f73b651bc2",
  "app.sms_usage_give_back(uuid)": "f97f0d2ef0eadfbabd93f157793df96e",
  "sms_quota_return(uuid,uuid)": "166b0640aa22b85767118041be671199",
};

const FEATURES = {
  sms: true,
  meeting_reminders: true,
  signatures: true,
  collection: true,
  documents: true,
  payments: true,
  punch_cards: true,
  instant_reply: true,
  review_requests: true,
};
const allow = (org: string) =>
  asAdmin((q) =>
    q(
      `update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb,
              limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{"max_sms_per_month": 100000}'::jsonb
        where organization_id = $1`,
      [org, JSON.stringify(FEATURES)],
    ),
  );

const template = (org: string, fields: { type: string; body: string; notice?: string | null; channel?: string; active?: boolean }) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.message_templates (organization_id, name, channel, message_type, subject, body, is_active, notice_kind)
           values ($1, $2, $3, $4, null, $5, $6, $7) returning id`,
          [org, `t-${Math.random().toString(36).slice(2, 10)}`, fields.channel ?? "sms", fields.type, fields.body, fields.active ?? true, fields.notice ?? null],
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
  asService(async (q) => (await q<{ r: Answer }>("select public.sms_job_compose($1, $2, $3) as r", [job.id, job.lease, site])).rows[0].r);

const contact = (user: string, org: string, phone: string | null, extra: Answer = {}) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, last_name, phone, owner_id, gender) values ($1, 'דנה', 'כהן', $2, $3, $4) returning id",
          [org, phone, user, extra.gender ?? null],
        )
      ).rows[0].id,
  );

/** A consent entry on the record's SMS channel (marketing needs a recorded grant, CNS-07). */
const consent = (org: string, record: { contact?: string; lead?: string }, state: "granted" | "withdrawn") =>
  asAdmin((q) =>
    q("insert into public.consents (organization_id, lead_id, contact_id, channel, state, source, method) values ($1, $2, $3, 'sms', $4, 'manual', 'בשיחה')", [
      org,
      record.lead ?? null,
      record.contact ?? null,
      state,
    ]),
  );

describe("the SMS composer (SMS-05, InforU)", () => {
  let owner: { id: string }, ownerB: { id: string };
  let org: string, orgB: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("compose-owner");
    org = await createOrg(owner.id, "עסק הרכבה");
    ownerB = await createUser("compose-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
    await allow(org);
    await allow(orgB);
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '03-5550000' where id = $1", [org]);
      await q("update public.profiles set full_name = 'נועה הנציגה' where id = $1", [owner.id]);
      await q(
        "insert into public.org_document_settings (organization_id, address_line, city) values ($1, 'הרצל 1', 'תל אביב') on conflict (organization_id) do update set address_line = excluded.address_line, city = excluded.city",
        [org],
      );
    });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(closePool);

  it("is for service_role only, and only on the lease the send check passed", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "רון לוי", phone: "052-1112222", owner_id: owner.id });
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead });
    const denied = await asUser(owner.id, (q) => q("select public.sms_job_compose($1, $2, $3)", [job.id, job.lease, SITE])).catch((e: { code?: string }) => e.code);
    expect(denied).toBe("42501");
    expect(await compose({ id: job.id, lease: "00000000-0000-4000-8000-000000000000" })).toEqual({ refused: "stale" });
    await asAdmin((q) => q("update app.jobs set send_checked_lease = null where id = $1", [job.id]));
    expect(await compose(job)).toEqual({ refused: "stale" });
    // delta review (4): only a counted job, and once per lease
    const fresh = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead });
    await asAdmin((q) => q("update app.jobs set usage_counted = false where id = $1", [fresh.id]));
    expect(await compose(fresh)).toEqual({ refused: "stale" });
    const twice = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead });
    expect(await compose(twice)).toMatchObject({ to: "+972521112222" });
    expect(await compose(twice)).toEqual({ refused: "stale" });
  });

  it("fills a card's service SMS from the record as it is now, with the business's fields", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "רון לוי", phone: "052-1112222", owner_id: owner.id });
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי} {שם מלא}, כאן {שם הנציג} מ{שם העסק} {טלפון העסק}, {כתובת העסק}." });
    const job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead, sent_by_user_id: owner.id });
    // the number changed after queuing: the CURRENT one is used
    await asAdmin((q) => q("update public.leads set phone = '052-3334444' where id = $1", [lead]));
    expect(await compose(job)).toEqual({
      to: "+972523334444",
      sender: null,
      text: "שלום רון רון לוי, כאן נועה הנציגה מעסק הרכבה 03-5550000, הרצל 1, תל אביב.",
    });
  });

  it("refuses a gone record, a missing phone, a changed template, a field without a value and a text too long", async () => {
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const gone = await insertLead(owner.id, org, { full_name: "א", phone: "052-1110001", owner_id: owner.id });
    let job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: gone });
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [gone]));
    expect(await compose(job)).toEqual({ refused: "record_gone" });

    const nophone = await insertLead(owner.id, org, { full_name: "ב", phone: "052-1110002", owner_id: owner.id });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: nophone });
    await asAdmin((q) => q("update public.leads set phone = null where id = $1", [nophone]));
    expect(await compose(job)).toEqual({ refused: "no_phone" });

    const lead = await insertLead(owner.id, org, { full_name: "ג", phone: "052-1110003", owner_id: owner.id });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead });
    await asAdmin((q) => q("update public.message_templates set is_active = false where id = $1", [t]));
    expect(await compose(job)).toEqual({ refused: "inactive" });
    await asAdmin((q) => q("update public.message_templates set is_active = true where id = $1", [t]));

    const quote = await template(org, { type: "requested_document", body: "ההצעה: {קישור להצעה}" });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: quote, lead_id: lead });
    expect(await compose(job)).toEqual({ refused: "unfilled_field" });

    const long = await template(org, { type: "requested_document", body: `${"א".repeat(280)} {שם מלא}` });
    const named = await insertLead(owner.id, org, { full_name: "ש".repeat(40), phone: "052-1110004", owner_id: owner.id });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: long, lead_id: named });
    expect(await compose(job)).toEqual({ refused: "too_long" });
  });

  it("wraps a marketing SMS in the envelope with its own unsubscribe link, and needs the site's address for it", async () => {
    const c = await contact(owner.id, org, "052-2220001", { gender: "female" });
    await consent(org, { contact: c }, "granted");
    const t = await template(org, { type: "marketing", body: "{זכר: שלום לך | נקבה: שלום לך יקרה | ניטרלי: שלום} {שם פרטי}, יש חדש." });
    let job = await prepared(org, { channel: "sms", message_type: "marketing", template_id: t, contact_id: c, sent_by_user_id: owner.id });
    expect(await compose(job, null)).toEqual({ refused: "site_url" });
    job = await prepared(org, { channel: "sms", message_type: "marketing", template_id: t, contact_id: c, sent_by_user_id: owner.id });
    const answer = await compose(job);
    expect(answer.to).toBe("+972522220001");
    const text = String(answer.text);
    expect(text).toMatch(/^פרסומת: שלום לך יקרה דנה, יש חדש\.\n\nעסק הרכבה · 03-5550000 · הרצל 1, תל אביב\nלהסרה מרשימת התפוצה: https:\/\/mexuz\.test\/f\/unsub\/[A-Za-z0-9_-]{64}$/);
    // the link's token is a live one of this contact and channel (only its hash is kept)
    const token = text.slice(-64);
    const kept = await asAdmin(
      async (q) =>
        (await q<{ n: number }>("select count(*)::int as n from app.consent_preference_tokens where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') and organization_id = $2", [token, org]))
          .rows[0].n,
    );
    expect(kept).toBe(1);
  });

  it("judges consent itself on the number it returns (review (1))", async () => {
    const t = await template(org, { type: "marketing", body: "שלום {שם פרטי}, יש חדש. {קישור הסרה}" });
    // marketing without a recorded grant
    const c = await contact(owner.id, org, "052-2220021");
    let job = await prepared(org, { channel: "sms", message_type: "marketing", template_id: t, contact_id: c });
    expect(await compose(job)).toEqual({ refused: "consent_missing" });
    // a grant, then a withdrawal after the send check
    await consent(org, { contact: c }, "granted");
    job = await prepared(org, { channel: "sms", message_type: "marketing", template_id: t, contact_id: c });
    await consent(org, { contact: c }, "withdrawn");
    expect(await compose(job)).toEqual({ refused: "consent_suppressed" });
    // a service message to a number that replied "הסר" (blocklist, SMS-03) after the send check
    const s = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const d = await contact(owner.id, org, "052-2220022");
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: s, contact_id: d });
    await asService((q) => q("select public.sms_inbound_optout($1, '0522220022', 'הסר')", [org]));
    expect(await compose(job)).toEqual({ refused: "consent_blocked" });
    // the hash key gone: cannot check = refused
    const e = await contact(owner.id, org, "052-2220023");
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: s, contact_id: e });
    await asAdmin((q) => q("delete from app.settings where key = 'consent_hash_key'"));
    try {
      expect(await compose(job)).toEqual({ refused: "consent_unknown" });
    } finally {
      await asAdmin((q) => q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]));
    }
  });

  it("never reads a customer's value as a field, and names the rep only as a member of the business (review (7), (8))", async () => {
    const t = await template(org, { type: "requested_document", body: "שלום {שם מלא}, כאן {שם הנציג}." });
    const lead = await insertLead(owner.id, org, { full_name: "{שם העסק} {זכר: א | נקבה: ב | ניטרלי: ג}", phone: "052-2220031", owner_id: owner.id });
    let job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead, sent_by_user_id: owner.id });
    expect((await compose(job)).text).toBe("שלום {שם העסק} {זכר: א | נקבה: ב | ניטרלי: ג}, כאן נועה הנציגה.");
    // a sender who is no member of this business: no rep name, so the field is unfilled
    await asAdmin((q) => q("update public.profiles set full_name = 'זר' where id = $1", [ownerB.id]));
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead, sent_by_user_id: ownerB.id });
    expect(await compose(job)).toEqual({ refused: "unfilled_field" });
  });

  it("uses the approved sender name, else the verified own number", async () => {
    const c = await contact(owner.id, org, "052-2220002");
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    await asAdmin((q) =>
      q(
        `insert into public.org_message_settings (organization_id, sms_sender_name) values ($1, 'Harkava')
         on conflict (organization_id) do update set sms_sender_name = 'Harkava'`,
        [org],
      ),
    );
    // a platform owner's approval (platform_set_sms_sender_approval) stamps it; set here directly
    await asAdmin((q) => q("update public.org_message_settings set sms_sender_approved_at = now() where organization_id = $1", [org]));
    const job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, contact_id: c });
    expect((await compose(job)).sender).toBe("Harkava");
    await asAdmin((q) => q("update public.org_message_settings set sms_sender_name = null, sms_sender_approved_at = null where organization_id = $1", [org]));
  });

  it("refuses a deal's SMS when the deal's contact changed", async () => {
    const c = await contact(owner.id, org, "052-2220003");
    const c2 = await contact(owner.id, org, "052-2220004");
    const { pipelineId, stages } = await defaultPipeline(org);
    const deal = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'ע', $2, $3, $4, $5) returning id", [org, pipelineId, stages[0].id, c, owner.id]))
          .rows[0].id,
    );
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    const job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, contact_id: c, deal_id: deal });
    await asAdmin((q) => q("update public.deals set contact_id = $2 where id = $1", [deal, c2]));
    expect(await compose(job)).toEqual({ refused: "customer_changed" });
  });

  it("a meeting reminder: the meeting as queued, its personal link minted last", async () => {
    const c = await contact(owner.id, org, "052-2220005");
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
    const t = await template(org, { type: "meeting_reminder", notice: "meeting_day", body: "תזכורת: {תאריך} ב-{שעה}{, ב-{מיקום}}. לשינוי: {קישור}" });
    const queue = async () => {
      const job = await prepared(org, { channel: "sms", message_type: "meeting_reminder", template_id: t, contact_id: c, meeting_id: meeting, event_at: new Date(starts).toISOString() });
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
    const links = await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.booking_manage_links where meeting_id = $1", [meeting])).rows[0].n);
    expect(links).toBe(1);

    // moved after queuing: nothing is minted
    await asAdmin((q) => q("delete from app.meeting_customer_messages where meeting_id = $1", [meeting]));
    job = await queue();
    await asAdmin((q) => q("update public.meetings set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1", [meeting]));
    expect(await compose(job)).toEqual({ refused: "meeting_changed" });
  });

  it("a punch card notice: the card still active and the contact's", async () => {
    const c = await contact(owner.id, org, "052-2220006");
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
    const t = await template(org, { type: "punch_card_notice", notice: "punch_card_low", body: "{שם פרטי}, ב{שם הכרטיסייה} {כניסות}, עד {תאריך}." });
    // review (9): only while the business's customer messages switch is on
    let job = await prepared(org, { channel: "sms", message_type: "punch_card_notice", template_id: t, contact_id: c, punch_card_id: card });
    expect(await compose(job)).toEqual({ refused: "messages_off" });
    await asAdmin((q) =>
      q(
        `insert into public.punch_card_alert_settings (organization_id, customer_messages) values ($1, true)
         on conflict (organization_id) do update set customer_messages = true`,
        [org],
      ),
    );
    job = await prepared(org, { channel: "sms", message_type: "punch_card_notice", template_id: t, contact_id: c, punch_card_id: card });
    expect((await compose(job)).text).toBe("דנה, בעשר כניסות נשארו 10 כניסות, עד 1 במרץ 2027.");
    job = await prepared(org, { channel: "sms", message_type: "punch_card_notice", template_id: t, contact_id: c, punch_card_id: card });
    await asAdmin((q) => q("update public.punch_cards set status = 'cancelled', cancelled_at = now(), cancel_reason = 'בדיקה' where id = $1", [card]));
    expect(await compose(job)).toEqual({ refused: "card_changed" });
  });

  it("a collection reminder: the stage's refusal rule, and the balance at send time", async () => {
    const c = await contact(owner.id, org, "052-2220007");
    await asAdmin((q) =>
      q(
        `update public.org_document_settings set collection_customer_reminder = true, collection_customer_stages = '{0,7,14}' where organization_id = $1`,
        [org],
      ),
    );
    const doc = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, 'tax_invoice', '1001', current_date - 10, 123450, current_date) returning id",
            [org, c],
          )
        ).rows[0].id,
    );
    const t = await template(org, { type: "collection", notice: "collection_reminder", body: "{שם פרטי}, {מסמך} על {סכום}, עד {מועד תשלום}." });
    const queue = async (offset: number) => {
      const job = await prepared(org, { channel: "sms", message_type: "collection", template_id: t, contact_id: c, collection_document_id: doc });
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
    expect(String(answer.text)).toMatch(/^דנה, חשבונית מס 1001 על 1,234\.50 ₪, עד \d+ ב.+ \d{4}\.$/);
    // a stage the business switched off since
    expect(await compose(await queue(-3))).toEqual({ refused: "stage_off" });
  });

  it("an instant reply: only while the record's phone is still the typed one", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "מיכל", phone: "052-2220008", owner_id: owner.id });
    const form = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.forms (organization_id, name, instant_reply) values ($1, 'טופס', true) returning id", [org])).rows[0].id);
    const submission = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.form_submissions (organization_id, form_id, status, lead_id, payload) values ($1, $2, 'accepted', $3, $4) returning id", [org, form, lead, { phone: "0522220008" }]))
          .rows[0].id,
    );
    const t = await template(org, { type: "instant_reply", notice: "instant_reply_open", body: "{שם פרטי}, נחזור עד {שעה}. {שם העסק}" });
    const queue = async () => {
      const job = await prepared(org, { channel: "sms", message_type: "instant_reply", template_id: t, lead_id: lead, form_submission_id: submission, event_at: "2030-01-01T10:30:00Z" });
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
    await asAdmin((q) => q("update public.leads set phone = '052-9990000' where id = $1", [lead]));
    expect(await compose(job)).toEqual({ refused: "address_changed" });
  });

  it("a review request: the stored link only, never while the outside-link switch holds the business", async () => {
    const c = await contact(owner.id, org, "052-2220009");
    await consent(org, { contact: c }, "granted");
    await asAdmin((q) =>
      q(
        `insert into public.review_request_settings (organization_id, enabled, review_url) values ($1, true, 'https://g.page/r/abc/review')
         on conflict (organization_id) do update set enabled = true, review_url = excluded.review_url`,
        [org],
      ),
    );
    const t = await template(org, { type: "review_request", notice: "review_request", body: "{שם פרטי}, נשמח לביקורת: {קישור לביקורת}" });
    const queue = async () => {
      const request = await asAdmin(
        async (q) =>
          (await q<{ id: string }>("insert into app.review_requests (organization_id, source_kind, source_id, contact_id, outcome, channel) values ($1, 'deal', gen_random_uuid(), $2, 'pending', 'sms') returning id", [org, c]))
            .rows[0].id,
      );
      const job = await prepared(org, { channel: "sms", message_type: "review_request", template_id: t, contact_id: c, review_request_id: request });
      await asAdmin((q) => q("update app.review_requests set job_id = $2, outcome = 'queued' where id = $1", [request, job.id]));
      return job;
    };
    const text = String((await compose(await queue())).text);
    expect(text.startsWith("פרסומת: דנה, נשמח לביקורת: https://g.page/r/abc/review")).toBe(true);
    expect(text).toMatch(/\/f\/unsub\/[A-Za-z0-9_-]{64}$/);
    const job = await queue();
    await asAdmin((q) => q("insert into app.qr_external_blocks (organization_id, blocked, reason) values ($1, true, 'בדיקה') on conflict (organization_id) do update set blocked = true", [org]));
    expect(await compose(job)).toEqual({ refused: "link_blocked" });
    await asAdmin((q) => q("update app.qr_external_blocks set blocked = false where organization_id = $1", [org]));
  });

  it("a sender check's code goes to the business's own phone, once per lease", async () => {
    const result = await asUser(owner.id, async (q) => (await q<{ r: Answer }>("select public.sms_sender_verify_start($1) as r", [org])).rows[0].r);
    expect(result).toEqual({ ok: true });
    const queued = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from app.jobs where organization_id = $1 and payload ? 'sender_check_id' order by created_at desc limit 1", [org])).rows[0].id,
    );
    const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
    const job = rows.find((r) => r.id === queued) as Claimed;
    await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id, usage_counted = true where id = $1", [queued]));
    const answer = await compose(job);
    expect(answer.to).toBe("+97235550000");
    expect(answer.sender).toBeNull();
    // owner (323) ב: the exact wording
    expect(String(answer.text)).toMatch(/^מקסוז: קוד האימות שלך הוא \d{6}\. בתוקף 10 דקות\. לא ביקשת קוד\? אפשר להתעלם\.$/);
    // a second compose on the same lease (delta review (4)); the code is issued once in any case (sms_sender_code_issue)
    expect(await compose(job)).toEqual({ refused: "stale" });
  });

  it("never reaches across businesses", async () => {
    const other = await contact(ownerB.id, orgB, "052-2220010");
    const t = await template(org, { type: "requested_document", body: "שלום {שם פרטי}" });
    // a job of business A naming B's contact (never made by the app): no record is found in A
    const job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, contact_id: other });
    expect(await compose(job)).toEqual({ refused: "record_gone" });
    // A's template on B's job is not found
    const own = await contact(ownerB.id, orgB, "052-2220011");
    const jobB = await prepared(orgB, { channel: "sms", message_type: "requested_document", template_id: t, contact_id: own });
    expect(await compose(jobB)).toEqual({ refused: "not_found" });
  });

  it("runs the shared fill fixture like fillMessage()", async () => {
    const fixture = JSON.parse(readFileSync(path.join(__dirname, "../unit/fixtures/sms-fill.json"), "utf8")) as {
      cases: Array<{ name: string; text: string; values: Answer; gender: string | null; envelope: boolean; expected: string }>;
    };
    for (const c of fixture.cases) {
      const out = await asAdmin(
        async (q) =>
          (
            await q<{ r: string }>(
              "select app.sms_fill(case when $4 then app.sms_marketing_envelope($1) else $1 end, $2::jsonb, $3) as r",
              [c.text, JSON.stringify(c.values), c.gender, c.envelope],
            )
          ).rows[0].r,
      );
      expect(out, c.name).toBe(c.expected);
    }
  });

  it("gives the SMS count back for a refused message, never for another holder's lease (owner (326) ב)", async () => {
    const t = await template(org, { type: "requested_document", body: "ההצעה: {קישור להצעה}" });
    const lead = await insertLead(owner.id, org, { full_name: "ז", phone: "052-2220041", owner_id: owner.id });
    const counters = () =>
      asAdmin(
        async (q) =>
          (
            await q<{ used: number; service: number }>(
              `select (select m.used from app.sms_quota_months m where m.organization_id = $1
                        and m.month = date_trunc('month', (now() at time zone app.intake_zone(o.timezone))::date)::date) as used,
                      (select u.service from app.message_usage_days u where u.organization_id = $1 and u.channel = 'sms'
                        and u.day = (now() at time zone app.intake_zone(o.timezone))::date) as service
                 from public.organizations o where o.id = $1`,
              [org],
            )
          ).rows[0],
      );
    // as job_message_may_send leaves a counted job (its count taken a moment before)
    const counted = async () => {
      const job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: lead });
      await asAdmin(async (q) => {
        await q("update app.jobs set usage_counted = true where id = $1", [job.id]);
        await q(
          `insert into app.sms_quota_months (organization_id, month, used)
           select o.id, date_trunc('month', (now() at time zone app.intake_zone(o.timezone))::date)::date, 5 from public.organizations o where o.id = $1
           on conflict (organization_id, month) do update set used = 5`,
          [org],
        );
        await q(
          `insert into app.message_usage_days (organization_id, channel, day, marketing, service)
           select o.id, 'sms', (now() at time zone app.intake_zone(o.timezone))::date, 0, 5 from public.organizations o where o.id = $1
           on conflict (organization_id, channel, day) do update set service = 5`,
          [org],
        );
      });
      return job;
    };
    let job = await counted();
    expect(await compose({ id: job.id, lease: "00000000-0000-4000-8000-000000000000" })).toEqual({ refused: "stale" });
    expect(await counters()).toEqual({ used: 5, service: 5 });
    expect(await compose(job)).toEqual({ refused: "unfilled_field" });
    expect(await counters()).toEqual({ used: 4, service: 4 });
    const flag = async (id: string) => asAdmin(async (q) => (await q<{ c: boolean }>("select usage_counted as c from app.jobs where id = $1", [id])).rows[0].c);
    expect(await flag(job.id)).toBe(false);

    // the adapter's path: lease-bound, once (the composer ran first and stamped the counted day)
    job = await counted();
    await asAdmin((q) => q("update app.jobs j set sms_counted_on = (select (now() at time zone app.intake_zone(o.timezone))::date from public.organizations o where o.id = j.organization_id), composed_lease = lease_id where j.id = $1", [job.id]));
    const back = (j: Claimed) => asService(async (q) => (await q<{ r: Answer }>("select public.sms_quota_return($1, $2) as r", [j.id, j.lease])).rows[0].r);
    expect(await back({ id: job.id, lease: "00000000-0000-4000-8000-000000000000" })).toEqual({ refused: "stale" });
    expect(await back(job)).toEqual({ returned: true });
    expect(await back(job)).toEqual({ returned: false });
    expect(await counters()).toEqual({ used: 4, service: 4 });
    const denied = await asUser(owner.id, (q) => q("select public.sms_quota_return($1, $2)", [job.id, job.lease])).catch((e: { code?: string }) => e.code);
    expect(denied).toBe("42501");

    // delta review (2): the count goes back to the day it was taken on, never to today's; an unknown day gives nothing back
    job = await counted();
    await asAdmin(async (q) => {
      await q("insert into app.sms_quota_months (organization_id, month, used) values ($1, '2026-01-01', 7) on conflict (organization_id, month) do update set used = 7", [org]);
      await q("update app.jobs set sms_counted_on = '2026-01-31' where id = $1", [job.id]);
    });
    expect(await back(job)).toEqual({ returned: true });
    expect(await counters()).toEqual({ used: 5, service: 5 });
    expect(await asAdmin(async (q) => (await q<{ used: number }>("select used from app.sms_quota_months where organization_id = $1 and month = '2026-01-01'", [org])).rows[0].used)).toBe(6);
    job = await counted();
    expect(await back(job)).toEqual({ returned: false });
    expect(await counters()).toEqual({ used: 5, service: 5 });
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
              where p.oid in ('public.sms_job_compose(uuid, uuid, text)'::regprocedure, 'app.sms_compose_core(uuid, uuid, text)'::regprocedure,
                              'app.sms_usage_give_back(uuid)'::regprocedure, 'public.sms_quota_return(uuid, uuid)'::regprocedure)`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
    for (const r of rows) expect(r.acl ?? "", r.name).not.toMatch(/(^|,)(anon|authenticated)=/);
    for (const name of ["sms_job_compose(uuid,uuid,text)", "sms_quota_return(uuid,uuid)"]) {
      expect(rows.find((r) => r.name === name)?.acl, name).toMatch(/service_role=X/);
    }
    for (const name of ["app.sms_compose_core(uuid,uuid,text)", "app.sms_usage_give_back(uuid)"]) {
      expect(rows.find((r) => r.name === name)?.acl ?? "", name).not.toMatch(/service_role=/);
    }
  });
});
