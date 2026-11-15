import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import fixture from "../unit/fixtures/card-unfillable-fields.json";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

// EML-02 (15 November 2026, the owner's first live send; migration card_email_fields): a card's or an automation's message
// fills only app.card_message_fields(); a template holding any other field is refused before it is queued (hint
// record_message:unfillable_field, the fields in the detail), {שם הנציג} is the sender (a card) or the record's owner (an
// automation), the card's list answers 'unfilled', and the sending person is told in the bell.

const KEY = "test-consent-key";
const SITE = "https://mexuz.test";
const RULE = "22222222-2222-4222-8222-222222222222";

type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

const FEATURES = { sms: true, collection: true, documents: true, payments: true };
const allow = (org: string) =>
  asAdmin((q) =>
    q(
      `update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb,
              limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{"max_sms_per_month": 100000}'::jsonb
        where organization_id = $1`,
      [org, JSON.stringify(FEATURES)],
    ),
  );

const template = (org: string, f: { channel: "email" | "sms"; type: string; body: string; subject?: string | null }) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.message_templates (organization_id, name, channel, message_type, subject, body, is_active)
           values ($1, $2, $3, $4, $5, $6, true) returning id`,
          [org, `t-${Math.random().toString(36).slice(2, 10)}`, f.channel, f.type, f.channel === "email" ? (f.subject ?? "שלום {שם פרטי}") : null, f.body],
        )
      ).rows[0].id,
  );

const prepared = async (org: string, payload: Answer): Promise<Claimed> => {
  const id = await asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify(payload)])).rows[0].id);
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id, usage_counted = true where id = $1", [id]));
  return job as Claimed;
};
const composeEmail = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Answer }>("select public.email_job_compose($1, $2, $3) as r", [job.id, job.lease, SITE])).rows[0].r);
const composeSms = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Answer }>("select public.sms_job_compose($1, $2, $3) as r", [job.id, job.lease, SITE])).rows[0].r);

const pgErr = (e: unknown) => e as { code?: string; hint?: string; detail?: string };

// review of b219c81b (1): the sender's notice runs as a trigger on public.messages, beside the pinned app.jobs_record_message.
// A change of its body, or a new trigger on public.messages, fails here until it gets a fresh independent review (it writes
// a public table, notifications, on every failed message); then update the md5 / the list.
const SENDER_NOTICE_MD5 = "57d1c65f2b45743a46439bea1d989702";
const MESSAGES_TRIGGERS = ["messages_refused_sender_notice", "messages_touch"];

describe("the fields a card's message fills (EML-02, 15 November 2026)", () => {
  let owner: { id: string }, member: { id: string }, viewer: { id: string };
  let org: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("cardf-owner");
    org = await createOrg(owner.id, "עסק השדות");
    member = await addMember(org, owner.id, "member", "cardf-member");
    viewer = await addMember(org, owner.id, "viewer", "cardf-viewer");
    await allow(org);
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '03-5550000' where id = $1", [org]);
      await q("update public.profiles set full_name = 'נועה הבעלים' where id = $1", [owner.id]);
      await q("update public.profiles set full_name = 'משה החבר' where id = $1", [member.id]);
      await q("update public.profiles set full_name = 'צופה' where id = $1", [viewer.id]);
      await q(
        "insert into public.org_document_settings (organization_id, address_line, city) values ($1, 'הרצל 1', 'תל אביב') on conflict (organization_id) do update set address_line = excluded.address_line, city = excluded.city",
        [org],
      );
    });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(closePool);

  it("names the same fields as the app, case by case (shared fixture)", async () => {
    for (const c of fixture.cases) {
      const got = await asAdmin(
        async (q) => (await q<{ r: string[] }>("select app.card_unfillable_fields($1, $2, $3) as r", [c.type, c.subject, c.body])).rows[0].r,
      );
      expect(got, JSON.stringify(c)).toEqual(c.missing);
    }
    // no API role may call the helpers
    const denied = await asUser(owner.id, (q) => q("select app.card_message_fields()")).catch((e) => pgErr(e).code);
    expect(denied).toBe("42501");
  });

  it("refuses a card's email and SMS from a template the card cannot fill, naming the fields", async () => {
    const lead = await insertLead(member.id, org, { full_name: "רון לוי", email: "ron@example.test", phone: "052-1112222", owner_id: member.id });
    const quoteEmail = await template(org, { channel: "email", type: "requested_document", subject: "הצעה", body: "ההצעה: {קישור להצעה}, עד {תוקף}" });
    const e = await asUser(member.id, (q) => q("select public.record_email_send($1, 'lead', $2, $3, '{}', '{}')", [org, lead, quoteEmail])).catch(pgErr);
    expect(e).toMatchObject({ code: "P0001", hint: "record_message:unfillable_field", detail: "קישור להצעה, תוקף" });
    const quoteSms = await template(org, { channel: "sms", type: "marketing", body: "{תוכן העדכון}" });
    const s = await asUser(member.id, (q) => q("select public.record_sms_send($1, 'lead', $2, $3)", [org, lead, quoteSms])).catch(pgErr);
    expect(s).toMatchObject({ code: "P0001", hint: "record_message:unfillable_field", detail: "תוכן העדכון" });
    // nothing was queued for either
    const queued = await asAdmin(
      async (q) => (await q<{ n: number }>("select count(*)::int as n from app.jobs where payload ->> 'template_id' = any ($1)", [[quoteEmail, quoteSms]])).rows[0].n,
    );
    expect(queued).toBe(0);
    // a template the card fills goes into the queue
    const fine = await template(org, { channel: "email", type: "requested_document", body: "שלום {שם פרטי}, כאן {שם הנציג} מ{שם העסק}" });
    const ok = await asUser(member.id, async (q) => (await q<{ r: Answer }>("select public.record_email_send($1, 'lead', $2, $3, '{}', '{}') as r", [org, lead, fine])).rows[0].r);
    expect(typeof ok.job_id).toBe("string");
  });

  it("an automation's step refuses such a template when the rule runs (the refusal helpers answer 'unfillable_field')", async () => {
    const email = await template(org, { channel: "email", type: "requested_document", body: "{קישור להצעה}" });
    const sms = await template(org, { channel: "sms", type: "requested_document", body: "{תוקף}" });
    const fine = await template(org, { channel: "sms", type: "requested_document", body: "{שם פרטי}" });
    const r = await asAdmin(
      async (q) =>
        (
          await q<{ e: string | null; s: string | null; f: string | null }>(
            "select app.record_email_template_refusal($1, $2, false) as e, app.record_sms_template_refusal($1, $3, false) as s, app.record_sms_template_refusal($1, $4, false) as f",
            [org, email, sms, fine],
          )
        ).rows[0],
    );
    expect(r).toEqual({ e: "unfillable_field", s: "unfillable_field", f: null });
  });

  it("{שם הנציג}: the card's sender, else for an automation the record's owner (a deal's: the deal's owner), never a viewer", async () => {
    const c = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.contacts (organization_id, first_name, last_name, email, phone, owner_id) values ($1, 'דנה', 'כהן', 'dana@example.test', '052-3334444', $2) returning id",
            [org, member.id],
          )
        ).rows[0].id,
    );
    const emailT = await template(org, { channel: "email", type: "requested_document", subject: "{שם הנציג}", body: "כאן {שם הנציג}" });
    const smsT = await template(org, { channel: "sms", type: "requested_document", body: "כאן {שם הנציג}" });

    // a card: the person who sent it, whoever owns the record
    let job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: emailT, contact_id: c, reply_to_user_id: owner.id });
    expect(await composeEmail(job)).toMatchObject({ subject: "נועה הבעלים" });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: smsT, contact_id: c, sent_by_user_id: owner.id });
    expect(await composeSms(job)).toMatchObject({ text: "כאן נועה הבעלים" });

    // an automation (a button press too): the record's owner, not the presser
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: emailT, contact_id: c, automation_id: RULE, pressed_by_user_id: owner.id });
    expect(await composeEmail(job)).toMatchObject({ subject: "משה החבר" });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: smsT, contact_id: c, automation_id: RULE });
    expect(await composeSms(job)).toMatchObject({ text: "כאן משה החבר" });

    // a deal's message: the deal's owner
    const pipeline = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 order by position limit 1", [org])).rows[0].id);
    const stage = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from public.stages where organization_id = $1 and pipeline_id = $2 and kind = 'open' order by position limit 1", [org, pipeline])).rows[0].id,
    );
    const deal = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
            [org, pipeline, stage, c, owner.id],
          )
        ).rows[0].id,
    );
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: emailT, contact_id: c, deal_id: deal, automation_id: RULE });
    expect(await composeEmail(job)).toMatchObject({ subject: "נועה הבעלים" });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: smsT, contact_id: c, deal_id: deal, automation_id: RULE });
    expect(await composeSms(job)).toMatchObject({ text: "כאן נועה הבעלים" });

    // a viewer owning the record names no rep for an automation: the field stays unfilled and the message refuses
    await asAdmin((q) => q("update public.contacts set owner_id = $2 where id = $1", [c, viewer.id]));
    job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: emailT, contact_id: c, automation_id: RULE });
    expect(await composeEmail(job)).toEqual({ refused: "unfilled_field" });
    job = await prepared(org, { channel: "sms", message_type: "requested_document", template_id: smsT, contact_id: c, automation_id: RULE });
    expect(await composeSms(job)).toEqual({ refused: "unfilled_field" });
  });

  it("a refusal for a field without a value shows on the card and tells the sender who is not an owner or admin", async () => {
    const lead = await insertLead(member.id, org, { full_name: "גל שני", email: "gal@example.test", owner_id: member.id });
    // {שם הנציג} with a sender who has no name: the composer refuses 'unfilled_field'
    await asAdmin((q) => q("update public.profiles set full_name = '' where id = $1", [member.id]));
    const t = await template(org, { channel: "email", type: "requested_document", subject: "שלום", body: "כאן {שם הנציג}" });
    const job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, reply_to_user_id: member.id });
    expect(await composeEmail(job)).toEqual({ refused: "unfilled_field" });
    await asService((q) => q("select public.finish_job($1, $2, false, 'refused unfilled_field', true, true, null, null, 'unfilled_field')", [job.id, job.lease]));
    await asAdmin((q) => q("update public.profiles set full_name = 'משה החבר' where id = $1", [member.id]));

    const list = await asUser(member.id, async (q) => (await q<{ r: Answer[] }>("select public.record_email_queue($1, 'lead', $2) as r", [org, lead])).rows[0].r);
    expect(list.find((row) => row.job_id === job.id)).toMatchObject({ state: "not_sent", reason: "unfilled" });

    const notices = await asAdmin(
      async (q) =>
        (
          await q<{ user_id: string; body: string; entity_type: string; entity_id: string }>(
            "select user_id, body, entity_type, entity_id from public.notifications where organization_id = $1 and title = 'הודעה ללקוח לא נשלחה' and entity_id = $2",
            [org, lead],
          )
        ).rows,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ user_id: member.id, entity_type: "lead" });
    expect(notices[0].body).toContain("האימייל מהתבנית");
    expect(notices[0].body).toContain("שדה בהודעה לא התמלא");
    // the owners are told by the business notice (app.message_send_refused), never twice by this one
    const ownerNotices = await asAdmin(
      async (q) =>
        (
          await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and user_id = $2 and title = 'הודעה ללקוח לא נשלחה'", [
            org,
            owner.id,
          ])
        ).rows[0].n,
    );
    expect(ownerNotices).toBe(1);
  });

  it("a marketing message is not queued while the envelope's business address or phone is missing", async () => {
    const bare = await createOrg(owner.id, "עסק בלי פרטים");
    await allow(bare);
    const lead = await insertLead(owner.id, bare, { full_name: "רון", email: "ron2@example.test", phone: "052-1112299", owner_id: owner.id });
    const mEmail = await template(bare, { channel: "email", type: "marketing", body: "שלום {שם פרטי}" });
    const mSms = await template(bare, { channel: "sms", type: "marketing", body: "שלום {שם פרטי}" });
    const service = await template(bare, { channel: "email", type: "requested_document", body: "שלום {שם פרטי}" });
    expect(await asAdmin(async (q) => (await q<{ r: string[] }>("select app.marketing_details_missing($1) as r", [bare])).rows[0].r)).toEqual(["address", "phone"]);
    const e = await asUser(owner.id, (q) => q("select public.record_email_send($1, 'lead', $2, $3, '{}', '{}')", [bare, lead, mEmail])).catch(pgErr);
    expect(e).toMatchObject({ code: "P0001", hint: "record_message:business_details", detail: "address,phone" });
    const s = await asUser(owner.id, (q) => q("select public.record_sms_send($1, 'lead', $2, $3)", [bare, lead, mSms])).catch(pgErr);
    expect(s).toMatchObject({ code: "P0001", hint: "record_message:business_details" });
    // a rule's step refuses it too; a service message does not carry the envelope and goes
    expect(await asAdmin(async (q) => (await q<{ r: string }>("select app.record_email_template_refusal($1, $2, false) as r", [bare, mEmail])).rows[0].r)).toBe("business_details");
    const ok = await asUser(owner.id, async (q) => (await q<{ r: Answer }>("select public.record_email_send($1, 'lead', $2, $3, '{}', '{}') as r", [bare, lead, service])).rows[0].r);
    expect(typeof ok.job_id).toBe("string");
    // the business phone alone counts as the phone; the address still missing
    await asAdmin((q) => q("update public.organizations set phone = '03-5551111' where id = $1", [bare]));
    expect(await asAdmin(async (q) => (await q<{ r: string[] }>("select app.marketing_details_missing($1) as r", [bare])).rows[0].r)).toEqual(["address"]);
    await asAdmin((q) => q("insert into public.org_document_settings (organization_id, city) values ($1, 'חיפה')", [bare]));
    expect(await asAdmin(async (q) => (await q<{ r: string[] }>("select app.marketing_details_missing($1) as r", [bare])).rows[0].r)).toEqual([]);
    const sent = await asUser(owner.id, async (q) => (await q<{ r: Answer }>("select public.record_email_send($1, 'lead', $2, $3, '{}', '{}') as r", [bare, lead, mEmail])).rows[0].r);
    expect(typeof sent.job_id).toBe("string");
  });

  it("new sending hours judge again only this business's jobs waiting for the window", async () => {
    const other = await createOrg(owner.id, "עסק שכן");
    const lead = await insertLead(owner.id, org, { full_name: "שעות", email: "hours@example.test", owner_id: owner.id });
    const otherLead = await insertLead(owner.id, other, { full_name: "שעות", email: "hours2@example.test", owner_id: owner.id });
    const t = await template(org, { channel: "email", type: "requested_document", body: "שלום {שם פרטי}" });
    const t2 = await template(other, { channel: "email", type: "requested_document", body: "שלום {שם פרטי}" });
    const later = "now() + interval '10 hours'";
    const job = async (o: string, l: string, tpl: string, mark: string | null, cap: string | null) =>
      asAdmin(async (q) => {
        const id = (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [o, JSON.stringify({ channel: "email", message_type: "requested_document", template_id: tpl, lead_id: l })])).rows[0].id;
        await q(`update app.jobs set next_run_at = ${later}, last_error = $2, cap_wait = $3 where id = $1`, [id, mark, cap]);
        return id;
      });
    const waiting = await job(org, lead, t, "waiting:sending_hours", null);
    const capped = await job(org, lead, t, "waiting:over_cap", "over_cap");
    const paused = await job(org, lead, t, "waiting:sending_paused", null);
    const scheduled = await job(org, lead, t, null, null);
    const neighbour = await job(other, otherLead, t2, "waiting:sending_hours", null);
    // a job that failed once and now waits for the window carries the same mark (status failed)
    const failedWaiting = await job(org, lead, t, "waiting:sending_hours", null);
    await asAdmin((q) => q("update app.jobs set status = 'failed', attempts = 1 where id = $1", [failedWaiting]));
    await asUser(owner.id, (q) =>
      q(
        "insert into public.org_message_settings (organization_id, window_from, window_until) values ($1, '07:00', '22:00') on conflict (organization_id) do update set window_from = excluded.window_from, window_until = excluded.window_until",
        [org],
      ),
    );
    const due = await asAdmin(
      async (q) =>
        (await q<{ id: string; due: boolean }>("select id, next_run_at <= now() as due from app.jobs where id = any ($1)", [[waiting, failedWaiting, capped, paused, scheduled, neighbour]])).rows,
    );
    const byId = Object.fromEntries(due.map((r) => [r.id, r.due]));
    expect(byId).toEqual({ [waiting]: true, [failedWaiting]: true, [capped]: false, [paused]: false, [scheduled]: false, [neighbour]: false });
    // a save that keeps the hours changes nothing
    await asAdmin((q) => q(`update app.jobs set next_run_at = ${later} where id = $1`, [waiting]));
    await asUser(owner.id, (q) => q("update public.org_message_settings set monthly_cap_email = 1000 where organization_id = $1", [org]));
    expect(await asAdmin(async (q) => (await q<{ due: boolean }>("select next_run_at <= now() as due from app.jobs where id = $1", [waiting])).rows[0].due)).toBe(false);
  });

  it("the sender's notice and the triggers of public.messages are pinned as reviewed", async () => {
    const r = await asAdmin(
      async (q) =>
        (
          await q<{ md5: string; triggers: string[] }>(
            `select (select md5(p.prosrc) from pg_proc p where p.oid = 'app.messages_refused_sender_notice()'::regprocedure) as md5,
                    (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
                      where t.tgrelid = 'public.messages'::regclass and not t.tgisinternal) as triggers`,
          )
        ).rows[0],
    );
    expect(r.md5).toBe(SENDER_NOTICE_MD5);
    expect(r.triggers).toEqual(MESSAGES_TRIGGERS);
  });

  it("the sender is told once per template and reason a business day", async () => {
    const lead = await insertLead(member.id, org, { full_name: "חזרה", email: "again@example.test", owner_id: member.id });
    const t = await template(org, { channel: "email", type: "requested_document", subject: "שלום", body: "שלום {שם פרטי}" });
    const t2 = await template(org, { channel: "email", type: "requested_document", subject: "שלום", body: "שלום {שם פרטי}" });
    const fail = async (tpl: string, code: string) => {
      const job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: tpl, lead_id: lead, reply_to_user_id: member.id });
      await asService((q) => q("select public.finish_job($1, $2, false, $3, true, true, null, null, $4)", [job.id, job.lease, `refused ${code}`, code]));
    };
    await fail(t, "unfilled_field");
    await fail(t, "unfilled_field");
    await fail(t, "too_long");
    await fail(t2, "unfilled_field");
    const n = await asAdmin(
      async (q) =>
        (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and user_id = $2 and entity_id = $3", [org, member.id, lead])).rows[0].n,
    );
    // twice the same template and reason = one; another reason or another template = one more each
    expect(n).toBe(3);
    // the next business day tells again
    await asAdmin((q) => q("update app.message_sender_refusal_notices set notified_on = notified_on - 1 where organization_id = $1 and user_id = $2", [org, member.id]));
    await fail(t, "unfilled_field");
    const after = await asAdmin(
      async (q) =>
        (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and user_id = $2 and entity_id = $3", [org, member.id, lead])).rows[0].n,
    );
    expect(after).toBe(4);
  });

  it("an automation's step names the two refusals in its own words", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "כלל", email: "rule@example.test", phone: "052-1113333", owner_id: owner.id });
    const bad = await template(org, { channel: "email", type: "requested_document", body: "{קישור להצעה}" });
    const badSms = await template(org, { channel: "sms", type: "requested_document", body: "{תוקף}" });
    const rule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'כלל שדות', 'lead', 'created', '{}', '[]', $2, false) returning id`,
          [org, JSON.stringify([{ type: "send_email", template_id: bad }, { type: "send_sms", template_id: badSms }])],
        )
      ).rows[0].id,
    );
    const steps = await asAdmin(
      async (q) => (await q<{ s: Array<{ error?: string }> }>("select app.run_automation_actions(a, 'lead', $2) as s from public.automations a where a.id = $1", [rule, lead])).rows[0].s,
    );
    expect(steps.map((x) => x.error)).toEqual(["the template holds a field an automation cannot fill", "the template holds a field an automation cannot fill"]);
    // a marketing template while the business details are missing
    const bare = await createOrg(owner.id, "עסק כלל בלי פרטים");
    await allow(bare);
    const bareLead = await insertLead(owner.id, bare, { full_name: "כלל", email: "rule2@example.test", owner_id: owner.id });
    const mkt = await template(bare, { channel: "email", type: "marketing", body: "שלום {שם פרטי}" });
    const mRule = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'כלל שיווק', 'lead', 'created', '{}', '[]', $2, false) returning id`,
          [bare, JSON.stringify([{ type: "send_email", template_id: mkt }])],
        )
      ).rows[0].id,
    );
    const mSteps = await asAdmin(
      async (q) => (await q<{ s: Array<{ error?: string }> }>("select app.run_automation_actions(a, 'lead', $2) as s from public.automations a where a.id = $1", [mRule, bareLead])).rows[0].s,
    );
    expect(mSteps[0].error).toBe("the business address or phone is missing for a marketing message");
  });

  it("an owner's own card send is told only by the business notice", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "טל רז", email: "tal@example.test", owner_id: owner.id });
    const t = await template(org, { channel: "email", type: "requested_document", subject: "שלום", body: "שלום {שם פרטי}" });
    const job = await prepared(org, { channel: "email", message_type: "requested_document", template_id: t, lead_id: lead, reply_to_user_id: owner.id });
    await asService((q) => q("select public.finish_job($1, $2, false, 'refused unfilled_field', true, true, null, null, 'unfilled_field')", [job.id, job.lease]));
    const n = await asAdmin(
      async (q) => (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and entity_id = $2", [org, lead])).rows[0].n,
    );
    expect(n).toBe(0);
  });
});
