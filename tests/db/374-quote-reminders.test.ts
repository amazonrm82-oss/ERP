import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

// QUO-18, the reminders (owner's answers (381) ב, (382) א, (383) א, (384) ב): up to two reminders to a customer who did not open
// the quote, 3 and 7 business days after sending; one to a customer who opened it and did not answer, two days before the last
// day; off by default; plan key quote_reminders from basic up; through the quote send path (job with quote_id).

const KEY = "test-consent-key";
const SITE = "https://mexuz.test";

type U = { id: string; email: string };
type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

afterAll(closePool);

describe("automatic quote reminders (QUO-18)", () => {
  let owner: U, member: U, viewer: U;
  let org: string;
  let pipe: { pipelineId: string; stageId: string };
  let today: string;
  let personEmail: string, personSms: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  // a person's send of the quote through the system that went (review F6: only such a quote gets reminders)
  const personSend = async (quote: string, channel: "email" | "sms" = "email") => {
    const r = await asUser(member.id, async (q) =>
      (await one<{ r: { job_id: string } }>(q, "select public.quote_message_send($1, $2, $3, $4) as r", [org, quote, channel, channel === "email" ? personEmail : personSms])).r,
    );
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where id = $1", [r.job_id]));
  };
  const newQuote = async (opts: { email?: string | null; validDays?: number | null; send?: "email" | "sms" | false } = {}) => {
    const contact = await asUser(member.id, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, email, phone) values ($1, 'דנה', $2, '052-1234567') returning id", [
          org,
          opts.email === undefined ? "dana@example.test" : opts.email,
        ])
      ).id,
    );
    const quote = await asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipe.pipelineId,
          pipe.stageId,
          contact,
        ])
      ).id;
      const days = opts.validDays === undefined ? 60 : opts.validDays;
      const id = (
        await one<{ id: string }>(
          q,
          "insert into public.quotes (organization_id, title, deal_id, valid_until) values ($1, 'הצעה', $2, case when $3::integer is null then null else current_date + $3::integer end) returning id",
          [org, deal, days],
        )
      ).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot, position) values ($1, $2, 'עבודה', 1, 10000, 1)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    if (opts.send !== false) await personSend(quote, opts.send ?? (opts.email === null ? "sms" : "email"));
    return { contact, quote };
  };
  // the server arranges the past: the quote was sent on that business day at 10:00, its status and validity as given
  const arrange = (quote: string, fields: { sentOn?: string; status?: string; validUntil?: string | null }) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      if (fields.sentOn) {
        await q(
          "update public.quotes set sent_at = ($2::date + time '10:00') at time zone 'Asia/Jerusalem', quote_date = least(quote_date, $2::date) where id = $1",
          [quote, fields.sentOn],
        );
      }
      if (fields.status) await q("update public.quotes set status = $2 where id = $1", [quote, fields.status]);
      if (fields.validUntil !== undefined) await q("update public.quotes set valid_until = $2::date where id = $1", [quote, fields.validUntil]);
    });
  const businessDays = (from: string, n: number) =>
    asAdmin(async (q) => (await one<{ d: string }>(q, "select app.add_business_days($1, $2::date, $3)::text as d", [org, from, n])).d);
  const stage = (quote: string, day: string) =>
    asAdmin(async (q) => (await one<{ s: string | null }>(q, "select app.quote_reminder_stage(q, $2::date) as s from public.quotes q where q.id = $1", [quote, day])).s);
  const addDays = (day: string, n: number) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // the latest sending day whose 3rd business day is today or earlier and whose 7th is after today
  const sentForStage = async (n: 3 | 7) => {
    for (let back = 1; back < 40; back++) {
      const day = addDays(today, -back);
      if ((await businessDays(day, n)) <= today) return day;
    }
    throw new Error("no day");
  };
  const run = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.send_quote_reminders() as n")).n);
  const rows = (quote: string) =>
    asAdmin(async (q) => (await q<{ stage: string; outcome: string | null; channel: string | null; job_id: string | null }>("select stage, outcome, channel, job_id from app.quote_reminders where quote_id = $1 order by stage", [quote])).rows);
  const payloadOf = (job: string) => asAdmin(async (q) => (await one<{ p: Answer }>(q, "select payload as p from app.jobs where id = $1", [job])).p);
  const prepared = async (job: string): Promise<Claimed> => {
    const claimed = (await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r)).find((r) => r.id === job);
    expect(claimed, "claimed").toBeDefined();
    await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id, usage_counted = true where id = $1", [job]));
    return claimed as Claimed;
  };
  const compose = (kind: "email" | "sms", job: Claimed) =>
    asService(async (q) => (await one<{ r: Answer }>(q, `select public.${kind}_job_compose($1, $2, $3) as r`, [job.id, job.lease, SITE])).r);
  const setSwitch = (on: boolean) => asAdmin((q) => q("update public.org_document_settings set quote_customer_reminder = $2 where organization_id = $1", [org, on]));
  const setFeature = (key: string, on: boolean) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object($2::text, $3::boolean) where organization_id = $1", [org, key, on]));

  beforeAll(async () => {
    await asAdmin((q) => q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]));
    owner = await createUser("qrem-owner");
    org = await createOrg(owner.id, "עסק התזכורות");
    member = await addMember(org, owner.id, "member", "qrem-member");
    viewer = await addMember(org, owner.id, "viewer", "qrem-viewer");
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages[0].id };
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]);
      await q(
        "update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": true, \"sms\": true, \"quote_reminders\": true}'::jsonb where organization_id = $1",
        [org],
      );
      await q(
        `insert into public.org_document_settings (organization_id, vat_status, address_line, city, phone) values ($1, 'licensed', 'הרצל 1', 'תל אביב', '03-5555555')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [org],
      );
    });
    personEmail = await asAdmin(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.message_templates (organization_id, name, channel, message_type, subject, body) values ($1, 'הצעה באימייל', 'email', 'requested_document', 'הצעה', 'שלום {שם פרטי}: {קישור להצעה}') returning id",
            [org],
          )
        ).id,
    );
    personSms = await asAdmin(
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'הצעה ב-SMS', 'sms', 'requested_document', 'שלום {שם פרטי}: {קישור להצעה}') returning id",
            [org],
          )
        ).id,
    );
    today = await asAdmin(async (q) => (await one<{ d: string }>(q, "select ((now() at time zone 'Asia/Jerusalem')::date)::text as d")).d);
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));

  it("(383) א is off for a new business; owners and admins switch it on, never a member or a viewer", async () => {
    const fresh = await createUser("qrem-fresh");
    const freshOrg = await createOrg(fresh.id, "עסק חדש");
    await asUser(fresh.id, (q) => q("insert into public.org_document_settings (organization_id) values ($1) on conflict do nothing", [freshOrg]));
    expect(
      await asAdmin(async (q) => (await one<{ on: boolean }>(q, "select quote_customer_reminder as on from public.org_document_settings where organization_id = $1", [freshOrg])).on),
    ).toBe(false);
    for (const u of [member, viewer]) {
      const changed = await asUser(u.id, async (q) => (await q("update public.org_document_settings set quote_customer_reminder = true where organization_id = $1 returning 1", [org])).rowCount).catch(() => 0);
      expect(changed, u.email).toBe(0);
    }
    expect(await asUser(owner.id, async (q) => (await q("update public.org_document_settings set quote_customer_reminder = true where organization_id = $1 returning 1", [org])).rowCount)).toBe(1);
  });

  it("(384) ב: the plan key, basic and up; off in personal and in the fallback", async () => {
    const plans = await asAdmin(async (q) => (await q<{ key: string; on: unknown }>("select key, features -> 'quote_reminders' as on from public.plans")).rows);
    const by = Object.fromEntries(plans.map((p) => [p.key, p.on]));
    expect([by.basic, by.pro, by.business]).toEqual([true, true, true]);
    expect(by.personal).toBe(false);
    expect(await asAdmin(async (q) => (await one<{ v: unknown }>(q, "select app.plan_key_defaults() -> 'features' -> 'quote_reminders' as v")).v)).toBe(false);
  });

  it("works out the stage by business days, never after validity, and nothing once opened but the last-days one", async () => {
    const { quote } = await newQuote();
    const sent = addDays(today, -1);
    await arrange(quote, { sentOn: sent });
    const d3 = await businessDays(sent, 3);
    const d7 = await businessDays(sent, 7);
    const d10 = await businessDays(d7, 3);
    expect(await stage(quote, addDays(d3, -1))).toBeNull();
    expect(await stage(quote, d3)).toBe("unopened_1");
    expect(await stage(quote, addDays(d7, -1))).toBe(d3 <= addDays(d7, -1) ? "unopened_1" : null);
    expect(await stage(quote, d7)).toBe("unopened_2");
    expect(await stage(quote, d10)).toBe("unopened_2");
    expect(await stage(quote, addDays(d10, 1))).toBe((await businessDays(d7, 3)) >= addDays(d10, 1) ? "unopened_2" : null);
    // opened: only two days before the last day, until that day
    await arrange(quote, { status: "viewed", validUntil: addDays(today, 2) });
    expect(await stage(quote, addDays(today, -1))).toBeNull();
    expect(await stage(quote, today)).toBe("expiring");
    expect(await stage(quote, addDays(today, 2))).toBe("expiring");
    // without a last day: none
    await arrange(quote, { validUntil: null });
    expect(await stage(quote, today)).toBeNull();
    // past validity (the quote is no longer on offer): none
    await arrange(quote, { status: "sent", validUntil: addDays(today, -1) });
    expect(await stage(quote, d3)).toBeNull();
  });

  it("queues one reminder per stage through the quote path, only with the switch and the key, and the composer judges it again", async () => {
    const { quote, contact } = await newQuote();
    await arrange(quote, { sentOn: await sentForStage(3) });
    expect(await stage(quote, today)).toMatch(/^unopened_/);
    await setSwitch(false);
    await run();
    expect(await rows(quote)).toEqual([]);
    await setSwitch(true);
    await setFeature("quote_reminders", false);
    await run();
    expect(await rows(quote)).toEqual([]);
    await setFeature("quote_reminders", true);
    await run();
    const [first] = await rows(quote);
    expect(first).toMatchObject({ outcome: "queued", channel: "email" });
    expect(await payloadOf(first.job_id as string)).toEqual({
      channel: "email",
      message_type: "requested_document",
      template_id: expect.any(String),
      quote_id: quote,
      contact_id: contact,
      event_at: expect.stringMatching(/Z$/),
    });
    // the seeded template is the system's own (notice_kind), and a person can never send it
    const tpl = (await payloadOf(first.job_id as string)).template_id as string;
    expect(await asAdmin(async (q) => (await one<{ k: string; w: string }>(q, "select notice_kind as k, wording_version as w from public.message_templates where id = $1", [tpl])))).toEqual({
      k: "quote_reminder",
      w: "quote-reminder-draft-1",
    });
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_message_send($1, $2, 'email', $3)", [org, quote, tpl])))).hint).toBe("record_message:notice_template");
    // once per stage
    await run();
    expect((await rows(quote)).length).toBe(1);
    // the composer fills it with a new link
    const job = await prepared(first.job_id as string);
    const answer = await compose("email", job);
    expect(String(answer.text)).toMatch(/\/f\/quote\/[A-Za-z0-9_-]{64}/);
    // no person sent it: it answers to the quote's owner while an active member who is not a viewer
    expect(answer.reply_to).toBe(member.email);
  });

  it("stops when the customer opens it, the switch goes off, or the quote is answered, cancelled or superseded", async () => {
    // opened after queuing: the 'unopened' reminder is refused
    const a = await newQuote();
    await arrange(a.quote, { sentOn: await sentForStage(3) });
    await run();
    let job = await prepared((await rows(a.quote))[0].job_id as string);
    await arrange(a.quote, { status: "viewed" });
    expect(await compose("email", job)).toEqual({ refused: "quote_changed" });

    // the switch went off after queuing
    const b = await newQuote();
    await arrange(b.quote, { sentOn: await sentForStage(3) });
    await run();
    job = await prepared((await rows(b.quote))[0].job_id as string);
    await setSwitch(false);
    try {
      expect(await compose("email", job)).toEqual({ refused: "reminder_off" });
    } finally {
      await setSwitch(true);
    }

    // cancelled and accepted quotes get none
    const c = await newQuote();
    await arrange(c.quote, { sentOn: await sentForStage(3) });
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, c.quote]));
    const d = await newQuote();
    await arrange(d.quote, { sentOn: await sentForStage(3), status: "accepted" });
    await run();
    expect(await rows(c.quote)).toEqual([]);
    expect(await rows(d.quote)).toEqual([]);

    // a newer sent version supersedes the older
    const e = await newQuote();
    await arrange(e.quote, { sentOn: await sentForStage(3) });
    const v2 = await asUser(member.id, async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, e.quote])).id);
    await asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, v2]));
    expect(await stage(e.quote, today)).toBeNull();
  });

  it("goes on the channel the quote was last sent on by a person, else email, else SMS", async () => {
    const a = await newQuote({ send: "sms" });
    await arrange(a.quote, { sentOn: await sentForStage(3) });
    await run();
    expect((await rows(a.quote))[0]).toMatchObject({ outcome: "queued", channel: "sms" });

    const b = await newQuote({ send: "email" });
    await arrange(b.quote, { sentOn: await sentForStage(3) });
    await run();
    expect((await rows(b.quote))[0]).toMatchObject({ outcome: "queued", channel: "email" });
  });

  it("review F6: a quote only marked sent, never sent to the customer through the system, gets no reminder", async () => {
    const { quote } = await newQuote({ send: false });
    await arrange(quote, { sentOn: await sentForStage(3) });
    expect(await stage(quote, today)).toBe("unopened_1");
    await run();
    expect(await rows(quote)).toEqual([]);
    // a person's send that has not gone yet does not count either
    await asUser(member.id, (q) => q("select public.quote_message_send($1, $2, 'email', $3)", [org, quote, personEmail]));
    await run();
    expect(await rows(quote)).toEqual([]);
  });

  it("review F2: 250 waiting quotes whose stage is not due do not starve a due one", async () => {
    const waiting = await newQuote();
    // sent long enough ago that the first reminder is done and the second is not due yet
    let sentOn = "";
    for (let back = 1; back < 40 && !sentOn; back++) {
      const day = addDays(today, -back);
      if ((await businessDays(day, 4)) <= today && (await businessDays(day, 7)) > today) sentOn = day;
    }
    expect(sentOn).not.toBe("");
    await arrange(waiting.quote, { sentOn });
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      // 250 copies of it, each with a person's message that went and its first reminder handled
      const ids = (
        await q<{ id: string }>(
          `insert into public.quotes
           select (jsonb_populate_record(null::public.quotes, to_jsonb(q) || jsonb_build_object('id', gen_random_uuid(), 'number', null, 'number_display', null))).*
             from public.quotes q, generate_series(1, 250) g where q.id = $1
           returning id`,
          [waiting.quote],
        )
      ).rows.map((r) => r.id);
      await q(
        // made two hours ago, so they stay out of the person's hourly cap
        `insert into app.jobs (organization_id, kind, payload, status, created_at)
         select $1, 'message.send', jsonb_build_object('channel', 'email', 'message_type', 'requested_document', 'template_id', $2::text,
                'quote_id', x, 'contact_id', $3::text, 'reply_to_user_id', $4::text), 'done', now() - interval '2 hours'
           from unnest($5::uuid[]) x`,
        [org, personEmail, waiting.contact, member.id, ids],
      );
      await q("insert into app.quote_reminders (quote_id, stage, organization_id, outcome) select x, 'unopened_1', $1, 'queued' from unnest($2::uuid[]) x", [org, ids]);
    });
    const due = await newQuote();
    await arrange(due.quote, { sentOn: await sentForStage(3) });
    await run();
    expect((await rows(due.quote))[0]).toMatchObject({ stage: "unopened_1", outcome: "queued" });
  });

  it("delta review 4: a stage tried least recently comes first, so a stuck one does not keep the slot", async () => {
    // what earlier tests left due is handled first
    await run();
    const stuck = await newQuote();
    // sent a day before the other (so the old order, by sending time, would put it first), still in its first stage
    const base = await sentForStage(3);
    await arrange(stuck.quote, { sentOn: addDays(base, -1) });
    if ((await stage(stuck.quote, today)) !== "unopened_1") await arrange(stuck.quote, { sentOn: base });
    expect(await stage(stuck.quote, today)).toBe("unopened_1");
    // the older quote's first stage was just tried and found no template
    await asAdmin((q) =>
      q("insert into app.quote_reminders (quote_id, stage, organization_id, outcome, last_attempt_at) values ($1, 'unopened_1', $2, 'no_template', now())", [stuck.quote, org]),
    );
    const fresh = await newQuote();
    await arrange(fresh.quote, { sentOn: await sentForStage(3) });
    const runOne = () =>
      asAdmin(async (q) => {
        await q("set local app.quote_reminder_per_org = '1'");
        await q("select app.send_quote_reminders()");
      });
    await runOne();
    expect((await rows(fresh.quote))[0]).toMatchObject({ outcome: "queued" });
    expect((await rows(stuck.quote))[0]).toMatchObject({ outcome: "no_template" });
    // the next run gives the stuck stage its turn (the templates are there now)
    await runOne();
    expect((await rows(stuck.quote))[0]).toMatchObject({ outcome: "queued" });
  });

  it("review F7: the switch goes on only with the key; a missing template is tried again until the window ends", async () => {
    await setFeature("quote_reminders", false);
    try {
      await setSwitch(false);
      const on = await pgError(asUser(owner.id, (q) => q("update public.org_document_settings set quote_customer_reminder = true where organization_id = $1", [org])));
      expect(on.hint).toBe("feature:quote_reminders");
    } finally {
      await setFeature("quote_reminders", true);
      await setSwitch(true);
    }
    // switching off is always allowed, with the key or without it
    await asUser(owner.id, (q) => q("update public.org_document_settings set quote_customer_reminder = false where organization_id = $1", [org]));
    await setSwitch(true);

    const { quote } = await newQuote();
    await arrange(quote, { sentOn: await sentForStage(3) });
    await asAdmin((q) => q("update public.message_templates set is_active = false where organization_id = $1 and notice_kind = 'quote_reminder'", [org]));
    try {
      await run();
      expect((await rows(quote))[0]).toMatchObject({ stage: "unopened_1", outcome: "no_template" });
    } finally {
      await asAdmin((q) => q("update public.message_templates set is_active = true where organization_id = $1 and notice_kind = 'quote_reminder'", [org]));
    }
    await run();
    expect((await rows(quote))[0]).toMatchObject({ stage: "unopened_1", outcome: "queued" });
  });

  it("{שם הנציג} is the quote's owner while an active member, else the business's name", async () => {
    const { quote } = await newQuote();
    await arrange(quote, { sentOn: await sentForStage(3) });
    await run();
    const job = await prepared((await rows(quote))[0].job_id as string);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, member.id]));
    try {
      const answer = await compose("email", job);
      expect(String(answer.text).endsWith("עסק התזכורות, עסק התזכורות")).toBe(true);
      expect(answer.reply_to).toBeNull();
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, member.id]));
    }
  });

});
