import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_REVIEW_REQUEST_TEMPLATES, REVIEW_REQUEST_WORDING_VERSION } from "../../src/features/message-templates/templates";
import cases from "../unit/fixtures/review-urls.json";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

const KEY = "test-consent-key";
const setKey = (value: string) =>
  asAdmin((q) => q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]));

type U = { id: string; email: string };
type Row = Record<string, unknown>;

/**
 * RET-02 (owner (273): a new key `review_requests`, basic and up; (271) ב no internal survey): after a won deal or a held
 * meeting the business's customer gets ONE request with the business's Google review link; no filter by satisfaction. It
 * is a MARKETING message (a recorded grant of the channel, the caps), queued as an OPS-04 message.send job with ids only.
 */
describe("review requests (RET-02)", () => {
  let owner: U, member: U;
  let org: string;
  let pipeline: { pipelineId: string; stages: { id: string; kind: string }[] };
  let n = 0;
  const URL = "https://g.page/r/CbXyZ123abc/review";

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const features = (o: string, extra: Record<string, boolean> = {}) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o, JSON.stringify({ review_requests: true, sms: false, ...extra })]),
    );
  /** the job, with message.send seen by a worker now; the shared row is put back in the same transaction */
  const job = (o: string | null = org, worker = true) =>
    asAdmin(async (q) => {
      const before = (await one<{ t: string | null }>(q, "select last_claimed_at::text as t from app.job_kind_seen where kind = 'message.send'"))?.t ?? null;
      await q(
        "insert into app.job_kind_seen (kind, last_claimed_at) values ('message.send', $1) on conflict (kind) do update set last_claimed_at = excluded.last_claimed_at",
        [worker ? new Date().toISOString() : null],
      );
      const done = (await one<{ n: number }>(q, "select app.send_review_requests($1::uuid[]) as n", [o === null ? null : [o]])).n;
      await q("update app.job_kind_seen set last_claimed_at = $1::timestamptz where kind = 'message.send'", [before]);
      return done;
    });
  const settings = (o: string, values: Row, u: U = owner) =>
    asUser(u.id, async (q) => {
      const cols = Object.keys(values);
      const set = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
      const done = await q(`update public.review_request_settings set ${set} where organization_id = $1 returning id`, [o, ...Object.values(values)]);
      if (done.rowCount === 0) {
        await q(
          `insert into public.review_request_settings (organization_id, ${cols.join(", ")}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`,
          [o, ...Object.values(values)],
        );
      }
    });
  /** server-only fields moved back in time (triggers skipped in this one transaction) */
  const backdate = (sql: string, params: unknown[]) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(sql, params);
    });
  const contact = (o: string, email: string | null, phone: string | null = null, u: U = owner) =>
    asUser(u.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, email, phone) values ($1, 'דנה', $2, $3, $4) returning id", [o, u.id, email, phone])).id,
    );
  const grant = (o: string, c: string, channel = "email") =>
    asAdmin((q) => q("insert into public.consents (organization_id, contact_id, channel, state, source) values ($1, $2, $3, 'granted', 'form')", [o, c, channel]));
  const wonDeal = (o: string, c: string | null, stages = pipeline, u: U = owner) =>
    asUser(u.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, $2, $3, $4, $5) returning id",
          [o, `עסקה ${++n}`, stages.pipelineId, (stages.stages.find((s) => s.kind === "won") as { id: string }).id, c],
        )
      ).id,
    );
  const requests = (o: string) =>
    asAdmin(async (q) =>
      (
        await q<{ source_kind: string; source_id: string; lead_id: string | null; contact_id: string | null; outcome: string; channel: string | null; job_id: string | null }>(
          "select source_kind, source_id, lead_id, contact_id, outcome, channel, job_id from app.review_requests where organization_id = $1 order by created_at, id",
          [o],
        )
      ).rows,
    );
  const jobs = (o: string) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string; payload: Row }>(
          "select id, payload from app.jobs where organization_id = $1 and kind = 'message.send' and payload ->> 'message_type' = 'review_request' order by created_at, id",
          [o],
        )
      ).rows,
    );

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("rr-owner");
    org = await createOrg(owner.id, "עסק הביקורות");
    member = await addMember(org, owner.id, "member", "rr-member");
    pipeline = await defaultPipeline(org);
    await features(org);
  });

  it("review_request is a marketing type with its own closed field list, judged by the template rule", async () => {
    const lists = await asAdmin(async (q) =>
      one<{ all: string[]; service: string[]; fields: string[]; merge: string[] }>(
        q,
        "select app.message_types() as all, app.service_message_types() as service, app.message_type_fields('review_request') as fields, app.message_merge_fields() as merge",
      ),
    );
    expect(lists.all).toContain("review_request");
    expect(lists.service).not.toContain("review_request");
    expect(lists.fields).toEqual(["שם פרטי", "שם העסק", "טלפון העסק", "קישור לביקורת"]);
    expect(lists.merge.at(-1)).toBe("קישור לביקורת");
    const problems = await asAdmin(async (q) =>
      one<Record<string, string | null>>(
        q,
        `select app.message_template_problem('sms', 'review_request', null, 'שלום {שם פרטי}: {קישור לביקורת}', null, null) as ok,
                app.message_template_problem('sms', 'review_request', null, 'שלום {שם פרטי}, {סכום} הנחה', null, null) as field,
                app.message_template_problem('sms', 'review_request', null, 'כתבו לנו: https://g.page/r/abc/review', null, null) as link,
                app.message_template_problem('sms', 'marketing', null, 'כתבו לנו: https://g.page/r/abc/review {סכום}', null, null) as marketing`,
      ),
    );
    expect(problems).toEqual({ ok: null, field: "field_not_allowed", link: "external_link", marketing: null });
    // a person never writes a review request template, and the mark is the server's
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'שלי', 'sms', 'review_request', 'שלום {שם פרטי}')", [org]))))
        .code,
    ).toBe("23514");
  });

  it("the link rule equals the shared fixture", async () => {
    for (const c of cases) {
      const ok = await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.review_url_ok($1) as ok", [c.url])).ok);
      expect(ok, c.note).toBe(c.ok);
    }
  });

  it("switching on needs the key, an https link and a trigger; the start time is the server's; the templates come with it", async () => {
    const other = await createUser("rr-noplan");
    const noPlan = await createOrg(other.id, "עסק בלי ביקורות");
    await features(noPlan, { review_requests: false });
    // off is always allowed, even without the key
    await settings(noPlan, { review_url: URL, delay_days: 2 }, other);
    expect((await pgError(settings(noPlan, { enabled: true }, other))).hint).toBe("feature:review_requests");
    // owner (307) ב: any https link the QR rule accepts; http, a user name or a host without a dot is still refused
    expect((await pgError(settings(org, { enabled: true, review_url: "http://www.facebook.com/biz/reviews" }))).hint).toBe("review_request:url");
    expect((await pgError(settings(org, { enabled: true, review_url: "https://user@www.easy.co.il/x" }))).hint).toBe("review_request:url");
    expect((await pgError(settings(org, { enabled: true }))).hint).toBe("review_request:incomplete");
    expect((await pgError(settings(org, { enabled: true, review_url: URL, on_deal_won: false, on_meeting_held: false }))).hint).toBe("review_request:incomplete");
    // a member cannot
    expect(await asUser(member.id, async (q) => (await q("update public.review_request_settings set enabled = true where organization_id = $1", [org])).rowCount)).toBe(0);
    await settings(org, { enabled: true, review_url: `  ${URL} `, delay_days: 2 });
    const row = await asAdmin(async (q) =>
      one<{ review_url: string; enabled_at: string | null }>(q, "select review_url, enabled_at::text from public.review_request_settings where organization_id = $1", [org]),
    );
    expect(row.review_url).toBe(URL);
    expect(row.enabled_at).not.toBeNull();
    // kept on another change
    await settings(org, { delay_days: 2 });
    expect(await asAdmin(async (q) => (await one<{ t: string }>(q, "select enabled_at::text as t from public.review_request_settings where organization_id = $1", [org])).t)).toBe(row.enabled_at);
    const templates = await asAdmin(async (q) =>
      (
        await q<{ name: string; channel: string; subject: string | null; body: string; wording_version: string; sendable: string | null }>(
          "select name, channel, subject, body, wording_version, app.message_template_sendable(organization_id, id) as sendable from public.message_templates where organization_id = $1 and notice_kind = 'review_request' order by channel desc",
          [org],
        )
      ).rows,
    );
    expect(templates).toEqual(
      DEFAULT_REVIEW_REQUEST_TEMPLATES.map((d) => ({ name: d.name, channel: d.channel, subject: d.subject, body: d.body, wording_version: REVIEW_REQUEST_WORDING_VERSION, sendable: null })),
    );
    // the business that may not switch on got no templates
    expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind = 'review_request'", [noPlan]))).toBe(0);
  });

  it("a won deal: after the delay, one request to its contact, ids only; never twice, never within 90 days", async () => {
    const dana = await contact(org, "dana-rr@example.test");
    await grant(org, dana);
    const deal = await wonDeal(org, dana);
    // the delay (2 days) has not passed
    await job();
    expect(await requests(org)).toEqual([]);
    await settings(org, { delay_days: 0 });
    expect(await job()).toBe(1);
    const [req] = await requests(org);
    expect(req).toMatchObject({ source_kind: "deal", source_id: deal, contact_id: dana, outcome: "queued", channel: "email" });
    const [queued] = await jobs(org);
    expect(queued.id).toBe(req.job_id);
    expect(Object.keys(queued.payload).sort()).toEqual(["channel", "contact_id", "event_at", "message_type", "review_request_id", "template_id"]);
    expect(queued.payload).toMatchObject({ channel: "email", message_type: "review_request", contact_id: dana });
    // the event is judged once
    expect(await job()).toBe(0);
    // another won deal of the same contact within 90 days
    const again = await wonDeal(org, dana);
    expect(await job()).toBe(1);
    expect((await requests(org)).find((r) => r.source_id === again)?.outcome).toBe("recent");
    expect(await jobs(org)).toHaveLength(1);
  });

  it("the queue judges it as marketing: no grant = consent_missing, never sent", async () => {
    const [queued] = await jobs(org);
    // the business sends at any hour and its minute's count starts again
    await asAdmin(async (q) => {
      await q(
        `insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '00:00', '24:00', false)
         on conflict (organization_id) do update set window_from = excluded.window_from, window_until = excluded.window_until, skip_rest_days = false`,
        [org],
      );
      await q("update app.message_send_rate set sent = 0 where organization_id = $1", [org]);
      await q("update app.message_system_rate set sent = 0");
      // the grant withdrawn after queueing
      await q("insert into public.consents (organization_id, contact_id, channel, state, source) values ($1, $2, 'email', 'withdrawn', 'form')", [org, queued.payload.contact_id]);
    });
    const claimed = await asService(async (q) => (await one<{ r: Array<{ id: string; lease: string }> }>(q, "select public.claim_jobs(array['message.send'], 100) as r")).r);
    const mine = claimed.find((c) => c.id === queued.id) as { id: string; lease: string };
    expect(mine).toBeDefined();
    const r = await asService(async (q) => (await one<{ r: Row }>(q, "select public.job_message_may_send($1, $2) as r", [mine.id, mine.lease])).r);
    expect(r.may_send).toBe(false);
  });

  it("no grant, no address, a binned deal or contact, an event before switching on: nothing queued", async () => {
    const before = (await jobs(org)).length;
    const noConsent = await contact(org, "noconsent-rr@example.test");
    const d1 = await wonDeal(org, noConsent);
    const noAddress = await contact(org, null);
    const d2 = await wonDeal(org, noAddress);
    const binnedContact = await contact(org, "binned-rr@example.test");
    await grant(org, binnedContact);
    const d3 = await wonDeal(org, binnedContact);
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binnedContact]));
    const ok = await contact(org, "binneddeal-rr@example.test");
    await grant(org, ok);
    const d4 = await wonDeal(org, ok);
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [d4]));
    const old = await contact(org, "old-rr@example.test");
    await grant(org, old);
    const d5 = await wonDeal(org, old);
    await backdate("update public.deals set closed_at = (select enabled_at from public.review_request_settings where organization_id = $1) - interval '1 hour' where id = $2", [org, d5]);
    await job();
    const byDeal = new Map((await requests(org)).map((r) => [r.source_id, r.outcome]));
    expect(byDeal.get(d1)).toBe("no_consent");
    expect(byDeal.get(d2)).toBe("no_address");
    expect(byDeal.get(d3)).toBe("no_contact");
    expect(byDeal.has(d4)).toBe(false);
    expect(byDeal.has(d5)).toBe(false);
    expect((await jobs(org)).length).toBe(before);
  });

  it("review (5): an imported deal is history, never asked about, even after switching on", async () => {
    const imported = await contact(org, "imported-rr@example.test");
    await grant(org, imported);
    const importJob = await asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'deal', 'deals.csv', 'create') returning id", [org])).id,
    );
    const deal = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, import_job_id) values ($1, 'עסקה מיובאת', $2, $3, $4, $5) returning id",
          [org, pipeline.pipelineId, (pipeline.stages.find((s) => s.kind === "won") as { id: string }).id, imported, importJob],
        )
      ).id,
    );
    await job();
    expect((await requests(org)).some((r) => r.source_id === deal)).toBe(false);
  });

  it("review (9): only a phone the used-up SMS quota cannot reach and no email = quota", async () => {
    await features(org, { sms: true });
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_sms_per_month\": 0}'::jsonb where organization_id = $1", [org]));
    try {
      const phoneOnly = await contact(org, null, "0501234567");
      await grant(org, phoneOnly, "sms");
      const d = await wonDeal(org, phoneOnly);
      await job();
      expect((await requests(org)).find((r) => r.source_id === d)?.outcome).toBe("quota");
    } finally {
      await features(org);
    }
  });

  it("a held meeting asks its contact; turned off, paused, without a worker or without the key: nothing", async () => {
    await settings(org, { on_meeting_held: true });
    // switched on a day ago, so a meeting that ended an hour ago counts
    await backdate("update public.review_request_settings set enabled_at = now() - interval '1 day' where organization_id = $1", [org]);
    const yael = await contact(org, "yael-rr@example.test");
    await grant(org, yael);
    const meeting = await asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id) values ($1, 'פגישה', now() - interval '2 hours', now() - interval '1 hour', $2) returning id",
          [org, yael],
        )
      ).id,
    );
    await asUser(owner.id, (q) => q("update public.meetings set status = 'held' where id = $1", [meeting]));
    // HEB-09: nothing while paused
    await asUser(owner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [org]));
    expect(await job()).toBe(0);
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    // no worker asked for message jobs in the last day: nothing
    expect(await job(org, false)).toBe(0);
    // without the key: nothing
    await features(org, { review_requests: false });
    expect(await job()).toBe(0);
    await features(org);
    // (the earlier switch-on time moved back a day, so the deal closed just before it is judged now too)
    expect(await job()).toBeGreaterThanOrEqual(1);
    const req = (await requests(org)).find((r) => r.source_id === meeting);
    expect(req).toMatchObject({ source_kind: "meeting", contact_id: yael, outcome: "queued" });
    // switched off: a new event waits for nothing
    await settings(org, { enabled: false });
    const later = await contact(org, "later-rr@example.test");
    await grant(org, later);
    const d = await wonDeal(org, later);
    expect(await job()).toBe(0);
    expect((await requests(org)).some((r) => r.source_id === d)).toBe(false);
  });

  it("review (7): a contact merge keeps the 90 days: the duplicate's requests move to the kept contact", async () => {
    await settings(org, { enabled: true });
    const dup = await contact(org, "dup-rr@example.test");
    await grant(org, dup);
    const d1 = await wonDeal(org, dup);
    await job();
    expect((await requests(org)).find((r) => r.source_id === d1)?.outcome).toBe("queued");
    const keep = await contact(org, "keep-rr@example.test");
    await grant(org, keep);
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    expect((await requests(org)).find((r) => r.source_id === d1)?.contact_id).toBe(keep);
    // the kept contact was asked within 90 days through the duplicate: a new won deal is 'recent'
    const d2 = await wonDeal(org, keep);
    await job();
    expect((await requests(org)).find((r) => r.source_id === d2)?.outcome).toBe("recent");
  });

  it("the payload key review_request_id goes only with its type, on a contact or a lead, without files or a sender", async () => {
    const ok = (payload: Row) =>
      asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify(payload)])).ok);
    const id = "11111111-1111-4111-8111-111111111111";
    const base = { channel: "sms", contact_id: id, message_type: "review_request", review_request_id: id };
    expect(await ok(base)).toBe(true);
    expect(await ok({ ...base, message_type: "marketing" })).toBe(false);
    // (309) ב: on a lead too, never on both
    expect(await ok({ channel: "sms", lead_id: id, message_type: "review_request", review_request_id: id })).toBe(true);
    expect(await ok({ ...base, lead_id: id })).toBe(false);
    expect(await ok({ ...base, channel: "whatsapp" })).toBe(false);
    expect(await ok({ ...base, automation_id: id })).toBe(false);
    expect(await ok({ ...base, review_request_id: "x" })).toBe(false);
  });

  describe("(309) ב: a lead with a held meeting", () => {
    let lorg: string;
    let lowner: U;
    let lpipe: { pipelineId: string; stages: { id: string; kind: string }[] };
    let status: string;
    const lead = (email: string | null, phone: string | null = null) =>
      asUser(lowner.id, async (q) =>
        (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, owner_id, email, phone) values ($1, $5, 'רון', $2, $3, $4) returning id", [lorg, lowner.id, email, phone, status])).id,
      );
    const leadGrant = (l: string, channel = "email") =>
      asAdmin((q) => q("insert into public.consents (organization_id, lead_id, channel, state, source) values ($1, $2, $3, 'granted', 'form')", [lorg, l, channel]));
    const heldMeeting = (links: { lead_id?: string; contact_id?: string }) =>
      asUser(lowner.id, async (q) => {
        const id = (
          await one<{ id: string }>(
            q,
            "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id, contact_id) values ($1, 'פגישה', now() - interval '2 hours', now() - interval '1 hour', $2, $3) returning id",
            [lorg, links.lead_id ?? null, links.contact_id ?? null],
          )
        ).id;
        await q("update public.meetings set status = 'held' where id = $1", [id]);
        return id;
      });

    beforeAll(async () => {
      lowner = await createUser("rr-lead-owner");
      lorg = await createOrg(lowner.id, "עסק הלידים והביקורות");
      lpipe = await defaultPipeline(lorg);
      status = await defaultLeadStatus(lorg);
      await features(lorg);
      await settings(lorg, { enabled: true, review_url: "https://www.facebook.com/biz/reviews", on_deal_won: true, on_meeting_held: true, delay_days: 0 }, lowner);
      await backdate("update public.review_request_settings set enabled_at = now() - interval '1 day' where organization_id = $1", [lorg]);
    });

    it("a lead with a held meeting is queued, ids only; a lead without a grant is not", async () => {
      const ron = await lead("ron-rr@example.test");
      await leadGrant(ron);
      const m1 = await heldMeeting({ lead_id: ron });
      const noGrant = await lead("nogrant-rr@example.test");
      const m2 = await heldMeeting({ lead_id: noGrant });
      await job(lorg);
      const rows = await requests(lorg);
      expect(rows.find((r) => r.source_id === m1)).toMatchObject({ source_kind: "meeting", lead_id: ron, contact_id: null, outcome: "queued", channel: "email" });
      expect(rows.find((r) => r.source_id === m2)).toMatchObject({ lead_id: noGrant, outcome: "no_consent", job_id: null });
      const queued = (await jobs(lorg)).find((j) => j.id === rows.find((r) => r.source_id === m1)?.job_id) as { payload: Row };
      expect(Object.keys(queued.payload).sort()).toEqual(["channel", "event_at", "lead_id", "message_type", "review_request_id", "template_id"]);
      expect(queued.payload).toMatchObject({ lead_id: ron, message_type: "review_request" });
      // a second held meeting within 90 days: recent
      const m3 = await heldMeeting({ lead_id: ron });
      await job(lorg);
      expect((await requests(lorg)).find((r) => r.source_id === m3)?.outcome).toBe("recent");
    });

    it("the 90 days follow the lead to its contact when it is converted; a converted lead is never asked itself", async () => {
      const tal = await lead("tal-rr@example.test");
      await leadGrant(tal);
      const m1 = await heldMeeting({ lead_id: tal });
      await job(lorg);
      expect((await requests(lorg)).find((r) => r.source_id === m1)?.outcome).toBe("queued");
      const contactId = await asUser(lowner.id, async (q) =>
        (await one<{ r: { contact_id: string } }>(q, "select public.convert_lead($1, false) as r", [tal])).r.contact_id,
      );
      expect(contactId).toBeTruthy();
      expect((await requests(lorg)).find((r) => r.source_id === m1)).toMatchObject({ lead_id: null, contact_id: contactId });
      await grant(lorg, contactId);
      // the contact's won deal within 90 days: recent (the lead's request counts)
      const d = await wonDeal(lorg, contactId, lpipe, lowner);
      // a later meeting linked only to the converted lead goes to its contact, also recent
      const m2 = await heldMeeting({ lead_id: tal });
      await job(lorg);
      const rows = await requests(lorg);
      expect(rows.find((r) => r.source_id === d)).toMatchObject({ contact_id: contactId, outcome: "recent" });
      expect(rows.find((r) => r.source_id === m2)).toMatchObject({ lead_id: null, contact_id: contactId, outcome: "recent" });
    });

    it("a meeting linked to a lead and a contact asks the contact, once", async () => {
      const both = await lead("both-lead-rr@example.test");
      await leadGrant(both);
      const c = await contact(lorg, "both-contact-rr@example.test", null, lowner);
      await grant(lorg, c);
      const m = await heldMeeting({ lead_id: both, contact_id: c });
      await job(lorg);
      await job(lorg);
      const rows = (await requests(lorg)).filter((r) => r.source_id === m);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ lead_id: null, contact_id: c, outcome: "queued" });
      expect((await requests(lorg)).some((r) => r.lead_id === both)).toBe(false);
    });

    it("review (3): a lead converted before its event is judged asks its contact; a contact's 90 days count rows left on its converted lead", async () => {
      const gil = await lead("gil-rr@example.test");
      const contactId = await asUser(lowner.id, async (q) =>
        (await one<{ r: { contact_id: string } }>(q, "select public.convert_lead($1, false) as r", [gil])).r.contact_id,
      );
      await grant(lorg, contactId);
      // the job saw the meeting before the conversion: it hands the lead
      const source = "22222222-2222-4222-8222-222222222222";
      const outcome = await asAdmin(async (q) =>
        (await one<{ o: string }>(q, "select app.review_request_person($1, 'meeting', $2, $3, null, current_date, 'Asia/Jerusalem') as o", [lorg, source, gil])).o,
      );
      expect(outcome).toBe("queued");
      expect((await requests(lorg)).find((r) => r.source_id === source)).toMatchObject({ lead_id: null, contact_id: contactId });
      // a row still on another lead converted into a contact (written before the move) counts for that contact
      const hila = await lead("hila-rr@example.test");
      const hilaContact = await asUser(lowner.id, async (q) =>
        (await one<{ r: { contact_id: string } }>(q, "select public.convert_lead($1, false) as r", [hila])).r.contact_id,
      );
      await grant(lorg, hilaContact);
      await asAdmin((q) =>
        q("insert into app.review_requests (organization_id, source_kind, source_id, lead_id, outcome) values ($1, 'meeting', gen_random_uuid(), $2, 'queued')", [lorg, hila]),
      );
      const d = await wonDeal(lorg, hilaContact, lpipe, lowner);
      await job(lorg);
      expect((await requests(lorg)).find((r) => r.source_id === d)?.outcome).toBe("recent");
    });

    it("review (2): a request queued to the same address in the last 90 days makes another 'recent', whoever holds it", async () => {
      const first = await contact(lorg, "shared-rr@example.test", null, lowner);
      await grant(lorg, first);
      const d1 = await wonDeal(lorg, first, lpipe, lowner);
      await job(lorg);
      const r1 = (await requests(lorg)).find((r) => r.source_id === d1);
      expect(r1?.outcome).toBe("queued");
      const hash = await asAdmin(async (q) => (await one<{ h: string | null }>(q, "select address_hash as h from app.review_requests where organization_id = $1 and source_id = $2", [lorg, d1])).h);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const second = await contact(lorg, "Shared-RR@example.test", null, lowner);
      const d2 = await wonDeal(lorg, second, lpipe, lowner);
      await job(lorg);
      expect((await requests(lorg)).find((r) => r.source_id === d2)).toMatchObject({ contact_id: second, outcome: "recent", job_id: null });
    });

    it("review (1): the platform's outside-link switch stops the job and refuses switching on or a new link", async () => {
      const block = (blocked: boolean) =>
        asAdmin((q) =>
          q(
            "insert into app.qr_external_blocks (organization_id, blocked, reason) values ($1, $2, 'בדיקה') on conflict (organization_id) do update set blocked = excluded.blocked",
            [lorg, blocked],
          ),
        );
      const c = await contact(lorg, "blocked-rr@example.test", null, lowner);
      await grant(lorg, c);
      const d = await wonDeal(lorg, c, lpipe, lowner);
      await block(true);
      try {
        expect(await job(lorg)).toBe(0);
        expect((await requests(lorg)).some((r) => r.source_id === d)).toBe(false);
        expect((await pgError(settings(lorg, { review_url: "https://www.easy.co.il/page/1" }, lowner))).hint).toBe("review_request:external_off");
        // the other settings and switching off stay allowed; switching on again is refused
        await settings(lorg, { delay_days: 0 }, lowner);
        await settings(lorg, { enabled: false }, lowner);
        expect((await pgError(settings(lorg, { enabled: true }, lowner))).hint).toBe("review_request:external_off");
      } finally {
        await block(false);
      }
      await settings(lorg, { enabled: true }, lowner);
      await backdate("update public.review_request_settings set enabled_at = now() - interval '1 day' where organization_id = $1", [lorg]);
      await job(lorg);
      expect((await requests(lorg)).find((r) => r.source_id === d)?.outcome).toBe("queued");
    });

    it("review (5): a new or changed link is at most 300 characters", async () => {
      const long = `https://www.facebook.com/${"a".repeat(300)}`;
      expect((await pgError(settings(lorg, { review_url: long }, lowner))).hint).toBe("review_request:url_long");
    });

    it("a lead merge moves the duplicate's requests to the kept lead", async () => {
      const dup = await lead("dup-lead-rr@example.test");
      await leadGrant(dup);
      const m = await heldMeeting({ lead_id: dup });
      await job(lorg);
      const keep = await lead("keep-lead-rr@example.test");
      await asUser(lowner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [lorg, keep, dup]));
      expect((await requests(lorg)).find((r) => r.source_id === m)).toMatchObject({ lead_id: keep, outcome: "queued" });
    });
  });
});
