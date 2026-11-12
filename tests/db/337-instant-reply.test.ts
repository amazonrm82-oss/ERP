import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string) =>
  asAdmin((q) =>
    q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );

type Row = Record<string, unknown>;
type Claimed = { id: string; lease: string };

const submit = (token: string, payload: Row, spam = false) =>
  asService(async (q) => (await q<{ r: Row }>("select public.intake_submit($1, 'form', $2, null, null, $3) as r", [token, JSON.stringify(payload), spam])).rows[0].r);
const repliesOf = (org: string) =>
  asAdmin(async (q) => (await q<{ outcome: string; job_id: string | null; submission_id: string }>("select outcome, job_id, submission_id from app.instant_replies where organization_id = $1 order by created_at, submission_id", [org])).rows);
const replyJobs = (org: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ id: string; payload: Row; template: string | null }>(
          `select j.id, j.payload, t.notice_kind as template
             from app.jobs j left join public.message_templates t on t.id = (j.payload ->> 'template_id')::uuid
            where j.organization_id = $1 and j.kind = 'message.send' and j.payload ->> 'message_type' = 'instant_reply'
            order by j.created_at, j.id`,
          [org],
        )
      ).rows,
  );
const claimOne = async (id: string): Promise<Claimed> => {
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  return job as Claimed;
};
const maySend = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Row }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);

/**
 * SPD-04 (owner (80) א, (120) ג; the lead's interim choices (a)-(d)): a web form may send an instant automatic reply, a
 * service message, only to the address typed in that submission, once per submission, from the business's marked DRAFT
 * templates; in working hours "by {שעה}", outside them the second template; SMS when the business has the sms key.
 */
describe("the instant reply to a web form inquiry (SPD-04)", () => {
  let owner: { id: string }, member: { id: string };
  let org: string;
  let form: { id: string; token: string };

  const setSms = (on: boolean) =>
    asAdmin((q) =>
      q(
        `update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object('sms', $2::boolean),
                limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{"max_sms_per_month": 100000}'::jsonb
          where organization_id = $1`,
        [org, on],
      ),
    );
  const setFeature = (key: string, on: boolean) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object($2::text, $3::boolean) where organization_id = $1", [
        org,
        key,
        on,
      ]),
    );
  // open all day every day, or closed today (today a rest day)
  const setOpen = (open: boolean) =>
    asAdmin((q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, working_hours)
         values ($1, case when $2 then '{}'::smallint[] else array[extract(dow from now() at time zone 'Asia/Jerusalem')::smallint] end, false, null)
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays, holidays_rest = false, working_hours = null`,
        [org, open],
      ),
    );

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("ir-owner");
    org = await createOrg(owner.id, "סטודיו מענה");
    member = await addMember(org, owner.id, "member", "ir-member");
    await asAdmin((q) => q("update public.organizations set phone = '03-5550000' where id = $1", [org]));
    await setSms(false);
    await setOpen(true);
    form = await asUser(owner.id, async (q) =>
      (await q<{ id: string; token: string }>(`insert into public.forms (organization_id, name, owner_id, fields) values ($1, 'טופס מענה', $2, '[{"key":"full_name","required":true},{"key":"phone","required":false},{"key":"email","required":false}]') returning id, token`, [org, owner.id]))
        .rows[0],
    );
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await setKey(KEY);
    await closePool();
  });

  it("off by default: nothing is judged or queued; owners and admins turn it on, members cannot", async () => {
    await submit(form.token, { full_name: "כבוי", email: "off@example.test" });
    expect(await repliesOf(org)).toEqual([]);
    expect(await replyJobs(org)).toEqual([]);
    expect((await asUser(member.id, (q) => q("update public.forms set instant_reply = true where id = $1 returning id", [form.id]))).rowCount).toBe(0);
    expect((await asUser(owner.id, (q) => q("update public.forms set instant_reply = true where id = $1 returning id", [form.id]))).rowCount).toBe(1);
  });

  it("turning it on seeds four marked DRAFT templates, once per business and channel", async () => {
    const templates = await asAdmin(
      async (q) =>
        (
          await q<{ channel: string; notice_kind: string; message_type: string; wording_version: string }>(
            "select channel, notice_kind, message_type, wording_version from public.message_templates where organization_id = $1 and message_type = 'instant_reply' order by channel, notice_kind",
            [org],
          )
        ).rows,
    );
    expect(templates).toEqual([
      { channel: "email", notice_kind: "instant_reply_closed", message_type: "instant_reply", wording_version: "instant-reply-draft-1" },
      { channel: "email", notice_kind: "instant_reply_open", message_type: "instant_reply", wording_version: "instant-reply-draft-1" },
      { channel: "sms", notice_kind: "instant_reply_closed", message_type: "instant_reply", wording_version: "instant-reply-draft-1" },
      { channel: "sms", notice_kind: "instant_reply_open", message_type: "instant_reply", wording_version: "instant-reply-draft-1" },
    ]);
    // every one passes the service rule as written
    const problems = await asAdmin(
      async (q) =>
        (await q<{ p: string | null }>("select app.message_template_sendable(organization_id, id) as p from public.message_templates where organization_id = $1 and message_type = 'instant_reply'", [org])).rows,
    );
    expect(problems.map((r) => r.p)).toEqual([null, null, null, null]);
    // switching off and on again adds nothing
    await asUser(owner.id, (q) => q("update public.forms set instant_reply = false where id = $1", [form.id]));
    await asUser(owner.id, (q) => q("update public.forms set instant_reply = true where id = $1", [form.id]));
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.message_templates where organization_id = $1 and message_type = 'instant_reply'", [org])).rows[0].n)).toBe(4);
  });

  it("one email job of ids only to the typed address, in working hours, with the return time as event_at", async () => {
    const before = Date.now();
    const r = await submit(form.token, { full_name: "דנה", email: "Dana.Reply@Example.Test" });
    const jobs = await replyJobs(org);
    expect(jobs).toHaveLength(1);
    const { event_at, template_id, form_submission_id, ...rest } = jobs[0].payload as Row & { event_at: string };
    expect(rest).toEqual({ channel: "email", message_type: "instant_reply", lead_id: r.lead_id });
    expect(template_id).toBeTruthy();
    expect(jobs[0].template).toBe("instant_reply_open");
    // the business's target (60 minutes) from now, in working time (open all day)
    const minutes = (Date.parse(event_at) - before) / 60000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThan(62);
    const [reply] = await repliesOf(org);
    expect(reply).toMatchObject({ outcome: "queued", job_id: jobs[0].id, submission_id: form_submission_id });
    // a service message: it goes without a consent, whatever the sending window
    await asAdmin((q) =>
      q(
        `insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '00:00', '00:01', true)
         on conflict (organization_id) do update set window_from = '00:00', window_until = '00:01', skip_rest_days = true`,
        [org],
      ),
    );
    expect(await maySend(await claimOne(jobs[0].id))).toEqual({ may_send: true });
  });

  it("SMS when the business has the sms key and the person typed a phone, else email; the typed address only", async () => {
    await setSms(true);
    try {
      const both = await submit(form.token, { full_name: "שניים", phone: "050-7710001", email: "both@example.test" });
      const [sms] = await replyJobs(org).then((all) => all.filter((j) => (j.payload as Row).lead_id === both.lead_id));
      expect(sms.payload).toMatchObject({ channel: "sms", lead_id: both.lead_id });
      expect(sms.template).toBe("instant_reply_open");
    } finally {
      await setSms(false);
    }
    const phoneOnly = await submit(form.token, { full_name: "טלפון", phone: "050-7710002" });
    expect((await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === phoneOnly.lead_id)).toEqual([]);
    expect((await repliesOf(org)).at(-1)?.outcome).toBe("no_address");
  });

  it("a repeat inquiry with another address than the record's sends nothing; (280) ג the same address once a day", async () => {
    const first = await submit(form.token, { full_name: "חוזר", phone: "050-7710003", email: "first@example.test" });
    const again = await submit(form.token, { full_name: "חוזר", phone: "050-7710003", email: "second@example.test" });
    expect(again.status).toBe("duplicate");
    expect((await repliesOf(org)).at(-1)?.outcome).toBe("no_address");
    const third = await submit(form.token, { full_name: "חוזר", phone: "050-7710003", email: "First@Example.test" });
    expect(third.status).toBe("duplicate");
    expect((await repliesOf(org)).at(-1)?.outcome).toBe("address_cap");
    expect((await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === first.lead_id)).toHaveLength(1);
    // the buckets keep no address
    const cols = await asAdmin(
      async (q) =>
        (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'instant_reply_buckets' order by 1")).rows.map(
          (r) => r.c,
        ),
    );
    expect(cols).toEqual(["bucket", "day", "organization_id"]);
  });

  it("review 1: 200 a business day (lowered here), then a notice; no consent_hash_key = nothing; the inquiry always goes in", async () => {
    const submitWith = (payload: Row, settings: Record<string, string>) =>
      asService(async (q) => {
        for (const [key, value] of Object.entries(settings)) await q("select set_config($1, $2, true)", [key, value]);
        return (await q<{ r: Row }>("select public.intake_submit($1, 'form', $2, null, null, false) as r", [form.token, JSON.stringify(payload)])).rows[0].r;
      });
    const used = await asAdmin(
      async (q) =>
        (
          await q<{ n: number }>(
            "select coalesce(max(queued), 0)::int as n from app.instant_reply_days where organization_id = $1 and day = (now() at time zone 'Asia/Jerusalem')::date",
            [org],
          )
        ).rows[0].n,
    );
    const capped = await submitWith({ full_name: "מכסה", email: "cap-1@example.test" }, { "app.instant_reply_day_cap": String(used) });
    expect(capped.status).toBe("accepted");
    expect((await repliesOf(org)).at(-1)?.outcome).toBe("day_cap");
    const notices = await asAdmin(
      async (q) =>
        (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and title = 'מענה מיידי ללקוחות נעצר להיום'", [org])).rows[0].n,
    );
    expect(notices).toBe(1);
    await submitWith({ full_name: "מכסה", email: "cap-2@example.test" }, { "app.instant_reply_day_cap": String(used) });
    expect((await repliesOf(org)).at(-1)?.outcome).toBe("day_cap");
    expect(
      await asAdmin(
        async (q) =>
          (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and title = 'מענה מיידי ללקוחות נעצר להיום'", [org])).rows[0].n,
      ),
    ).toBe(1);
    // no key: fail closed
    await asAdmin((q) => q("update app.settings set value = '' where key = 'consent_hash_key'"));
    try {
      const r = await submit(form.token, { full_name: "בלי מפתח", email: "nokey@example.test" });
      expect(r.status).toBe("accepted");
      expect((await repliesOf(org)).at(-1)?.outcome).toBe("no_key");
      expect((await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === r.lead_id)).toEqual([]);
    } finally {
      await setKey(KEY);
    }
  });

  it("review 2: it skips the sending window but takes the per-minute rate like any message", async () => {
    const r = await submit(form.token, { full_name: "קצב", email: "rate-reply@example.test" });
    const [job] = (await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === r.lead_id);
    await asAdmin((q) =>
      q(
        `insert into app.message_send_rate (organization_id, channel, minute_start, sent) values ($1, 'email', date_trunc('minute', now()), 1000)
         on conflict (organization_id, channel) do update set minute_start = date_trunc('minute', now()), sent = 1000`,
        [org],
      ),
    );
    try {
      expect(await maySend(await claimOne(job.id))).toEqual({ may_send: false, reason: "rate", retry: true });
    } finally {
      await asAdmin((q) => q("update app.message_send_rate set sent = 0 where organization_id = $1", [org]));
    }
    const fns = await asAdmin(
      async (q) =>
        (await q<{ a: boolean; w: boolean; v: boolean }>("select app.message_always_sends('instant_reply') as a, app.message_window_exempt('instant_reply') as w, app.message_always_sends('verification_code') as v")).rows[0],
    );
    expect(fns).toEqual({ a: false, w: true, v: true });
  });

  it("owner (282) ב: the system's templates are edited and switched off, never deleted; an offer or a link is refused", async () => {
    const tpl = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.message_templates where organization_id = $1 and notice_kind = 'instant_reply_open' and channel = 'sms'", [org])).rows[0].id);
    const original = await asAdmin(async (q) => (await q<{ body: string; name: string }>("select body, name from public.message_templates where id = $1", [tpl])).rows[0]);
    const hint = async (sql: string, args: unknown[]) => (await pgError(asUser(owner.id, (q) => q(sql, args)))).hint;
    for (const body of ["שלום, במבצע!", "רק היום 20% הנחה", "הנחה של עשרה", "% הנחה", "המחיר יישלח", "המחיר 100 ש\"ח", "המחיר ₪100", "שירות בחינם", "קופון מתנה", "50 NIS", "100NIS", "20 ٪", "במבְּצָע"]) {
      expect(await hint("update public.message_templates set body = $2 where id = $1", [tpl, body]), body).toBe("message_template:offer");
    }
    expect(await hint("update public.message_templates set body = 'ראו www.example.com' where id = $1", [tpl])).toBe("message_template:instant_reply_link");
    expect(await hint("update public.message_templates set subject = 'https://x.example.com' where id = $1", [tpl])).toBe("message_template:instant_reply_link");
    expect(await hint("delete from public.message_templates where id = $1", [tpl])).toBe("message_template:instant_reply_delete");
    // review: the marked template keeps its channel and type for a person's write
    for (const set of ["channel = 'email', subject = 'נושא'", "message_type = 'marketing'"]) {
      expect(await hint(`update public.message_templates set ${set} where id = $1`, [tpl]), set).toBe("message_template:instant_reply_kind");
    }
    // review: an outsider learns nothing from the refusal helper
    const outsider = await createUser("outsider");
    const asked = await asUser(outsider.id, async (q) =>
      (await q<{ r: string | null }>("select app.instant_reply_template_refusal($1, 'instant_reply', null, 'במבצע') as r", [org])).rows[0].r,
    );
    expect(asked).toBeNull();
    expect(
      await asUser(owner.id, async (q) =>
        (await q<{ r: string | null }>("select app.instant_reply_template_refusal($1, 'instant_reply', null, 'במבצע') as r", [org])).rows[0].r,
      ),
    ).toBe("offer");
    // a person edits the wording and the name now
    expect((await asUser(owner.id, (q) => q("update public.message_templates set name = 'מענה שלנו', body = 'שלום {שם פרטי}, נחזור אליך עד {שעה}. {שם העסק}' where id = $1 returning id", [tpl]))).rowCount).toBe(1);
    // owner (305) ב: a bare מבצע or הנחה is no offer
    expect((await asUser(owner.id, (q) => q("update public.message_templates set body = 'אני מבצע את העבודה, הנחה סבירה היא שנחזור מחר' where id = $1 returning id", [tpl]))).rowCount).toBe(1);
    expect((await asUser(owner.id, (q) => q("update public.message_templates set is_active = false where id = $1 returning id", [tpl]))).rowCount).toBe(1);
    expect((await asUser(owner.id, (q) => q("update public.message_templates set is_active = true where id = $1 returning id", [tpl]))).rowCount).toBe(1);
    // a server write is refused too (every writer)
    expect((await pgError(asAdmin((q) => q("update public.message_templates set body = 'במבצע' where id = $1", [tpl])))).hint).toBe("message_template:offer");
    await asUser(owner.id, (q) => q("update public.message_templates set name = $2, body = $3 where id = $1", [tpl, original.name, original.body]));
    // a person's own instant reply: the same rule on insert; deleting it is allowed
    expect(
      await hint("insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'מענה עם הצעה', 'sms', 'instant_reply', 'קופון לפנייה הבאה')", [org]),
    ).toBe("message_template:offer");
    const own = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'מענה שלי', 'sms', 'instant_reply', 'שלום {שם פרטי}') returning id",
          [org],
        )
      ).rows[0].id,
    );
    expect(await hint("update public.message_templates set message_type = 'instant_reply', body = 'מחיר: 5$' where id = $1", [own])).toBe("message_template:offer");
    expect((await asUser(owner.id, (q) => q("delete from public.message_templates where id = $1 returning id", [own]))).rowCount).toBe(1);
    // every other type keeps its behaviour: saved, the problem only shown
    const other = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'מבצע החודש', 'sms', 'collection', 'מבצע: 20% הנחה על {סכום}') returning id",
          [org],
        )
      ).rows[0].id,
    );
    expect((await asUser(owner.id, (q) => q("delete from public.message_templates where id = $1 returning id", [other]))).rowCount).toBe(1);
    // the rule answers 'offer' for an instant reply only, so a stored offer is not sent
    const codes = await asAdmin(
      async (q) =>
        (
          await q<{ a: string | null; b: string | null; c: string }>(
            `select app.message_template_problem('sms', 'instant_reply', null, 'במבצע!', null, null) as a,
                    app.message_template_problem('sms', 'collection', null, 'מבצע!', null, null) as b,
                    app.message_send_refusal_text('offer') as c`,
          )
        ).rows[0],
    );
    expect(codes).toEqual({ a: "offer", b: null, c: "יש בתבנית מחיר, הנחה או מילה שיווקית" });
  });

  it("final review: an email is bucketed by its folded form; the record still matches the address as typed", async () => {
    const key = (address: string) =>
      asAdmin(async (q) => (await q<{ k: string | null }>("select app.instant_reply_email_key($1) as k", [address])).rows[0].k);
    expect(await key("Victim+1@Gmail.com")).toBe("victim@gmail.com");
    expect(await key("v.ictim@googlemail.com")).toBe("victim@gmail.com");
    expect(await key("first.last+x@example.test")).toBe("first.last@example.test");
    expect(await key("not-an-address")).toBe("not-an-address");
    const first = await submit(form.token, { full_name: "קורבן", email: "victim+1@gmail.com" });
    expect((await repliesOf(org)).at(-1)?.outcome).toBe("queued");
    const second = await submit(form.token, { full_name: "קורבן 2", email: "v.ictim@gmail.com" });
    // a different record (the address as typed differs), but the same bucket: no second reply today
    expect(second.lead_id).not.toBe(first.lead_id);
    expect((await repliesOf(org)).at(-1)?.outcome).toBe("address_cap");
    expect((await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === second.lead_id)).toEqual([]);
  });

  it("final review: the templates are seeded only with the plan key, and a seed the cap refuses is tried again later", async () => {
    const other = await createUser("ir-seed-owner");
    const otherOrg = await createOrg(other.id, "עסק זריעה");
    const instantCount = () =>
      asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.message_templates where organization_id = $1 and message_type = 'instant_reply'", [otherOrg])).rows[0].n);
    const seeded = () =>
      asAdmin(async (q) => (await q<{ c: string }>("select channel as c from app.instant_reply_template_seeds where organization_id = $1 order by 1", [otherOrg])).rows.map((r) => r.c));
    const setKeyOf = (on: boolean) =>
      asAdmin((q) =>
        q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || jsonb_build_object('instant_reply', $2::boolean) where organization_id = $1", [otherOrg, on]),
      );
    await setKeyOf(false);
    const formId = await asUser(other.id, async (q) =>
      (await q<{ id: string }>("insert into public.forms (organization_id, name, instant_reply) values ($1, 'טופס בלי מפתח', true) returning id", [otherOrg])).rows[0].id,
    );
    expect(await instantCount()).toBe(0);
    expect(await seeded()).toEqual([]);
    // with the key, but the business is at its 50 templates: nothing seeded and nothing marked done
    await setKeyOf(true);
    for (let i = 0; i < 60; i += 1) {
      const failed = await asUser(other.id, (q) =>
        q("insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, $2, 'sms', 'marketing', 'שלום')", [otherOrg, `מילוי ${i}`]),
      )
        .then(() => false)
        .catch(() => true);
      if (failed) break;
    }
    await asUser(other.id, (q) => q("update public.forms set instant_reply = false where id = $1", [formId]));
    await asUser(other.id, (q) => q("update public.forms set instant_reply = true where id = $1", [formId]));
    expect(await instantCount()).toBe(0);
    expect(await seeded()).toEqual([]);
    // room again: a later try (the next reply, or the switch) adds them and marks both channels
    await asUser(other.id, (q) => q("delete from public.message_templates where organization_id = $1 and name like 'מילוי %'", [otherOrg]));
    await asAdmin((q) => q("select app.seed_instant_reply_templates($1)", [otherOrg]));
    expect(await instantCount()).toBe(4);
    expect(await seeded()).toEqual(["email", "sms"]);
  });

  it("(259) א: a new web form takes the business default; a widget never; the default is owners' and admins'", async () => {
    const save = (who: string, on: boolean) =>
      asUser(who, (q) =>
        q(
          `insert into public.org_message_settings (organization_id, instant_reply_default) values ($1, $2)
           on conflict (organization_id) do update set instant_reply_default = excluded.instant_reply_default`,
          [org, on],
        ),
      );
    expect((await pgError(save(member.id, true))).code).toBe("42501");
    await save(owner.id, true);
    try {
      const made = await asUser(owner.id, async (q) =>
        (await q<{ instant_reply: boolean }>("insert into public.forms (organization_id, name) values ($1, 'טופס ברירת מחדל') returning instant_reply", [org])).rows[0].instant_reply,
      );
      expect(made).toBe(true);
      const hook = await asUser(owner.id, async (q) =>
        (await q<{ instant_reply: boolean }>("insert into public.forms (organization_id, kind, name) values ($1, 'webhook', 'חיבור') returning instant_reply", [org])).rows[0].instant_reply,
      );
      expect(hook).toBe(false);
    } finally {
      await save(owner.id, false);
    }
    const off = await asUser(owner.id, async (q) =>
      (await q<{ instant_reply: boolean }>("insert into public.forms (organization_id, name) values ($1, 'טופס בלי') returning instant_reply", [org])).rows[0].instant_reply,
    );
    expect(off).toBe(false);
  });

  it("exactly once per submission: emitting again for the same submission queues nothing", async () => {
    const r = await submit(form.token, { full_name: "פעם", email: "once@example.test" });
    const [reply] = (await repliesOf(org)).slice(-1);
    const again = await asAdmin(async (q) => {
      await q("select set_config('app.instant_reply_submission', $1, true)", [reply.submission_id]);
      return (await q<{ r: string | null }>("select app.instant_reply_queue($1, $2, $3, null) as r", [org, form.id, r.lead_id])).rows[0].r;
    });
    expect(again).toBeNull();
    expect((await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === r.lead_id)).toHaveLength(1);
    // a spam submission is never judged
    const count = (await repliesOf(org)).length;
    await submit(form.token, { full_name: "ספאם", email: "spam@example.test" }, true);
    expect(await repliesOf(org)).toHaveLength(count);
  });

  it("outside working hours: the second template, and the return time counted from the next working day", async () => {
    await setOpen(false);
    try {
      const r = await submit(form.token, { full_name: "לילה", email: "night@example.test" });
      const [job] = (await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === r.lead_id);
      expect(job.template).toBe("instant_reply_closed");
      // (261) א: "ביום העבודה הבא עד {שעה}"
      const body = await asAdmin(async (q) => (await q<{ body: string }>("select body from public.message_templates where id = $1", [(job.payload as Row).template_id])).rows[0].body);
      expect(body).toContain("ביום העבודה הבא עד {שעה}");
      const due = await asAdmin(
        async (q) =>
          (
            await q<{ d: string }>("select ((($1::timestamptz) at time zone 'Asia/Jerusalem')::date - (now() at time zone 'Asia/Jerusalem')::date)::text as d", [
              (job.payload as Row).event_at,
            ])
          ).rows[0].d,
      );
      expect(Number(due)).toBeGreaterThanOrEqual(1);
    } finally {
      await setOpen(true);
    }
  });

  it("the blocklist and a privacy erasure still stop it (refused when it would go)", async () => {
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'all', array['blocked-reply@example.test'], 'person_request')", [org]));
    const r = await submit(form.token, { full_name: "חסום", email: "blocked-reply@example.test" });
    const [job] = (await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === r.lead_id);
    expect(await maySend(await claimOne(job.id))).toEqual({ may_send: false, reason: "consent_blocked" });

    // an erasure at the person's request on another record of the same address (made by a person, not the form)
    const erased = await insertLead(owner.id, org, { full_name: "נמחק", email: "erased-reply@example.test" });
    await asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, 'email', 'withdrawn', 'erasure')", [org, erased]));
    const other = await submit(form.token, { full_name: "נמחק", email: "erased-reply@example.test" });
    const [job2] = (await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === other.lead_id).slice(-1);
    expect(await maySend(await claimOne(job2.id))).toEqual({ may_send: false, reason: "consent_blocked" });
  });

  it("without the plan key, or with the template switched off, nothing is queued; the inquiry itself always goes in", async () => {
    await setFeature("instant_reply", false);
    try {
      const r = await submit(form.token, { full_name: "בלי חבילה", email: "noplan@example.test" });
      expect(r.status).toBe("accepted");
      expect((await repliesOf(org)).at(-1)?.outcome).toBe("feature_off");
      expect((await replyJobs(org)).filter((j) => (j.payload as Row).lead_id === r.lead_id)).toEqual([]);
    } finally {
      await setFeature("instant_reply", true);
    }
    await asAdmin((q) => q("update public.message_templates set is_active = false where organization_id = $1 and notice_kind = 'instant_reply_open'", [org]));
    try {
      const r = await submit(form.token, { full_name: "כבויה", email: "tpl-off@example.test" });
      expect(r.status).toBe("accepted");
      expect((await repliesOf(org)).at(-1)?.outcome).toBe("no_template");
    } finally {
      await asAdmin((q) => q("update public.message_templates set is_active = true where organization_id = $1 and notice_kind = 'instant_reply_open'", [org]));
    }
  });

  it("the card and an automation never send it; the payload key belongs to an instant reply only", async () => {
    const tpl = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.message_templates where organization_id = $1 and notice_kind = 'instant_reply_open' and channel = 'email'", [org])).rows[0].id);
    const r = await submit(form.token, { full_name: "כרטיס", email: "card@example.test" });
    expect((await pgError(asUser(owner.id, (q) => q("select public.record_email_send($1, 'lead', $2, $3)", [org, r.lead_id, tpl])))).hint).toBe("record_message:notice_template");
    const enqueue = (payload: Row) => asAdmin((q) => q("select app.enqueue_job($1, 'message.send', $2::jsonb, null)", [org, JSON.stringify(payload)]));
    const submission = (await repliesOf(org)).at(-1)?.submission_id;
    expect((await pgError(enqueue({ channel: "email", lead_id: r.lead_id, message_type: "requested_document", form_submission_id: submission }))).hint).toBe("job:payload");
    expect((await pgError(enqueue({ channel: "email", lead_id: r.lead_id, message_type: "instant_reply", form_submission_id: "x" }))).hint).toBe("job:payload");
    expect((await pgError(enqueue({ channel: "email", lead_id: r.lead_id, message_type: "instant_reply", form_submission_id: submission, automation_id: tpl }))).hint).toBe(
      "job:payload",
    );
  });

  it("the new functions and tables are the server's only", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ r: string; f: string; ok: boolean }>(
            `select r, f, has_function_privilege(r, f, 'execute') as ok
               from unnest(array['anon', 'authenticated', 'service_role']) r,
                    unnest(array['app.instant_reply_queue(uuid,uuid,uuid,uuid)', 'app.seed_instant_reply_templates(uuid)']) f`,
          )
        ).rows,
    );
    for (const row of rows) expect(row.ok, `${row.r} ${row.f}`).toBe(false);
    for (const table of ["app.instant_replies", "app.instant_reply_template_seeds"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const ok = await asAdmin(async (q) => (await q<{ ok: boolean }>("select has_table_privilege($1, $2, 'select') as ok", [role, table])).rows[0].ok);
        expect(ok, `${role} ${table}`).toBe(false);
      }
    }
  });
});
