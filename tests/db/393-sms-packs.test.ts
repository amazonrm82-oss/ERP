import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import segmentCases from "../unit/fixtures/sms-segments.json";
import { addMember, asAdmin, asAnon, asMfaUser, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

// SMS-06 (owner 18 November 2026, answers (437) א, (438) א, (439) א): SMS is paid from a prepaid balance of segments.
const KEY = "test-consent-key";

type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;
type Movement = { kind: string; segments: number; balance_after: number; job_id: string | null; pack: number | null };

const caseText = (c: { text: string; repeat?: number; suffix?: string }) => c.text.repeat(c.repeat ?? 1) + (c.suffix ?? "");

const balanceOf = (org: string) =>
  asAdmin(async (q) => (await q<{ balance: number; loaded_at: string | null }>("select balance, loaded_at from app.sms_balances where organization_id = $1", [org])).rows[0] ?? null);
const movements = (org: string) =>
  asAdmin(async (q) => (await q<Movement>("select kind, segments, balance_after, job_id, pack from app.sms_balance_movements where organization_id = $1 order by created_at, id", [org])).rows);
/** A pack loaded the way the platform owner loads one (the single writer, as the server). */
const load = (org: string, pack = 300) => asAdmin((q) => q("select app.sms_balance_move($1, 'grant', $2, null, $2, null, null)", [org, pack]));
const charge = (org: string, segments: number, job: string) => asAdmin((q) => q("select app.sms_balance_move($1, 'charge', $2, $3, null, null, null)", [org, -segments, job]));
const notices = (org: string, title: string) =>
  asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and title = $2", [org, title])).rows[0].n);

const enqueue = (org: string, payload: Answer) =>
  asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify(payload)])).rows[0].id);
const claim = async (id: string): Promise<Claimed> => {
  await asAdmin((q) => q("update app.jobs set next_run_at = now() - interval '1 second' where id = $1", [id]));
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  return job as Claimed;
};
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
  return asService(async (q) => (await q<{ r: Answer }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
};
const compose = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Answer }>("select public.sms_job_compose($1, $2, 'https://mexuz.test') as r", [job.id, job.lease])).rows[0].r);
const jobOf = (id: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ status: string; last_error: string | null; cap_wait: string | null; sms_metered: boolean; sms_segments: number | null; usage_counted: boolean }>(
          "select status, last_error, cap_wait, sms_metered, sms_segments, usage_counted from app.jobs where id = $1",
          [id],
        )
      ).rows[0],
  );

describe("prepaid SMS packs (SMS-06)", () => {
  let owner: { id: string }, admin: { id: string }, member: { id: string }, ownerB: { id: string }, staff: { id: string }, support: { id: string };
  let org: string, orgB: string;
  let template: string, marketingTemplate: string;

  const lead = async (phone = "050-1234567") => insertLead(owner.id, org, { full_name: "ליד SMS", phone, owner_id: owner.id });
  const serviceJob = async (leadId: string) => enqueue(org, { channel: "sms", message_type: "requested_document", template_id: template, lead_id: leadId });

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("packs-owner");
    org = await createOrg(owner.id, "עסק חבילות");
    admin = await addMember(org, owner.id, "admin", "packs-admin");
    member = await addMember(org, owner.id, "member", "packs-member");
    ownerB = await createUser("packs-owner-b");
    orgB = await createOrg(ownerB.id, "עסק אחר");
    staff = await createUser("packs-platform-owner");
    support = await createUser("packs-platform-support");
    await asAdmin(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'owner') on conflict (user_id) do update set role = excluded.role", [staff.id]);
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]);
      await q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"sms\": true}'::jsonb where organization_id = any($1::uuid[])", [[org, orgB]]);
      await q("update public.organizations set phone = '03-5550000' where id = $1", [org]);
      await q(
        "insert into public.org_document_settings (organization_id, address_line, phone) values ($1, 'הרצל 1', '03-5550000') on conflict (organization_id) do update set address_line = excluded.address_line, phone = excluded.phone",
        [org],
      );
      template = (
        await q<{ id: string }>(
          "insert into public.message_templates (organization_id, name, channel, message_type, subject, body, is_active) values ($1, 'מסמך', 'sms', 'requested_document', null, 'שלום {שם פרטי}', true) returning id",
          [org],
        )
      ).rows[0].id;
      marketingTemplate = (
        await q<{ id: string }>(
          "insert into public.message_templates (organization_id, name, channel, message_type, subject, body, is_active) values ($1, 'שיווק', 'sms', 'marketing', null, 'מבצע', true) returning id",
          [org],
        )
      ).rows[0].id;
    });
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1::uuid[])", [[staff.id, support.id]]));
    await closePool();
  });

  it("counts segments exactly as the TS mirror (shared fixture)", async () => {
    for (const c of segmentCases) {
      const n = await asAdmin(async (q) => (await q<{ n: number }>("select app.sms_segments($1) as n", [caseText(c)])).rows[0].n);
      expect(n, JSON.stringify(c).slice(0, 60)).toBe(c.segments);
    }
  });

  it("(437) א: no monthly SMS in any plan; the flag is on in every sold plan", async () => {
    const rows = await asAdmin(
      async (q) =>
        (await q<{ key: string; quota: number; sms: boolean }>("select key, (limits ->> 'max_sms_per_month')::int as quota, (features ->> 'sms')::boolean as sms from public.plans where key in ('personal','basic','pro','business')")).rows,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) expect([r.key, r.quota, r.sms]).toEqual([r.key, 0, true]);
  });

  it("the tables are in schema app with RLS and no grants; the reads answer owners and admins of the business only", async () => {
    const rls = await asAdmin(
      async (q) =>
        (await q<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where oid in ('app.sms_balances'::regclass, 'app.sms_balance_movements'::regclass)")).rows,
    );
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const g = await asAdmin(
        async (q) =>
          (await q<{ a: boolean; b: boolean }>("select has_table_privilege($1, 'app.sms_balances', 'select') as a, has_table_privilege($1, 'app.sms_balance_movements', 'select') as b", [role])).rows[0],
      );
      expect([role, g.a, g.b]).toEqual([role, false, false]);
    }
    await load(org, 300);
    const mine = await asUser(owner.id, async (q) => (await q<{ r: Answer }>("select public.sms_balance_summary($1) as r", [org])).rows[0].r);
    expect(mine.allowed).toBe(true);
    expect(mine.balance).toBe(300);
    expect(mine.channel).toBe("open");
    expect((mine.movements as Answer[])[0]).toEqual(expect.objectContaining({ kind: "grant", segments: 300, balance_after: 300, pack: 300 }));
    // no ids in a movement
    expect(Object.keys((mine.movements as Answer[])[0]).sort()).toEqual(["at", "balance_after", "kind", "pack", "segments"]);
    expect((await asUser(admin.id, async (q) => (await q<{ r: Answer }>("select public.sms_balance_summary($1) as r", [org])).rows[0].r)).allowed).toBe(true);
    expect(await asUser(member.id, async (q) => (await q<{ r: Answer }>("select public.sms_balance_summary($1) as r", [org])).rows[0].r)).toEqual({ allowed: false });
    // another business's owner learns nothing
    expect(await asUser(ownerB.id, async (q) => (await q<{ r: Answer }>("select public.sms_balance_summary($1) as r", [org])).rows[0].r)).toEqual({ allowed: false });
    expect((await pgError(asAnon((q) => q("select public.sms_balance_summary($1)", [org])))).code).toBe("42501");
    // the channel state: null for an outsider
    expect(await asUser(ownerB.id, async (q) => (await q<{ s: string | null }>("select app.sms_channel_state($1) as s", [org])).rows[0].s)).toBeNull();
    expect(await asUser(member.id, async (q) => (await q<{ s: string | null }>("select app.sms_channel_state($1) as s", [org])).rows[0].s)).toBe("open");
    expect(await asUser(ownerB.id, async (q) => (await q<{ s: string | null }>("select app.sms_channel_state($1) as s", [orgB])).rows[0].s)).toBe("no_balance");
  });

  it("the balance changes only with a movement, and a movement never changes", async () => {
    const before = (await balanceOf(org))!.balance;
    const e = await pgError(asAdmin((q) => q("update app.sms_balances set balance = balance + 100 where organization_id = $1", [org])));
    expect(e.hint).toBe("sms_balance:movement");
    const e2 = await pgError(asAdmin((q) => q("update app.sms_balance_movements set segments = 5000 where organization_id = $1", [org])));
    expect(e2.hint).toBe("sms_balance:movement");
    const e3 = await pgError(asAdmin((q) => q("insert into app.sms_balances (organization_id, balance) values ($1, 10)", [orgB])));
    expect(e3.hint).toBe("sms_balance:movement");
    expect((await balanceOf(org))!.balance).toBe(before);
    // every movement's balance_after is the running sum
    const all = await movements(org);
    let sum = 0;
    for (const m of all) {
      sum = m.kind === "clear" ? 0 : sum + m.segments;
      expect(m.balance_after).toBe(sum);
    }
  });

  it("platform_sms_grant: the platform owner only, at aal2, packs from the closed list, logged", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select public.platform_sms_grant($1, 300, null)", [orgB])))).code).toBe("42501");
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.platform_sms_grant($1, 300, null)", [orgB])))).code).toBe("42501");
    expect((await pgError(asUser(staff.id, (q) => q("select public.platform_sms_grant($1, 300, null)", [orgB])))).code).toBe("42501");
    const bad = await pgError(asMfaUser(staff.id, (q) => q("select public.platform_sms_grant($1, 250, null)", [orgB])));
    expect([bad.code, bad.hint]).toEqual(["22023", "sms_grant:pack"]);
    const r = await asMfaUser(staff.id, async (q) => (await q<{ r: Answer }>("select public.platform_sms_grant($1, 1000, 'קבלה 17') as r", [orgB])).rows[0].r);
    expect(r).toEqual({ ok: true, balance: 1000 });
    const log = await asAdmin(
      async (q) => (await q<{ action: string; details: Answer; actor_id: string }>("select action, details, actor_id from app.platform_log where organization_id = $1 and action = 'sms.grant'", [orgB])).rows,
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({ action: "sms.grant", details: { pack: 1000, balance_after: 1000 }, actor_id: staff.id });
    const m = await movements(orgB);
    expect(m.at(-1)).toEqual(expect.objectContaining({ kind: "grant", segments: 1000, pack: 1000 }));
    // support reads the balance (counts only); a business owner does not
    const view = await asMfaUser(support.id, async (q) => (await q<{ r: Answer }>("select public.platform_sms_balance($1) as r", [orgB])).rows[0].r);
    expect(view.balance).toBe(1000);
    expect((await pgError(asUser(ownerB.id, (q) => q("select public.platform_sms_balance($1)", [orgB])))).code).toBe("42501");
  });

  it("no balance ever loaded = the channel is off: the card refuses, and a queued SMS waits, then is cancelled after 24 hours", async () => {
    const fresh = await createUser("packs-nobalance");
    const freshOrg = await createOrg(fresh.id, "עסק בלי יתרה");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"sms\": true}'::jsonb where organization_id = $1", [freshOrg]));
    const t = await asAdmin(
      async (q) =>
        (await q<{ id: string }>("insert into public.message_templates (organization_id, name, channel, message_type, subject, body, is_active) values ($1, 'מסמך', 'sms', 'requested_document', null, 'שלום', true) returning id", [freshOrg])).rows[0].id,
    );
    const l = await insertLead(fresh.id, freshOrg, { full_name: "ליד", phone: "050-7654321", owner_id: fresh.id });
    const e = await pgError(asUser(fresh.id, (q) => q("select public.record_sms_send($1, 'lead', $2, $3)", [freshOrg, l, t])));
    expect(e.hint).toBe("sms_balance:none");
    // collection reminders and review requests choose email
    expect(await asAdmin(async (q) => (await q<{ r: boolean }>("select app.collection_sms_room($1) as r", [freshOrg])).rows[0].r)).toBe(false);

    const id = await enqueue(freshOrg, { channel: "sms", message_type: "requested_document", template_id: t, lead_id: l });
    const answer = await maySend(await claim(id));
    expect(answer).toEqual({ may_send: false, reason: "sms_balance", retry: true });
    expect(await jobOf(id)).toEqual(expect.objectContaining({ status: "queued", cap_wait: "sms_balance", last_error: "waiting:sms_balance" }));
    // the owners' "cancel the waiting" takes it (a cap waiter)
    await asAdmin((q) => q("update app.jobs set sms_balance_wait_since = now() - interval '25 hours' where id = $1", [id]));
    const late = await maySend(await claim(id));
    expect(late).toEqual({ may_send: false, reason: "sms_balance_expired" });
    expect((await jobOf(id)).status).toBe("refused");
  });

  it("a service SMS passes the gate, the composer charges its final text's segments once, and a refusal or notSent gives them back", async () => {
    await asAdmin((q) => q("select app.sms_balance_clear($1, 'test')", [org]));
    await load(org, 300);
    const l = await lead();
    const id = await serviceJob(l);
    const job = await claim(id);
    expect(await maySend(job)).toEqual({ may_send: true });
    expect((await jobOf(id)).sms_metered).toBe(true);
    const answer = await compose(job);
    expect(typeof answer.text).toBe("string");
    const segments = await asAdmin(async (q) => (await q<{ n: number }>("select app.sms_segments($1) as n", [answer.text])).rows[0].n);
    expect((await balanceOf(org))!.balance).toBe(300 - segments);
    expect((await movements(org)).at(-1)).toEqual(expect.objectContaining({ kind: "charge", segments: -segments, job_id: id }));
    // a later charge of the same job (a provider throttle, a new lease) charges nothing
    expect(await asAdmin(async (q) => (await q<{ r: string | null }>("select app.sms_balance_charge($1, 'x') as r", [id])).rows[0].r)).toBeNull();
    expect((await balanceOf(org))!.balance).toBe(300 - segments);
    // the adapter never reached the provider: the segments go back, once
    const back = await asService(async (q) => (await q<{ r: Answer }>("select public.sms_quota_return($1, $2) as r", [job.id, job.lease])).rows[0].r);
    expect(back).toEqual({ returned: true });
    expect((await balanceOf(org))!.balance).toBe(300);
    expect(await asAdmin(async (q) => (await q<{ r: boolean }>("select app.sms_balance_refund($1) as r", [id])).rows[0].r)).toBe(false);
    expect((await balanceOf(org))!.balance).toBe(300);
    // a refused composition (not stale) charges nothing
    const l2 = await lead(null as unknown as string);
    const id2 = await serviceJob(l2);
    const j2 = await claim(id2);
    await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id, usage_counted = true, sms_metered = true where id = $1", [id2]));
    expect((await compose(j2)).refused).toBeTruthy();
    expect((await balanceOf(org))!.balance).toBe(300);
  });

  it("multipart: a long Hebrew text is charged several segments", async () => {
    const l = await lead();
    const id = await serviceJob(l);
    await asAdmin((q) => q("update app.jobs set sms_metered = true where id = $1", [id]));
    const before = (await balanceOf(org))!.balance;
    expect(await asAdmin(async (q) => (await q<{ r: string | null }>("select app.sms_balance_charge($1, $2) as r", [id, "ש".repeat(135)])).rows[0].r)).toBeNull();
    expect((await balanceOf(org))!.balance).toBe(before - 3);
    expect((await jobOf(id)).sms_segments).toBe(3);
  });

  it("a failed delivery report gives the segments back; delivered and unknown stay charged", async () => {
    const mk = async (status: string, code: string | null) => {
      const l = await lead();
      const id = await serviceJob(l);
      await asAdmin((q) => q("update app.jobs set sms_metered = true where id = $1", [id]));
      await asAdmin((q) => q("select app.sms_balance_charge($1, 'hello')", [id]));
      await asAdmin((q) =>
        q(
          "insert into public.messages (organization_id, lead_id, channel, direction, status, provider, provider_message_id, provider_error_code, job_id, occurred_at) values ($1, $2, 'sms', 'outbound', $3, 'inforu', $4::text, $5, $4::text::uuid, now())",
          [org, l, status, id, code],
        ),
      );
      return id;
    };
    const start = (await balanceOf(org))!.balance;
    const sent = await mk("sent", null);
    const unknown = await mk("unknown", "unknown_timeout");
    expect((await balanceOf(org))!.balance).toBe(start - 2);
    await asAdmin((q) => q("update public.messages set status = 'delivered' where job_id = $1", [sent]));
    expect((await balanceOf(org))!.balance).toBe(start - 2);
    await asAdmin((q) => q("update public.messages set status = 'failed', provider_error_code = 'undelivered' where job_id = $1", [unknown]));
    expect((await balanceOf(org))!.balance).toBe(start - 1);
    // the report repeated changes nothing
    await asAdmin((q) => q("update public.messages set provider_error_code = 'again' where job_id = $1", [unknown]));
    expect((await balanceOf(org))!.balance).toBe(start - 1);
    // a job that ends failed at the provider (inserted failed) gives back too
    await mk("failed", "status_m5");
    expect((await balanceOf(org))!.balance).toBe(start - 1);
  });

  it("at 0 a marketing SMS waits; a service SMS goes down to minus 50 and not beyond", async () => {
    await asAdmin((q) => q("select app.sms_balance_clear($1, 'test')", [org]));
    await load(org, 300);
    const bal = (await balanceOf(org))!.balance;
    const filler = await serviceJob(await lead());
    await charge(org, bal, filler);
    expect((await balanceOf(org))!.balance).toBe(0);

    const l = await lead();
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה')", [org, l]),
    );
    const mk = await enqueue(org, { channel: "sms", message_type: "marketing", template_id: marketingTemplate, lead_id: l });
    expect(await maySend(await claim(mk))).toEqual({ may_send: false, reason: "sms_balance", retry: true });
    // a marketing charge never takes the balance below 0
    await asAdmin((q) => q("update app.jobs set sms_metered = true where id = $1", [mk]));
    expect(await asAdmin(async (q) => (await q<{ r: string | null }>("select app.sms_balance_charge($1, 'x') as r", [mk])).rows[0].r)).toBe("sms_balance");

    const svc = await serviceJob(await lead());
    expect(await maySend(await claim(svc))).toEqual({ may_send: true });
    await asAdmin((q) => q("select app.sms_balance_charge($1, $2)", [svc, "ש".repeat(134)]));
    expect((await balanceOf(org))!.balance).toBe(-2);
    // down to -50 exactly
    const big = await serviceJob(await lead());
    await asAdmin((q) => q("update app.jobs set sms_metered = true where id = $1", [big]));
    await charge(org, 48, big);
    expect((await balanceOf(org))!.balance).toBe(-50);
    const over = await serviceJob(await lead());
    expect(await maySend(await claim(over))).toEqual({ may_send: false, reason: "sms_balance", retry: true });
    await asAdmin((q) => q("update app.jobs set sms_metered = true where id = $1", [over]));
    expect(await asAdmin(async (q) => (await q<{ r: string | null }>("select app.sms_balance_charge($1, 'x') as r", [over])).rows[0].r)).toBe("sms_balance");
    const e = await pgError(asAdmin((q) => q("select app.sms_balance_move($1, 'charge', -1, $2, null, null, null)", [org, over])));
    expect(e.code).toBe("23514");
    // the next pack covers the minus
    await load(org, 300);
    expect((await balanceOf(org))!.balance).toBe(250);
  });

  it("the composer's own refusal for room puts the job back to wait, uncounted", async () => {
    await asAdmin((q) => q("select app.sms_balance_clear($1, 'test')", [org]));
    await load(org, 300);
    const filler = await serviceJob(await lead());
    await charge(org, 300 + 49, filler);
    const id = await serviceJob(await lead());
    const job = await claim(id);
    expect(await maySend(job)).toEqual({ may_send: true });
    // the text needs 2 segments; one is left before minus 50
    await asAdmin((q) => q("update public.message_templates set body = $2 where id = $1", [template, "ש".repeat(100)]));
    try {
      expect(await compose(job)).toEqual({ refused: "sms_balance" });
    } finally {
      await asAdmin((q) => q("update public.message_templates set body = 'שלום {שם פרטי}' where id = $1", [template]));
    }
    expect(await jobOf(id)).toEqual(expect.objectContaining({ status: "queued", cap_wait: "sms_balance", usage_counted: false, sms_segments: 2 }));
    expect((await balanceOf(org))!.balance).toBe(-49);
    // the next send check knows the job needs 2 segments
    expect(await maySend(await claim(id))).toEqual({ may_send: false, reason: "sms_balance", retry: true });
  });

  it("notices to the active owners at 20% of the last pack and at 0, once per crossing, re-armed by a load", async () => {
    const o = await createUser("packs-notice-owner");
    const n = await createOrg(o.id, "עסק התראות");
    const a = await addMember(n, o.id, "admin", "packs-notice-admin");
    await load(n, 300);
    const j = await asAdmin(async (q) => (await q<{ id: string }>("select gen_random_uuid() as id")).rows[0].id);
    await charge(n, 239, j);
    expect(await notices(n, "יתרת ה-SMS נמוכה")).toBe(0);
    await charge(n, 1, j);
    expect(await notices(n, "יתרת ה-SMS נמוכה")).toBe(1);
    await charge(n, 10, j);
    expect(await notices(n, "יתרת ה-SMS נמוכה")).toBe(1);
    await charge(n, 50, j);
    expect(await notices(n, "יתרת ה-SMS נגמרה")).toBe(1);
    await charge(n, 5, j);
    expect(await notices(n, "יתרת ה-SMS נגמרה")).toBe(1);
    // owners only
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and user_id = $2 and title like 'יתרת ה-SMS%'", [n, a.id])).rows[0].n)).toBe(0);
    await load(n, 1000);
    await charge(n, 800, j);
    expect(await notices(n, "יתרת ה-SMS נמוכה")).toBe(2);
  });

  it("(439) א: suspended keeps the balance; cancelled clears it with a final movement, the channel off, nothing given back after", async () => {
    const o = await createUser("packs-cancel-owner");
    const c = await createOrg(o.id, "עסק שבוטל");
    await load(c, 300);
    const j = await asAdmin(async (q) => (await q<{ id: string }>("select gen_random_uuid() as id")).rows[0].id);
    await charge(c, 7, j);
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [c]));
    expect(await balanceOf(c)).toEqual(expect.objectContaining({ balance: 293 }));
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [c]));
    expect((await balanceOf(c))!.balance).toBe(293);
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [c]));
    expect(await balanceOf(c)).toEqual({ balance: 0, loaded_at: null });
    expect((await movements(c)).at(-1)).toEqual(expect.objectContaining({ kind: "clear", segments: -293, balance_after: 0 }));
    expect(await asAdmin(async (q) => (await q<{ r: boolean }>("select app.sms_balance_refund($1) as r", [j])).rows[0].r)).toBe(false);
    expect((await balanceOf(c))!.balance).toBe(0);
    const e = await pgError(asMfaUser(staff.id, (q) => q("select public.platform_sms_grant($1, 300, null)", [c])));
    expect(e.hint).toBe("sms_grant:cancelled");
    // a business marked deleted loses it too
    const o2 = await createUser("packs-deleted-owner");
    const d = await createOrg(o2.id, "עסק שנמחק");
    await load(d, 1000);
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [d]));
    expect(await balanceOf(d)).toEqual({ balance: 0, loaded_at: null });
  });

  it("a suspended business sends nothing from its balance", async () => {
    const o = await createUser("packs-suspended-owner");
    const s = await createOrg(o.id, "עסק מושעה");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"sms\": true}'::jsonb where organization_id = $1", [s]));
    await load(s, 300);
    const l = await insertLead(o.id, s, { full_name: "ליד", phone: "050-1112222", owner_id: o.id });
    const id = await enqueue(s, { channel: "sms", message_type: "requested_document", lead_id: l });
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [s]));
    expect(await maySend(await claim(id))).toEqual({ may_send: false, reason: "business_closed" });
    expect((await balanceOf(s))!.balance).toBe(300);
  });

  it("(438) א: the sender-number code is never charged and at most 3 a business day", async () => {
    await asAdmin((q) => q("select app.sms_balance_clear($1, 'test')", [org]));
    await asAdmin((q) => q("delete from app.sms_sender_checks where organization_id = $1", [org]));
    // the code goes even with no balance
    const first = await asUser(owner.id, async (q) => (await q<{ r: Answer }>("select public.sms_sender_verify_start($1) as r", [org])).rows[0].r);
    expect(first).toEqual({ ok: true });
    const id = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from app.jobs where organization_id = $1 and payload ? 'sender_check_id' order by created_at desc limit 1", [org])).rows[0].id,
    );
    const job = await claim(id);
    expect(await maySend(job)).toEqual({ may_send: true });
    const composed = await compose(job);
    expect(typeof composed.text).toBe("string");
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.sms_balance_movements where job_id = $1", [id])).rows[0].n)).toBe(0);
    // two more today, then refused for the day
    await asAdmin((q) =>
      q("insert into app.sms_sender_checks (organization_id, phone, created_by) select $1, '+97235550000', $2 from generate_series(1, 2)", [org, owner.id]),
    );
    const daily = await asUser(owner.id, async (q) => (await q<{ r: Answer }>("select public.sms_sender_verify_start($1) as r", [org])).rows[0].r);
    expect(daily).toEqual({ ok: false, reason: "daily" });
    // checks of earlier days do not count
    await asAdmin((q) => q("update app.sms_sender_checks set created_at = created_at - interval '2 days' where organization_id = $1", [org]));
    expect(await asUser(owner.id, async (q) => (await q<{ r: Answer }>("select public.sms_sender_verify_start($1) as r", [org])).rows[0].r)).toEqual({ ok: true });
  });

  it("the collection room needs a loaded balance above 0", async () => {
    await asAdmin((q) => q("select app.sms_balance_clear($1, 'test')", [org]));
    expect(await asAdmin(async (q) => (await q<{ r: boolean }>("select app.collection_sms_room($1) as r", [org])).rows[0].r)).toBe(false);
    await load(org, 300);
    expect(await asAdmin(async (q) => (await q<{ r: boolean }>("select app.collection_sms_room($1) as r", [org])).rows[0].r)).toBe(true);
  });
});
