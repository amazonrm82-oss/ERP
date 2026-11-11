import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string) =>
  asAdmin((q) =>
    q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );
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
          fields.body ?? "שלום {שם פרטי}, המסמך בדרך. {שם העסק}",
          fields.active ?? true,
        ],
      )
    ).rows[0].id,
  );
const lead = (user: string, org: string, email: string | null, phone: string | null = null) =>
  insertLead(user, org, { full_name: "ליד אימייל", email, phone, owner_id: user });
const contact = (user: string, org: string, email: string | null, owner = user) =>
  asUser(
    user,
    async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, email, owner_id) values ($1, 'דנה', $2, $3) returning id", [org, email, owner]))
        .rows[0].id,
  );
const deal = async (user: string, org: string, contactId: string | null) => {
  const { pipelineId, stages } = await defaultPipeline(org);
  return asUser(
    user,
    async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקת אימייל', $2, $3, $4, $5) returning id",
          [org, pipelineId, stages[0].id, contactId, user],
        )
      ).rows[0].id,
  );
};

/**
 * AUT-08: an automation step that queues one email of the business's email template, with send_sms's rules (SMS-02): an
 * OPS-04 message.send job of ids only, judged by the queue's own send check; nothing on the worker's path changes.
 */
describe("the automation step send_email (AUT-08)", () => {
  let owner: { id: string }, member: { id: string }, ownerB: { id: string };
  let org: string, orgB: string;
  let service: string;

  const rule = (entity: string, actions: Array<Record<string, unknown>>, by: { id: string } = owner) =>
    asUser(by.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'אימייל מאוטומציה', $2, 'created', '{}', '[]', $3, false) returning id`,
          [org, entity, JSON.stringify(actions)],
        )
      ).rows[0].id,
    );
  const run = async (ruleId: string, entity: string, record: string) =>
    await asAdmin(async (q) => (await q<{ s: Step[] }>("select app.run_automation_actions(a, $2, $3) as s from public.automations a where a.id = $1", [ruleId, entity, record])).rows[0].s);
  const jobsOf = (ruleId: string) =>
    asAdmin(async (q) => (await q<{ id: string; payload: Payload }>("select id, payload from app.jobs where payload ->> 'automation_id' = $1 order by created_at, id", [ruleId])).rows);
  const stepOfRun = async (ruleId: string, record: string) =>
    (
      await asAdmin(async (q) =>
        (await q<{ steps: Step[] }>("select steps from public.automation_runs where automation_id = $1 and entity_id = $2 order by created_at desc limit 1", [ruleId, record]))
          .rows[0],
      )
    )?.steps[0];

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("eml-auto-owner");
    org = await createOrg(owner.id, "עסק אימייל");
    member = await addMember(org, owner.id, "member", "eml-auto-member");
    ownerB = await createUser("eml-auto-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
    await allowSms(org);
    service = await template(owner.id, org, { name: "מסמך מבוקש אימייל" });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await setKey(KEY);
    await closePool();
  });

  it("queues one job of ids only on a lead, a contact and a deal (to its contact); no reply-to and no files", async () => {
    const l = await lead(owner.id, org, "lead-auto@example.test");
    const leadRule = await rule("lead", [{ type: "send_email", template_id: service }]);
    expect(await run(leadRule, "lead", l)).toEqual([{ action: "send_email", status: "ok" }]);
    expect((await jobsOf(leadRule)).map((j) => j.payload)).toEqual([
      { channel: "email", lead_id: l, message_type: "requested_document", template_id: service, automation_id: leadRule },
    ]);
    const c = await contact(owner.id, org, "contact-auto@example.test");
    const d = await deal(owner.id, org, c);
    const dealRule = await rule("deal", [{ type: "send_email", template_id: service }]);
    expect(await run(dealRule, "deal", d)).toEqual([{ action: "send_email", status: "ok" }]);
    expect((await jobsOf(dealRule))[0].payload).toMatchObject({ channel: "email", contact_id: c, deal_id: d, automation_id: dealRule });
    const contactRule = await rule("contact", [{ type: "send_email", template_id: service }]);
    expect(await run(contactRule, "contact", c)).toEqual([{ action: "send_email", status: "ok" }]);
    const [job] = await jobsOf(contactRule);
    expect(job.payload).not.toHaveProperty("deal_id");
    expect(job.payload).not.toHaveProperty("reply_to_user_id");
    // a service email goes (no consent needed); it is not in a card's list
    expect(await maySend(await claimOne(job.id))).toEqual({ may_send: true });
    expect(await asUser(owner.id, async (q) => (await q<{ r: unknown[] }>("select public.record_email_queue($1, 'contact', $2) as r", [org, c])).rows[0].r)).toEqual([]);
  });

  it("the payload rule: automation_id on email, never with a reply-to person or files; sent_by_user_id stays sms", async () => {
    const l = await lead(owner.id, org, "payload-auto@example.test");
    const enqueue = (payload: Payload) =>
      asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify(payload)])).rows[0].id);
    const base = { channel: "email", lead_id: l, message_type: "requested_document", template_id: service, automation_id: service };
    await enqueue(base);
    await enqueue({ ...base, pressed_by_user_id: owner.id });
    for (const extra of [{ reply_to_user_id: owner.id }, { file_ids: [service] }, { library_file_ids: [service] }, { sent_by_user_id: owner.id }]) {
      expect((await pgError(enqueue({ ...base, ...extra }))).hint, JSON.stringify(extra)).toBe("job:payload");
    }
    expect((await pgError(enqueue({ ...base, channel: "whatsapp" }))).hint).toBe("job:payload");
  });

  it("names each refusal as a step error and queues nothing", async () => {
    const cases: Array<[string, () => Promise<{ entity: string; record: string; template: unknown }>, string]> = [
      ["no email", async () => ({ entity: "lead", record: await lead(owner.id, org, null, "0521113001"), template: service }), "the record has no email"],
      ["no contact", async () => ({ entity: "deal", record: await deal(owner.id, org, null), template: service }), "the deal has no contact"],
      ["missing template", async () => ({ entity: "lead", record: await lead(owner.id, org, "r1@example.test"), template: "11111111-1111-4111-8111-111111111111" }), "the email template no longer exists"],
      ["malformed template", async () => ({ entity: "lead", record: await lead(owner.id, org, "r2@example.test"), template: "x" }), "the email template no longer exists"],
      ["sms template", async () => ({ entity: "lead", record: await lead(owner.id, org, "r3@example.test"), template: await template(owner.id, org, { name: "SMS לאוטומציה", channel: "sms" }) }), "the template is not an email template"],
      ["meeting reminder", async () => ({ entity: "lead", record: await lead(owner.id, org, "r4@example.test"), template: await template(owner.id, org, { name: "תזכורת", type: "meeting_reminder", body: "שלום" }) }), "this message type is not sent by an automation"],
      ["inactive", async () => ({ entity: "lead", record: await lead(owner.id, org, "r5@example.test"), template: await template(owner.id, org, { name: "כבויה לאוטומציה", active: false }) }), "the email template is off"],
      ["link", async () => ({ entity: "lead", record: await lead(owner.id, org, "r6@example.test"), template: await template(owner.id, org, { name: "קישור לאוטומציה", body: "ראו www.example.com" }) }), "the email template cannot be sent"],
    ];
    for (const [label, setup, error] of cases) {
      const { entity, record, template: tpl } = await setup();
      const ruleId = await rule(entity, [{ type: "send_email", template_id: tpl }]);
      expect(await run(ruleId, entity, record), label).toEqual([{ action: "send_email", status: "error", error }]);
      expect(await jobsOf(ruleId), label).toEqual([]);
    }
    // a template the system sends itself (notice_kind) is never a rule's
    const marked = await template(owner.id, org, { name: "מסומנת" });
    await asAdmin((q) => q("update public.message_templates set notice_kind = 'signature_reminder' where id = $1", [marked]));
    const l0 = await lead(owner.id, org, "r7@example.test");
    const markedRule = await rule("lead", [{ type: "send_email", template_id: marked }]);
    expect(await run(markedRule, "lead", l0)).toEqual([{ action: "send_email", status: "error", error: "the system sends this template itself, not an automation" }]);
    // another business's template, a task rule and a binned record
    const theirs = await template(ownerB.id, orgB, { name: "שלהם לאוטומציה" });
    const l = await lead(owner.id, org, "r8@example.test");
    const foreign = await rule("lead", [{ type: "send_email", template_id: theirs }]);
    expect(await run(foreign, "lead", l)).toEqual([{ action: "send_email", status: "error", error: "the email template no longer exists" }]);
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.jobs where organization_id = $1", [orgB])).rows[0].n)).toBe(0);
    const task = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.tasks (organization_id, title, lead_id) values ($1, 'משימה', $2) returning id", [org, l])).rows[0].id);
    const taskRule = await rule("task", [{ type: "send_email", template_id: service }]);
    expect(await run(taskRule, "task", task)).toEqual([{ action: "send_email", status: "error", error: "an email goes to a lead, a contact or a deal's contact" }]);
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [l]));
    const binned = await rule("lead", [{ type: "send_email", template_id: service }]);
    expect(await run(binned, "lead", l)).toEqual([{ action: "send_email", status: "error", error: "the record is in the recycle bin" }]);
    expect(await jobsOf(binned)).toEqual([]);
  });

  it("one email per rule and record a business day; the same rule's SMS is counted apart", async () => {
    const l = await lead(owner.id, org, "daily-auto@example.test", "0521113002");
    const sms = await template(owner.id, org, { name: "SMS יומי", channel: "sms" });
    const ruleId = await rule("lead", [
      { type: "send_email", template_id: service },
      { type: "send_sms", template_id: sms },
    ]);
    expect(await run(ruleId, "lead", l)).toEqual([
      { action: "send_email", status: "ok" },
      { action: "send_sms", status: "ok" },
    ]);
    expect(await run(ruleId, "lead", l)).toEqual([
      { action: "send_email", status: "ok", warning: "an email was already sent today by this rule" },
      { action: "send_sms", status: "ok", warning: "an SMS was already sent today by this rule" },
    ]);
    // both jobs share created_at (one transaction): compare the channels sorted
    expect((await jobsOf(ruleId)).map((j) => String(j.payload.channel)).sort()).toEqual(["email", "sms"]);
  });

  it("collection: the plan keys; a step is saved only by a payment recorder; a button press judges the presser", async () => {
    const collection = await template(owner.id, org, { name: "גבייה לאוטומציה", type: "collection", body: "שלום {שם פרטי}" });
    const setFeatures = (features: Record<string, boolean>) =>
      asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1", [org, JSON.stringify(features)]));
    await setFeatures({ collection: true, documents: true, payments: true, granular_permissions: true });
    // a member who manages automations (PRM-01 grant) but does not record payments
    const keeper = await addMember(org, owner.id, "member", "eml-rule-keeper");
    await asAdmin((q) =>
      q(
        "insert into public.member_permissions (organization_id, user_id, permissions) values ($1, $2, array['manage_automations']) on conflict (organization_id, user_id) do update set permissions = excluded.permissions",
        [org, keeper.id],
      ),
    );
    expect((await pgError(rule("lead", [{ type: "send_email", template_id: collection }], keeper))).hint).toBe("automation:email_collection");
    expect(await rule("lead", [{ type: "send_email", template_id: service }], keeper)).toBeTruthy();
    // SMS keeps its own hint
    const smsCollection = await template(owner.id, org, { name: "גבייה SMS", type: "collection", channel: "sms", body: "שלום {שם פרטי}" });
    expect((await pgError(rule("lead", [{ type: "send_sms", template_id: smsCollection }], keeper))).hint).toBe("automation:sms_collection");

    const l = await lead(owner.id, org, "collect-auto@example.test");
    const ruleId = await rule("lead", [{ type: "send_email", template_id: collection }]);
    await setFeatures({ payments: false });
    try {
      expect(await run(ruleId, "lead", l)).toEqual([{ action: "send_email", status: "error", error: "collection messages are not in the plan" }]);
    } finally {
      await setFeatures({ payments: true });
    }
    expect(await run(ruleId, "lead", l)).toEqual([{ action: "send_email", status: "ok" }]);

    // a button run: the presser's payments right
    const button = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'כפתור גבייה באימייל', 'lead', 'manual', '{}', '[]', $2, true) returning id`,
          [org, JSON.stringify([{ type: "send_email", template_id: collection }])],
        )
      ).rows[0].id,
    );
    const press = (user: string, record: string) => asUser(user, (q) => q("select public.run_manual_automation($1, $2, $3)", [org, button, record]));
    const mine = await lead(member.id, org, "collect-member@example.test");
    await press(member.id, mine);
    expect(await stepOfRun(button, mine)).toMatchObject({ action: "send_email", status: "error", error: "collection messages need the payments right of the person who pressed" });
    const ownerLead = await lead(owner.id, org, "collect-owner@example.test");
    await press(owner.id, ownerLead);
    expect(await stepOfRun(button, ownerLead)).toMatchObject({ action: "send_email", status: "ok" });
  });

  it("a button press counts in the presser's 30 emails an hour, with the card's emails; its SMS count is untouched", async () => {
    const presser = await addMember(org, owner.id, "member", "eml-presser");
    const button = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
           values ($1, 'כפתור אימייל', 'lead', 'manual', '{}', '[]', $2, true) returning id`,
          [org, JSON.stringify([{ type: "send_email", template_id: service }])],
        )
      ).rows[0].id,
    );
    const press = (record: string) => asUser(presser.id, (q) => q("select public.run_manual_automation($1, $2, $3)", [org, button, record]));
    const first = await lead(presser.id, org, "press-1@example.test");
    await press(first);
    expect(await stepOfRun(button, first)).toMatchObject({ status: "ok" });
    const [job] = await jobsOf(button);
    expect(job.payload).toMatchObject({ channel: "email", automation_id: button, pressed_by_user_id: presser.id });
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select app.record_sms_sent_last_hour($1) as n", [presser.id])).rows[0].n)).toBe(0);
    // 29 card emails by the same person in the hour: the press made 30, the next press is held back
    for (let i = 0; i < 29; i += 1) {
      await asAdmin((q) =>
        q("select app.enqueue_job($1, 'message.send', $2::jsonb, null)", [
          org,
          JSON.stringify({ channel: "email", message_type: "requested_document", lead_id: first, template_id: service, reply_to_user_id: presser.id }),
        ]),
      );
    }
    const second = await lead(presser.id, org, "press-2@example.test");
    await press(second);
    expect(await stepOfRun(button, second)).toMatchObject({ status: "ok", warning: "too many emails this hour by the person who pressed" });
    expect(await jobsOf(button)).toHaveLength(1);
    // review 5: the card counts the presses too (29 card emails + 1 press = 30)
    expect((await pgError(asUser(presser.id, (q) => q("select public.record_email_send($1, 'lead', $2, $3, '{}', '{}')", [org, second, service])))).hint).toBe("record_email:rate");
  });

  it("final review: a pressed SMS or email step takes the person's two send locks, record_email then record_sms", async () => {
    const presser = await addMember(org, owner.id, "member", "eml-lock-presser");
    const sms = await template(owner.id, org, { name: "SMS לנעילה", channel: "sms" });
    for (const step of [{ type: "send_sms", template_id: sms }, { type: "send_email", template_id: service }]) {
      const button = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions, is_active)
             values ($1, $2, 'lead', 'manual', '{}', '[]', $3, true) returning id`,
            [org, `כפתור נעילה ${step.type}`, JSON.stringify([step])],
          )
        ).rows[0].id,
      );
      const record = await insertLead(presser.id, org, { full_name: "ליד נעילה", email: `lock-${step.type}@example.test`, phone: step.type === "send_sms" ? "0521113090" : null, owner_id: presser.id });
      const held = await asUser(presser.id, async (q) => {
        await q("select public.run_manual_automation($1, $2, $3)", [org, button, record]);
        const key = (name: string) =>
          q<{ n: number }>(
            `select count(*)::int as n from pg_locks
              where locktype = 'advisory' and pid = pg_backend_pid() and objsubid = 1
                and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
            [name],
          );
        return [(await key(`record_email:${presser.id}`)).rows[0].n, (await key(`record_sms:${presser.id}`)).rows[0].n];
      });
      expect(held, step.type).toEqual([1, 1]);
      expect(await stepOfRun(button, record), step.type).toMatchObject({ status: "ok" });
    }
    // and the order is fixed in both functions' bodies: record_email first
    const bodies = await asAdmin(
      async (q) =>
        (
          await q<{ src: string }>(
            "select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in ('automation_send_sms', 'automation_send_email')",
          )
        ).rows,
    );
    expect(bodies).toHaveLength(2);
    for (const { src } of bodies) {
      const email = src.indexOf("'record_email:' || v_presser::text");
      const smsAt = src.indexOf("'record_sms:' || v_presser::text");
      expect(email).toBeGreaterThan(-1);
      expect(smsAt).toBeGreaterThan(email);
      expect(email).toBeLessThan(Math.max(src.indexOf("'automation_sms:'"), src.indexOf("'automation_email:'")));
    }
  });

  it("marketing is judged by the queue's consent check; HEB-09's pause queues the job and the step says so", async () => {
    const marketing = await template(owner.id, org, { name: "מבצע לאוטומציה", type: "marketing", body: "שלום {שם פרטי}. {שם העסק}" });
    const m = await lead(owner.id, org, "promo-auto@example.test");
    const mRule = await rule("lead", [{ type: "send_email", template_id: marketing }]);
    expect(await run(mRule, "lead", m)).toEqual([{ action: "send_email", status: "ok" }]);
    const [job] = await jobsOf(mRule);
    expect(job.payload.message_type).toBe("marketing");
    expect(await maySend(await claimOne(job.id))).toEqual({ may_send: false, reason: "consent_missing" });

    const l = await lead(owner.id, org, "paused-auto@example.test");
    const ruleId = await rule("lead", [{ type: "send_email", template_id: service }]);
    await asUser(owner.id, (q) =>
      q(
        `insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'עצירה')
         on conflict (organization_id) do update set paused = true, reason = 'עצירה'`,
        [org],
      ),
    );
    try {
      expect(await run(ruleId, "lead", l)).toEqual([{ action: "send_email", status: "ok", warning: "customer sending is paused" }]);
      const [paused] = await jobsOf(ruleId);
      expect(await maySend(await claimOne(paused.id))).toEqual({ may_send: false, reason: "sending_paused", retry: true });
    } finally {
      await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    }
  });

  it("the new functions are the engine's only: no API role executes them", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ r: string; f: string; ok: boolean }>(
            `select r, f, has_function_privilege(r, f, 'execute') as ok
               from unnest(array['anon', 'authenticated', 'service_role']) r,
                    unnest(array['app.automation_send_email(public.automations,text,uuid,uuid)',
                                 'app.record_email_template_refusal(uuid,uuid,boolean)',
                                 'app.automation_email_sent_last_hour(uuid)']) f`,
          )
        ).rows,
    );
    for (const row of rows) expect(row.ok, `${row.r} ${row.f}`).toBe(false);
  });
});
