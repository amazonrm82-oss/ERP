import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string) =>
  asAdmin((q) =>
    q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );

// review F1: SMS needs the plan's sms flag and a month quota (off and 0 in every plan)
const allowSms = (...orgs: string[]) =>
  asAdmin((q) =>
    q(
      `update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{"sms": true}'::jsonb,
              limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{"max_sms_per_month": 100000}'::jsonb
        where organization_id = any($1::uuid[])`,
      [orgs],
    ),
  );

type Claimed = { id: string; lease: string };
type Payload = Record<string, unknown>;
type Step = { action: string; status: string; error?: string; warning?: string };

const send = (user: string, org: string, kind: string, record: string, template: string) =>
  asUser(
    user,
    async (q) =>
      (await q<{ r: { job_id: string; paused: boolean; refused?: string } }>("select public.record_sms_send($1, $2, $3, $4) as r", [org, kind, record, template])).rows[0].r,
  );
const queue = (user: string, org: string, kind: string, record: string) =>
  asUser(user, async (q) => (await q<{ r: Array<Record<string, unknown>> }>("select public.record_sms_queue($1, $2, $3) as r", [org, kind, record])).rows[0].r);
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
          fields.channel ?? "sms",
          fields.type ?? "requested_document",
          (fields.channel ?? "sms") === "email" ? "המסמך שביקשת" : null,
          fields.body ?? "שלום {שם פרטי}, המסמך בדרך. {שם העסק}",
          fields.active ?? true,
        ],
      )
    ).rows[0].id,
  );
const lead = (user: string, org: string, phone: string | null, owner = user) => insertLead(user, org, { full_name: "ליד SMS", phone, owner_id: owner });
const contact = (user: string, org: string, phone: string | null) =>
  asUser(
    user,
    async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone, owner_id) values ($1, 'דנה', $2, $3) returning id", [org, phone, user]))
        .rows[0].id,
  );
const deal = async (user: string, org: string, contactId: string | null) => {
  const { pipelineId, stages } = await defaultPipeline(org);
  return asUser(
    user,
    async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקת SMS', $2, $3, $4, $5) returning id",
          [org, pipelineId, stages[0].id, contactId, user],
        )
      ).rows[0].id,
  );
};

/**
 * SMS-02: one SMS to the customer from the record's card, from an SMS template, and an automation step that queues one. Both are
 * OPS-04 message.send jobs (ids only) judged by the queue's own send check; nothing on the worker's path changes.
 */
describe("SMS from the record card and from an automation (SMS-02)", () => {
  let owner: { id: string }, member: { id: string }, other: { id: string }, viewer: { id: string }, ownerB: { id: string };
  let org: string, orgB: string;
  let service: string;

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("sms-owner");
    org = await createOrg(owner.id, "עסק SMS");
    member = await addMember(org, owner.id, "member", "sms-member");
    other = await addMember(org, owner.id, "member", "sms-other");
    viewer = await addMember(org, owner.id, "viewer", "sms-viewer");
    ownerB = await createUser("sms-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
    // review F1: SMS needs the plan's sms flag and a month quota (off and 0 in every plan): both businesses get them here
    await allowSms(org, orgB);
    service = await template(owner.id, org, { name: "מסמך מבוקש SMS" });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await setKey(KEY);
    await closePool();
  });

  it("the card queues one message.send job of ids only, with the template and the sender; the list shows it without the number", async () => {
    const id = await lead(member.id, org, "0521110001");
    const answer = await send(member.id, org, "lead", id, service);
    expect(answer.paused).toBe(false);
    expect(await payloadOf(answer.job_id)).toEqual({
      channel: "sms",
      lead_id: id,
      message_type: "requested_document",
      template_id: service,
      sent_by_user_id: member.id,
    });
    const list = await queue(member.id, org, "lead", id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ job_id: answer.job_id, template_name: "מסמך מבוקש SMS", sender_id: member.id, state: "waiting", reason: null });
    expect(JSON.stringify(list)).not.toContain("521110001");
    // the email card's list does not show it, and the SMS list does not show emails
    expect(await asUser(member.id, async (q) => (await q<{ r: unknown[] }>("select public.record_email_queue($1, 'lead', $2) as r", [org, id])).rows[0].r)).toEqual([]);
  });

  it("a deal's SMS goes to the deal's contact and names the deal; a deal without a contact is refused", async () => {
    const c = await contact(member.id, org, "0521110002");
    const d = await deal(member.id, org, c);
    const answer = await send(member.id, org, "deal", d, service);
    expect(await payloadOf(answer.job_id)).toMatchObject({ channel: "sms", contact_id: c, deal_id: d, sent_by_user_id: member.id });
    expect((await queue(member.id, org, "deal", d)).map((r) => r.job_id)).toEqual([answer.job_id]);
    // the contact's own card does not list the deal's SMS
    expect(await queue(member.id, org, "contact", c)).toEqual([]);
    const own = await send(member.id, org, "contact", c, service);
    expect((await queue(member.id, org, "contact", c)).map((r) => r.job_id)).toEqual([own.job_id]);
    const bare = await deal(member.id, org, null);
    expect((await pgError(send(member.id, org, "deal", bare, service))).hint).toBe("record_sms:no_contact");
    // a binned contact is no contact
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [c]));
    expect((await pgError(send(member.id, org, "deal", d, service))).hint).toBe("record_sms:no_contact");
  });

  it("rights: whoever writes and reads the record sends; a viewer, an unread record and another business are refused", async () => {
    const id = await lead(member.id, org, "0521110003");
    expect((await pgError(send(viewer.id, org, "lead", id, service))).code).toBe("42501");
    expect((await send(other.id, org, "lead", id, service)).job_id).toBeTruthy();
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect((await pgError(send(other.id, org, "lead", id, service))).hint).toBe("record_sms:not_found");
      expect((await pgError(asUser(other.id, (q) => q("select app.record_sms_enqueue($1, 'lead', $2, $3)", [org, id, service]))))).toMatchObject({
        hint: "record_sms:not_found",
      });
      expect(await queue(other.id, org, "lead", id)).toEqual([]);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    expect((await pgError(send(ownerB.id, org, "lead", id, service))).hint).toMatch(/record_sms:(not_found|not_permitted)/);
    expect((await pgError(send(ownerB.id, orgB, "lead", id, service))).hint).toBe("record_sms:not_found");
    expect(await queue(ownerB.id, org, "lead", id)).toEqual([]);
    expect(await pgError(asUser(ownerB.id, (q) => q("select app.record_sms_enqueue($1, 'lead', $2, $3)", [org, id, service])))).toMatchObject({ code: "42501" });
    // another business's template is not found here, in both halves
    const theirs = await template(ownerB.id, orgB, { name: "שלהם" });
    expect((await pgError(send(member.id, org, "lead", id, theirs))).hint).toBe("record_sms:template");
    expect((await pgError(asUser(member.id, (q) => q("select app.record_sms_enqueue($1, 'lead', $2, $3)", [org, id, theirs])))).hint).toBe("record_sms:template");
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [id]));
    expect((await pgError(send(member.id, org, "lead", id, service))).hint).toBe("record_sms:not_found");
    expect((await pgError(send(member.id, org, "task", id, service))).hint).toBe("record_sms:kind");
  });

  it("the number is the record's own phone: none is refused", async () => {
    const id = await lead(member.id, org, null);
    expect((await pgError(send(member.id, org, "lead", id, service))).hint).toBe("record_sms:no_phone");
  });

  it("templates: SMS only, sendable now, and of a type a card may send; collection needs the right and the plan keys", async () => {
    const id = await lead(member.id, org, "0521110004");
    const email = await template(owner.id, org, { name: "אימייל", channel: "email" });
    expect((await pgError(send(member.id, org, "lead", id, email))).hint).toBe("record_sms:channel");
    const inactive = await template(owner.id, org, { name: "כבויה", active: false });
    expect(await pgError(send(member.id, org, "lead", id, inactive))).toMatchObject({ hint: "record_sms:not_sendable" });
    const linked = await template(owner.id, org, { name: "עם קישור", body: "שלום, ראו www.example.com" });
    expect(await pgError(send(member.id, org, "lead", id, linked))).toMatchObject({ hint: "record_sms:not_sendable" });
    for (const type of ["meeting_reminder", "verification_code", "punch_card_notice"]) {
      const t = await template(owner.id, org, { name: `סוג ${type}`, type, body: "שלום" });
      expect((await pgError(send(member.id, org, "lead", id, t))).hint, type).toBe("record_sms:type");
    }
    const collection = await template(owner.id, org, { name: "גבייה", type: "collection", body: "שלום {שם פרטי}" });
    const FEATURES = { collection: true, documents: true, payments: true };
    const setFeatures = (features: Record<string, boolean>) =>
      asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1", [org, JSON.stringify(features)]));
    await setFeatures(FEATURES);
    try {
      expect((await pgError(send(member.id, org, "lead", id, collection))).hint).toBe("record_sms:collection");
      expect((await payloadOf((await send(owner.id, org, "lead", id, collection)).job_id)).message_type).toBe("collection");
      for (const key of ["collection", "documents", "payments"]) {
        await setFeatures({ ...FEATURES, [key]: false });
        expect((await pgError(send(owner.id, org, "lead", id, collection))).hint, key).toBe(`feature:${key}`);
        await setFeatures(FEATURES);
      }
    } finally {
      await setFeatures(FEATURES);
    }
  });

  it("marketing needs the queue's consent check: refused without an SMS grant, sent with one, refused again after an opt-out", async () => {
    const marketing = await template(owner.id, org, { name: "מבצע", type: "marketing", body: "שלום {שם פרטי}, מבצע החודש. {שם העסק}" });
    const id = await lead(member.id, org, "0521110005");
    const first = await send(member.id, org, "lead", id, marketing);
    expect(await maySend(await claimOne(first.job_id))).toEqual({ may_send: false, reason: "consent_missing" });
    expect((await queue(member.id, org, "lead", id))[0]).toMatchObject({ job_id: first.job_id, state: "not_sent", reason: "consent" });
    // an email grant is not an SMS grant
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה')", [org, id]),
    );
    const second = await send(member.id, org, "lead", id, marketing);
    expect(await maySend(await claimOne(second.job_id))).toEqual({ may_send: true });
    await asUser(member.id, (q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'withdrawn', 'manual', 'ביקש')", [org, id]),
    );
    const third = await send(member.id, org, "lead", id, marketing);
    expect((await maySend(await claimOne(third.job_id))).may_send).toBe(false);
  });

  it("HEB-09: while sending is paused the SMS is queued, said so, and waits", async () => {
    const pausedOwner = await createUser("sms-pause-owner");
    const pausedOrg = await createOrg(pausedOwner.id, "עסק עצור");
    await allowSms(pausedOrg);
    const tpl = await template(pausedOwner.id, pausedOrg, { name: "מסמך" });
    const id = await lead(pausedOwner.id, pausedOrg, "0521110006");
    await asUser(pausedOwner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [pausedOrg]));
    const answer = await send(pausedOwner.id, pausedOrg, "lead", id, tpl);
    expect(answer.paused).toBe(true);
    expect(await maySend(await claimOne(answer.job_id))).toEqual({ may_send: false, reason: "sending_paused", retry: true });
    expect((await queue(pausedOwner.id, pausedOrg, "lead", id))[0]).toMatchObject({ state: "waiting" });
  });

  it("at most 30 SMS a person an hour, across businesses, counted apart from emails", async () => {
    const id = await lead(owner.id, org, "0521110007", other.id);
    const fill = (o: string, record: string, user: string, key: string, channel: string) =>
      asAdmin((q) =>
        q(
          `select app.enqueue_job($1, 'message.send', jsonb_build_object('channel', $5::text, 'lead_id', $2::text, 'message_type', 'requested_document',
                  $4::text, $3::text)) from generate_series(1, 30)`,
          [o, record, user, key, channel],
        ),
      );
    // 30 emails of the person do not count for SMS
    await fill(org, id, other.id, "reply_to_user_id", "email");
    expect((await send(other.id, org, "lead", id, service)).job_id).toBeTruthy();
    await fill(org, id, other.id, "sent_by_user_id", "sms");
    expect((await pgError(send(other.id, org, "lead", id, service))).hint).toBe("record_sms:rate");
    expect((await send(owner.id, org, "lead", id, service)).job_id).toBeTruthy();
    // 30 SMS in another business stop the person here too
    const second = await createUser("sms-rate-two");
    const orgC = await createOrg(second.id, "עסק שלישי");
    const leadC = await lead(second.id, orgC, "0521110008");
    await fill(orgC, leadC, second.id, "sent_by_user_id", "sms");
    const token = await asUser(owner.id, async (q) => (await q<{ t: string }>("select public.create_invitation($1, $2, 'member') as t", [org, (await asAdmin(async (qq) => (await qq<{ e: string }>("select email as e from auth.users where id = $1", [second.id])).rows[0].e))])).rows[0].t);
    await asUser(second.id, (q) => q("select public.accept_invitation($1)", [token]));
    const here = await lead(owner.id, org, "0521110009", second.id);
    expect((await pgError(send(second.id, org, "lead", here, service))).hint).toBe("record_sms:rate");
  });

  it("the payload: sent_by_user_id and automation_id are SMS only, never both; the email-only ids stay email only", async () => {
    const ok = (payload: Payload) => asAdmin(async (q) => (await q<{ ok: boolean }>("select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify(payload)])).rows[0].ok);
    const id = "11111111-1111-4111-8111-111111111111";
    const base = { channel: "sms", contact_id: id, message_type: "marketing", template_id: id };
    expect(await ok({ ...base, sent_by_user_id: id, deal_id: id })).toBe(true);
    expect(await ok({ ...base, automation_id: id, deal_id: id })).toBe(true);
    expect(await ok({ ...base, sent_by_user_id: id, automation_id: id })).toBe(false);
    expect(await ok({ ...base, channel: "email", sent_by_user_id: id })).toBe(false);
    expect(await ok({ ...base, channel: "whatsapp", automation_id: id })).toBe(false);
    expect(await ok({ ...base, channel: "whatsapp", deal_id: id })).toBe(false);
    expect(await ok({ ...base, sent_by_user_id: "me" })).toBe(false);
    expect(await ok({ ...base, automation_id: 5 })).toBe(false);
    expect(await ok({ ...base, file_ids: [id] })).toBe(false);
    expect(await ok({ ...base, reply_to_user_id: id })).toBe(false);
    // a deal names the deal's contact, never a lead
    expect(await ok({ channel: "sms", lead_id: id, message_type: "marketing", deal_id: id })).toBe(false);
    // EML-02's email payload is unchanged
    expect(await ok({ channel: "email", contact_id: id, message_type: "collection", deal_id: id, file_ids: [id], reply_to_user_id: id })).toBe(true);
  });

  it("grants: the person's call and the list are for authenticated only; the definer halves only through the call or the engine", async () => {
    const rights = await asAdmin(
      async (q) =>
        (
          await q<{ role: string; send: boolean; list: boolean; enqueue: boolean; step: boolean; rule: boolean }>(
            `select r as role,
                    has_function_privilege(r, 'public.record_sms_send(uuid,text,uuid,uuid)', 'execute') as send,
                    has_function_privilege(r, 'public.record_sms_queue(uuid,text,uuid)', 'execute') as list,
                    has_function_privilege(r, 'app.record_sms_enqueue(uuid,text,uuid,uuid)', 'execute') as enqueue,
                    has_function_privilege(r, 'app.automation_send_sms(public.automations,text,uuid,uuid)', 'execute') as step,
                    has_function_privilege(r, 'app.record_sms_template_refusal(uuid,uuid,boolean)', 'execute') as rule
               from unnest(array['anon', 'authenticated']) r order by 1`,
          )
        ).rows,
    );
    expect(rights).toEqual([
      { role: "anon", send: false, list: false, enqueue: false, step: false, rule: false },
      { role: "authenticated", send: true, list: true, enqueue: true, step: false, rule: false },
    ]);
  });

  describe("the automation step send_sms", () => {
    const rule = (entity: string, actions: Array<Record<string, unknown>>) =>
      asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'SMS מאוטומציה', $2, 'created', '{}', '[]', $3, false) returning id`,
            [org, entity, JSON.stringify(actions)],
          )
        ).rows[0].id,
      );
    const run = async (ruleId: string, entity: string, record: string) =>
      (await asAdmin(async (q) => (await q<{ s: Step[] }>("select app.run_automation_actions(a, $2, $3) as s from public.automations a where a.id = $1", [ruleId, entity, record])).rows[0].s));
    const jobsOf = (ruleId: string) =>
      asAdmin(async (q) => (await q<{ id: string; payload: Payload }>("select id, payload from app.jobs where payload ->> 'automation_id' = $1 order by created_at, id", [ruleId])).rows);

    it("queues one job of ids only on a lead, a contact and a deal (to its contact)", async () => {
      const l = await lead(owner.id, org, "0521110010");
      const leadRule = await rule("lead", [{ type: "send_sms", template_id: service }]);
      expect(await run(leadRule, "lead", l)).toEqual([{ action: "send_sms", status: "ok" }]);
      expect((await jobsOf(leadRule)).map((j) => j.payload)).toEqual([
        { channel: "sms", lead_id: l, message_type: "requested_document", template_id: service, automation_id: leadRule },
      ]);
      const c = await contact(owner.id, org, "0521110011");
      const d = await deal(owner.id, org, c);
      const dealRule = await rule("deal", [{ type: "send_sms", template_id: service }]);
      expect(await run(dealRule, "deal", d)).toEqual([{ action: "send_sms", status: "ok" }]);
      expect((await jobsOf(dealRule))[0].payload).toMatchObject({ contact_id: c, deal_id: d, automation_id: dealRule });
      const contactRule = await rule("contact", [{ type: "send_sms", template_id: service }]);
      expect(await run(contactRule, "contact", c)).toEqual([{ action: "send_sms", status: "ok" }]);
      expect((await jobsOf(contactRule))[0].payload).toMatchObject({ contact_id: c, automation_id: contactRule });
      expect((await jobsOf(contactRule))[0].payload).not.toHaveProperty("deal_id");
      // automation SMS are not in a card's list
      expect(await queue(owner.id, org, "lead", l)).toEqual([]);
    });

    it("names each refusal as a step error and queues nothing", async () => {
      const cases: Array<[string, () => Promise<{ entity: string; record: string; template: unknown }>, string]> = [
        ["no phone", async () => ({ entity: "lead", record: await lead(owner.id, org, null), template: service }), "the record has no phone"],
        ["no contact", async () => ({ entity: "deal", record: await deal(owner.id, org, null), template: service }), "the deal has no contact"],
        ["missing template", async () => ({ entity: "lead", record: await lead(owner.id, org, "0521110012"), template: "11111111-1111-4111-8111-111111111111" }), "the SMS template no longer exists"],
        ["malformed template", async () => ({ entity: "lead", record: await lead(owner.id, org, "0521110013"), template: "x" }), "the SMS template no longer exists"],
        ["email template", async () => ({ entity: "lead", record: await lead(owner.id, org, "0521110014"), template: await template(owner.id, org, { name: "אימייל לאוטומציה", channel: "email" }) }), "the template is not an SMS template"],
        ["meeting reminder", async () => ({ entity: "lead", record: await lead(owner.id, org, "0521110015"), template: await template(owner.id, org, { name: "תזכורת", type: "meeting_reminder", body: "שלום" }) }), "this message type is not sent by an automation"],
        ["inactive", async () => ({ entity: "lead", record: await lead(owner.id, org, "0521110016"), template: await template(owner.id, org, { name: "כבויה לאוטומציה", active: false }) }), "the SMS template is off"],
        ["link", async () => ({ entity: "lead", record: await lead(owner.id, org, "0521110017"), template: await template(owner.id, org, { name: "קישור לאוטומציה", body: "ראו www.example.com" }) }), "the SMS template cannot be sent"],
      ];
      for (const [label, setup, error] of cases) {
        const { entity, record, template: tpl } = await setup();
        const ruleId = await rule(entity, [{ type: "send_sms", template_id: tpl }]);
        expect(await run(ruleId, entity, record), label).toEqual([{ action: "send_sms", status: "error", error }]);
        expect(await jobsOf(ruleId), label).toEqual([]);
      }
      // another business's template, a task rule and a binned record
      const theirs = await template(ownerB.id, orgB, { name: "שלהם לאוטומציה" });
      const l = await lead(owner.id, org, "0521110018");
      const foreign = await rule("lead", [{ type: "send_sms", template_id: theirs }]);
      expect(await run(foreign, "lead", l)).toEqual([{ action: "send_sms", status: "error", error: "the SMS template no longer exists" }]);
      expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.jobs where organization_id = $1", [orgB])).rows[0].n)).toBe(0);
      const task = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.tasks (organization_id, title, lead_id) values ($1, 'משימה', $2) returning id", [org, l])).rows[0].id);
      const taskRule = await rule("task", [{ type: "send_sms", template_id: service }]);
      expect(await run(taskRule, "task", task)).toEqual([{ action: "send_sms", status: "error", error: "an SMS goes to a lead, a contact or a deal's contact" }]);
      await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [l]));
      const binned = await rule("lead", [{ type: "send_sms", template_id: service }]);
      expect((await run(binned, "lead", l))[0]).toMatchObject({ status: "error" });
      expect(await jobsOf(binned)).toEqual([]);
    });

    it("collection needs the plan keys, not a person's right; marketing is judged by the queue's consent check", async () => {
      const collection = await template(owner.id, org, { name: "גבייה לאוטומציה", type: "collection", body: "שלום {שם פרטי}" });
      const setFeatures = (features: Record<string, boolean>) =>
        asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1", [org, JSON.stringify(features)]));
      const l = await lead(owner.id, org, "0521110019");
      const ruleId = await rule("lead", [{ type: "send_sms", template_id: collection }]);
      await setFeatures({ collection: true, documents: true, payments: false });
      try {
        expect(await run(ruleId, "lead", l)).toEqual([{ action: "send_sms", status: "error", error: "collection messages are not in the plan" }]);
        await setFeatures({ payments: true });
        expect(await run(ruleId, "lead", l)).toEqual([{ action: "send_sms", status: "ok" }]);
      } finally {
        await setFeatures({ collection: true, documents: true, payments: true });
      }
      const marketing = await template(owner.id, org, { name: "מבצע לאוטומציה", type: "marketing", body: "שלום {שם פרטי}. {שם העסק}" });
      const m = await lead(owner.id, org, "0521110020");
      const mRule = await rule("lead", [{ type: "send_sms", template_id: marketing }]);
      expect(await run(mRule, "lead", m)).toEqual([{ action: "send_sms", status: "ok" }]);
      const [job] = await jobsOf(mRule);
      expect(job.payload.message_type).toBe("marketing");
      expect(await maySend(await claimOne(job.id))).toEqual({ may_send: false, reason: "consent_missing" });
    });

    it("HEB-09: while sending is paused the job is queued and the step says so", async () => {
      const l = await lead(owner.id, org, "0521110021");
      const ruleId = await rule("lead", [{ type: "send_sms", template_id: service }]);
      await asUser(owner.id, (q) =>
        q(
          `insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'עצירה')
           on conflict (organization_id) do update set paused = true, reason = 'עצירה'`,
          [org],
        ),
      );
      try {
        expect(await run(ruleId, "lead", l)).toEqual([{ action: "send_sms", status: "ok", warning: "customer sending is paused" }]);
        const [job] = await jobsOf(ruleId);
        expect(await maySend(await claimOne(job.id))).toEqual({ may_send: false, reason: "sending_paused", retry: true });
      } finally {
        await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
      }
    });
  });

  describe("owner (210) ב: the plan's sms flag and month quota over every SMS to a customer", () => {
    const noSms = (o: string) =>
      asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"sms\": false}'::jsonb where organization_id = $1", [o]));
    const enqueue = (o: string, payload: Payload) =>
      asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [o, JSON.stringify(payload)])).rows[0].id);

    it("the plans: personal off and 0, basic 100, pro 300, business 1,000; the fallback off and 0", async () => {
      const plans = await asAdmin(
        async (q) =>
          (
            await q<{ key: string; f: boolean; l: number }>(
              "select key, (features ->> 'sms')::boolean as f, (limits ->> 'max_sms_per_month')::numeric::int as l from public.plans where key in ('personal', 'basic', 'pro', 'business') order by position",
            )
          ).rows,
      );
      expect(plans).toEqual([
        { key: "personal", f: false, l: 0 },
        { key: "basic", f: true, l: 100 },
        { key: "pro", f: true, l: 300 },
        { key: "business", f: true, l: 1000 },
      ]);
      const fallback = await asAdmin(async (q) => (await q<{ d: { features: Record<string, unknown>; limits: Record<string, unknown> } }>("select app.plan_key_defaults() as d")).rows[0].d);
      expect([fallback.features.sms, fallback.limits.max_sms_per_month]).toEqual([false, 0]);
    });

    it("without the flag the card is refused (feature:sms), the step fails, and any other SMS waits uncounted", async () => {
      const plainOwner = await createUser("sms-plain-owner");
      const plainOrg = await createOrg(plainOwner.id, "עסק בלי SMS");
      await noSms(plainOrg);
      const tpl = await template(plainOwner.id, plainOrg, { name: "מסמך" });
      const id = await lead(plainOwner.id, plainOrg, "0521110030");
      expect((await pgError(send(plainOwner.id, plainOrg, "lead", id, tpl))).hint).toBe("feature:sms");
      const ruleId = await asUser(plainOwner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'SMS', 'lead', 'created', '{}', '[]', $2, false) returning id`,
            [plainOrg, JSON.stringify([{ type: "send_sms", template_id: tpl }])],
          )
        ).rows[0].id,
      );
      const steps = await asAdmin(async (q) =>
        (await q<{ s: Step[] }>("select app.run_automation_actions(a, 'lead', $2) as s from public.automations a where a.id = $1", [ruleId, id])).rows[0].s,
      );
      expect(steps).toEqual([{ action: "send_sms", status: "error", error: "SMS is not in the plan" }]);
      // a meeting reminder or a punch card notice queued by its own path waits; an email does not
      const sms = await enqueue(plainOrg, { channel: "sms", message_type: "requested_document", lead_id: id });
      expect(await maySend(await claimOne(sms))).toEqual({ may_send: false, reason: "sms_off", retry: true });
      expect(await asAdmin(async (q) => (await q<{ e: string; c: boolean }>("select last_error as e, usage_counted as c from app.jobs where id = $1", [sms])).rows[0])).toEqual({
        e: "waiting:sms_off",
        c: false,
      });
    });

    it("the quota holds every SMS when it is about to go, never a verification code; the owners are told; a raise lets it go", async () => {
      const qOwner = await createUser("sms-quota-owner");
      const qOrg = await createOrg(qOwner.id, "עסק מכסה");
      await allowSms(qOrg);
      const setCap = (cap: number) =>
        asAdmin((q) => q("update public.subscriptions set limit_overrides = limit_overrides || jsonb_build_object('max_sms_per_month', $2::int) where organization_id = $1", [qOrg, cap]));
      await setCap(2);
      const tpl = await template(qOwner.id, qOrg, { name: "מסמך" });
      const smsNotices = () =>
        asAdmin(
          async (q) =>
            (await q<{ title: string }>("select title from public.notifications where organization_id = $1 and type = 'system' and title like '%SMS%' order by created_at", [qOrg]))
              .rows.map((n) => n.title),
        );
      const used = () =>
        asAdmin(async (q) => (await q<{ used: number }>("select used from app.sms_quota_months where organization_id = $1", [qOrg])).rows.map((r) => r.used));
      const l1 = await lead(qOwner.id, qOrg, "0521110031");
      // a card SMS and a CAL-12-like service SMS of another path: both counted
      const card = await send(qOwner.id, qOrg, "lead", l1, tpl);
      expect(await maySend(await claimOne(card.job_id))).toEqual({ may_send: true });
      const other = await enqueue(qOrg, { channel: "sms", message_type: "requested_document", lead_id: l1 });
      expect(await maySend(await claimOne(other))).toEqual({ may_send: true });
      expect(await used()).toEqual([2]);
      expect(await smsNotices()).toEqual(["הודעות SMS מחכות: מכסת החבילה מלאה"]);
      // over the quota: the next one waits uncounted as a cap waiter, one notice a day
      const third = await send(qOwner.id, qOrg, "lead", await lead(qOwner.id, qOrg, "0521110033"), tpl);
      expect(await maySend(await claimOne(third.job_id))).toEqual({ may_send: false, reason: "over_cap", retry: true });
      expect(await asAdmin(async (q) => (await q<{ w: string | null; c: boolean }>("select cap_wait as w, usage_counted as c from app.jobs where id = $1", [third.job_id])).rows[0])).toEqual({
        w: "over_cap",
        c: false,
      });
      expect(await smsNotices()).toEqual(["הודעות SMS מחכות: מכסת החבילה מלאה"]);
      expect(await used()).toEqual([2]);
      // a verification code is never counted and never held
      const check = await asAdmin(async (q) => (await q<{ id: string }>("insert into app.sms_sender_checks (organization_id, phone) values ($1, '+972521110031') returning id", [qOrg])).rows[0].id);
      const code = await enqueue(qOrg, { channel: "sms", message_type: "verification_code", sender_check_id: check });
      expect(await maySend(await claimOne(code))).toEqual({ may_send: true });
      expect(await used()).toEqual([2]);
      // a raised quota lets the waiting one go
      await setCap(10);
      await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [third.job_id]));
      expect(await maySend(await claimOne(third.job_id))).toEqual({ may_send: true });
      expect(await used()).toEqual([3]);
      // a new month starts again (the counter of the month)
      await setCap(3);
      await asAdmin((q) => q("update app.sms_quota_months set month = (month - interval '1 month')::date where organization_id = $1", [qOrg]));
      const next = await send(qOwner.id, qOrg, "lead", l1, tpl);
      expect(await maySend(await claimOne(next.job_id))).toEqual({ may_send: true });
    });
  });

  describe("review F4: who pressed, and one SMS per rule and record a day", () => {
    it("a button run's collection SMS needs the presser's payments right", async () => {
      const collection = await template(owner.id, org, { name: "גבייה לכפתור", type: "collection", body: "שלום {שם פרטי}" });
      await asAdmin((q) =>
        q("update public.subscriptions set feature_overrides = feature_overrides || '{\"collection\": true, \"documents\": true, \"payments\": true}'::jsonb where organization_id = $1", [org]),
      );
      const ruleId = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'כפתור גבייה', 'lead', 'manual', '{}', '[]', $2, true) returning id`,
            [org, JSON.stringify([{ type: "send_sms", template_id: collection }])],
          )
        ).rows[0].id,
      );
      const stepsOf = (record: string) =>
        asAdmin(
          async (q) =>
            (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1 and entity_id = $2 order by created_at desc limit 1", [ruleId, record])).rows[0]
              ?.steps,
        );
      const press = (user: string, record: string) => asUser(user, (q) => q("select public.run_manual_automation($1, $2, $3)", [org, ruleId, record]));
      const mine = await lead(member.id, org, "0521110034", member.id);
      await press(member.id, mine);
      expect((await stepsOf(mine))?.[0]).toMatchObject({ action: "send_sms", status: "error", error: "collection messages need the payments right of the person who pressed" });
      const ownerLead = await lead(owner.id, org, "0521110035");
      await press(owner.id, ownerLead);
      expect((await stepsOf(ownerLead))?.[0]).toMatchObject({ action: "send_sms", status: "ok" });
    });

    it("review (2): a collection SMS step is saved only by a payment recorder; other steps and other writers are untouched", async () => {
      const collection = await template(owner.id, org, { name: "גבייה לשמירה", type: "collection", body: "שלום {שם פרטי}" });
      // a member who manages automations (PRM-01 grant) but does not record payments
      const keeper = await addMember(org, owner.id, "member", "sms-rule-keeper");
      await asAdmin(async (q) => {
        await q("update public.subscriptions set feature_overrides = feature_overrides || '{\"granular_permissions\": true}'::jsonb where organization_id = $1", [org]);
        await q("insert into public.member_permissions (organization_id, user_id, permissions) values ($1, $2, array['manage_automations']) on conflict (organization_id, user_id) do update set permissions = excluded.permissions", [org, keeper.id]);
      });
      const insertAs = (user: string, templateId: string) =>
        asUser(user, async (q) =>
          (
            await q<{ id: string }>(
              `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
               values ($1, 'גבייה', 'lead', 'created', '{}', '[]', $2, false) returning id`,
              [org, JSON.stringify([{ type: "send_sms", template_id: templateId }])],
            )
          ).rows[0].id,
        );
      expect((await pgError(insertAs(keeper.id, collection))).hint).toBe("automation:sms_collection");
      expect(await insertAs(keeper.id, service)).toBeTruthy();
      const saved = await insertAs(owner.id, collection);
      // an unrelated edit of the owner's rule by the keeper keeps the step it already held
      await asUser(keeper.id, (q) => q("update public.automations set name = 'גבייה 2', actions = actions where id = $1", [saved]));
      expect(
        await asAdmin(async (q) => (await q<{ name: string }>("select name from public.automations where id = $1", [saved])).rows[0].name),
      ).toBe("גבייה 2");
      // but adding a collection step to a rule is refused
      const plain = await insertAs(keeper.id, service);
      expect(
        (
          await pgError(
            asUser(keeper.id, (q) =>
              q("update public.automations set actions = actions || $2::jsonb where id = $1", [plain, JSON.stringify([{ type: "send_sms", template_id: collection }])]),
            ),
          )
        ).hint,
      ).toBe("automation:sms_collection");
      // a server write (no person) is not judged here
      await asAdmin((q) => q("update public.automations set actions = actions || $2::jsonb where id = $1", [plain, JSON.stringify([{ type: "send_sms", template_id: collection }])]));
    });

    it("review (7): a button press counts in the presser's 30 SMS an hour", async () => {
      const presser = await addMember(org, owner.id, "member", "sms-presser");
      const ruleId = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, 'כפתור SMS', 'lead', 'manual', '{}', '[]', $2, true) returning id`,
            [org, JSON.stringify([{ type: "send_sms", template_id: service }])],
          )
        ).rows[0].id,
      );
      const press = (record: string) => asUser(presser.id, (q) => q("select public.run_manual_automation($1, $2, $3)", [org, ruleId, record]));
      const stepOf = async (record: string) =>
        (
          await asAdmin(async (q) =>
            (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1 and entity_id = $2 order by created_at desc limit 1", [ruleId, record]))
              .rows[0],
          )
        )?.steps[0];
      const first = await lead(presser.id, org, "0521110040", presser.id);
      await press(first);
      expect(await stepOf(first)).toMatchObject({ status: "ok" });
      const [job] = await asAdmin(async (q) => (await q<{ payload: Payload }>("select payload from app.jobs where payload ->> 'automation_id' = $1", [ruleId])).rows);
      expect(job.payload).toMatchObject({ automation_id: ruleId, pressed_by_user_id: presser.id });
      // 29 card SMS by the same person in the hour: the press made 30, the next press is held back (no SMS)
      for (let i = 0; i < 29; i += 1) {
        await asAdmin((q) =>
          q("select app.enqueue_job($1, 'message.send', $2::jsonb, null)", [
            org,
            JSON.stringify({ channel: "sms", message_type: "requested_document", lead_id: first, template_id: service, sent_by_user_id: presser.id }),
          ]),
        );
      }
      const second = await lead(presser.id, org, "0521110041", presser.id);
      await press(second);
      expect(await stepOf(second)).toMatchObject({ status: "ok", warning: "too many SMS this hour by the person who pressed" });
      // and the card counts the presses too
      expect((await pgError(send(presser.id, org, "lead", second, service))).hint).toBe("record_sms:rate");
    });

    it("a second SMS of the same rule to the same record on the same business day queues nothing and warns", async () => {
      const l = await lead(owner.id, org, "0521110036");
      const mk = () =>
        asUser(owner.id, async (q) =>
          (
            await q<{ id: string }>(
              `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
               values ($1, 'SMS יומי', 'lead', 'created', '{}', '[]', $2, false) returning id`,
              [org, JSON.stringify([{ type: "send_sms", template_id: service }])],
            )
          ).rows[0].id,
        );
      const runOn = async (ruleId: string) =>
        (await asAdmin(async (q) => (await q<{ s: Step[] }>("select app.run_automation_actions(a, 'lead', $2) as s from public.automations a where a.id = $1", [ruleId, l])).rows[0].s));
      const count = (ruleId: string) =>
        asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.jobs where payload ->> 'automation_id' = $1", [ruleId])).rows[0].n);
      const a = await mk();
      expect(await runOn(a)).toEqual([{ action: "send_sms", status: "ok" }]);
      expect(await runOn(a)).toEqual([{ action: "send_sms", status: "ok", warning: "an SMS was already sent today by this rule" }]);
      expect(await count(a)).toBe(1);
      // another rule is its own count
      const b = await mk();
      expect(await runOn(b)).toEqual([{ action: "send_sms", status: "ok" }]);
      // the next business day sends again
      await asAdmin((q) => q("update app.jobs set created_at = created_at - interval '1 day' where payload ->> 'automation_id' = $1", [a]));
      expect(await runOn(a)).toEqual([{ action: "send_sms", status: "ok" }]);
      expect(await count(a)).toBe(2);
    });
  });
});
